# Codex-Native Kimi Task Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe foreground-only `$kimi-task` skill that forwards one task to Kimi, defaults to read-only, supports explicit write access and exact-session resume, returns its result in the current Codex task, and cancels safely on interruption.

**Architecture:** Add a `--codex-once` branch to the retained `task` command. It reuses `executeTaskRun`, `runKimiTurn`, and the shared ACP broker but bypasses legacy job records and detached workers. Extend the broker/client session policy with opt-in cancel-on-disconnect, and expose the slice through one elevated Codex skill with no background or durable job API.

**Tech Stack:** Node.js ESM, plain `node:assert/strict` test suites, newline-delimited JSON-RPC ACP, Codex plugin skills and manifest JSON.

## Global Constraints

- Work only in the `kimi-in-codex` repository; do not modify the separate `kimi-in-claude-code` checkout.
- Preserve the current setup and frozen-review contracts.
- Make exactly one elevated Kimi runtime call per `$kimi-task` invocation, with no sandbox-first attempt or retry.
- Default native tasks to read-only; enable write access only for an explicit edit request or explicit user selection.
- Treat elevated task execution as normal user filesystem authority, not an OS sandbox.
- Support foreground one-shot execution only; keep background jobs and durable status/result/cancel under KMP-32.
- Resume only an exact ACP `sessionId` already returned in the current Codex conversation; never guess from repository job history.
- End compound verification commands with `&& echo GATE-GREEN || echo GATE-FAILED` and confirm the printed sentinel.
- Follow TDD for every behavior change and mutation-check the read-only default plus both cancellation legs.

---

### Task 1: Add the one-shot CLI contract and exact-session resume

**Files:**

- Modify: `plugins/kimi/tests/kimi-companion.test.mjs:120-390`
- Modify: `plugins/kimi/scripts/kimi-companion.mjs:70-90, 530-612, 718-782, 1050-1110`

**Interfaces:**

- Consumes: existing `executeTaskRun(request)`, `resolveRequestedModel(value)`, `readTaskPrompt(cwd, options, positionals)`, and `runKimiTurn({ resumeSessionId })`.
- Produces: `task --codex-once --json [--prompt-file path] [--read-only|--write] [--fresh|--resume-session id] [--model value]` and a terminal JSON envelope with `taskStatus`.
- Preserves: the existing legacy foreground/background task path when `--codex-once` is absent.

- [ ] **Step 1: Add failing one-shot CLI tests**

Add focused scenarios to `kimi-companion.test.mjs` that assert:

```js
const before = JSON.parse(runCli(["status", "--json", "--all"], { env, cwd }).stdout);
const run = runCli([
  "task", "--codex-once", "--json", "--read-only",
  "--prompt-file", promptFile
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
```

Use the `prompt-echo` fixture and a temporary prompt containing newlines, quotes, backslashes, and literal `--write`; assert the echoed user portion is byte-identical after removing the documented read-only preamble.

Add negative cases:

```js
for (const args of [
  ["--codex-once", "--background", "x"],
  ["--codex-once", "--resume-last"],
  ["--codex-once", "--resume"],
  ["--codex-once", "--fresh", "--resume-session", "sess-1", "x"]
]) {
  const result = runCli(["task", "--json", ...args], { env, cwd });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).taskStatus, "FAILED");
}
```

Add an exact-resume case using the `resume-check` fixture: run a fresh one-shot, capture its `sessionId`, then call `--resume-session <captured>` and assert the fixture reports `resumed-session` and the returned ID is unchanged.

- [ ] **Step 2: Run the companion suite and confirm RED**

Run:

```bash
node plugins/kimi/tests/kimi-companion.test.mjs && echo RED-UNEXPECTED-GREEN || echo RED-EXPECTED-FAIL
```

Expected: `RED-EXPECTED-FAIL` because `--codex-once`, `--resume-session`, and `taskStatus` are not implemented.

