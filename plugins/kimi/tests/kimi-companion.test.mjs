// Companion CLI tests: drive the real kimi-companion.mjs as child processes
// against the scripted fake agent (KIMI_COMPANION_AGENT_SPAWN override),
// with job state isolated via CLAUDE_PLUGIN_DATA.
// Run: node plugin/tests/kimi-companion.test.mjs  (prints KIMI-COMPANION-TESTS-GREEN)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/kimi-companion.mjs", import.meta.url));

const deadman = setTimeout(() => {
  console.error("COMPANION-TESTS TIMEOUT after 90s");
  process.exit(2);
}, 90_000);
deadman.unref?.();

function makeEnv(scenario, pluginData) {
  const env = {
    ...process.env,
    KIMI_COMPANION_AGENT_SPAWN: JSON.stringify({ command: process.execPath, args: [FIXTURE, scenario] }),
    CLAUDE_PLUGIN_DATA: pluginData
  };
  // KMP-23: KIMI_COMPANION_DATA outranks CLAUDE_PLUGIN_DATA in state.mjs; a
  // developer shell where the session hook exported it would silently break
  // test isolation (tests writing into REAL plugin data).
  delete env.KIMI_COMPANION_DATA;
  return env;
}

function runCli(args, { env, cwd }) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeFrozenDiff(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-frozen-diff-"));
  const file = path.join(dir, "final.diff");
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
  fs.writeFileSync(file, bytes);
  return {
    file,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

// Every workspace is registered for exit-time teardown so a failed
// assertion mid-suite cannot leak detached brokers or agents.
const cleanupTargets = [];
process.on("exit", () => {
  for (const target of cleanupTargets) {
    try {
      shutdownBroker(target.env, target.cwd);
    } catch {}
  }
});

function makeWorkspace(scenario) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-cli-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-data-"));
  const env = makeEnv(scenario, pluginData);
  cleanupTargets.push({ env, cwd });
  return { cwd, env };
}

async function pollUntil(fn, timeoutMs = 20_000, intervalMs = 250) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Deterministic teardown: request shutdown, verify the endpoint actually
// died, escalate to a process-group kill via the recorded pid if not.
function shutdownBroker(env, cwd) {
  const script = `
    (async () => {
      const m = await import(process.argv[2]);
      const p = await import(process.argv[3]);
      const s = m.loadBrokerSession(process.argv[1]);
      if (!s?.endpoint) process.exit(0);
      await m.sendBrokerShutdown(s.endpoint).catch(() => {});
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const alive = await m.waitForBrokerEndpoint(s.endpoint, 100);
        if (!alive) process.exit(0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (Number.isFinite(s.pid)) {
        try { p.terminateProcessTree(s.pid); } catch {}
      }
      process.exit(0);
    })();
  `;
  const probe = spawnSync(
    process.execPath,
    ["-e", script, cwd, pathToImport("../scripts/lib/broker-lifecycle.mjs"), pathToImport("../scripts/lib/process.mjs")],
    { env, cwd, encoding: "utf8", timeout: 15_000 }
  );
  return probe.status;
}

function pathToImport(relative) {
  return new URL(relative, import.meta.url).href;
}

// 1. Foreground task end to end: output rendered, job recorded completed
// with the ACP sessionId stored, status/result readable afterwards.
{
  const { cwd, env } = makeWorkspace("basic");
  const run = runCli(["task", "do the thing"], { env, cwd });
  assert.equal(run.status, 0, `task failed: ${run.stderr}`);
  assert.match(run.stdout, /pong/);

  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(status.status, 0);
  const report = JSON.parse(status.stdout);
  assert.equal(report.latestFinished.status, "completed");
  assert.equal(report.latestFinished.kindLabel, "task");
  assert.ok(report.latestFinished.threadId, "ACP sessionId must be recorded on the job");

  const result = runCli(["result"], { env, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pong/);
  shutdownBroker(env, cwd);
}

// 2. Background task survives its launcher: the launcher exits immediately,
// the detached worker finishes the job, and the result is recoverable from
// a completely fresh CLI invocation (M2 criteria 1 + 2, deterministic).
{
  const { cwd, env } = makeWorkspace("slow-prompt");
  const launch = runCli(["task", "--background", "slow thing"], { env, cwd });
  assert.equal(launch.status, 0, `launch failed: ${launch.stderr}`);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  assert.ok(jobId, `no job id in: ${launch.stdout}`);
  // The launcher process has already exited here — only the detached worker
  // remains. Poll job state from fresh CLI invocations.
  const completed = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    if (status.status !== 0) {
      return null;
    }
    const snapshot = JSON.parse(status.stdout);
    return snapshot.job.status === "completed" ? snapshot : null;
  });
  assert.ok(completed, "background job never completed");

  const result = runCli(["result", jobId], { env, cwd });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /slow done/);
  shutdownBroker(env, cwd);
}

// 3. Busy signaling surfaces through the CLI: while a background turn runs,
// a concurrent foreground task fails with the friendly busy message
// (M2 criterion 3, deterministic).
{
  const { cwd, env } = makeWorkspace("slow-prompt-3s");
  const launch = runCli(["task", "--background", "long thing"], { env, cwd });
  assert.equal(launch.status, 0);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  // Wait until the background worker's turn is actually in flight.
  const running = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "running" ? snapshot : null;
  }, 10_000);
  assert.ok(running, "background job never started running");

  const concurrent = runCli(["task", "second thing"], { env, cwd });
  assert.notEqual(concurrent.status, 0);
  assert.match(concurrent.stdout + concurrent.stderr, /busy with another turn/);

  const completed = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "completed" ? snapshot : null;
  });
  assert.ok(completed, "background job should still complete after the busy rejection");
  shutdownBroker(env, cwd);
}

