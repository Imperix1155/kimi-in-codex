// Companion CLI tests: drive the real kimi-companion.mjs as child processes
// against the scripted fake agent (KIMI_COMPANION_AGENT_SPAWN override),
// with job state isolated via CLAUDE_PLUGIN_DATA.
// Run: node plugin/tests/kimi-companion.test.mjs  (prints KIMI-COMPANION-TESTS-GREEN)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
