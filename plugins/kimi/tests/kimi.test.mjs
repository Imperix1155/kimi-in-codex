// Deterministic turn-capture tests against the scripted fake agent.
// Run: node plugin/tests/kimi.test.mjs  (prints KIMI-TESTS-GREEN)
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../scripts/lib/acp-client.mjs";
import { kimiProfile } from "../scripts/lib/agent-profile.mjs";
import {
  applySessionUpdate,
  assertReadOnlyPermissionEvents,
  createTurnCapture,
  newSession,
  parseStructuredOutput,
  runPromptTurn
} from "../scripts/lib/kimi.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

function fakeProfile(scenario) {
  return {
    ...kimiProfile,
    id: "fake",
    displayName: "FakeAgent",
    spawn: { command: process.execPath, args: [FIXTURE, scenario] }
  };
}

function connectTo(scenario, options = {}) {
  return AcpClient.connect(process.cwd(), { profile: fakeProfile(scenario), ...options });
}

// 1. Full capture: messages, thoughts, tool calls (incl. merge + skeleton),
// plan, touched files, unknown kinds, progress events, handler chaining.
{
  const client = await connectTo("turn-capture");
  const otherSessionMessages = [];
  client.setNotificationHandler((message) => otherSessionMessages.push(message));
  const previousHandler = client.notificationHandler;

  const session = await newSession(client, process.cwd(), { permissionDecision: "reject" });
  assert.equal(session.sessionId, "sess-1");
  assert.equal(client.sessionPermissionDecisions.get("sess-1"), "reject");

  const progress = [];
  const result = await runPromptTurn(client, {
    sessionId: session.sessionId,
    prompt: "do the thing",
    onProgress: (event) => progress.push(typeof event === "string" ? event : event.message)
  });

  assert.equal(result.status, 0);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.agentMessage, "Hello, world.");
  assert.equal(result.reasoning, "thinking hard");

  assert.equal(result.toolCalls.length, 6);
  const byId = new Map(result.toolCalls.map((call) => [call.toolCallId, call]));
  assert.equal(byId.get("t1").status, "completed");
  assert.equal(byId.get("t2").status, "completed");
  assert.equal(byId.get("t2").locations.length, 2);
  assert.equal(byId.get("ghost").status, "failed");
  assert.equal(byId.get("t3").status, "failed");
  assert.equal(byId.get("t4").status, "completed");
  assert.equal(byId.get("t5").status, "completed");

  // Failed edit excluded; diff-only edits included — including the
  // kimi-realistic kind-"other" write whose only signal is the diff block.
  assert.deepEqual(result.touchedFiles, ["/tmp/x.mjs", "/tmp/y.mjs", "/tmp/z.mjs", "/tmp/w.mjs"]);
  assert.equal(result.plan.length, 2);
  assert.ok(result.plan.every((entry) => entry.status === "completed"));
  assert.deepEqual(result.unknownUpdateKinds, ["future_unknown_kind"]);

  assert.ok(progress.some((message) => message.includes("Tool started: Read config")));
  assert.ok(progress.some((message) => message.includes("Tool Edit files completed.")));
  assert.ok(progress.some((message) => message.includes("Plan: 2/2 steps completed.")));
  assert.ok(progress.some((message) => message.includes("Turn completed.")));

  // The other session's update went to the previous handler, not the capture.
  assert.equal(otherSessionMessages.length, 1);
  assert.equal(otherSessionMessages[0].params.sessionId, "sess-OTHER");
  assert.ok(!result.agentMessage.includes("leak"));

  // Our capture handler was removed again after the turn.
  assert.equal(client.notificationHandler, previousHandler);

  await client.close();
}

// 2. Non-end_turn stop reasons map to failure status.
{
  const client = await connectTo("refusal");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await runPromptTurn(client, { sessionId: "sess-1", prompt: "do something dubious" });
  assert.equal(result.status, 1);
  assert.equal(result.stopReason, "refusal");
  await client.close();
}

// 3. Input validation.
{
  const client = await connectTo("basic");
  await assert.rejects(() => runPromptTurn(client, { prompt: "x" }), /requires a sessionId/);
  await assert.rejects(() => runPromptTurn(client, { sessionId: "s", prompt: [] }), /non-empty prompt/);
  await client.close();
}

// 4. applySessionUpdate unit edges: wrong method, wrong session, malformed
// update object, throwing onProgress observer.
{
  const state = createTurnCapture("sess-1", {
    onProgress: () => {
      throw new Error("observer bug");
    }
  });
  assert.equal(applySessionUpdate(state, { method: "other/thing", params: { sessionId: "sess-1" } }), false);
  assert.equal(applySessionUpdate(state, { method: "session/update", params: { sessionId: "nope", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } }), false);
  assert.equal(applySessionUpdate(state, { method: "session/update", params: { sessionId: "sess-1", update: null } }), true);
  assert.equal(applySessionUpdate(state, { method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "tool_call", toolCallId: "t9", title: "X", kind: "execute" } } }), true);
  assert.equal(state.toolCalls.get("t9").kind, "execute");
  assert.equal(state.messageSegments.length, 0);
}

