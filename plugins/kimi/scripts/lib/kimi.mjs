// Turn-capture accumulator + engine orchestration: maps ACP session/update
// notifications into progress reporting and final result assembly, and
// exposes the high-level entry points the companion CLI drives (runKimiTurn,
// cancelKimiSession, availability/runtime probes). Ported from the codex
// plugin's lib/codex.mjs, much reduced: ACP has no subagent threads and turn
// completion is the session/prompt RESPONSE, not a notification. Agent
// specifics stay in agent-profile.mjs; this file owns only the ACP
// vocabulary and orchestration.
import process from "node:process";
import { AcpClient, BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV } from "./acp-client.mjs";
import { AGENT_SPAWN_ENV, getAgentProfile, isAuthRequiredError } from "./agent-profile.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

// KMP-24: our reject-policy answer surfaces to the model as "The tool call is
// rejected by the user. Stop what you are doing…", so without this preamble a
// read-only task self-aborts on its first shell attempt, reading automated
// policy as the user cancelling. Wording proven live 2026-07-26.
export const READ_ONLY_TASK_PREAMBLE = `<tool_availability>
This is a READ-ONLY task: write, edit, and shell/execute tools are blocked by an automated policy.
A rejected tool call is that automated read-only policy answering — it is NOT the user cancelling, and no user is present. A rejection result may read "The tool call is rejected by the user. Stop what you are doing and wait for the user to tell you how to proceed." — that exact text is the automated policy speaking, not a human. Do not stop, do not wait, and never end your turn because of a rejection.
Your built-in file-reading tools work normally; continue the task with those and always produce a final answer. If a step genuinely cannot be done without shell or writes, say so in your final answer and complete everything else.
</tool_availability>

`;

// KMP-27: even with the preamble, a live rejection's CLI text ("rejected by
// the user — stop") can make the model end its turn with no answer. This is
// the one-shot recovery prompt sent on the same session when that happens.
export const REJECTION_CONTINUATION_PROMPT =
  "Those tool rejections were the automated read-only policy answering — not the user; no user is present. Do not stop. Continue the task now using only your built-in file-reading tools and produce your final answer.";

const EDITING_TOOL_KINDS = new Set(["edit", "delete", "move"]);

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

// Same reporter contract as the codex plugin: a string for plain updates or
// { message, phase, ...extra } when structure applies. The extra fields
// matter: threadId on the session-ready event is how a RUNNING job's record
// learns its ACP sessionId, which /kimi:cancel needs to target the turn.
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  try {
    if (phase || Object.keys(extra).length > 0) {
      onProgress({ message, phase, ...extra });
    } else {
      onProgress(message);
    }
  } catch {}
}

function phaseForToolKind(kind) {
  if (EDITING_TOOL_KINDS.has(kind)) {
    return "editing";
  }
  if (kind === "execute") {
    return "running";
  }
  return "investigating";
}

// Content arrives as an ACP ContentBlock ({ type: "text", text }) or an
// array of them; non-text blocks are ignored for text assembly.
function extractTextContent(content) {
  if (content == null) {
    return "";
  }
  if (Array.isArray(content)) {
    return content.map((block) => extractTextContent(block)).join("");
  }
  if (typeof content === "object") {
    // Plain text block ({type:"text", text}) or a bare {text}.
    if (typeof content.text === "string") {
      return content.text;
    }
    // ACP tool-result blocks wrap the payload: {type:"content", content:{text}}
    // — verified live against kimi 2026-07-22. Unwrap it so tool/sub-agent
    // output is not silently dropped.
    if (content.content !== undefined) {
      return extractTextContent(content.content);
    }
  }
  return "";
}

export function createTurnCapture(sessionId, options = {}) {
  return {
    sessionId,
    // Chunks group into segments by ACP messageId (chunks without one
    // continue the current segment) so distinct messages in a turn are not
    // mashed into a single string.
    messageSegments: [],
    thoughtParts: [],
    toolCalls: new Map(),
    planEntries: [],
    unknownUpdateKinds: new Set(),
    onProgress: options.onProgress ?? null
  };
}

function appendMessageChunk(state, update) {
  const text = extractTextContent(update.content);
  if (!text) {
    return;
  }
  const messageId = update.messageId ?? null;
  let segment = state.messageSegments.at(-1);
  if (!segment || (messageId !== null && segment.messageId !== null && segment.messageId !== messageId)) {
    segment = { messageId, parts: [] };
    state.messageSegments.push(segment);
  }
  if (segment.messageId === null && messageId !== null) {
    segment.messageId = messageId;
  }
  segment.parts.push(text);
}