// 4. Cancel: a hanging background turn is cancelled; the job is marked
// cancelled and the shared runtime is NOT left busy.
{
  const { cwd, env } = makeWorkspace("cancellable");
  const launch = runCli(["task", "--background", "never ending"], { env, cwd });
  assert.equal(launch.status, 0);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  const running = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "running" ? snapshot : null;
  }, 10_000);
  assert.ok(running, "job never reached running state");

  const cancel = runCli(["cancel", jobId], { env, cwd });
  assert.equal(cancel.status, 0, `cancel failed: ${cancel.stderr}`);
  assert.match(cancel.stdout, /Cancelled task-/);

  const status = runCli(["status", jobId, "--json"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).job.status, "cancelled");

  // The broker must be responsive (not busy) afterwards. Probe with a raw
  // session/new — a fixture "cancellable" prompt would hold by design, so a
  // follow-up task is the wrong instrument here.
  const probeScript = `
    const deadman = setTimeout(() => process.exit(3), 5000);
    (async () => {
      const { AcpClient } = await import(process.argv[2]);
      const { loadBrokerSession } = await import(process.argv[3]);
      const endpoint = loadBrokerSession(process.argv[1])?.endpoint;
      if (!endpoint) process.exit(4);
      const client = await AcpClient.connect(process.argv[1], { brokerEndpoint: endpoint });
      await client.request("session/new", { cwd: process.argv[1], mcpServers: [] });
      await client.close();
      clearTimeout(deadman);
      process.exit(0);
    })().catch(() => process.exit(5));
  `;
  const probeOk = await pollUntil(() => {
    const probe = spawnSync(
      process.execPath,
      ["-e", probeScript, cwd, pathToImport("../scripts/lib/acp-client.mjs"), pathToImport("../scripts/lib/broker-lifecycle.mjs")],
      { env, cwd, encoding: "utf8", timeout: 10_000 }
    );
    return probe.status === 0 ? true : null;
  }, 10_000, 500);
  assert.ok(probeOk, "broker stayed busy after cancel");
  shutdownBroker(env, cwd);
}

// 5. Resume: --resume-last picks the stored sessionId from the last task
// job and goes through session/load (fixture reports resumed vs fresh).
{
  const { cwd, env } = makeWorkspace("resume-check");
  const first = runCli(["task", "start something"], { env, cwd });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /fresh-session/);

  const firstStatus = JSON.parse(runCli(["status", "--json", "--all"], { env, cwd }).stdout);
  const storedSessionId = firstStatus.latestFinished.threadId;
  assert.ok(storedSessionId);

  const resumed = runCli(["task", "--resume-last"], { env, cwd });
  assert.equal(resumed.status, 0, `resume failed: ${resumed.stderr}`);
  assert.match(resumed.stdout, /resumed-session/);

  const secondStatus = JSON.parse(runCli(["status", "--json", "--all"], { env, cwd }).stdout);
  assert.equal(secondStatus.latestFinished.threadId, storedSessionId, "resumed job must reuse the stored sessionId");
  shutdownBroker(env, cwd);
}

// 6. Guardrails: bogus model rejected with the menu; no prompt and no
// resume is an error; unimplemented subcommands say which item ships them.
{
  const { cwd, env } = makeWorkspace("basic");
  const model = runCli(["task", "--model", "gpt-4", "x"], { env, cwd });
  assert.notEqual(model.status, 0);
  assert.match(model.stderr, /Unknown model "gpt-4"/);
  assert.match(model.stderr, /highspeed/);

  const empty = runCli(["task"], { env, cwd });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /Provide a prompt/);

  const setup = runCli(["setup"], { env, cwd });
  assert.equal(setup.status, 0, "bare setup now runs the probes");
  assert.match(setup.stdout, /# Kimi Setup/);
}

// 6b. --model alias resolves to the wire id and reaches the agent via
// session/set_model (fixture echoes what it received).
{
  const { cwd, env } = makeWorkspace("model-check");
  const aliased = runCli(["task", "--model", "highspeed", "x"], { env, cwd });
  assert.equal(aliased.status, 0, `model task failed: ${aliased.stderr}`);
  assert.match(aliased.stdout, /model:kimi-code\/kimi-for-coding-highspeed,thinking/);
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("model-check");
  const noFlag = runCli(["task", "x"], { env, cwd });
  assert.equal(noFlag.status, 0);
  assert.match(noFlag.stdout, /model:default/);
  shutdownBroker(env, cwd);
}

// 7. --write end to end: the allow policy reaches the session the task runs
// on (fixture reports which option the broker selected) AND the permission
// event plumbing records the decision on the job payload.
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const writeRun = runCli(["task", "--write", "--json", "edit something"], { env, cwd });
  assert.equal(writeRun.status, 0, `write task failed: ${writeRun.stderr}`);
  const payload = JSON.parse(writeRun.stdout);
  assert.match(payload.rawOutput, /perm:ok/);
  assert.equal(payload.permissionEvents.length, 1);
  assert.equal(payload.permissionEvents[0].decision, "allow");
  assert.equal(payload.permissionEvents[0].optionId, "ok");
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const readRun = runCli(["task", "--json", "read-only thing"], { env, cwd });
  assert.equal(readRun.status, 0);
  const payload = JSON.parse(readRun.stdout);
  assert.match(payload.rawOutput, /perm:no/);
  assert.equal(payload.permissionEvents.length, 1);
  assert.equal(payload.permissionEvents[0].decision, "reject");
  assert.equal(payload.permissionEvents[0].optionId, "no");
  shutdownBroker(env, cwd);
}

// 7b. --read-only always beats --write, tested in BOTH the pre-tokenized
// shape and the REAL slash-command shape (one quoted string that the CLI
// re-tokenizes — the /kimi:task command prepends "--write " inside it).
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const pretokenized = runCli(["task", "--write", "--read-only", "--json", "cautious thing"], { env, cwd });
  assert.equal(pretokenized.status, 0, pretokenized.stderr);
  assert.equal(JSON.parse(pretokenized.stdout).permissionEvents[0].decision, "reject");
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const singleString = runCli(["task", "--write --read-only --json cautious thing"], { env, cwd });
  assert.equal(singleString.status, 0, singleString.stderr);
  const payload = JSON.parse(singleString.stdout);
  assert.match(payload.rawOutput, /perm:no/);
  assert.equal(payload.permissionEvents[0].decision, "reject");
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const reversed = runCli(["task", "--read-only --write --json cautious thing"], { env, cwd });
  assert.equal(reversed.status, 0, reversed.stderr);
  assert.equal(JSON.parse(reversed.stdout).permissionEvents[0].decision, "reject");
  shutdownBroker(env, cwd);
}