// 5. Overlapping turns on DIFFERENT sessions: non-LIFO teardown must not
// strip the still-active capture or lose its later chunks.
{
  const client = await connectTo("two-sessions");
  const base = [];
  client.setNotificationHandler((message) => base.push(message));
  const baseHandler = client.notificationHandler;

  const s1 = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const s2 = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  assert.equal(s1.sessionId, "sess-1");
  assert.equal(s2.sessionId, "sess-2");

  const turnA = runPromptTurn(client, { sessionId: "sess-1", prompt: "a" });

  // A second capture on the SAME session is refused loudly.
  await assert.rejects(() => runPromptTurn(client, { sessionId: "sess-1", prompt: "dup" }), /already active/);

  const turnB = runPromptTurn(client, { sessionId: "sess-2", prompt: "b" });
  const resultA = await turnA;
  const resultB = await turnB;

  assert.equal(resultA.agentMessage, "A1");
  // B2 arrived AFTER turn A finished — the old save/restore pattern lost it.
  assert.equal(resultB.agentMessage, "B1B2");
  assert.equal(client.notificationHandler, baseHandler);
  await client.close();
}

// 6. Distinct messageIds become segments: agentMessage joins them,
// lastAgentMessage is the final message only.
{
  const client = await connectTo("message-ids");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await runPromptTurn(client, { sessionId: "sess-1", prompt: "x" });
  assert.equal(result.agentMessage, "first part\n\nfinal answer");
  assert.equal(result.lastAgentMessage, "final answer");
  await client.close();
}

// 7. parseStructuredOutput: last fence beats earlier/stale JSON; non-object
// JSON never satisfies the contract; prose braces don't block a later fence.
{
  const stale = JSON.stringify({ verdict: "approve", summary: "stale example" });
  const real = JSON.stringify({ verdict: "needs-attention", summary: "the real one" });
  const twoFences = "Example first:\n```json\n" + stale + "\n```\nFinal answer:\n```json\n" + real + "\n```";
  assert.equal(parseStructuredOutput(twoFences).parsed.summary, "the real one");

  assert.equal(parseStructuredOutput("4").parsed, null);
  assert.equal(parseStructuredOutput("[1,2]").parsed, null);

  const proseBraces = "Note {weird} prose first.\n```json\n" + real + "\n```";
  assert.equal(parseStructuredOutput(proseBraces).parsed.summary, "the real one");

  assert.match(parseStructuredOutput("no json here").parseError, /not valid JSON/);
  assert.match(parseStructuredOutput("").parseError, /did not return/);
}

// 8. The review security guard: throws on any non-reject decision (missing
// decision fails closed too); passes on all-reject and on no events.
{
  assert.doesNotThrow(() => assertReadOnlyPermissionEvents([]));
  assert.doesNotThrow(() => assertReadOnlyPermissionEvents(undefined));
  assert.doesNotThrow(() => assertReadOnlyPermissionEvents([{ decision: "reject" }, { decision: "reject" }]));
  assert.throws(() => assertReadOnlyPermissionEvents([{ decision: "allow" }]), /SECURITY/);
  assert.throws(() => assertReadOnlyPermissionEvents([{ decision: "reject" }, { decision: "allow" }]), /SECURITY/);
  assert.throws(() => assertReadOnlyPermissionEvents([{}]), /SECURITY/);
  assert.throws(() => assertReadOnlyPermissionEvents([null]), /SECURITY/);
}

// 9. parseStructuredOutput: fallback fields can never overwrite the
// computed parse outcome (regression: a falsy fallback parseError laundered
// a failed parse into success).
{
  assert.match(parseStructuredOutput("not json", { parseError: "" }).parseError, /not valid JSON/);
  assert.match(parseStructuredOutput("", { failureMessage: "" }).parseError, /did not return/);
  assert.match(parseStructuredOutput("", { failureMessage: "   " }).parseError, /did not return/);
  const ok = parseStructuredOutput('{"a":1}', { parsed: "bogus", rawOutput: "bogus" });
  assert.deepEqual(ok.parsed, { a: 1 });
  assert.equal(ok.rawOutput, '{"a":1}');
  assert.equal(ok.parseError, null);
}

