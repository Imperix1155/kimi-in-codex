// Functional tests for both Claude Code hooks, driven exactly as the
// harness drives them: stdin JSON, argv event name, env contract.
// Run: node plugin/tests/hooks.test.mjs  (prints HOOKS-TESTS-GREEN)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/kimi-companion.mjs", import.meta.url));
const STOP_HOOK = fileURLToPath(new URL("../scripts/stop-review-gate-hook.mjs", import.meta.url));
const LIFECYCLE_HOOK = fileURLToPath(new URL("../scripts/session-lifecycle-hook.mjs", import.meta.url));

const deadman = setTimeout(() => {
  console.error("HOOKS-TESTS TIMEOUT after 90s");
  process.exit(2);
}, 90_000);
deadman.unref?.();

const cleanupTargets = [];
process.on("exit", () => {
  for (const target of cleanupTargets) {
    try {
      shutdownBroker(target.env, target.cwd);
    } catch {}
  }
});

function makeWorkspace(scenario) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kmc-hook-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-hookdata-"));
  const env = {
    ...process.env,
    KIMI_COMPANION_AGENT_SPAWN: JSON.stringify({ command: process.execPath, args: [FIXTURE, scenario] }),
    CLAUDE_PLUGIN_DATA: pluginData
  };
  // KMP-23: see kimi-companion.test.mjs makeEnv — isolation would silently
  // break in a shell where the session hook exported KIMI_COMPANION_DATA.
  delete env.KIMI_COMPANION_DATA;
  cleanupTargets.push({ env, cwd });
  return { cwd, env };
}

// Stop-gate workspaces are git repos with a real uncommitted change so the
// hook exercises the inline-context path (the fixture BLOCKS if the prompt
// arrives without the repo-state boundary — see fake-acp-agent.mjs).
function makeGitWorkspace(scenario) {
  const ws = makeWorkspace(scenario);
  spawnSync("git", ["init", "-q"], { cwd: ws.cwd, encoding: "utf8" });
  fs.writeFileSync(path.join(ws.cwd, "changed.mjs"), "export const value = 1;\n");
  return ws;
}

function run(script, args, { env, cwd, input } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { env, cwd, input, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function pathToImport(relative) {
  return new URL(relative, import.meta.url).href;
}

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
  spawnSync(
    process.execPath,
    ["-e", script, cwd, pathToImport("../scripts/lib/broker-lifecycle.mjs"), pathToImport("../scripts/lib/process.mjs")],
    { env, cwd, encoding: "utf8", timeout: 15_000 }
  );
}

function brokerAlive(env, cwd) {
  const script = `
    (async () => {
      const m = await import(process.argv[2]);
      const s = m.loadBrokerSession(process.argv[1]);
      if (!s?.endpoint) process.exit(3);
      const alive = await m.waitForBrokerEndpoint(s.endpoint, 300);
      process.exit(alive ? 0 : 3);
    })();
  `;
  const probe = spawnSync(process.execPath, ["-e", script, cwd, pathToImport("../scripts/lib/broker-lifecycle.mjs")], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 10_000
  });
  return probe.status === 0;
}

const stopInput = (cwd, extra = {}) =>
  JSON.stringify({ session_id: "sess-hook", cwd, last_assistant_message: "I edited src/x.mjs.", ...extra });

// 1. Gate disabled (default): the stop hook allows the stop — no decision
// output, exit 0.
{
  const { cwd, env } = makeWorkspace("stop-gate-allow");
  const hook = run(STOP_HOOK, [], { env, cwd, input: stopInput(cwd) });
  assert.equal(hook.status, 0);
  assert.ok(!hook.stdout.includes('"decision"'), `unexpected decision output: ${hook.stdout}`);
}

// 2. Gate enabled + reviewer says ALLOW: stop proceeds. Uses a git repo
// so the fixture verifies the inlined repo state arrived intact via stdin.
{
  const { cwd, env } = makeGitWorkspace("stop-gate-allow");
  const enable = run(CLI, ["setup", "--enable-review-gate"], { env, cwd });
  assert.equal(enable.status, 0, enable.stderr);
  assert.match(enable.stdout, /Enabled the stop-time review gate/);

  const hook = run(STOP_HOOK, [], { env, cwd, input: stopInput(cwd) });
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(!hook.stdout.includes('"decision"'), `ALLOW must not block: ${hook.stdout}`);
  shutdownBroker(env, cwd);
}

// 3. Gate enabled + reviewer says BLOCK: the hook emits a block decision
// carrying the reviewer's reason.
{
  const { cwd, env } = makeGitWorkspace("stop-gate-block");
  run(CLI, ["setup", "--enable-review-gate"], { env, cwd });
  const hook = run(STOP_HOOK, [], { env, cwd, input: stopInput(cwd) });
  assert.equal(hook.status, 0, hook.stderr);
  const decision = JSON.parse(hook.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /planted bug from the previous turn/);
  shutdownBroker(env, cwd);
}

// 4. Gate re-disabled: the hook goes quiet again.
{
  const { cwd, env } = makeWorkspace("stop-gate-block");
  run(CLI, ["setup", "--enable-review-gate"], { env, cwd });
  run(CLI, ["setup", "--disable-review-gate"], { env, cwd });
  const hook = run(STOP_HOOK, [], { env, cwd, input: stopInput(cwd) });
  assert.equal(hook.status, 0);
  assert.ok(!hook.stdout.includes('"decision"'));
}