// 7c. Resume rebinds the permission policy: a session created write-enabled
// is resumed read-only, and the rejection actually reaches the agent.
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const first = runCli(["task", "--write", "--json", "start it"], { env, cwd });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).permissionEvents[0].decision, "allow");

  const resumed = runCli(["task", "--resume-last", "--read-only", "--json", "continue carefully"], { env, cwd });
  assert.equal(resumed.status, 0, resumed.stderr);
  const payload = JSON.parse(resumed.stdout);
  assert.match(payload.rawOutput, /perm:no/);
  assert.equal(payload.permissionEvents[0].decision, "reject", "resume must rebind the policy to read-only");
  shutdownBroker(env, cwd);
}

// 7d. KMP-24: read-only tasks carry the policy preamble so a rejected shell
// call reads as automated policy, not the user cancelling; write tasks and
// the user's own text stay untouched. Asserted on the prompt the agent
// actually received (prompt-echo fixture), not on companion internals.
{
  const { cwd, env } = makeWorkspace("prompt-echo");
  const readRun = runCli(["task", "--json", "verify the thing"], { env, cwd });
  assert.equal(readRun.status, 0, readRun.stderr);
  const readPrompt = JSON.parse(readRun.stdout).rawOutput;
  assert.match(readPrompt, /READ-ONLY task/, "read-only task must carry the KMP-24 preamble");
  assert.match(readPrompt, /NOT the user cancelling/, "preamble must name the rejection misread");
  assert.match(readPrompt, /verify the thing$/, "user text must survive verbatim after the preamble");
  assert.ok(readPrompt.indexOf("READ-ONLY task") < readPrompt.indexOf("verify the thing"), "preamble must precede the user text");

  const writeRun = runCli(["task", "--write", "--json", "edit the thing"], { env, cwd });
  assert.equal(writeRun.status, 0, writeRun.stderr);
  const writePrompt = JSON.parse(writeRun.stdout).rawOutput;
  assert.doesNotMatch(writePrompt, /READ-ONLY task/, "write task must NOT carry the preamble");
  assert.match(writePrompt, /edit the thing$/);

  // Promptless read-only resume: the preamble must compose with the
  // DEFAULT_CONTINUE_PROMPT fallback, not replace or skip it.
  const resumed = runCli(["task", "--resume-last", "--read-only", "--json"], { env, cwd });
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedPrompt = JSON.parse(resumed.stdout).rawOutput;
  assert.match(resumedPrompt, /READ-ONLY task/, "read-only resume must carry the preamble");
  assert.match(resumedPrompt, /Continue from the current session state/, "default continue prompt must survive");
  shutdownBroker(env, cwd);
}