// Applies one notification to the capture state. Returns true when the
// notification belonged to this capture's session (even if the update kind
// is unmapped); false means "not ours" so callers can route it elsewhere.
export function applySessionUpdate(state, notification) {
  if (notification?.method !== "session/update") {
    return false;
  }
  const params = notification.params ?? {};
  if (params.sessionId !== state.sessionId) {
    return false;
  }
  const update = params.update;
  if (!update || typeof update !== "object") {
    return true;
  }

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      appendMessageChunk(state, update);
      return true;
    }
    case "agent_thought_chunk": {
      const text = extractTextContent(update.content);
      if (text) {
        state.thoughtParts.push(text);
      }
      return true;
    }
    case "tool_call": {
      const toolCallId = update.toolCallId ?? `tool-${state.toolCalls.size}`;
      const entry = {
        toolCallId,
        title: update.title ?? "",
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        locations: update.locations ?? [],
        content: update.content ?? []
      };
      state.toolCalls.set(toolCallId, entry);
      emitProgress(
        state.onProgress,
        `Tool started: ${shorten(entry.title) || entry.kind}`,
        phaseForToolKind(entry.kind)
      );
      return true;
    }
    case "tool_call_update": {
      const toolCallId = update.toolCallId;
      if (toolCallId == null) {
        return true;
      }
      let entry = state.toolCalls.get(toolCallId);
      if (!entry) {
        // Update for a call whose start we never saw — record a skeleton so
        // its outcome still shows up in the result.
        entry = { toolCallId, title: "", kind: "other", status: "pending", locations: [], content: [] };
        state.toolCalls.set(toolCallId, entry);
      }
      for (const key of ["status", "title", "kind", "locations", "content", "rawInput", "rawOutput"]) {
        if (update[key] !== undefined && update[key] !== null) {
          entry[key] = update[key];
        }
      }
      if (update.status === "completed" || update.status === "failed") {
        emitProgress(
          state.onProgress,
          `Tool ${shorten(entry.title) || entry.kind} ${update.status}.`,
          update.status === "failed" ? "failed" : phaseForToolKind(entry.kind)
        );
      }
      return true;
    }
    case "plan": {
      state.planEntries = Array.isArray(update.entries) ? update.entries : [];
      const total = state.planEntries.length;
      const completed = state.planEntries.filter((entry) => entry?.status === "completed").length;
      emitProgress(state.onProgress, `Plan: ${completed}/${total} steps completed.`, "planning");
      return true;
    }
    // Known kinds we deliberately ignore (PLAN §1).
    case "available_commands_update":
    case "current_mode_update":
      return true;
    default:
      if (typeof update.sessionUpdate === "string") {
        state.unknownUpdateKinds.add(update.sessionUpdate);
      }
      return true;
  }
}

// Best-effort: only COMPLETED calls count (a rejected edit touched nothing).
// A diff-type content block is the modification signal REGARDLESS of the
// advertised tool kind — verified live 2026-07-17: kimi reports its edits
// as kind "other" with empty locations, and only the diff block (with its
// required path field) reveals the write. Edit-kind locations still count
// for agents that do populate them. Consumers wanting ground truth should
// diff the worktree.
function collectTouchedFiles(state) {
  const paths = new Set();
  for (const call of state.toolCalls.values()) {
    if (call.status !== "completed") {
      continue;
    }
    if (EDITING_TOOL_KINDS.has(call.kind)) {
      for (const location of call.locations ?? []) {
        if (location?.path) {
          paths.add(location.path);
        }
      }
    }
    for (const block of Array.isArray(call.content) ? call.content : []) {
      if (block?.type === "diff" && block.path) {
        paths.add(block.path);
      }
    }
  }
  return [...paths];
}

// Text a tool call carried in its result content (e.g. an "Agent" sub-agent's
// report). This is the deliverable when the model routes work through tools
// and emits only a thin final message — it MUST be recoverable, or completed
// work is silently lost (verified live 2026-07-22).
function collectToolOutputs(state) {
  const outputs = [];
  for (const call of state.toolCalls.values()) {
    const text = extractTextContent(call.content).trim();
    if (text) {
      outputs.push({
        toolCallId: call.toolCallId,
        title: call.title ?? "",
        kind: call.kind ?? "other",
        status: call.status ?? "pending",
        text
      });
    }
  }
  return outputs;
}