- [ ] **Step 3: Implement one-shot option parsing and validation**

In `handleTask`, add `resume-session` to `valueOptions` and `codex-once` to `booleanOptions`. Validate before any job is created:

```js
const codexOnce = Boolean(options["codex-once"]);
const resumeSessionId = options["resume-session"] == null
  ? null
  : String(options["resume-session"]).trim();

if (codexOnce && options.background) {
  throw new Error("Codex one-shot tasks do not support --background; durable jobs remain deferred.");
}
if (codexOnce && (options.resume || options["resume-last"])) {
  throw new Error("Codex one-shot resume requires --resume-session <exact-session-id>.");
}
if (resumeSessionId && options.fresh) {
  throw new Error("Choose either --fresh or --resume-session.");
}
if (Object.hasOwn(options, "resume-session") && !resumeSessionId) {
  throw new Error("--resume-session requires a non-empty ACP session id.");
}
```

Keep legacy `resumeLast` resolution unchanged outside one-shot mode. In one-shot mode, build the request directly with `resumeSessionId`; do not call `buildTaskJob`, `resolveLatestTrackedTaskSession`, or any state-writing helper.

- [ ] **Step 4: Implement the terminal envelope and progress separation**

Add focused helpers near `runForegroundCommand`:

```js
function classifyTaskExecution(execution) {
  if (execution.cancelled) return "CANCELLED";
  return execution.exitStatus === 0 ? "COMPLETED" : "FAILED";
}

async function runCodexOneShotTask(request) {
  const progress = createProgressReporter({ stderr: true });
  const execution = await executeTaskRun({ ...request, onProgress: progress });
  const payload = {
    taskStatus: classifyTaskExecution(execution),
    ...execution.payload
  };
  outputResult(payload, true);
  if (execution.exitStatus !== 0) process.exitCode = execution.exitStatus;
  return execution;
}
```

Route `codexOnce` to this helper and return before legacy job creation. Add `hasCodexOneShotIntent(argv)` beside `hasFrozenReviewIntent`; in `main().catch`, emit exactly one JSON object for one-shot JSON failures:

```js
console.log(JSON.stringify({ taskStatus: "FAILED", error: message }, null, 2));
```

Keep the concrete error on stderr and set a nonzero exit code.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run:

```bash
node plugins/kimi/tests/kimi-companion.test.mjs && echo TASK-ONCE-GREEN || echo TASK-ONCE-FAILED
```

Expected: `KIMI-COMPANION-TESTS-GREEN` followed by `TASK-ONCE-GREEN`.

- [ ] **Step 6: Commit the one-shot CLI slice**

```bash
git add plugins/kimi/scripts/kimi-companion.mjs plugins/kimi/tests/kimi-companion.test.mjs
git diff --cached --check
git commit -m "feat: add Codex one-shot Kimi tasks"
```

### Task 2: Make interruption cancel the exact active Kimi turn

**Files:**

- Modify: `plugins/kimi/tests/fixtures/fake-acp-agent.mjs:20-180`
- Modify: `plugins/kimi/tests/acp-broker.test.mjs:120-230`
- Modify: `plugins/kimi/tests/kimi-companion.test.mjs:390-480`
- Modify: `plugins/kimi/scripts/lib/acp-client.mjs:35-115, 390-430`
- Modify: `plugins/kimi/scripts/lib/kimi.mjs:571-705`
- Modify: `plugins/kimi/scripts/acp-broker.mjs:70-225, 227-271`
- Modify: `plugins/kimi/scripts/kimi-companion.mjs:530-612, 659-782`

**Interfaces:**

- Extends: `client.setSessionPermissionDecision(sessionId, decision, { cancelOnDisconnect })`.
- Extends: `newSession(client, cwd, { permissionDecision, cancelOnDisconnect })` and `runKimiTurn(cwd, { signal, cancelOnDisconnect })`.
- Produces: graceful `AbortSignal` cancellation plus broker fallback cancellation when the one-shot client disconnects.
- Preserves: legacy clients default to `cancelOnDisconnect: false` and continue to satisfy the existing “dead client stays busy until turn finishes” test.