// 7e. KMP-27: a read-only turn that ends silently after a policy rejection
// gets exactly one continuation prompt on the same session, and the
// recovered answer becomes the result (rejection evidence preserved).
{
  const { cwd, env } = makeWorkspace("reject-then-silent");
  const run = runCli(["task", "--json", "probe something"], { env, cwd });
  assert.equal(run.status, 0, `continuation task failed: ${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.match(payload.rawOutput, /CONTINUED-ANSWER/, "continuation answer must be the result");
  assert.match(payload.rawOutput, /automated read-only policy answering/, "continuation prompt must carry the policy clarification");
  assert.equal(payload.permissionEvents.length, 1);
  assert.equal(payload.permissionEvents[0].decision, "reject");
  assert.ok((payload.toolOutputs ?? []).some((t) => /rejected by the user/.test(t.text ?? "")), "first turn's rejection evidence must survive the merge");
  shutdownBroker(env, cwd);
}

// 7f. Codex foreground one-shot tasks are read-only by default, return a
// terminal taskStatus envelope, preserve prompt-file bytes, and never create
// a durable task record. This fails if the one-shot path starts using the
// legacy tracked-job flow or accidentally grants write permission.
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const before = JSON.parse(runCli(["status", "--json", "--all"], { env, cwd }).stdout);
  const run = runCli([
    "task", "--codex-once", "--json", "one-shot read-only task"
  ], { env, cwd });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.taskStatus, "COMPLETED");
  assert.equal(payload.sessionId, "sess-1");
  assert.equal(payload.permissionEvents[0].decision, "reject");
  const after = JSON.parse(runCli(["status", "--json", "--all"], { env, cwd }).stdout);
  assert.deepEqual(after.running, before.running);
  assert.deepEqual(after.latestFinished, before.latestFinished);
  assert.deepEqual(after.recent, before.recent);
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("prompt-echo");
  const prompt = '\n  leading-space\n"quoted" \\backslash --write\ntrailing-space  \n';
  const promptFile = path.join(cwd, "one-shot-prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf8");
  const run = runCli([
    "task", "--codex-once", "--json", "--prompt-file", promptFile
  ], { env, cwd });
  assert.equal(run.status, 0, run.stderr);
  const echoed = JSON.parse(run.stdout).rawOutput.slice("PROMPT-ECHO:".length);
  assert.match(echoed, /READ-ONLY task/, "read-only preamble must precede the prompt-file content");
  assert.equal(echoed.slice(-prompt.length), prompt, "prompt-file boundary whitespace must reach Kimi unchanged after the preamble");
  shutdownBroker(env, cwd);
}

// 7g. One-shot write and model selections flow through the same foreground
// session, but only an explicit --write may select an allow permission.
{
  const { cwd, env } = makeWorkspace("permission-standard");
  const run = runCli([
    "task", "--codex-once", "--write", "--json", "edit exactly this file"
  ], { env, cwd });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.taskStatus, "COMPLETED");
  assert.equal(payload.permissionEvents[0].decision, "allow");
  shutdownBroker(env, cwd);
}
{
  const { cwd, env } = makeWorkspace("model-check");
  const run = runCli([
    "task", "--codex-once", "--model", "highspeed", "--json", "use the selected model"
  ], { env, cwd });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.taskStatus, "COMPLETED");
  assert.match(payload.rawOutput, /model:kimi-code\/kimi-for-coding-highspeed,thinking/);
  shutdownBroker(env, cwd);
}

// 7h. One-shot resume is exact-session-only. It must reuse the session id
// returned by the fresh task and reject legacy repository-history selectors.
{
  const { cwd, env } = makeWorkspace("resume-check");
  const fresh = runCli([
    "task", "--codex-once", "--fresh", "--json", "start the exact session"
  ], { env, cwd });
  assert.equal(fresh.status, 0, fresh.stderr);
  const firstPayload = JSON.parse(fresh.stdout);
  assert.equal(firstPayload.taskStatus, "COMPLETED");
  assert.match(firstPayload.rawOutput, /fresh-session/);

  const resumed = runCli([
    "task", "--codex-once", "--resume-session", firstPayload.sessionId, "--json"
  ], { env, cwd });
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedPayload = JSON.parse(resumed.stdout);
  assert.equal(resumedPayload.taskStatus, "COMPLETED");
  assert.equal(resumedPayload.sessionId, firstPayload.sessionId);
  assert.match(resumedPayload.rawOutput, /resumed-session/);

  for (const args of [
    ["--codex-once", "--background", "x"],
    ["--codex-once", "--resume-last"],
    ["--codex-once", "--resume"],
    ["--codex-once", "--fresh", "--resume-session", "sess-1", "x"]
  ]) {
    const invalid = runCli(["task", "--json", ...args], { env, cwd });
    assert.notEqual(invalid.status, 0, `one-shot arguments must fail: ${args.join(" ")}`);
    assert.equal(JSON.parse(invalid.stdout).taskStatus, "FAILED");
  }
  shutdownBroker(env, cwd);
}

// 7i. One-shot process interruption is graceful and confirmed by ACP: both
// supported signals return a CANCELLED JSON result, stop the fake delayed
// write before it reaches normal completion, and release the broker for the
// next foreground task.
for (const signal of ["SIGINT", "SIGTERM"]) {
  const { cwd, env: baseEnv } = makeWorkspace("cancel-write-delay");
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-one-shot-cancel-"));
  const promptMarker = path.join(markerDir, "prompt-active.txt");
  const cancelMarker = path.join(markerDir, "cancel-received.txt");
  const postCancelMarker = path.join(markerDir, "post-cancel-write.txt");
  const env = {
    ...baseEnv,
    KIMI_FAKE_PROMPT_MARKER: promptMarker,
    KIMI_FAKE_CANCEL_MARKER: cancelMarker,
    KIMI_FAKE_POST_CANCEL_MARKER: postCancelMarker
  };
  const child = spawn(process.execPath, [
    CLI, "task", "--codex-once", "--write", "--json", `interrupt with ${signal}`
  ], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });

  const promptActive = await pollUntil(() => fs.existsSync(promptMarker), 5000, 25);
  assert.ok(promptActive, `${signal} fixture never reached its active prompt`);
  assert.equal(child.kill(signal), true, `${signal} was not delivered to the one-shot process`);
  const exited = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000))
  ]);
  if (!exited) {
    child.kill("SIGKILL");
  }
  assert.ok(exited, `${signal} one-shot process did not exit inside the deadline`);
  assert.notEqual(exited.code, 0, `${signal} cancellation must exit nonzero; stdout: ${stdout}; stderr: ${stderr}`);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.deepEqual(
    { cancelReceived: fs.existsSync(cancelMarker), postCancelWrite: fs.existsSync(postCancelMarker) },
    { cancelReceived: true, postCancelWrite: false },
    `${signal} must reach ACP cancellation and prevent delayed post-cancel work`
  );
  const payload = JSON.parse(stdout);
  assert.equal(payload.taskStatus, "CANCELLED", `${signal} stdout: ${stdout}\nstderr: ${stderr}`);
  assert.equal(payload.stopReason, "cancelled");

  const next = runCli(["task", "--codex-once", "--json", "next task after cancellation"], { env, cwd });
  assert.equal(next.status, 0, `${signal} left the broker busy: ${next.stderr}`);
  assert.equal(JSON.parse(next.stdout).taskStatus, "COMPLETED");
  shutdownBroker(env, cwd);
}

// 7j. A non-cooperative agent cannot hold the one-shot CLI open forever.
// The signal still reaches ACP, but without a cancelled stopReason the
// terminal result is FAILED with explicit unconfirmed-cancellation evidence.
{
  const { cwd, env: baseEnv } = makeWorkspace("cancel-unconfirmed");
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-one-shot-unconfirmed-"));
  const promptMarker = path.join(markerDir, "prompt-active.txt");
  const cancelMarker = path.join(markerDir, "cancel-received.txt");
  const env = {
    ...baseEnv,
    KIMI_FAKE_PROMPT_MARKER: promptMarker,
    KIMI_FAKE_CANCEL_MARKER: cancelMarker
  };
  const child = spawn(process.execPath, [
    CLI, "task", "--codex-once", "--json", "ignore this cancellation"
  ], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });

  assert.ok(await pollUntil(() => fs.existsSync(promptMarker), 5000, 25), "unconfirmed fixture never reached its active prompt");
  assert.equal(child.kill("SIGINT"), true);
  const exited = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000))
  ]);
  if (!exited) {
    child.kill("SIGKILL");
  }
  assert.ok(exited, "unconfirmed cancellation did not exit inside the bounded deadline");
  assert.notEqual(exited.code, 0);
  assert.ok(await pollUntil(() => fs.existsSync(cancelMarker), 1000, 25), "unconfirmed cancellation never reached ACP");
  const payload = JSON.parse(stdout);
  assert.equal(payload.taskStatus, "FAILED", `stdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(payload.error, /cancellation unconfirmed/i);
  shutdownBroker(env, cwd);
}

// 8. Externally killed worker: status must reconcile the record to failed
// instead of reporting "running" forever, and cancel must then refuse.
{
  const { cwd, env } = makeWorkspace("cancellable");
  const launch = runCli(["task", "--background", "doomed"], { env, cwd });
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  const running = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "running" && Number.isFinite(snapshot.job.pid) ? snapshot : null;
  }, 10_000);
  assert.ok(running, "job never reached running with a recorded pid");

  process.kill(running.job.pid, "SIGKILL");
  const reconciled = await pollUntil(() => {
    const status = runCli(["status", jobId, "--json"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    return snapshot?.job.status === "failed" ? snapshot : null;
  }, 10_000);
  assert.ok(reconciled, "dead worker was never reconciled to failed");
  assert.match(reconciled.job.errorMessage ?? "", /Worker process died/);
  shutdownBroker(env, cwd);
}

// 9. Foreground cancel: a running foreground task (NOT a group leader) is
// killed for real, and the job record ends cancelled — never a false
// "cancelled" while the task actually continues.
{
  const { cwd, env } = makeWorkspace("slow-prompt-3s");
  const fg = spawn(process.execPath, [CLI, "task", "long foreground"], { env, cwd, stdio: "ignore" });
  const fgExit = new Promise((resolve) => fg.on("exit", (code, signal) => resolve({ code, signal })));

  const running = await pollUntil(() => {
    const status = runCli(["status", "--json", "--all"], { env, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    const job = snapshot?.running?.[0];
    return job && job.threadId ? job : null;
  }, 10_000);
  assert.ok(running, "foreground job never reached running with a sessionId");

  const cancel = runCli(["cancel", running.id], { env, cwd });
  assert.equal(cancel.status, 0, `foreground cancel failed: ${cancel.stderr}`);

  const exited = await Promise.race([fgExit, new Promise((resolve) => setTimeout(() => resolve(null), 8000))]);
  assert.ok(exited, "foreground process kept running after cancel reported success");

  const finalStatus = runCli(["status", running.id, "--json"], { env, cwd });
  assert.equal(JSON.parse(finalStatus.stdout).job.status, "cancelled");
  shutdownBroker(env, cwd);
}

// 10. Review end to end: git context collected, prompt-driven review runs
// read-only, fenced JSON tolerated, findings rendered, job recorded.
function makeGitWorkspace(scenario) {
  const ws = makeWorkspace(scenario);
  spawnSync("git", ["init", "-q"], { cwd: ws.cwd, encoding: "utf8" });
  fs.mkdirSync(path.join(ws.cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws.cwd, "src", "buggy.mjs"), "export function compute(total, divisor) {\n  return total / divisor;\n}\n");
  return ws;
}
{
  const { cwd, env } = makeGitWorkspace("review-json");
  const review = runCli(["review", "--wait", "check the math"], { env, cwd });
  assert.equal(review.status, 0, `review failed: ${review.stderr}`);
  assert.match(review.stdout, /# Kimi Review/);
  assert.match(review.stdout, /Verdict: needs-attention/);
  assert.match(review.stdout, /Planted divide-by-zero/);
  assert.match(review.stdout, /Guard the divisor/);

  const status = runCli(["status", "--json", "--all"], { env, cwd });
  const report = JSON.parse(status.stdout);
  assert.equal(report.latestFinished.kindLabel, "review");
  assert.equal(report.latestFinished.status, "completed");
  shutdownBroker(env, cwd);
}

// 11. Review with unparseable output is a FAILED review: parse error and
// raw message surfaced, nonzero exit, job recorded failed.
{
  const { cwd, env } = makeGitWorkspace("review-bad-json");
  const review = runCli(["review", "--wait"], { env, cwd });
  assert.notEqual(review.status, 0, "structurally failed review must exit nonzero");
  assert.match(review.stdout, /did not return valid structured JSON/i);
  assert.match(review.stdout, /could not produce structured output/);
  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "failed");
  shutdownBroker(env, cwd);
}

// 11d. A review turn that ends with NO message at all is a failed review
// (regression: empty stderr as failureMessage laundered parseError to "").
{
  const { cwd, env } = makeGitWorkspace("review-empty");
  const review = runCli(["review", "--wait", "--json"], { env, cwd });
  assert.notEqual(review.status, 0, "empty review output must exit nonzero");
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.result, null);
  assert.match(payload.parseError ?? "", /did not return/);
  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "failed", "empty review must persist as failed");
  shutdownBroker(env, cwd);
}

// 11b. Schema-invalid JSON (verdict outside the enum) also fails the review.
{
  const { cwd, env } = makeGitWorkspace("review-invalid-schema");
  const review = runCli(["review", "--wait"], { env, cwd });
  assert.notEqual(review.status, 0);
  assert.match(review.stdout, /unexpected review shape/i);
  assert.match(review.stdout, /Invalid verdict/);
  shutdownBroker(env, cwd);
}

// 11c. Review invoked from a SUBDIRECTORY still targets the whole repo: the
// only change is a root-level untracked file, which must select
// working-tree scope (branch scope would fail in this commitless repo).
{
  const { cwd, env } = makeGitWorkspace("review-json");
  const subdir = path.join(cwd, "src");
  const review = runCli(["review", "--wait"], { env, cwd: subdir });
  assert.equal(review.status, 0, `subdir review failed: ${review.stderr}`);
  assert.match(review.stdout, /Target: working tree diff/);
  shutdownBroker(env, cwd);
}

// 12. Review outside a git repository fails with a clear message.
{
  const { cwd, env } = makeWorkspace("review-json");
  const review = runCli(["review", "--wait"], { env, cwd });
  assert.notEqual(review.status, 0);
  assert.match(review.stderr + review.stdout, /Git repository/i);
}

// 13. M3 security criterion: a write attempt DURING A REVIEW is rejected,
// and the reject path is ASSERTED three ways — the agent saw the reject
// option selected (summary echo), our handler recorded the event with the
// reject decision, and the review still completed with a valid verdict.
{
  const { cwd, env } = makeGitWorkspace("review-write-attempt");
  const review = runCli(["review", "--wait", "--json"], { env, cwd });
  assert.equal(review.status, 0, `review failed: ${review.stderr}`);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.result.summary, "perm-outcome:no", "the agent must have received the REJECT option");
  assert.equal(payload.permissionRejections, 1, "the reject path must be recorded, not inferred");
  assert.ok(payload.permissionEvents.every((event) => event.decision === "reject"));
  assert.equal(payload.result.verdict, "needs-attention");

  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "completed");
  shutdownBroker(env, cwd);
}