export function buildTurnResult(state, promptResponse) {
  const stopReason = promptResponse?.stopReason ?? null;
  const messages = state.messageSegments.map((segment) => segment.parts.join(""));
  const agentMessage = messages.join("\n\n");
  const toolOutputs = collectToolOutputs(state);
  return {
    status: stopReason === "end_turn" ? 0 : 1,
    stopReason,
    agentMessage,
    lastAgentMessage: messages.at(-1) ?? "",
    reasoning: state.thoughtParts.join(""),
    toolCalls: [...state.toolCalls.values()],
    toolOutputs,
    // A turn that "completed" but produced no message AND no tool output did
    // nothing usable — callers key exit status and rendering off this so an
    // empty end_turn is not reported as success.
    hasContent: Boolean(agentMessage.trim()) || toolOutputs.length > 0,
    touchedFiles: collectTouchedFiles(state),
    plan: state.planEntries,
    unknownUpdateKinds: [...state.unknownUpdateKinds]
  };
}

// Creates a session and binds its permission policy in one step so no turn
// can run on it before the policy is set. The await matters: on a brokered
// client the policy is registered broker-side and returns a promise.
export async function newSession(client, cwd, options = {}) {
  const session = await client.request("session/new", {
    cwd,
    mcpServers: options.mcpServers ?? []
  });
  if (options.permissionDecision) {
    await client.setSessionPermissionDecision(session.sessionId, options.permissionDecision);
  }
  return session;
}

// Per-client capture registry. A single dispatcher handler routes each
// notification to the active capture for its sessionId (base handler gets
// the rest), so overlapping turns on DIFFERENT sessions can't corrupt each
// other — a plain save-and-restore of client.notificationHandler only
// survives strict LIFO nesting. Two concurrent captures on the SAME session
// are refused loudly (ACP serializes turns within a session anyway).
const clientCaptures = new WeakMap();

function installCapture(client, state) {
  let entry = clientCaptures.get(client);
  if (!entry) {
    entry = { base: client.notificationHandler ?? null, captures: new Map() };
    clientCaptures.set(client, entry);
    client.setNotificationHandler((message) => {
      const capture = entry.captures.get(message?.params?.sessionId);
      if (capture && applySessionUpdate(capture, message)) {
        return;
      }
      if (entry.base) {
        entry.base(message);
      }
    });
  }
  if (entry.captures.has(state.sessionId)) {
    throw new Error(`A turn capture is already active for session ${state.sessionId}.`);
  }
  entry.captures.set(state.sessionId, state);
}

function removeCapture(client, state) {
  const entry = clientCaptures.get(client);
  if (!entry) {
    return;
  }
  if (entry.captures.get(state.sessionId) === state) {
    entry.captures.delete(state.sessionId);
  }
  if (entry.captures.size === 0) {
    clientCaptures.delete(client);
    client.setNotificationHandler(entry.base ?? null);
  }
}

export function getKimiAvailability(cwd) {
  // With a spawn override active, the override IS the agent — probing the
  // real binary would wrongly fail on hosts without Kimi installed.
  if (process.env[AGENT_SPAWN_ENV]) {
    return { available: true, detail: `agent spawn override active (${AGENT_SPAWN_ENV})` };
  }
  const profile = getAgentProfile();
  // Deeper probes (acp --help, known-good version drift) belong to the
  // setup command (KMP-12); the ACP handshake itself is the real check.
  // Bounded (KMP-25): this spawnSync runs on EVERY turn — a wedged binary
  // must never hang the caller forever.
  return binaryAvailable(profile.probe.command, profile.probe.args, { cwd, timeout: SETUP_PROBE_TIMEOUT_MS });
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session reuses one shared Kimi runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "on-demand startup",
    detail: "No shared Kimi runtime is active yet. The first task command will start one on demand.",
    endpoint: null
  };
}

export function isBrokerBusyError(error) {
  return error?.code === BROKER_BUSY_RPC_CODE;
}

// Every setup probe is bounded: a wedged agent must never hang /kimi:setup
// (env knob exists for tests and slow machines).
const SETUP_PROBE_TIMEOUT_MS = Number(process.env.KIMI_COMPANION_PROBE_TIMEOUT_MS) || 20_000;

