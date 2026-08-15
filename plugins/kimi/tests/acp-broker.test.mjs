// Broker tests: a real detached acp-broker.mjs process serving the scripted
// fake agent. Run: node plugin/tests/acp-broker.test.mjs  (prints ACP-BROKER-TESTS-GREEN)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpClient, BROKER_BUSY_RPC_CODE } from "../scripts/lib/acp-client.mjs";
import {
  clearBrokerSessionIfEndpoint,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  waitForBrokerEndpoint
} from "../scripts/lib/broker-lifecycle.mjs";
import { newSession, runPromptTurn } from "../scripts/lib/kimi.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

// The whole suite dies loudly rather than hanging a CI-less gate.
const deadman = setTimeout(() => {
  console.error("BROKER-TESTS TIMEOUT after 60s");
  process.exit(2);
}, 60_000);
deadman.unref?.();

function agentSpawnArgs(scenario) {
  return ["--agent-spawn", JSON.stringify({ command: process.execPath, args: [FIXTURE, scenario] })];
}

// Shutdown is acked before the listener finishes closing; poll until the
// endpoint actually stops accepting connections.
async function waitForEndpointDeath(endpoint, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const alive = await waitForBrokerEndpoint(endpoint, 100);
    if (!alive) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Each scenario gets its own workspace dir (broker state is per-cwd) and a
// broker that is always shut down, pass or fail.
async function withBroker(scenario, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs(scenario) });
  assert.ok(session?.endpoint, `broker failed to start for scenario ${scenario}`);
  try {
    await fn(session, cwd);
  } finally {
    await sendBrokerShutdown(session.endpoint).catch(() => {});
  }
}

// 1. Full path through the broker: handshake answered locally with the real
// agent's info, session/new + captured prompt turn, notifications relayed.
await withBroker("basic", async (session, cwd) => {
  const client = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  assert.equal(client.transport, "broker");
  assert.equal(client.agentInfo.protocolVersion, 1);
  const s = await newSession(client, cwd);
  const result = await runPromptTurn(client, { sessionId: s.sessionId, prompt: "ping" });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.agentMessage, "pong");
  await client.close();
});

// 2. Busy signaling: while one socket's turn is in flight, another socket's
// request gets BROKER_BUSY_RPC_CODE; after the turn it succeeds.
await withBroker("slow-prompt", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });

  const turn = clientA.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] });
  await new Promise((resolve) => setTimeout(resolve, 100));

  let busy = null;
  try {
    await clientB.request("session/new", { cwd, mcpServers: [] });
  } catch (error) {
    busy = error;
  }
  assert.ok(busy, "expected a busy error while the turn was in flight");
  assert.equal(busy.code, BROKER_BUSY_RPC_CODE);

  const result = await turn;
  assert.equal(result.stopReason, "end_turn");

  const after = await clientB.request("session/new", { cwd, mcpServers: [] });
  assert.ok(after.sessionId);
  await clientA.close();
  await clientB.close();
});

// 3. One shared agent process across separate client connections: the
// counter (and pid) persist after the first client disconnects.
await withBroker("counter", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });
  const first = await clientA.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] });
  assert.equal(first.promptCount, 1);
  await clientA.close();

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const second = await clientB.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] });
  assert.equal(second.promptCount, 2);
  assert.equal(second.agentPid, first.agentPid);
  await clientB.close();
});

// 4. Permission policy lives broker-side: allow via broker/session_policy is
// honored, the permission event is relayed to the active client, and an
// unset session falls back to fail-safe reject.
await withBroker("permission-standard", async (session, cwd) => {
  const events = [];
  const client = await AcpClient.connect(cwd, {
    brokerEndpoint: session.endpoint,
    onPermissionRequest: (event) => events.push(event)
  });
  const s = await newSession(client, cwd, { permissionDecision: "allow" });
  const result = await client.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "x" }] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "ok");
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "allow");
  await client.close();
});
await withBroker("permission-standard", async (session, cwd) => {
  const client = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const s = await newSession(client, cwd);
  const result = await client.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "x" }] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "no");
  await client.close();
});

// 5. Cross-socket cancel: a second connection's session/cancel notification
// reaches the agent while the broker is busy, resolving the held turn.
await withBroker("cancellable", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });
  const turn = runPromptTurn(clientA, { sessionId: "sess-1", prompt: "long task" });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  clientB.notify("session/cancel", { sessionId: "sess-1" });

  const result = await turn;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.status, 1);
  await clientA.close();
  await clientB.close();
});