// 10. Tool/sub-agent output is captured and recoverable (2026-07-22 fix):
// ACP wraps tool results as {type:"content", content:{text}}; the engine must
// unwrap it into toolOutputs and set hasContent, even when the final message
// is thin. Also the empty-turn case: no message, no tools -> hasContent false.
{
  const client = await connectTo("task-tool-content");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await runPromptTurn(client, { sessionId: "sess-1", prompt: "audit" });
  assert.equal(result.agentMessage, "Audit dispatched.");
  assert.equal(result.toolOutputs.length, 1);
  assert.match(result.toolOutputs[0].text, /AUDIT-BODY: 3 findings/);
  assert.equal(result.toolOutputs[0].status, "completed");
  assert.equal(result.hasContent, true);
  await client.close();
}
{
  const client = await connectTo("task-empty");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await runPromptTurn(client, { sessionId: "sess-1", prompt: "x" });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.agentMessage, "");
  assert.equal(result.toolOutputs.length, 0);
  assert.equal(result.hasContent, false, "an empty end_turn must not report content");
  await client.close();
}

// 11. KMP-32: probeBrokerStatus is the CONFIRMATION half of cancellation, so
// every answer it gives is evidence someone will act on. Two contracts.
//
// (a) A missing broker record and an UNREADABLE one are different facts.
// loadBrokerSession returns null for both, and reporting `running: false` for
// the unreadable case would let a cancel claim a confirmed stop against a
// broker that may still be mid-turn.
//
// (b) Neither the connect nor the request was bounded, so a broker that
// accepts the socket and then stops answering hung the probe indefinitely —
// bypassing the caller's confirmation window, which cannot inspect its own
// deadline while a probe is pending.
{
  const fs = await import("node:fs");
  const net = await import("node:net");
  const os = await import("node:os");
  const path = await import("node:path");
  const { probeBrokerStatus } = await import("../scripts/lib/kimi.mjs");
  const { saveBrokerSession } = await import("../scripts/lib/broker-lifecycle.mjs");
  const { resolveStateDir } = await import("../scripts/lib/state.mjs");

  const previousData = process.env.KIMI_COMPANION_DATA;
  process.env.KIMI_COMPANION_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-probe-data-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-probe-"));

  // (a1) No record at all: nothing was ever started, so nothing can be running.
  const absent = await probeBrokerStatus(cwd);
  assert.equal(absent.running, false, "a missing broker record means no runtime is up");
  assert.equal(absent.reachable, false);

  // (a2) A record that exists but cannot be parsed establishes NOTHING.
  const brokerStateFile = path.join(resolveStateDir(cwd), "broker.json");
  fs.mkdirSync(path.dirname(brokerStateFile), { recursive: true });
  fs.writeFileSync(brokerStateFile, "{ this is not json", "utf8");
  const malformed = await probeBrokerStatus(cwd);
  assert.equal(
    malformed.running,
    true,
    "an unreadable broker record must never be reported as proof that no turn is in flight"
  );
  assert.equal(malformed.reachable, false);
  assert.match(malformed.detail, /unreadable/i);

  // (b) Two stalls, one per unbounded leg. `answerInitialize: false` wedges
  // the handshake; `true` lets the handshake through and then never answers
  // broker/status — the realistic shape, since the broker answers both
  // methods locally and a wedged event loop answers neither.
  async function probeAgainstDeafBroker({ answerInitialize }) {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-probe-sock-"));
    const socketPath = path.join(socketDir, "broker.sock");
    const connections = [];
    const deaf = net.createServer((socket) => {
      connections.push(socket);
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        if (!answerInitialize) {
          return;
        }
        for (const line of chunk.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.method === "initialize") {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "1.49.0" } }
              })}\n`
            );
          }
          // Every other method — broker/status included — goes unanswered.
        }
      });
    });
    await new Promise((resolve) => deaf.listen(socketPath, resolve));
    saveBrokerSession(cwd, { endpoint: `unix:${socketPath}` });

    const startedAt = Date.now();
    const outcome = await probeBrokerStatus(cwd, { timeoutMs: 700 });
    const elapsed = Date.now() - startedAt;

    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise((resolve) => deaf.close(resolve));
    fs.rmSync(socketDir, { recursive: true, force: true });
    return { outcome, elapsed };
  }

  for (const answerInitialize of [false, true]) {
    const { outcome, elapsed } = await probeAgainstDeafBroker({ answerInitialize });
    const leg = answerInitialize ? "broker/status" : "handshake";
    assert.ok(elapsed < 5000, `a stalled ${leg} must return on the probe's own budget, took ${elapsed}ms`);
    assert.equal(outcome.reachable, false, `${leg}: a probe that never answered reached nothing`);
    assert.equal(outcome.running, true, `${leg}: an unanswered probe can never count as confirmation`);
    assert.deepEqual(outcome.activeSessions, []);
  }

  if (previousData === undefined) {
    delete process.env.KIMI_COMPANION_DATA;
  } else {
    process.env.KIMI_COMPANION_DATA = previousData;
  }
}

console.log("KIMI-TESTS-GREEN");