function withProbeDeadline(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${SETUP_PROBE_TIMEOUT_MS / 1000}s`)),
        SETUP_PROBE_TIMEOUT_MS
      );
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

// The three-state setup probe (PLAN §5 M4): not-installed / logged-out /
// ready, plus "error" for anything else. Auth is probed LIVE — a short
// direct agent spawn and a session/new attempt — because logged-out state
// only surfaces there (PLAN §1). Never touches the shared broker.
export async function getKimiSetupStatus(cwd) {
  const profile = getAgentProfile();
  const overrideActive = Boolean(process.env[AGENT_SPAWN_ENV]);
  const kimi = getKimiAvailability(cwd);
  const report = {
    state: "error",
    overrideActive,
    kimi,
    acp: null,
    versionNote: null,
    auth: { loggedIn: false, detail: "not probed" }
  };

  if (!kimi.available) {
    report.state = "not-installed";
    report.auth.detail = "Kimi Code CLI is not installed.";
    return report;
  }

  if (overrideActive) {
    report.acp = { available: true, detail: "agent spawn override active" };
  } else {
    report.acp = binaryAvailable(profile.probe.command, profile.probe.runtimeArgs ?? ["acp", "--help"], {
      cwd,
      timeout: SETUP_PROBE_TIMEOUT_MS
    });
    if (!report.acp.available) {
      // Installed binary with a broken ACP runtime is an ERROR, not
      // not-installed — "go install it" would be wrong guidance.
      report.state = "error";
      report.auth.detail = `The installed ${profile.displayName} CLI has no working ACP runtime: ${report.acp.detail}`;
      return report;
    }
    // The success detail is the subcommand's full help text — condense it.
    report.acp = { available: true, detail: `${profile.probe.command} ${(profile.probe.runtimeArgs ?? []).join(" ")} responds` };
    const version = String(kimi.detail).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    if (version && profile.probe.knownGoodVersion && version !== profile.probe.knownGoodVersion) {
      report.versionNote = `Installed ${profile.displayName} ${version} differs from the known-good ${profile.probe.knownGoodVersion}. If anything misbehaves, run \`node spike/acp-spike.mjs\` as a 30-second regression check.`;
    }
  }

  let client = null;
  try {
    client = await AcpClient.connect(cwd, { disableBroker: true, connectTimeoutMs: SETUP_PROBE_TIMEOUT_MS });
    try {
      await withProbeDeadline(client.request("session/new", { cwd, mcpServers: [] }), "session probe");
      report.state = "ready";
      report.auth = { loggedIn: true, detail: "logged in (live session check passed)" };
    } catch (error) {
      if (isAuthRequiredError(profile, error)) {
        report.state = "logged-out";
        report.auth = { loggedIn: false, detail: `Not logged in. ${profile.auth.loginInstructions}` };
      } else {
        report.auth = { loggedIn: false, detail: `ACP probe failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  } catch (error) {
    report.auth = {
      loggedIn: false,
      detail: `Could not start the agent: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    await client?.close().catch(() => {});
  }

  return report;
}

// Resolves a user-supplied model name/alias to the wire id, or throws with
// the full menu. null/empty input means "agent default" and returns null so
// callers skip session/set_model entirely.
export function resolveRequestedModel(nameOrAlias) {
  if (nameOrAlias == null || String(nameOrAlias).trim() === "") {
    return null;
  }
  const profile = getAgentProfile();
  const resolved = profile.resolveModel(String(nameOrAlias).trim());
  if (!resolved) {
    const aliases = Object.keys(profile.models.aliases).join(", ");
    throw new Error(`Unknown model "${nameOrAlias}". Available: ${profile.models.catalog.join(", ")} (aliases: ${aliases}).`);
  }
  return resolved;
}

// ACP has no native output-schema enforcement (unlike the codex app-server),
// so structured output is prompt-demanded and parsed tolerantly: raw text,
// then a fenced block, then the outermost brace span.
function structuredCandidates(rawOutput) {
  const text = String(rawOutput).trim();
  const candidates = [text];
  // LAST fence first: a final answer beats echoed examples or stale JSON
  // earlier in the message (which reviewed content could even plant).
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    candidates.push(fences[index][1].trim());
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }
  return candidates;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    // parseError must NEVER be falsy on a failed parse: an empty-string
    // failureMessage (e.g. blank stderr) would otherwise launder a missing
    // result into "no error" downstream.
    const failureMessage =
      typeof fallback.failureMessage === "string" && fallback.failureMessage.trim()
        ? fallback.failureMessage
        : "Kimi did not return a final structured message.";
    return {
      parsed: null,
      ...fallback,
      parseError: failureMessage,
      rawOutput: rawOutput ?? ""
    };
  }

  for (const candidate of structuredCandidates(rawOutput)) {
    try {
      const parsed = JSON.parse(candidate);
      // Only a JSON OBJECT can satisfy the contract; "4" or an array
      // parsing successfully must not shadow a later valid candidate.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // fallback spreads FIRST everywhere: it must never overwrite the
        // computed parsed/parseError/rawOutput fields.
        return { ...fallback, parsed, parseError: null, rawOutput };
      }
    } catch {}
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Final message was not valid JSON (tried raw text, fenced blocks newest-first, and outermost braces).",
    rawOutput
  };
}