// 13b. Frozen review verifies one saved artifact, sends exactly that text
// from an isolated empty session cwd, and returns ledger-ready provenance.
{
  const { cwd, env } = makeGitWorkspace("review-frozen-json");
  const frozenText = [
    "\ufeffdiff --git a/src/math.mjs b/src/math.mjs",
    "--- a/src/math.mjs",
    "+++ b/src/math.mjs",
    "@@ -1 +1 @@",
    "-export const answer = 41;",
    "+export const answer = 42;",
    ""
  ].join("\n");
  const artifact = writeFrozenDiff(frozenText);
  const liveSentinel = "LIVE-CHECKOUT-CONTENT-MUST-NOT-BE-REVIEWED";
  fs.writeFileSync(path.join(cwd, "live-only.txt"), `${liveSentinel}\n`, "utf8");
  env.KIMI_EXPECTED_FROZEN_TEXT = frozenText;
  env.KIMI_LIVE_SENTINEL = liveSentinel;
  env.KIMI_FROZEN_ARTIFACT_PATH = artifact.file;
  env.KIMI_CALLER_CWD = cwd;
  const sessionCwdMarker = path.join(os.tmpdir(), `kmc-session-cwd-${process.pid}-${Date.now()}`);
  env.KIMI_SESSION_CWD_MARKER = sessionCwdMarker;

  const review = runCli([
    "review",
    "--diff-file", artifact.file,
    "--diff-sha256", artifact.sha256,
    "--json"
  ], { env, cwd });
  assert.equal(review.status, 0, `frozen review failed: ${review.stderr}`);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.reviewStatus, "REVIEWED");
  assert.equal(payload.target.mode, "frozen-diff");
  assert.equal(payload.target.diffSha256, artifact.sha256);
  assert.equal(payload.target.byteCount, artifact.bytes.length);
  assert.equal(payload.context.inputMode, "frozen-inline-diff");
  assert.equal(payload.result.summary, "snapshot:true;live:false;path:false;isolated:true;empty:true");
  const isolatedSessionCwd = fs.readFileSync(sessionCwdMarker, "utf8").trim();
  assert.equal(fs.existsSync(isolatedSessionCwd), false, "temporary session cwd must be removed after the turn");
  shutdownBroker(env, cwd);
}

