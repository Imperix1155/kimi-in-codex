// Scripted stand-in for a real ACP agent process, driven by a scenario name
// in argv[2]. Speaks just enough JSONL ACP for tests/acp-client.test.mjs;
// echoes what it observed back inside the session/prompt result so tests can
// assert on the client's answers.
import process from "node:process";
import readline from "node:readline";

const scenario = process.argv[2] ?? "basic";
const rl = readline.createInterface({ input: process.stdin });
let nextAgentRequestId = 1000;
let sessionCount = 0;
let promptCount = 0;
let heldPromptId = null;
const waiters = new Map();
const observed = {};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function agentRequest(method, params, onResponse) {
  const id = nextAgentRequestId;
  nextAgentRequestId += 1;
  waiters.set(id, onResponse);
  send({ id, method, params });
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);

  // Response to one of our agent->client requests.
  if (message.id !== undefined && message.method === undefined) {
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
    return;
  }

  // Client->agent notification: session/cancel resolves a held turn. A
  // cancel arriving BEFORE the prompt is remembered and applied to the next
  // prompt immediately (mirrors real agents: no interleaving hangs forever).
  if (message.id === undefined && message.method === "session/cancel") {
    if (scenario === "cancellable") {
      if (heldPromptId !== null) {
        const promptId = heldPromptId;
        heldPromptId = null;
        send({ id: promptId, result: { stopReason: "cancelled" } });
      } else {
        observed.pendingCancel = true;
      }
    }
    return;
  }

  if (message.method === "initialize") {
    if (scenario === "init-error") {
      send({ id: message.id, error: { code: -32602, message: "unsupported protocol version" } });
      return;
    }
    if (scenario === "hang-init") {
      // Never answer: exercises the broker-startup-timeout teardown path.
      return;
    }
    if (scenario === "foreign-agent") {
      // KMP-23: an ACP-speaking broker/agent that is NOT Kimi (the codex
      // app-server also answers initialize). Identity validation must
      // refuse it before any session/* request dies downstream.
      send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "Codex App Server", version: "0.0.0" } } });
      return;
    }
    // Mirrors live kimi 1.49.0: identity validation (KMP-23) requires the
    // agentInfo block on every healthy handshake.
    send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "0.0.0-fake" } } });
    return;
  }

  if (message.method === "session/load") {
    observed.wasLoaded = true;
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "session/set_model") {
    observed.modelId = message.params?.modelId ?? null;
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "session/new") {
    if (scenario === "auth-error") {
      send({ id: message.id, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    if (scenario === "null-line") {
      // Valid JSON, invalid envelope — must not crash the client host.
      process.stdout.write("null\n");
      return;
    }
    if (scenario === "hang-session") {
      // initialize answered normally, session/new never answered.
      return;
    }
    if (scenario === "two-sessions") {
      sessionCount += 1;
      send({ id: message.id, result: { sessionId: `sess-${sessionCount}` } });
      return;
    }
    send({ id: message.id, result: { sessionId: "sess-1" } });
    return;
  }

  if (message.method === "session/prompt") {
    if (scenario === "permission-standard" || scenario === "permission-no-reject-kind") {
      const options = scenario === "permission-standard"
        ? [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }]
        : [{ optionId: "ok", kind: "allow_once" }];
      agentRequest("session/request_permission", { sessionId: message.params.sessionId ?? "sess-1", options }, (response) => {
        observed.permissionResponse = response;
        const outcome = response.result?.outcome?.optionId ?? response.result?.outcome?.outcome ?? "unknown";
        send({ method: "session/update", params: { sessionId: message.params.sessionId ?? "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done perm:${outcome}` } } } });
        send({ id: message.id, result: { stopReason: "end_turn", observed } });
      });
      return;
    }

    // A turn whose real deliverable lives in an "Agent" sub-agent tool call
    // (ACP wraps it as {type:"content", content:{text}}), with only a thin
    // final message. Reproduces the live 2026-07-22 output-loss bug.
    if (scenario === "reject-then-silent") {
      // KMP-27: first prompt — attempt a tool, get rejected, end the turn
      // with NO message (the live silent-abort shape). Second prompt (the
      // companion's continuation) — deliver the answer, echoing the
      // continuation text so tests can pin what was sent.
      promptCount += 1;
      const sid = message.params.sessionId ?? "sess-1";
      if (promptCount === 1) {
        agentRequest("session/request_permission", { sessionId: sid, options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] }, () => {
          send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "sh1", title: "Shell: probe", kind: "execute", status: "in_progress" } } });
          send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "sh1", status: "failed", content: [{ type: "content", content: { type: "text", text: "The tool call is rejected by the user." } }] } } });
          send({ id: message.id, result: { stopReason: "end_turn" } });
        });
        return;
      }
      const continuationText = (message.params.prompt ?? []).map((block) => block?.text ?? "").join("");
      send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `CONTINUED-ANSWER (got: ${continuationText})` } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "prompt-echo") {
      // Echoes the exact prompt text received, so tests can assert what the
      // companion actually sent (KMP-24 read-only preamble presence/absence).
      const promptText = (message.params.prompt ?? []).map((block) => block?.text ?? "").join("");
      send({ method: "session/update", params: { sessionId: message.params.sessionId ?? "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `PROMPT-ECHO:${promptText}` } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "task-tool-content") {
      const sid = message.params.sessionId ?? "sess-1";
      const upd = (u) => send({ method: "session/update", params: { sessionId: sid, update: u } });
      upd({ sessionUpdate: "tool_call", toolCallId: "a1", title: "Agent: Audit src/", kind: "other", status: "in_progress" });
      upd({ sessionUpdate: "tool_call_update", toolCallId: "a1", status: "completed", content: [{ type: "content", content: { type: "text", text: "AUDIT-BODY: 3 findings in src/, line-level detail here." } }] });
      upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Audit dispatched." } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    // Tool output only, no final message at all.
    if (scenario === "task-tool-only") {
      const sid = message.params.sessionId ?? "sess-1";
      send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "b1", title: "Agent: Report", kind: "other", status: "in_progress" } } });
      send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed", content: [{ type: "content", content: { text: "TOOL-ONLY-DELIVERABLE" } }] } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    // Clean end_turn that produced nothing usable — no message, no tools.
    if (scenario === "task-empty") {
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "unknown-request") {
      agentRequest("custom/not-a-real-method", {}, (response) => {
        observed.unknownResponse = response;
        send({ id: message.id, result: { stopReason: "end_turn", observed } });
      });
      return;
    }

    if (scenario === "crash-mid-turn") {
      process.exit(3);
    }

    if (scenario === "refusal") {
      send({ id: message.id, result: { stopReason: "refusal" } });
      return;
    }

    if (scenario === "slow-prompt" || scenario === "slow-prompt-3s") {
      const delay = scenario === "slow-prompt-3s" ? 3000 : 500;
      setTimeout(() => {
        send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "slow done" } } } });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      }, delay);
      return;
    }

    if (scenario === "resume-check") {
      const text = observed.wasLoaded ? "resumed-session" : "fresh-session";
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "model-check") {
      const text = `model:${observed.modelId ?? "default"}`;
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-json") {
      // KMP-24: the review path must never receive the generic task
      // preamble — fail the review loudly if it leaks (wire-level pin).
      const reviewPromptText = (message.params.prompt ?? []).map((block) => block?.text ?? "").join("");
      if (reviewPromptText.includes("READ-ONLY task")) {
        send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "generic task preamble leaked into the review prompt" } } } });
        send({ id: message.id, result: { stopReason: "end_turn" } });
        return;
      }
      const review = {
        verdict: "needs-attention",
        summary: "Ship blocker: planted divide-by-zero found.",
        findings: [{
          severity: "high",
          title: "Planted divide-by-zero",
          body: "compute() divides by a divisor that can be zero.",
          file: "src/buggy.mjs",
          line_start: 2,
          line_end: 3,
          confidence: 0.9,
          recommendation: "Guard the divisor before dividing."
        }],
        next_steps: ["Add a zero-divisor guard."]
      };
      // Fenced on purpose: exercises tolerant JSON extraction.
      const text = "Here is my review:\n```json\n" + JSON.stringify(review, null, 2) + "\n```";
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "stop-gate-allow" || scenario === "stop-gate-block") {
      // Self-checking: the prompt must have survived stdin intact WITH the
      // inlined repo-state boundary. A mangled or context-less prompt turns
      // an expected ALLOW into a BLOCK the tests will catch.
      const promptText = (message.params.prompt ?? []).map((block) => block?.text ?? "").join("");
      const hasContext = promptText.includes("BEGIN-REPO-STATE-") && promptText.includes("END-REPO-STATE-");
      // KMP-24/26: the stop-gate must NOT get the generic task preamble (its
      // "say so in your final answer" clause conflicts with the first-line
      // ALLOW/BLOCK contract); its own template carries gate-consistent
      // rejection wording instead. Both asserted on the wire prompt.
      const genericPreambleLeaked = promptText.includes("READ-ONLY task");
      const hasGateRejectionRules = promptText.includes("A rejection never changes your job");
      const text = !hasContext
        ? "BLOCK: prompt arrived without the inlined repository state."
        : genericPreambleLeaked
          ? "BLOCK: generic task preamble leaked into the stop-gate prompt."
          : !hasGateRejectionRules
            ? "BLOCK: stop-gate template lost its rejection-policy wording."
            : scenario === "stop-gate-allow"
              ? "ALLOW: previous turn made no code changes."
              : "BLOCK: the planted bug from the previous turn is still unfixed.";
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-empty") {
      // Turn ends with NO message at all — must be a failed review, not a
      // silent success (live-caught: empty stderr laundered the parse error).
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-bad-json") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I could not produce structured output, sorry." } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "review-write-attempt") {
      // Mid-review write attempt: the client's answer decides the review's
      // reported summary, so tests can assert the reject FIRED end to end.
      const options = [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
      agentRequest(
        "session/request_permission",
        { sessionId: message.params.sessionId, toolCall: { toolCallId: "w1", title: "Write review-notes.txt", kind: "edit" }, options },
        (response) => {
          observed.permissionResponse = response;
          const outcome = response.result?.outcome?.optionId ?? response.result?.outcome?.outcome ?? "unknown";
          const review = {
            verdict: "needs-attention",
            summary: `perm-outcome:${outcome}`,
            findings: [],
            next_steps: ["Investigate the write attempt."]
          };
          send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(review) } } } });
          send({ id: message.id, result: { stopReason: "end_turn", observed } });
        }
      );
      return;
    }

    if (scenario === "review-invalid-schema") {
      // Valid JSON, invalid shape: verdict outside the schema enum.
      const bogus = { verdict: "ship-it", summary: "Looks fine to me.", findings: [], next_steps: [] };
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(bogus) } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "counter") {
      promptCount += 1;
      send({ id: message.id, result: { stopReason: "end_turn", promptCount, agentPid: process.pid } });
      return;
    }

    if (scenario === "cancellable") {
      if (observed.pendingCancel) {
        observed.pendingCancel = false;
        send({ id: message.id, result: { stopReason: "cancelled" } });
        return;
      }
      heldPromptId = message.id;
      return;
    }

    if (scenario === "two-sessions") {
      // Turn A (sess-1) is held open; turn B (sess-2) arriving ends A first,
      // then keeps streaming — exercising non-LIFO capture teardown.
      const chunk = (sessionId, text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      if (message.params.sessionId === "sess-1") {
        chunk("sess-1", "A1");
        heldPromptId = message.id;
        return;
      }
      chunk("sess-2", "B1");
      send({ id: heldPromptId, result: { stopReason: "end_turn" } });
      chunk("sess-2", "B2");
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "message-ids") {
      const chunk = (messageId, text) => send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } } });
      chunk("m1", "first ");
      chunk("m1", "part");
      chunk("m2", "final answer");
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (scenario === "turn-capture") {
      const update = (u) => send({ method: "session/update", params: { sessionId: "sess-1", update: u } });
      update({ sessionUpdate: "plan", entries: [
        { content: "read the config", status: "in_progress", priority: "high" },
        { content: "edit the files", status: "pending", priority: "medium" }
      ] });
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read config", kind: "read", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
      update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit files", kind: "edit", status: "pending", locations: [{ path: "/tmp/x.mjs" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", locations: [{ path: "/tmp/x.mjs" }, { path: "/tmp/y.mjs" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "failed" });
      // Failed edit: its locations must NOT count as touched files.
      update({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Rejected edit", kind: "edit", status: "in_progress", locations: [{ path: "/tmp/rejected.mjs" }] });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "failed" });
      // Completed edit reporting only diff content, no locations.
      update({ sessionUpdate: "tool_call", toolCallId: "t4", title: "Diff-only edit", kind: "edit", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t4", status: "completed", content: [{ type: "diff", path: "/tmp/z.mjs", oldText: "a", newText: "b" }] });
      // Kimi-realistic: kind "other" + diff block is the only write signal.
      update({ sessionUpdate: "tool_call", toolCallId: "t5", title: "WriteFile: /tmp/w.mjs", kind: "other", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "t5", status: "completed", content: [{ type: "diff", path: "/tmp/w.mjs", oldText: "", newText: "x" }] });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking hard" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello, " } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world." } });
      update({ sessionUpdate: "plan", entries: [
        { content: "read the config", status: "completed", priority: "high" },
        { content: "edit the files", status: "completed", priority: "medium" }
      ] });
      update({ sessionUpdate: "future_unknown_kind", payload: 1 });
      update({ sessionUpdate: "available_commands_update", availableCommands: [] });
      // Different session: must be routed to the previous handler, not captured.
      send({ method: "session/update", params: { sessionId: "sess-OTHER", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "leak" } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
      return;
    }

    send({ method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }

  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