// Throws when any captured permission event was not answered under the
// reject policy — the review path's defense-in-depth guard, kept here so it
// is unit-testable (the CLI entrypoint cannot be imported without running).
export function assertReadOnlyPermissionEvents(events) {
  const granted = (events ?? []).filter((event) => event?.decision !== "reject");
  if (granted.length > 0) {
    throw new Error(`SECURITY: ${granted.length} permission request(s) were granted during a read-only review. This indicates a permission-policy regression; do not trust this review result.`);
  }
}

function rethrowWithLoginHint(profile, error) {
  if (isAuthRequiredError(profile, error)) {
    throw new Error(`Kimi is not logged in. ${profile.auth.loginInstructions}`);
  }
  throw error;
}

// Connect through the shared broker (starting it on demand), run fn, always
// close the socket. The broker outlives us; only our connection ends.
export async function withKimiClient(cwd, fn, options = {}) {
  const client = await AcpClient.connect(cwd, { useBroker: true, ...options });
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// One full task turn: session create-or-load, permission policy from the
// write flag (reject = read-only guarantee), prompt, captured result.
// Resume goes through session/load — verified live 2026-07-17: context
// survives both a new broker socket AND a fresh agent process (PLAN §7
// risk 2 closed; no stateless fallback needed).
export async function runKimiTurn(cwd, options = {}) {
  const profile = getAgentProfile();
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    throw new Error("Kimi Code CLI is not installed or not on PATH. Install it (https://github.com/MoonshotAI/kimi-code), then rerun /kimi:setup.");
  }

  // Every permission decision is captured on the result and surfaced as
  // progress: "the reject path fired" must be assertable, never inferred
  // from the absence of writes (PLAN §5 M3). Works on both transports —
  // direct clients fire onPermissionRequest locally, brokered clients get
  // the broker/permission_event relay.
  const permissionEvents = [];
  const callerClientOptions = options.clientOptions ?? {};
  const clientOptions = {
    ...callerClientOptions,
    // Composed, never replaced: a caller-supplied observer must not be able
    // to disable event capture (the review security guard reads it).
    onPermissionRequest: (event) => {
      permissionEvents.push(event);
      const title = event.params?.toolCall?.title ?? event.params?.toolCall?.kind ?? "tool request";
      const granted = event.decision === "allow";
      emitProgress(
        options.onProgress,
        `Permission ${granted ? "granted" : "REJECTED"} (${event.decision} policy): ${title}`,
        granted ? null : "rejected"
      );
      try {
        callerClientOptions.onPermissionRequest?.(event);
      } catch {}
    }
  };

  return withKimiClient(cwd, async (client) => {
    const decision = options.write ? "allow" : "reject";
    let sessionId;

    if (options.resumeSessionId) {
      emitProgress(options.onProgress, `Loading session ${options.resumeSessionId}.`, "starting");
      try {
        await client.request("session/load", { sessionId: options.resumeSessionId, cwd, mcpServers: [] });
      } catch (error) {
        rethrowWithLoginHint(profile, error);
      }
      sessionId = options.resumeSessionId;
      await client.setSessionPermissionDecision(sessionId, decision);
    } else {
      emitProgress(options.onProgress, "Starting Kimi session.", "starting");
      let session;
      try {
        session = await newSession(client, cwd, { permissionDecision: decision });
      } catch (error) {
        rethrowWithLoginHint(profile, error);
      }
      sessionId = session.sessionId;
    }

    emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { threadId: sessionId });

    // Model selection is per session via session/set_model with an exact
    // wire id (verified live 2026-07-17). No flag -> the agent's default.
    if (options.model) {
      await client.request("session/set_model", { sessionId, modelId: options.model });
      emitProgress(options.onProgress, `Model set (${options.model}).`, "starting");
    }

    const basePrompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!basePrompt) {
      throw new Error("A prompt is required for this Kimi run.");
    }
    // Applied after prompt/defaultPrompt resolution so resumed turns get it
    // too. Callers own the choice: the review AND stop-gate templates carry
    // their own tool_availability rules and must not be double-preambled.
    const prompt = options.promptPreamble ? `${options.promptPreamble}${basePrompt}` : basePrompt;

    let result = await runPromptTurn(client, { sessionId, prompt, onProgress: options.onProgress });

    // KMP-27: rejection-abort recovery. Deterministic trigger — at least one
    // rejected permission this turn AND no agent message at all (the silent
    // abort leaves only the rejection tool output). One continuation on the
    // same session, never a loop. Callers opt in alongside the preamble.
    if (
      options.continueAfterRejectionAbort &&
      !result.agentMessage.trim() &&
      permissionEvents.some((event) => event.decision !== "allow")
    ) {
      emitProgress(
        options.onProgress,
        "Turn ended silently after policy rejections — sending one continuation prompt.",
        "investigating"
      );
      const followUp = await runPromptTurn(client, {
        sessionId,
        prompt: REJECTION_CONTINUATION_PROMPT,
        onProgress: options.onProgress
      });
      // Merge so the first turn's tool activity (including the rejection
      // evidence) stays visible alongside the recovered answer.
      result = {
        ...followUp,
        toolCalls: [...result.toolCalls, ...followUp.toolCalls],
        toolOutputs: [...result.toolOutputs, ...followUp.toolOutputs],
        reasoning: [result.reasoning, followUp.reasoning].filter(Boolean).join("\n\n"),
        touchedFiles: [...new Set([...result.touchedFiles, ...followUp.touchedFiles])],
        unknownUpdateKinds: [...new Set([...result.unknownUpdateKinds, ...followUp.unknownUpdateKinds])],
        hasContent: result.hasContent || followUp.hasContent,
        plan: followUp.plan.length > 0 ? followUp.plan : result.plan
      };
    }

    return { ...result, sessionId, stderr: client.stderr ?? "", permissionEvents };
  }, clientOptions);
}