// 5. SessionStart: exports the session id into CLAUDE_ENV_FILE.
{
  const { cwd, env } = makeWorkspace("basic");
  const envFile = path.join(cwd, "claude-env");
  fs.writeFileSync(envFile, "", "utf8");
  const hook = run(LIFECYCLE_HOOK, ["SessionStart"], {
    env: { ...env, CLAUDE_ENV_FILE: envFile },
    cwd,
    input: JSON.stringify({ session_id: "sess-abc", cwd })
  });
  assert.equal(hook.status, 0, hook.stderr);
  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export KIMI_COMPANION_SESSION_ID='sess-abc'/);
  // KMP-23 primary leg (advisor 2026-07-30: previously unpinned — a revert
  // to exporting generic CLAUDE_PLUGIN_DATA kept all suites green): the hook
  // must export OUR env name, carrying the kimi-* data dir it was given.
  assert.match(exported, /export KIMI_COMPANION_DATA='[^']*kimi-hookdata[^']*'/);
  assert.doesNotMatch(exported, /export CLAUDE_PLUGIN_DATA=/, "the generic name must no longer be exported session-wide");
}

// 5b. SessionStart with a FOREIGN-named data dir (an earlier foreign hook's
// export already reached this process): must NOT capture it as ours.
{
  const { cwd, env } = makeWorkspace("basic");
  const envFile = path.join(cwd, "claude-env");
  fs.writeFileSync(envFile, "", "utf8");
  const foreignData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hookdata-"));
  const hook = run(LIFECYCLE_HOOK, ["SessionStart"], {
    env: { ...env, CLAUDE_PLUGIN_DATA: foreignData, CLAUDE_ENV_FILE: envFile },
    cwd,
    input: JSON.stringify({ session_id: "sess-frn", cwd })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.doesNotMatch(fs.readFileSync(envFile, "utf8"), /KIMI_COMPANION_DATA/, "a foreign-named data dir must not be captured");
}

// 6. SessionEnd: shuts the workspace broker down, clears its state record,
// and removes this session's jobs from the index.
{
  const { cwd, env } = makeWorkspace("basic");
  const sessionEnv = { ...env, KIMI_COMPANION_SESSION_ID: "sess-end" };
  const task = run(CLI, ["task", "hello"], { env: sessionEnv, cwd });
  assert.equal(task.status, 0, task.stderr);
  assert.equal(brokerAlive(env, cwd), true, "broker should be alive after the task");

  const statusBefore = run(CLI, ["status", "--json", "--all"], { env: sessionEnv, cwd });
  assert.equal(JSON.parse(statusBefore.stdout).latestFinished.status, "completed");

  const hook = run(LIFECYCLE_HOOK, ["SessionEnd"], {
    env: sessionEnv,
    cwd,
    input: JSON.stringify({ session_id: "sess-end", cwd })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(brokerAlive(env, cwd), false, "broker must be down after SessionEnd");

  const statusAfter = run(CLI, ["status", "--json", "--all"], { env: sessionEnv, cwd });
  const report = JSON.parse(statusAfter.stdout);
  assert.equal(report.running.length, 0);
  assert.equal(report.latestFinished, null, "this session's jobs must be removed");
}

// 7. Two sessions, one workspace: ending session B must NOT tear down the
// shared broker while session A's turn is still running.
{
  const { cwd, env } = makeWorkspace("cancellable");
  const envA = { ...env, KIMI_COMPANION_SESSION_ID: "sess-A" };
  const envB = { ...env, KIMI_COMPANION_SESSION_ID: "sess-B" };

  const launch = run(CLI, ["task", "--background", "long running work"], { env: envA, cwd });
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = launch.stdout.match(/as (task-[a-z0-9-]+)\./)?.[1];
  const start = Date.now();
  let running = null;
  while (Date.now() - start < 10_000) {
    const status = run(CLI, ["status", jobId, "--json"], { env: envA, cwd });
    const snapshot = status.status === 0 ? JSON.parse(status.stdout) : null;
    if (snapshot?.job.status === "running" && snapshot.job.threadId) {
      running = snapshot;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(running, "session A's job never reached running");

  const hook = run(LIFECYCLE_HOOK, ["SessionEnd"], {
    env: envB,
    cwd,
    input: JSON.stringify({ session_id: "sess-B", cwd })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(brokerAlive(env, cwd), true, "broker must survive another session's end while A is mid-turn");

  // Clean up session A for real: cancel its job, then its SessionEnd may
  // tear the broker down.
  run(CLI, ["cancel", jobId], { env: envA, cwd });
  const endA = run(LIFECYCLE_HOOK, ["SessionEnd"], {
    env: envA,
    cwd,
    input: JSON.stringify({ session_id: "sess-A", cwd })
  });
  assert.equal(endA.status, 0, endA.stderr);
  assert.equal(brokerAlive(env, cwd), false, "broker should be down after the last session ends");
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

// Final leak sweep.
await new Promise((resolve) => setTimeout(resolve, 500));
const leaked = listLeakedTestProcesses();
assert.deepEqual(leaked, [], `leaked TEST processes:\n${leaked.join("\n")}`);

console.log("HOOKS-TESTS-GREEN");
process.exit(0);
