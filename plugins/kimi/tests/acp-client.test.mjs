// Deterministic acp-client tests against the scripted fake agent.
// Run: node plugin/tests/acp-client.test.mjs  (prints ACP-CLIENT-TESTS-GREEN)
import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AcpClient, AcpError } from "../scripts/lib/acp-client.mjs";
import { kimiProfile, isAuthRequiredError } from "../scripts/lib/agent-profile.mjs";

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

// 1. Handshake + round trip + notification dispatch.
{
  const client = await connectTo("basic");
  assert.equal(client.agentInfo.protocolVersion, 1);
  const notifications = [];
  client.setNotificationHandler((message) => notifications.push(message));
  const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  assert.equal(session.sessionId, "sess-1");
  const result = await client.request("session/prompt", { sessionId: "sess-1", prompt: [{ type: "text", text: "ping" }] });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.update.sessionUpdate, "agent_message_chunk");
  await client.close();
}

// 2. Auth failure surfaces the structured JSON-RPC error (KMP-4 contract):
// code survives, and agent-profile detection works on the rejected error.
{
  const client = await connectTo("auth-error");
  let caught = null;
  try {
    await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AcpError);
  assert.equal(caught.code, -32000);
  assert.equal(isAuthRequiredError(kimiProfile, caught), true);
  await client.close();
}

// 3. Default policy is reject: the reject-kind option gets selected, and the
// onPermissionRequest observer fires (KMP-9 will assert through this hook).
{
  const events = [];
  const client = await connectTo("permission-standard", { onPermissionRequest: (event) => events.push(event) });
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await client.request("session/prompt", { sessionId: "sess-1", prompt: [] });
  assert.equal(result.observed.permissionResponse.result.outcome.outcome, "selected");
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "no");
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "reject");
  await client.close();
}

// 4. Fail closed: only allow-kind options offered under reject -> cancelled.
{
  const client = await connectTo("permission-no-reject-kind");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await client.request("session/prompt", { sessionId: "sess-1", prompt: [] });
  assert.equal(result.observed.permissionResponse.result.outcome.outcome, "cancelled");
  await client.close();
}

// 5. Allow policy selects the allow option.
{
  const client = await connectTo("permission-standard", { permissionDecision: "allow" });
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await client.request("session/prompt", { sessionId: "sess-1", prompt: [] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "ok");
  await client.close();
}

// 6. Unknown agent->client request is answered -32601 so the turn completes
// instead of hanging.
{
  const client = await connectTo("unknown-request");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await client.request("session/prompt", { sessionId: "sess-1", prompt: [] });
  assert.equal(result.observed.unknownResponse.error.code, -32601);
  await client.close();
}

// 7. Agent crash mid-turn rejects the pending request, resolves exitPromise,
// and later requests reject immediately instead of hanging.
{
  const client = await connectTo("crash-mid-turn");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  let caught = null;
  try {
    await client.request("session/prompt", { sessionId: "sess-1", prompt: [] });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AcpError);
  assert.match(caught.message, /exited unexpectedly \(exit 3\)/);
  await client.exitPromise;
  let afterExit = null;
  try {
    await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  } catch (error) {
    afterExit = error;
  }
  assert.ok(afterExit instanceof AcpError);
  await client.close();
}

// 8. A failed initialize handshake rejects connect() with the structured
// error and cleans up rather than orphaning the agent process.
{
  let caught = null;
  try {
    await connectTo("init-error");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AcpError);
  assert.equal(caught.code, -32602);
}

// 9. Valid-JSON-but-non-object agent output fails pending requests instead
// of throwing inside the transport and killing the host process.
{
  const client = await connectTo("null-line");
  let caught = null;
  try {
    await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AcpError);
  assert.match(caught.message, /non-object ACP message/);
  await client.close();
}

// 10. Per-session policy: an allow override for THIS session is honored
// while the client default stays reject.
{
  const client = await connectTo("permission-standard");
  const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  client.setSessionPermissionDecision(session.sessionId, "allow");
  const result = await client.request("session/prompt", { sessionId: session.sessionId, prompt: [] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "ok");
  await client.close();
}

// 11. A policy set for a DIFFERENT session must not leak: this session's
// request falls back to the fail-safe reject default.
{
  const client = await connectTo("permission-standard");
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  client.setSessionPermissionDecision("some-other-session", "allow");
  const result = await client.request("session/prompt", { sessionId: "sess-1", prompt: [] });
  assert.equal(result.observed.permissionResponse.result.outcome.optionId, "no");
  await client.close();
}

// 12. A throwing notification observer must not take down the transport.
{
  const client = await connectTo("basic");
  client.setNotificationHandler(() => {
    throw new Error("observer bug");
  });
  await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const result = await client.request("session/prompt", { sessionId: "sess-1", prompt: [] });
  assert.equal(result.stopReason, "end_turn");
  await client.close();
}

console.log("ACP-CLIENT-TESTS-GREEN");