// Best-effort cancel of a running turn via the live broker. Never spawns a
// broker or agent just to cancel; if no shared runtime is up, there is no
// agent-side turn to stop (the worker process kill handles the rest).
export async function cancelKimiSession(cwd, { sessionId }) {
  if (!sessionId) {
    return { attempted: false, detail: "missing sessionId" };
  }
  const endpoint = loadBrokerSession(cwd)?.endpoint ?? null;
  if (!endpoint) {
    return { attempted: false, detail: "no shared Kimi runtime is active" };
  }
  try {
    const client = await AcpClient.connect(cwd, { brokerEndpoint: endpoint });
    client.notify("session/cancel", { sessionId });
    await client.close();
    return { attempted: true, detail: `Sent session/cancel for ${sessionId}.` };
  } catch (error) {
    return { attempted: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// Runs one prompt turn with capture. Notifications for sessions without an
// active capture go to the handler that was installed before the first
// capture; the base handler is restored once the last capture ends. Callers
// must not call setNotificationHandler while any capture is active.
export async function runPromptTurn(client, options = {}) {
  const { sessionId, prompt, onProgress } = options;
  if (!sessionId) {
    throw new Error("runPromptTurn requires a sessionId.");
  }
  const promptBlocks = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
  if (!Array.isArray(promptBlocks) || promptBlocks.length === 0) {
    throw new Error("runPromptTurn requires a non-empty prompt.");
  }

  const state = createTurnCapture(sessionId, { onProgress });
  installCapture(client, state);

  try {
    emitProgress(onProgress, `Turn started (session ${sessionId}).`, "starting");
    const response = await client.request("session/prompt", { sessionId, prompt: promptBlocks });
    emitProgress(
      onProgress,
      response.stopReason === "end_turn" ? "Turn completed." : `Turn stopped (${response.stopReason}).`,
      "finalizing"
    );
    return buildTurnResult(state, response);
  } finally {
    removeCapture(client, state);
  }
}