// 6. Lifecycle: state file recorded; shutdown kills the endpoint; a second
// ensureBrokerSession then respawns a fresh broker.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") });
  assert.ok(session?.endpoint);
  assert.equal(loadBrokerSession(cwd)?.endpoint, session.endpoint);

  await sendBrokerShutdown(session.endpoint);
  assert.equal(await waitForEndpointDeath(session.endpoint), true);

  const respawned = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") });
  assert.ok(respawned?.endpoint);
  assert.notEqual(respawned.endpoint, session.endpoint);
  const client = await AcpClient.connect(cwd, { reuseExistingBroker: true });
  assert.equal(client.transport, "broker");
  await client.close();
  await sendBrokerShutdown(respawned.endpoint).catch(() => {});
}

// 7. Session-policy hijack refused: a second live socket cannot change a
// session it does not own, and the owner's reject stance still holds.
await withBroker("permission-standard", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const s = await newSession(clientA, cwd, { permissionDecision: "reject" });

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  let refused = null;
  try {
    await clientB.setSessionPermissionDecision(s.sessionId, "allow");
  } catch (error) {
    refused = error;
  }
  assert.ok(refused, "expected the hijack attempt to be refused");
  assert.match(refused.message, /another active client/);

  const result = await clientA.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "x" }] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "no");
  await clientA.close();
  await clientB.close();
});

// 8. Active socket dies mid-turn: the broker stays busy until the agent
// finishes (no ownership corruption, no leak to the next socket), then
// serves other clients normally.
await withBroker("slow-prompt", async (session, cwd) => {
  const clientA = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  await clientA.request("session/new", { cwd, mcpServers: [] });
  clientA.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "x" }] }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  clientA.socket.destroy();

  const clientB = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  let busy = null;
  try {
    await clientB.request("session/new", { cwd, mcpServers: [] });
  } catch (error) {
    busy = error;
  }
  assert.ok(busy, "expected busy while the dead client's turn still runs");
  assert.equal(busy.code, BROKER_BUSY_RPC_CODE);

  // After the abandoned turn completes, ownership released cleanly.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = await clientB.request("session/new", { cwd, mcpServers: [] });
  assert.ok(after.sessionId);
  await clientB.close();
});

// 9. Pipelined lines across interleaved chunks are parsed exactly once each
// (regression for the async-data-handler buffer corruption).
await withBroker("basic", async (session) => {
  const net = await import("node:net");
  const { parseBrokerEndpoint } = await import("../scripts/lib/broker-endpoint.mjs");
  const target = parseBrokerEndpoint(session.endpoint);
  const raw = net.createConnection({ path: target.path });
  raw.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    raw.on("connect", resolve);
    raw.on("error", reject);
  });

  const replies = [];
  let buf = "";
  raw.on("data", (chunk) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      replies.push(JSON.parse(buf.slice(0, idx)));
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
    }
  });

  // Two requests in one chunk, a third immediately after while the first is
  // still being proxied.
  raw.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/", mcpServers: [] } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/", mcpServers: [] } })}\n`);
  raw.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} })}\n`);

  const start = Date.now();
  while (replies.length < 3 && Date.now() - start < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(replies.length, 3);
  assert.deepEqual(new Set(replies.map((reply) => reply.id)), new Set([1, 2, 3]));
  assert.ok(replies.every((reply) => reply.result && !reply.error));
  raw.end();
});