// 13b.1. Relative artifact paths are resolved against the command cwd, not
// silently rebased to the repository root.
{
  const { cwd, env } = makeGitWorkspace("review-frozen-json");
  const subdir = path.join(cwd, "nested");
  fs.mkdirSync(subdir);
  const frozenText = "diff --git a/a b/a\n+relative artifact\n";
  const relativeFile = "final.diff";
  const bytes = Buffer.from(frozenText, "utf8");
  fs.writeFileSync(path.join(subdir, relativeFile), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  env.KIMI_EXPECTED_FROZEN_TEXT = frozenText;
  env.KIMI_CALLER_CWD = subdir;
  const review = runCli([
    "review", "--diff-file", relativeFile, "--diff-sha256", sha256, "--json"
  ], { env, cwd: subdir });
  assert.equal(review.status, 0, `relative frozen review failed: ${review.stderr}`);
  assert.equal(JSON.parse(review.stdout).target.diffSha256, sha256);
  shutdownBroker(env, cwd);
}

// 13c. A hash mismatch is rejected before the fake ACP agent starts. The
// error is explicit and includes both expected and observed provenance.
{
  const { cwd, env } = makeGitWorkspace("review-frozen-json");
  const artifact = writeFrozenDiff("diff --git a/a b/a\n+safe\n");
  const marker = path.join(os.tmpdir(), `kmc-agent-start-${process.pid}-${Date.now()}`);
  env.KIMI_FAKE_START_MARKER = marker;
  const wrongSha = "0".repeat(64);
  const review = runCli([
    "review",
    "--diff-file", artifact.file,
    "--diff-sha256", wrongSha,
    "--json"
  ], { env, cwd });
  assert.notEqual(review.status, 0);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.reviewStatus, "NOT REVIEWED");
  assert.match(payload.error, /SHA-256 mismatch/i);
  assert.equal(payload.expectedDiffSha256, wrongSha);
  assert.equal(payload.actualDiffSha256, artifact.sha256);
  assert.equal(fs.existsSync(marker), false, "Kimi must not start before artifact verification passes");
}

// 13d. Frozen mode requires paired, valid, non-empty evidence and never
// launders malformed evidence into a generic review failure.
{
  const { cwd, env } = makeGitWorkspace("review-frozen-json");
  const artifact = writeFrozenDiff("diff --git a/a b/a\n+safe\n");
  for (const args of [
    ["review", "--diff-file", artifact.file, "--json"],
    ["review", "--diff-sha256", artifact.sha256, "--json"],
    ["review", "--diff-file", artifact.file, "--diff-sha256", "xyz", "--json"],
    ["review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--scope", "working-tree", "--json"],
    ["review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--base=", "--json"],
    ["review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--scope=", "--json"],
    ["review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--background=false", "--json"]
  ]) {
    const marker = path.join(os.tmpdir(), `kmc-preflight-start-${process.pid}-${Date.now()}-${Math.random()}`);
    env.KIMI_FAKE_START_MARKER = marker;
    const review = runCli(args, { env, cwd });
    assert.notEqual(review.status, 0);
    assert.equal(JSON.parse(review.stdout).reviewStatus, "NOT REVIEWED");
    assert.equal(fs.existsSync(marker), false, "preflight failure must occur before the ACP agent starts");
  }
  const empty = writeFrozenDiff("");
  const review = runCli([
    "review",
    "--diff-file", empty.file,
    "--diff-sha256", empty.sha256,
    "--json"
  ], { env, cwd });
  assert.notEqual(review.status, 0);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.reviewStatus, "NOT REVIEWED");
  assert.match(payload.error, /empty/i);

  const invalidUtf8 = writeFrozenDiff(Buffer.from([0xff, 0xfe, 0xfd]));
  const invalidReview = runCli([
    "review",
    "--diff-file", invalidUtf8.file,
    "--diff-sha256", invalidUtf8.sha256,
    "--json"
  ], { env, cwd });
  assert.notEqual(invalidReview.status, 0);
  const invalidPayload = JSON.parse(invalidReview.stdout);
  assert.equal(invalidPayload.reviewStatus, "NOT REVIEWED");
  assert.match(invalidPayload.error, /UTF-8/i);
}