- [ ] **Step 1: Add failing broker disconnect tests**

Extend the `cancellable` fixture to record whether `session/cancel` arrived. In `acp-broker.test.mjs`, create a one-shot-owned session, start a held prompt, destroy its socket, and assert the held prompt is cancelled and a second client can start a session inside the deadline.

Pin legacy behavior separately by retaining the existing slow-prompt disconnect test unchanged.

Use this policy call in the new test:

```js
const taskSession = await newSession(clientA, cwd);
await clientA.setSessionPermissionDecision(taskSession.sessionId, "reject", {
  cancelOnDisconnect: true
});
```

- [ ] **Step 2: Add failing SIGINT and no-post-cancel-write tests**

Add a fixture scenario that holds a prompt and writes `KIMI_FAKE_POST_CANCEL_MARKER` only if it reaches its normal delayed completion. Spawn the one-shot CLI, wait until its session is active, send `SIGINT`, and assert:

```js
assert.notEqual(exited.code, 0);
const payload = JSON.parse(stdout);
assert.equal(payload.taskStatus, "CANCELLED");
assert.equal(fs.existsSync(postCancelMarker), false);
```

Then open a new broker client and assert `session/new` succeeds rather than returning `BROKER_BUSY_RPC_CODE`.

- [ ] **Step 3: Run broker and companion suites and confirm RED**

Run:

```bash
node plugins/kimi/tests/acp-broker.test.mjs && node plugins/kimi/tests/kimi-companion.test.mjs && echo RED-UNEXPECTED-GREEN || echo RED-EXPECTED-FAIL
```

Expected: `RED-EXPECTED-FAIL` because session policy has no disconnect option and the CLI has no abort handling.

- [ ] **Step 4: Extend the client and broker policy contract**

Keep the existing method name and add an optional third argument:

```js
setSessionPermissionDecision(sessionId, decision, options = {})
```

For broker clients, send:

```js
return this.request("broker/session_policy", {
  sessionId,
  decision,
  cancelOnDisconnect: Boolean(options.cancelOnDisconnect)
});
```

In `acp-broker.mjs`, maintain:

```js
const cancelOnDisconnectSessions = new Set();
const activeSessionBySocket = new Map();
```

Update those structures only after ownership validation. When forwarding `session/prompt`, record its `sessionId` for that socket. On socket close/error, call one idempotent helper that sends `appClient.notify("session/cancel", { sessionId })` only when the owned active session opted in. Do not clear `activeSocket` there; the existing request `finally` remains the sole release point.

- [ ] **Step 5: Thread cancellation options through the Kimi turn**

Extend `newSession` and the resume policy call to pass `cancelOnDisconnect`. Extend `runKimiTurn` with `signal`. After `sessionId` is known, install one abort listener that sends:

```js
client.notify("session/cancel", { sessionId });
```

Remove the listener in `finally`. If the signal is already aborted, notify before starting the prompt. Preserve the terminal `stopReason: "cancelled"` returned by the agent.

- [ ] **Step 6: Bind process signals only around one-shot execution**

In `runCodexOneShotTask`, create an `AbortController`. Register `process.once("SIGINT", abort)` and `process.once("SIGTERM", abort)` immediately before `executeTaskRun`, pass `signal` and `cancelOnDisconnect: true`, then remove both listeners in `finally`.

Set `taskStatus: "CANCELLED"` only when the engine reports `stopReason === "cancelled"`. If the bounded wait expires or the client exits without that confirmation, emit `FAILED` with `cancellation unconfirmed` and leave a nonzero exit status.

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run:

```bash
node plugins/kimi/tests/acp-broker.test.mjs && node plugins/kimi/tests/kimi-companion.test.mjs && echo CANCEL-GATE-GREEN || echo CANCEL-GATE-FAILED
```