// 10. Malformed request shapes get -32600 and do NOT occupy the broker.
await withBroker("basic", async (session, cwd) => {
  const net = await import("node:net");
  const { parseBrokerEndpoint } = await import("../scripts/lib/broker-endpoint.mjs");
  const target = parseBrokerEndpoint(session.endpoint);
  const raw = net.createConnection({ path: target.path });
  raw.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    raw.on("connect", resolve);
    raw.on("error", reject);
  });
  const reply = await new Promise((resolve) => {
    raw.once("data", (chunk) => resolve(JSON.parse(chunk.split("\n")[0])));
    raw.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9 })}\n`);
  });
  assert.equal(reply.error.code, -32600);
  raw.end();

  const client = await AcpClient.connect(cwd, { brokerEndpoint: session.endpoint });
  const s = await client.request("session/new", { cwd, mcpServers: [] });
  assert.ok(s.sessionId, "broker must not be stuck busy after a malformed request");
  await client.close();
});

// 11. Shutdown clears the state record, and reuseExistingBroker refuses a
// stale endpoint (falls back to a direct spawn) instead of failing.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") });
  assert.ok(session?.endpoint);
  await sendBrokerShutdown(session.endpoint);
  assert.equal(await waitForEndpointDeath(session.endpoint), true);
  assert.equal(loadBrokerSession(cwd), null, "broker shutdown must clear its own state record");

  // Plant a stale record pointing at the dead endpoint: connect must probe,
  // refuse it, and fall back to a direct fake-agent spawn.
  const { saveBrokerSession } = await import("../scripts/lib/broker-lifecycle.mjs");
  saveBrokerSession(cwd, session);
  const { kimiProfile } = await import("../scripts/lib/agent-profile.mjs");
  const client = await AcpClient.connect(cwd, {
    reuseExistingBroker: true,
    profile: { ...kimiProfile, id: "fake", displayName: "FakeAgent", spawn: { command: process.execPath, args: [FIXTURE, "basic"] } }
  });
  assert.equal(client.transport, "direct");
  await client.close();
}

// 12. Startup-timeout teardown kills the detached broker AND its hung agent.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const session = await ensureBrokerSession(cwd, {
    extraBrokerArgs: agentSpawnArgs("hang-init"),
    timeoutMs: 700
  });
  assert.equal(session, null, "a broker whose agent hangs at initialize must not be reported ready");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { execSync } = await import("node:child_process");
  let leftover = "";
  try {
    leftover = execSync("pgrep -f hang-init || true", { encoding: "utf8" }).trim();
  } catch {}
  assert.equal(leftover, "", `hung broker/agent processes leaked: ${leftover}`);
}

// 13. Concurrent ensureBrokerSession: exactly one broker survives in state
// and is usable; the loser is torn down.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const [a, b] = await Promise.all([
    ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") }),
    ensureBrokerSession(cwd, { extraBrokerArgs: agentSpawnArgs("basic") })
  ]);
  const recorded = loadBrokerSession(cwd);
  assert.ok(recorded?.endpoint, "one broker must be recorded");
  const survivors = [a, b].filter((s) => s?.endpoint);
  assert.ok(survivors.some((s) => s.endpoint === recorded.endpoint), "a returned session must match the recorded one");
  const client = await AcpClient.connect(cwd, { brokerEndpoint: recorded.endpoint });
  const s = await client.request("session/new", { cwd, mcpServers: [] });
  assert.ok(s.sessionId);
  await client.close();
  // The non-recorded endpoint (if any distinct one was returned) must be dead.
  for (const candidate of survivors) {
    if (candidate.endpoint !== recorded.endpoint) {
      assert.equal(await waitForEndpointDeath(candidate.endpoint), true, "losing broker must be torn down");
    }
  }
  await sendBrokerShutdown(recorded.endpoint).catch(() => {});
}

// KMP-23a. Foreign-broker heal: a recorded broker serving a NON-Kimi agent
// (the codex-collision shape) must be refused on identity, the pointer
// discarded, and the connect must succeed via a fresh broker — while the
// foreign broker (not ours) stays alive.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-data-"));
  const savedEnv = { data: process.env.KIMI_COMPANION_DATA, spawn: process.env.KIMI_COMPANION_AGENT_SPAWN };
  process.env.KIMI_COMPANION_DATA = dataDir;
  // The foreign broker is simulated as the real incident shape: a live
  // socket that answers initialize with a NON-Kimi identity (our own broker
  // now refuses to even start against a foreign agent, so it cannot play
  // this role). Inline line-JSON server, like the codex app-server.
  const net = await import("node:net");
  const foreignSock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kmc-frn-")), "foreign.sock");
  const foreignServer = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          const result = message.method === "initialize"
            ? { result: { protocolVersion: 1, agentInfo: { name: "Codex App Server", version: "0.0.0" } } }
            : { error: { code: -32601, message: "unknown variant" } };
          socket.write(`${JSON.stringify({ id: message.id, ...result })}\n`);
        } catch {}
      }
    });
  });
  await new Promise((resolve) => foreignServer.listen(foreignSock, resolve));
  const foreignEndpoint = `unix:${foreignSock}`;
  try {
    saveBrokerSession(cwd, { endpoint: foreignEndpoint, pid: null });

    process.env.KIMI_COMPANION_AGENT_SPAWN = JSON.stringify({ command: process.execPath, args: [FIXTURE, "basic"] });
    const client = await AcpClient.connect(cwd, { useBroker: true, connectTimeoutMs: 10_000 });
    assert.equal(client.agentInfo?.agentInfo?.name, "Kimi Code CLI", "healed connect must reach a Kimi-identified agent");
    const healed = loadBrokerSession(cwd);
    assert.ok(healed?.endpoint, "a fresh broker must be recorded after the heal");
    assert.notEqual(healed.endpoint, foreignEndpoint, "broker.json must point away from the foreign broker");
    assert.equal(foreignServer.listening, true, "the foreign broker must NOT be killed — it is not ours");
    const s = await client.request("session/new", { cwd, mcpServers: [] });
    assert.ok(s.sessionId, "healed broker must serve sessions");
    await client.close();
  } finally {
    // Teardown OUTSIDE the assertions: a failing assert must not leak the
    // broker into later suites' sweeps (advisor 2026-07-30 — observed live
    // as a cross-suite flake). Endpoint shutdown, then pid fallback.
    foreignServer.close();
    const recorded = loadBrokerSession(cwd);
    if (recorded?.endpoint && recorded.endpoint !== foreignEndpoint) {
      await sendBrokerShutdown(recorded.endpoint).catch(() => {});
    }
    if (Number.isFinite(recorded?.pid)) {
      try { process.kill(recorded.pid, "SIGKILL"); } catch {}
    }
    process.env.KIMI_COMPANION_DATA = savedEnv.data;
    if (savedEnv.data === undefined) delete process.env.KIMI_COMPANION_DATA;
    process.env.KIMI_COMPANION_AGENT_SPAWN = savedEnv.spawn;
    if (savedEnv.spawn === undefined) delete process.env.KIMI_COMPANION_AGENT_SPAWN;
  }
}

// KMP-23b. Freshly-SPAWNED foreign agent (bad spawn override / PATH): must
// fail loudly naming the cause — no heal loop, no broker left behind.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-data-"));
  const savedData = process.env.KIMI_COMPANION_DATA;
  process.env.KIMI_COMPANION_DATA = dataDir;
  try {
    // The broker's own internal client now validates identity too, so a
    // foreign spawn dies at broker startup (generic start failure, reason in
    // the broker log) — or, if it survives to the handshake, with the
    // explicit foreign message. Either way: loud, and no pointer left.
    await assert.rejects(
      () => AcpClient.connect(cwd, {
        useBroker: true,
        connectTimeoutMs: 10_000,
        brokerOptions: { extraBrokerArgs: agentSpawnArgs("foreign-agent") }
      }),
      (error) => /foreign broker state|agent command itself is wrong|identifies as|Failed to start the shared agent broker/.test(String(error?.message)),
      "fresh foreign spawn must fail loudly"
    );
    assert.equal(loadBrokerSession(cwd), null, "no broker pointer may survive a fresh-foreign failure");
  } finally {
    process.env.KIMI_COMPANION_DATA = savedData;
    if (savedData === undefined) delete process.env.KIMI_COMPANION_DATA;
  }
}

// KMP-23c. State namespacing + env precedence: KIMI_COMPANION_DATA outranks
// CLAUDE_PLUGIN_DATA, and both roots gain the /kimi/state/ namespace so our
// files can never collide with another plugin's <data>/state/<slug>.
{
  const { resolveStateDir } = await import("../scripts/lib/state.mjs");
  const saved = { kimi: process.env.KIMI_COMPANION_DATA, claude: process.env.CLAUDE_PLUGIN_DATA };
  try {
    process.env.KIMI_COMPANION_DATA = "/tmp/kmc-ours";
    process.env.CLAUDE_PLUGIN_DATA = "/tmp/kmc-theirs";
    const preferred = resolveStateDir(process.cwd());
    assert.ok(preferred.startsWith(path.join("/tmp/kmc-ours", "kimi", "state")), `KIMI_COMPANION_DATA must win and be namespaced, got ${preferred}`);
    delete process.env.KIMI_COMPANION_DATA;
    const fallback = resolveStateDir(process.cwd());
    assert.ok(fallback.startsWith(path.join("/tmp/kmc-theirs", "kimi", "state")), `CLAUDE_PLUGIN_DATA fallback must be namespaced, got ${fallback}`);
  } finally {
    for (const [key, value] of [["KIMI_COMPANION_DATA", saved.kimi], ["CLAUDE_PLUGIN_DATA", saved.claude]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// KMP-23d. Compare-and-delete: a healer holding a STALE foreign endpoint
// must not clobber a newer healthy pointer published by a concurrent healer.
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-data-"));
  const savedData = process.env.KIMI_COMPANION_DATA;
  process.env.KIMI_COMPANION_DATA = dataDir;
  try {
    saveBrokerSession(cwd, { endpoint: "unix:/tmp/kmc-new-healthy.sock", pid: null });
    assert.equal(clearBrokerSessionIfEndpoint(cwd, "unix:/tmp/kmc-old-foreign.sock"), "superseded", "stale-endpoint clear must refuse");
    assert.equal(loadBrokerSession(cwd)?.endpoint, "unix:/tmp/kmc-new-healthy.sock", "the newer pointer must survive");
    assert.equal(clearBrokerSessionIfEndpoint(cwd, "unix:/tmp/kmc-new-healthy.sock"), "cleared", "matching-endpoint clear must proceed");
    assert.equal(loadBrokerSession(cwd), null, "matching clear must remove the pointer");
    assert.equal(clearBrokerSessionIfEndpoint(cwd, "unix:/tmp/kmc-anything.sock"), "cleared", "already-gone counts as cleared");
  } finally {
    process.env.KIMI_COMPANION_DATA = savedData;
    if (savedData === undefined) delete process.env.KIMI_COMPANION_DATA;
  }
}

// KMP-23e. Legacy-state migration: state at the OLD <data>/state/<slug> path
// moves into the namespaced dir — but ONLY from a data dir whose basename
// identifies as ours (kimi-*), preserving the review-gate flag and
// rewriting job file paths. A foreign-named dir must never be adopted.
{
  const { resolveStateDir } = await import("../scripts/lib/state.mjs");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-test-"));
  const saved = { kimi: process.env.KIMI_COMPANION_DATA, claude: process.env.CLAUDE_PLUGIN_DATA };
  try {
    // Derive the workspace slug with a throwaway data dir (no legacy there).
    const throwaway = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-data-"));
    process.env.KIMI_COMPANION_DATA = throwaway;
    delete process.env.CLAUDE_PLUGIN_DATA;
    const slugDirName = path.basename(resolveStateDir(cwd));

    // Trusted kimi-* data dir with legacy state: must migrate.
    const trustedParent = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-mig-"));
    const trustedData = path.join(trustedParent, "kimi-testdata");
    const legacyDir = path.join(trustedData, "state", slugDirName);
    fs.mkdirSync(path.join(legacyDir, "jobs"), { recursive: true });
    const legacyLog = path.join(legacyDir, "jobs", "job-1.log");
    fs.writeFileSync(legacyLog, "old log\n");
    fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify({
      version: 1,
      config: { stopReviewGate: true },
      jobs: [{ id: "job-1", logFile: legacyLog, updatedAt: "2026-01-01T00:00:00Z" }]
    }));
    process.env.KIMI_COMPANION_DATA = trustedData;
    const migratedDir = resolveStateDir(cwd);
    assert.ok(migratedDir.includes(path.join("kimi", "state")), "migrated dir must be namespaced");
    const migratedState = JSON.parse(fs.readFileSync(path.join(migratedDir, "state.json"), "utf8"));
    assert.equal(migratedState.config.stopReviewGate, true, "the enabled review gate must survive the upgrade");
    assert.equal(migratedState.jobs[0].logFile, path.join(migratedDir, "jobs", "job-1.log"), "job logFile must be rewritten to the new path");
    assert.ok(fs.existsSync(migratedState.jobs[0].logFile), "the log file itself must have moved");
    assert.equal(fs.existsSync(legacyDir), false, "legacy dir must be gone after migration");

    // Foreign-named data dir with legacy state: must NOT be adopted.
    const foreignParent = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-mig-"));
    const foreignData = path.join(foreignParent, "codex-testdata");
    const foreignLegacy = path.join(foreignData, "state", slugDirName);
    fs.mkdirSync(foreignLegacy, { recursive: true });
    fs.writeFileSync(path.join(foreignLegacy, "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] }));
    process.env.KIMI_COMPANION_DATA = foreignData;
    const foreignResolved = resolveStateDir(cwd);
    assert.equal(fs.existsSync(path.join(foreignResolved, "state.json")), false, "foreign-named data dir must never be adopted");
    assert.equal(fs.existsSync(foreignLegacy), true, "foreign legacy state must be left untouched");
  } finally {
    for (const [key, value] of [["KIMI_COMPANION_DATA", saved.kimi], ["CLAUDE_PLUGIN_DATA", saved.claude]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

console.log("ACP-BROKER-TESTS-GREEN");
process.exit(0);