// 13d.1. Every failure on an invocation expressing frozen intent uses the
// explicit NOT REVIEWED envelope, including errors before artifact loading.
{
  const { cwd, env } = makeGitWorkspace("review-frozen-json");
  const artifact = writeFrozenDiff("diff --git a/a b/a\n+safe\n");
  for (const args of [
    ["review", "--json", "--diff-sha256"],
    ["review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--model", "not-a-model", "--json"],
    ["review", `--diff-file ${artifact.file} --diff-sha256 ${artifact.sha256} --model not-a-model --json`]
  ]) {
    const review = runCli(args, { env, cwd });
    assert.notEqual(review.status, 0);
    assert.equal(JSON.parse(review.stdout).reviewStatus, "NOT REVIEWED");
  }
  const outsideGit = makeWorkspace("review-frozen-json");
  const review = runCli([
    "review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--json"
  ], { env: outsideGit.env, cwd: outsideGit.cwd });
  assert.notEqual(review.status, 0);
  assert.equal(JSON.parse(review.stdout).reviewStatus, "NOT REVIEWED");

  const marker = path.join(os.tmpdir(), `kmc-empty-option-start-${process.pid}-${Date.now()}`);
  env.KIMI_FAKE_START_MARKER = marker;
  const emptyOptions = runCli([
    "review", "--diff-file=", "--diff-sha256=", "--json"
  ], { env, cwd });
  assert.notEqual(emptyOptions.status, 0);
  assert.equal(JSON.parse(emptyOptions.stdout).reviewStatus, "NOT REVIEWED");
  assert.equal(fs.existsSync(marker), false, "empty frozen options must not fall back to a live review");
}

// 13d.2. Frozen reviews exercise the same verified permission rejection path
// as legacy reviews; a write attempt is rejected and recorded.
{
  const { cwd, env } = makeGitWorkspace("review-write-attempt");
  const artifact = writeFrozenDiff("diff --git a/a b/a\n+read only\n");
  const review = runCli([
    "review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--json"
  ], { env, cwd });
  assert.equal(review.status, 0, review.stderr);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.reviewStatus, "REVIEWED");
  assert.equal(payload.permissionRejections, 1);
  assert.ok(payload.permissionEvents.every((event) => event.decision === "reject"));
  assert.equal(payload.result.summary, "perm-outcome:no");
  shutdownBroker(env, cwd);
}

// 13e. Invalid Kimi output is an explicit NOT REVIEWED result with the
// already-verified artifact provenance retained for the coverage ledger.
{
  const { cwd, env } = makeGitWorkspace("review-bad-json");
  const artifact = writeFrozenDiff("diff --git a/a b/a\n+unsafe\n");
  const review = runCli([
    "review",
    "--diff-file", artifact.file,
    "--diff-sha256", artifact.sha256,
    "--json"
  ], { env, cwd });
  assert.notEqual(review.status, 0);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.reviewStatus, "NOT REVIEWED");
  assert.equal(payload.target.diffSha256, artifact.sha256);
  assert.equal(payload.target.byteCount, artifact.bytes.length);
  assert.match(payload.parseError, /not valid JSON/i);
  assert.match(payload.error, /not valid JSON/i);
  shutdownBroker(env, cwd);
}

// 13f. A verified artifact with unavailable Kimi authentication is still
// explicit NOT REVIEWED and retains the artifact's provenance.
{
  const { cwd, env } = makeGitWorkspace("auth-error");
  const artifact = writeFrozenDiff("diff --git a/a b/a\n+auth probe\n");
  const review = runCli([
    "review",
    "--diff-file", artifact.file,
    "--diff-sha256", artifact.sha256,
    "--json"
  ], { env, cwd });
  assert.notEqual(review.status, 0);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.reviewStatus, "NOT REVIEWED");
  assert.equal(payload.target.diffSha256, artifact.sha256);
  assert.equal(payload.target.byteCount, artifact.bytes.length);
  assert.match(payload.error, /not logged in/i);
  shutdownBroker(env, cwd);
}

// 13g. A verified artifact whose ACP child cannot start preserves bounded
// broker evidence in the structured NOT REVIEWED envelope. This is the
// native Codex sandbox failure shape, not an authentication failure.
{
  const { cwd, env } = makeGitWorkspace("startup-sensitive-stderr");
  const artifact = writeFrozenDiff("diff --git a/a b/a\n+broker startup evidence\n");
  const review = runCli([
    "review", "--diff-file", artifact.file, "--diff-sha256", artifact.sha256, "--json"
  ], { env, cwd });
  assert.notEqual(review.status, 0);
  const payload = JSON.parse(review.stdout);
  assert.equal(payload.reviewStatus, "NOT REVIEWED");
  assert.equal(payload.target.diffSha256, artifact.sha256);
  assert.equal(payload.target.byteCount, artifact.bytes.length);
  assert.equal(payload.brokerStartup?.reason, "child-exit");
  assert.equal(payload.brokerStartup?.exitCode, 1);
  assert.equal(payload.brokerStartup?.signal, null);
  assert.match(payload.brokerStartup?.logTail ?? "", /Agent startup diagnostic: PermissionError opening ~\/\.kimi\/logs\/kimi\.log/);
  assert.doesNotMatch(JSON.stringify(payload), /secret-marker-123|PROMPT_MARKER|ARTIFACT_MARKER|Users\/example/);
}

// 14. Setup probes: all three states of the M4 gate criterion.
// ready — the fake agent accepts session/new.
{
  const { cwd, env } = makeWorkspace("basic");
  const setup = runCli(["setup", "--json"], { env, cwd });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.state, "ready");
  assert.equal(report.ready, true);
  assert.equal(report.auth.loggedIn, true);
}
// logged-out — session/new fails with the live-recorded auth error.
{
  const { cwd, env } = makeWorkspace("auth-error");
  const setup = runCli(["setup", "--json"], { env, cwd });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.state, "logged-out");
  assert.equal(report.ready, false);
  assert.match(report.auth.detail, /kimi login/);
  assert.ok(report.nextSteps.some((step) => step.includes("kimi login")));
}
// not-installed — no spawn override and a PATH without the kimi binary.
{
  const { cwd, env } = makeWorkspace("basic");
  const stripped = { ...env, PATH: "/usr/bin:/bin" };
  delete stripped.KIMI_COMPANION_AGENT_SPAWN;
  const setup = runCli(["setup", "--json"], { env: stripped, cwd });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.state, "not-installed");
  assert.equal(report.ready, false);
  assert.ok(report.nextSteps.some((step) => step.includes("MoonshotAI/kimi-code")));
}
// toggles still work and now come with the full report.
{
  const { cwd, env } = makeWorkspace("basic");
  const setup = runCli(["setup", "--enable-review-gate", "--json"], { env, cwd });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.reviewGateEnabled, true);
  assert.ok(report.actionsTaken.some((action) => action.includes("Enabled the stop-time review gate")));
  // With the spawn override active, the report must warn that it describes
  // the override agent, not the installed CLI.
  assert.ok(report.nextSteps.some((step) => step.includes("KIMI_COMPANION_AGENT_SPAWN")));
}