Expected: both suite sentinels followed by `CANCEL-GATE-GREEN`.

- [ ] **Step 8: Commit cancellation ownership**

```bash
git add plugins/kimi/scripts/acp-broker.mjs plugins/kimi/scripts/kimi-companion.mjs plugins/kimi/scripts/lib/acp-client.mjs plugins/kimi/scripts/lib/kimi.mjs plugins/kimi/tests/acp-broker.test.mjs plugins/kimi/tests/kimi-companion.test.mjs plugins/kimi/tests/fixtures/fake-acp-agent.mjs
git diff --cached --check
git commit -m "fix: cancel interrupted Codex Kimi tasks"
```

### Task 3: Add the public `$kimi-task` skill and package contract

**Files:**

- Create: `plugins/kimi/skills/kimi-task/SKILL.md`
- Create: `plugins/kimi/skills/kimi-task/agents/openai.yaml`
- Modify: `plugins/kimi/tests/codex-plugin-surface.test.mjs:1-90`
- Modify: `plugins/kimi/.codex-plugin/plugin.json:1-25`

**Interfaces:**

- Consumes: the `task --codex-once` CLI from Task 1 and the elevation pattern in `kimi-setup`/`kimi-review`.
- Produces: user-invocable `$kimi-task` with model, access, fresh, and exact-session controls.
- Does not produce: background, durable status/result, durable cancellation, or rescue behavior.

- [ ] **Step 1: Add failing package-surface assertions**

Extend `codex-plugin-surface.test.mjs` to assert the new skill and metadata exist and that the skill:

```js
assert.match(taskSkill, /task --codex-once --json/);
assert.equal(taskSkill.match(/kimi-companion\.mjs" task/g)?.length, 1);
assert.match(taskSkill, /sandbox_permissions:\s*["`]require_escalated["`]/);
assert.match(taskSkill, /default.*read-only/i);
assert.match(taskSkill, /normal user filesystem authority/i);
assert.match(taskSkill, /not (?:an )?OS sandbox/i);
assert.match(taskSkill, /--resume-session/);
assert.match(taskSkill, /background.*not supported|not support.*background/i);
assert.doesNotMatch(taskSkill, /\$kimi-status|\$kimi-result|\$kimi-cancel/);
```

Assert the manifest description/default prompt mention task handoff, `capabilities` contains both `Read` and `Write`, and the long description still says background lifecycle is not included.

- [ ] **Step 2: Run the surface test and confirm RED**

Run:

```bash
node plugins/kimi/tests/codex-plugin-surface.test.mjs && echo RED-UNEXPECTED-GREEN || echo RED-EXPECTED-FAIL
```

Expected: `RED-EXPECTED-FAIL` because `kimi-task` is absent.

- [ ] **Step 3: Write the task skill**

Create frontmatter containing only `name` and `description`. The workflow must:

1. resolve access intent, defaulting to read-only;
2. require explicit user edit intent or selection before `--write`;
3. resolve fresh versus exact `sessionId` resume without guessing;
4. preserve prompt bytes through a temporary UTF-8 prompt file;
5. resolve `PLUGIN_ROOT` from the skill path;
6. issue one mode-specific `require_escalated` foreground invocation;
7. forbid sandbox-first execution, retry, background, and legacy status/result/cancel;
8. validate `taskStatus` and present Kimi’s result, permission evidence, session ID, and touched files;
9. remove the temporary prompt file without changing repository content.

Use this single runtime command shape:

```bash
node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" task --codex-once --json --prompt-file "${PROMPT_FILE}" "${ACCESS_FLAG}" "${SESSION_FLAG}" ${MODEL_ARGS}
```

The skill must instruct Codex to construct the argument array safely rather than interpolate an untrusted model or session value through a shell string.

- [ ] **Step 4: Add native metadata and update the manifest**

Create `openai.yaml`:

```yaml
interface:
  display_name: "Kimi Task"
  short_description: "Hand one foreground task to Kimi"
  default_prompt: "Use $kimi-task to hand this task to Kimi in read-only mode."
```

Update manifest descriptions, keywords, capabilities, and default prompts to advertise setup, frozen review, and foreground task handoff while explicitly excluding background/durable lifecycle.

- [ ] **Step 5: Validate and confirm GREEN**

Run:

```bash
node plugins/kimi/tests/codex-plugin-surface.test.mjs && \
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/kimi/skills/kimi-task && \
echo TASK-SKILL-GREEN || echo TASK-SKILL-FAILED
```

Expected: surface sentinel, `Skill is valid!`, and `TASK-SKILL-GREEN`.

- [ ] **Step 6: Commit the native skill slice**

```bash
git add plugins/kimi/.codex-plugin/plugin.json plugins/kimi/skills/kimi-task plugins/kimi/tests/codex-plugin-surface.test.mjs
git diff --cached --check
git commit -m "feat: add native Kimi task skill"
```

### Task 4: Update the support boundary documentation

**Files:**

- Modify: `README.md:1-60`
- Modify: `AGENTS.md:1-45`
- Modify: `docs/PLAN.md:3-18`
- Modify: `docs/ROADMAP.md:60-70`

**Interfaces:**

- Consumes: the verified task contract from Tasks 1-3.
- Produces: truthful public and maintainer documentation for foreground task support.
- Preserves: KMP-30 remains unchecked until Task 5’s deterministic and live gates pass; KMP-32 remains open.

- [ ] **Step 1: Update docs without claiming unverified completion**

Document:

- `$kimi-task` foreground-only support;
- read-only default and explicit-write approval;
- normal user filesystem authority and absence of an OS sandbox;
- exact-session resume only;
- current-call status/result/cancellation ownership;
- background and durable lifecycle still deferred to KMP-32.

Update the root DOX index to list `plugins/kimi/skills/kimi-task/` and its runtime contracts. Do not mark KMP-30 complete yet.

- [ ] **Step 2: Run documentation and package consistency checks**

Run:

```bash
node plugins/kimi/tests/codex-plugin-surface.test.mjs && \
node plugins/kimi/tests/plugin-surface.test.mjs && \
rg -n "background|read-only|write|resume-session|normal user filesystem authority" README.md AGENTS.md docs/PLAN.md docs/ROADMAP.md plugins/kimi/skills/kimi-task/SKILL.md && \
echo DOC-GATE-GREEN || echo DOC-GATE-FAILED
```

Expected: both test sentinels, matching support-boundary lines, and `DOC-GATE-GREEN`.

- [ ] **Step 3: Commit documentation sync**

```bash
git add README.md AGENTS.md docs/PLAN.md docs/ROADMAP.md
git diff --cached --check
git commit -m "docs: document native Kimi task boundary"
```

### Task 5: Mutation-check, run the full gate, and prove Kimi 1.49 live

**Files:**

- Modify after all gates pass: `docs/ROADMAP.md:60-70`
- Verify: all files changed in Tasks 1-4

**Interfaces:**

- Consumes: completed one-shot runtime, cancellation contract, skill, manifest, and docs.
- Produces: mutation evidence, eight-suite deterministic evidence, live Kimi 1.49 evidence, and the final KMP-30 tracker update.

- [ ] **Step 1: Mutation-check the read-only default**

Use `apply_patch` to alter only the one-shot access default so an absent `--write` becomes write-enabled. Print the exact diff hunk, run the focused companion test, and confirm the default-read-only assertion fails. Apply the exact reverse patch and rerun the focused suite to green.

Expected mutation result: the permission test observes `decision: "allow"` instead of `"reject"`.

- [ ] **Step 2: Mutation-check graceful cancellation**

Use `apply_patch` to remove only the one-shot abort handler’s `session/cancel` notification. Print the exact diff hunk and run the SIGINT-focused companion scenario. Confirm it fails because cancellation is unconfirmed, the marker appears, or the broker remains busy. Apply the reverse patch and rerun green.

- [ ] **Step 3: Mutation-check disconnect cancellation**

Use `apply_patch` to disable only the broker’s cancel-on-disconnect notification. Print the exact diff hunk and run the focused broker scenario. Confirm it fails while the legacy survive-disconnect test still describes the unchanged default. Apply the reverse patch and rerun both tests green.

- [ ] **Step 4: Run all eight deterministic suites**

Run outside the filesystem sandbox if temporary Unix-socket listen is denied:

```bash
node plugins/kimi/tests/codex-plugin-surface.test.mjs && \
node plugins/kimi/tests/plugin-surface.test.mjs && \
node plugins/kimi/tests/acp-client.test.mjs && \
node plugins/kimi/tests/kimi.test.mjs && \
node plugins/kimi/tests/acp-broker.test.mjs && \
node plugins/kimi/tests/kimi-companion.test.mjs && \
node plugins/kimi/tests/hooks.test.mjs && \
node plugins/kimi/tests/render.test.mjs && \
echo GATE-GREEN || echo GATE-FAILED
```

Expected: all eight suite sentinels followed by `GATE-GREEN`.

- [ ] **Step 5: Run plugin and skill validators**

Run the repository’s plugin-creator validator against `plugins/kimi` and the skill-creator validator against `plugins/kimi/skills/kimi-task`. Confirm both validators exit zero and print their success output.

- [ ] **Step 6: Run the live read-only and exact-resume canaries**

Create a disposable scratch Git repository and record its clean status. Invoke `$kimi-task` once in read-only fresh mode with a unique codeword and ask Kimi to inspect the scratch repository without editing it and remember the codeword. Verify:

- `taskStatus: "COMPLETED"`;
- a non-empty exact `sessionId`;
- no changed scratch files;
- no permission event with `decision: "allow"`.

Invoke once more with `--resume-session <exact-id>` and ask for the codeword. Verify the same session ID and exact codeword return.

- [ ] **Step 7: Run the live explicit-write canary**

With a fresh disposable scratch repository, approve one write-mode invocation asking Kimi to create only `canary-output.txt` with a unique literal. Verify the file bytes, `taskStatus: "COMPLETED"`, at least one recorded allow decision when Kimi requests permission, and `touchedFiles` contains the scratch target. Confirm no paths outside the scratch repository changed as part of the canary evidence.

- [ ] **Step 8: Run the live interrupt canary**

Start one slow one-shot task in a disposable scratch repository, interrupt the foreground process, and verify the terminal envelope is `CANCELLED` with the exact session ID. Then use a raw broker connection to run `session/new`; it must succeed without `BROKER_BUSY`. Confirm no scratch writes appear after the cancellation timestamp.

- [ ] **Step 9: Mark KMP-30 complete and commit the gate receipt**

Update `docs/ROADMAP.md` with the date, exact deterministic sentinel, validator results, mutation outcomes, and four live canary results. Keep KMP-32 unchecked.

```bash
git add docs/ROADMAP.md
git diff --cached --check
git commit -m "docs: record native Kimi task verification"
```

- [ ] **Step 10: Run the final clean-tree and scope check**

Run:

```bash
git diff --check HEAD~5..HEAD && \
git status --short && \
git log -5 --oneline && \
echo FINAL-GATE-GREEN || echo FINAL-GATE-FAILED
```

Expected: no whitespace errors, only intentionally pre-existing worktree changes remain, five scoped implementation commits are visible, and `FINAL-GATE-GREEN` prints.

## Execution handoff

Recommended execution mode: use `superpowers:subagent-driven-development` so each task receives a fresh implementation context and an independent spec-compliance review before the next task. Inline execution through `superpowers:executing-plans` is also valid if the coordinator prefers one continuous worker.