// 14b. A wedged agent cannot hang setup: the handshake deadline fires, the
// state is error, and the wedged process is killed (leak sweep verifies).
{
  const { cwd, env } = makeWorkspace("hang-init");
  const setup = runCli(["setup", "--json"], { env: { ...env, KIMI_COMPANION_PROBE_TIMEOUT_MS: "2000" }, cwd });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.state, "error");
  assert.match(report.auth.detail, /handshake|timed out/i);
}
{
  const { cwd, env } = makeWorkspace("hang-session");
  const setup = runCli(["setup", "--json"], { env: { ...env, KIMI_COMPANION_PROBE_TIMEOUT_MS: "2000" }, cwd });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.state, "error");
  assert.match(report.auth.detail, /timed out/i);
}

// 14c. Installed binary with a BROKEN acp runtime is "error" (not
// "not-installed" — install guidance would be wrong). Uses a shim kimi
// whose --version works but whose acp subcommand fails.
{
  const { cwd, env } = makeWorkspace("basic");
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-shim-"));
  fs.writeFileSync(
    path.join(shimDir, "kimi"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "kimi, version 9.9.9"; exit 0; fi\necho "acp broken" >&2; exit 1\n'
  );
  fs.chmodSync(path.join(shimDir, "kimi"), 0o755);
  const stripped = { ...env, PATH: `${shimDir}:/usr/bin:/bin` };
  delete stripped.KIMI_COMPANION_AGENT_SPAWN;
  const setup = runCli(["setup", "--json"], { env: stripped, cwd });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.state, "error");
  assert.match(report.auth.detail, /no working ACP runtime/);
  assert.ok(!report.nextSteps.some((step) => step.includes("MoonshotAI/kimi-code")), "must not tell the user to install what is installed");
}


// Only TEST processes count as leaks: the plugin may be legitimately
// installed and in use on this machine (real brokers from real sessions
// must not fail the suite). Test brokers are identified by a test-workspace
// --cwd (kmc- mkdtemp prefix) or the --agent-spawn test flag; fake agents
// are unambiguous.
function listLeakedTestProcesses() {
  const ps = spawnSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  return ps
    .split("\n")
    .filter((line) => {
      // Exclude shell/orchestration wrappers whose command line merely
      // MENTIONS the fixture name (e.g. a `--check .../fake-acp-agent.mjs`
      // or `pgrep -f "fake-acp-agent"` runner) — match only the actual
      // scripted-agent and test-broker PROCESSES.
      if (/\bpgrep\b|\bsh -c\b|\bzsh\b|\beval\b|--check\b|node -e |-o pid=/.test(line)) {
        return false;
      }
      // Real fake agent: `node <path>/fake-acp-agent.mjs <scenario>`.
      if (/fake-acp-agent\.mjs\s+\S/.test(line)) {
        return true;
      }
      // Real test broker: serving with a test-workspace cwd or the test override.
      return /acp-broker\.mjs serve/.test(line) && (/--agent-spawn/.test(line) || /--cwd\s+\S*kmc-/.test(line));
    });
}

// 15. Output-loss fix (2026-07-22): a task whose deliverable is in a
// sub-agent tool call, with only a thin final message, must surface that
// content in BOTH the rendered output and the --json payload, and exit 0.
{
  const { cwd, env } = makeWorkspace("task-tool-content");
  const run = runCli(["task", "surface it"], { env, cwd });
  assert.equal(run.status, 0, `task failed: ${run.stderr}`);
  assert.match(run.stdout, /Audit dispatched\./);
  assert.match(run.stdout, /AUDIT-BODY: 3 findings/, "the sub-agent's content must not be dropped");
  assert.match(run.stdout, /Agent: Audit src\//);

  const json = runCli(["task", "--json", "surface it"], { env, cwd });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.toolOutputs.length, 1);
  assert.match(payload.toolOutputs[0].text, /AUDIT-BODY/);
  shutdownBroker(env, cwd);
}

// 15b. Tool-output-only turn (no final message) still surfaces content and
// exits 0 — a productive turn is not a false failure.
{
  const { cwd, env } = makeWorkspace("task-tool-only");
  const run = runCli(["task", "--json", "go"], { env, cwd });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, 0);
  assert.match(payload.toolOutputs[0].text, /TOOL-ONLY-DELIVERABLE/);
  const rendered = runCli(["task", "go"], { env, cwd });
  assert.match(rendered.stdout, /TOOL-ONLY-DELIVERABLE/);
  shutdownBroker(env, cwd);
}

// 15c. A clean end_turn that produced nothing usable is a FAILURE (exit
// nonzero, job failed), with an honest message — never exit 0 as before.
{
  const { cwd, env } = makeWorkspace("task-empty");
  const run = runCli(["task", "nothing"], { env, cwd });
  assert.notEqual(run.status, 0, "an empty turn must exit nonzero");
  assert.match(run.stdout, /produced no output/i);
  assert.doesNotMatch(run.stdout, /did not return a final message/, "old misleading string is gone");
  const status = runCli(["status", "--json", "--all"], { env, cwd });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "failed");
  shutdownBroker(env, cwd);
}

// Final leak sweep: the suite itself fails if any scenario left a broker or
// fake agent running — silent leaks must not depend on a manual pgrep.
await new Promise((resolve) => setTimeout(resolve, 500));
const leaked = listLeakedTestProcesses();
assert.deepEqual(leaked, [], `leaked TEST processes:\n${leaked.join("\n")}`);

console.log("KIMI-COMPANION-TESTS-GREEN");
process.exit(0);
