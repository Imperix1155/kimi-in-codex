# Codex Broker Permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve actionable broker-startup evidence and make native `$kimi-review` request its single authenticated Kimi runtime invocation outside the default Codex sandbox.

**Architecture:** Keep the existing detached broker and local Kimi authentication. Capture a bounded broker-child outcome and log tail before teardown, propagate the evidence through the frozen-review JSON envelope, and encode the required narrow escalation in the native skill without adding retries or fallbacks.

**Tech Stack:** Node.js 22 ESM, Agent Client Protocol, plain Node assertion suites, Codex Agent Skills Markdown.

## Global Constraints

- Do not redirect or copy `KIMI_SHARE_DIR`, Kimi configuration, or OAuth credentials.
- Do not bypass the broker or alter ACP permission rejection.
- `$kimi-review` executes the companion exactly once and never falls back to mutable Git state or background job controls.
- Broker log evidence is capped and excludes environment, credential, prompt, and artifact dumps.
- Silence or any failed/invalid leg remains `NOT REVIEWED`.
- Do not modify VRX or `Imperix1155/kimi-in-claude-code`.
- Publish only a draft pull request; do not merge.

---

### Task 1: Broker startup diagnostics

**Files:**
- Modify: `plugins/kimi/tests/fixtures/fake-acp-agent.mjs`
- Modify: `plugins/kimi/tests/acp-broker.test.mjs`
- Modify: `plugins/kimi/scripts/acp-broker.mjs`
- Modify: `plugins/kimi/scripts/lib/broker-lifecycle.mjs`

**Interfaces:**
- Consumes: `ensureBrokerSession(cwd, options)` and the existing `--agent-spawn` fixture seam.
- Produces: `BrokerStartupError` with `data.brokerStartup = { reason, exitCode, signal, logTail, logTruncated, scriptPath, cwd, endpointKind }` and exported `BROKER_LOG_TAIL_BYTES`.

- [ ] **Step 1: Add a fixture scenario that exits like the observed Kimi failure**

Add an early `startup-home-log-denied` scenario that writes a representative `PermissionError: [Errno 1] Operation not permitted: '/Users/example/.kimi/logs/kimi.log'` to stderr and exits `1`. Add `startup-long-stderr` whose end marker follows more than twice `BROKER_LOG_TAIL_BYTES` worth of text.

- [ ] **Step 2: Write the failing broker regression**

Use `AcpClient.connect(cwd, { useBroker: true, brokerOptions: { extraBrokerArgs } })` and assert the thrown error exposes:

```js
assert.equal(error.data.brokerStartup.reason, "child-exit");
assert.equal(error.data.brokerStartup.exitCode, 1);
assert.equal(error.data.brokerStartup.signal, null);
assert.match(error.data.brokerStartup.logTail, /PermissionError.*kimi\.log/s);
assert.equal(error.data.brokerStartup.endpointKind, "unix");
```

Capture the generated session directory through `createBrokerEndpoint`, then assert the directory, socket, pid file, log file, process, and broker state are gone after rejection. For the long-stderr scenario, assert the retained tail is at most `BROKER_LOG_TAIL_BYTES`, includes the end marker, excludes the beginning marker, and sets `logTruncated: true`.

- [ ] **Step 3: Run the broker test and observe red**

Run outside the Codex sandbox because the suite intentionally starts detached broker processes:

```text
node plugins/kimi/tests/acp-broker.test.mjs
```

Expected: failure because the current implementation returns only the generic broker-start error and deletes the log evidence.

- [ ] **Step 4: Preserve the agent's stderr in the broker log**

In `acp-broker.mjs`, format the top-level failure from `error.message` plus the already-capped `error.data.stderr` when present. Do not print any other error data or environment.

- [ ] **Step 5: Capture child completion and capped log evidence before cleanup**

In `broker-lifecycle.mjs`, race endpoint readiness against the child `close` event. On child exit or readiness timeout, read only the last `BROKER_LOG_TAIL_BYTES` from `broker.log`, build `brokerStartup`, perform the existing teardown, and throw `BrokerStartupError`. A timeout records null exit/signal unless known; it never invents a child result.

- [ ] **Step 6: Run the focused broker test and observe green**

Run:

```text
node plugins/kimi/tests/acp-broker.test.mjs && echo BROKER-GATE-GREEN || echo BROKER-GATE-FAILED
```

Expected: `ACP-BROKER-TESTS-GREEN` and `BROKER-GATE-GREEN`.

- [ ] **Step 7: Commit the broker diagnostics checkpoint**

```text
git add plugins/kimi/scripts/acp-broker.mjs plugins/kimi/scripts/lib/broker-lifecycle.mjs plugins/kimi/tests/acp-broker.test.mjs plugins/kimi/tests/fixtures/fake-acp-agent.mjs
git commit -m "fix: preserve Kimi broker startup evidence"
```

### Task 2: Structured failure propagation and native elevation

**Files:**
- Modify: `plugins/kimi/tests/kimi-companion.test.mjs`
- Modify: `plugins/kimi/tests/codex-plugin-surface.test.mjs`
- Modify: `plugins/kimi/scripts/kimi-companion.mjs`
- Modify: `plugins/kimi/skills/kimi-review/SKILL.md`

**Interfaces:**
- Consumes: `error.data.brokerStartup` from Task 1 and the existing frozen-review JSON failure envelope.
- Produces: top-level `brokerStartup` evidence on structured `NOT REVIEWED` and one skill-directed `sandbox_permissions: "require_escalated"` runtime call.

- [ ] **Step 1: Write failing companion and package-surface tests**

Add a frozen review using `startup-home-log-denied`; require exit nonzero, exact artifact SHA/bytes, `reviewStatus: "NOT REVIEWED"`, and `payload.brokerStartup.reason === "child-exit"` with the permission error in its capped log tail. Extend the package test to require:

```js
assert.match(reviewSkill, /sandbox_permissions:\s*["`]require_escalated["`]/);
assert.match(reviewSkill, /authenticated local Kimi runtime/i);
assert.match(reviewSkill, /Do not first attempt.*sandbox/i);
```

Retain the existing assertion that the Node review command occurs exactly once.

- [ ] **Step 2: Run both focused tests and observe red**

```text
node plugins/kimi/tests/kimi-companion.test.mjs
node plugins/kimi/tests/codex-plugin-surface.test.mjs
```

Expected: companion failure because `brokerStartup` is not serialized, and package failure because the skill lacks the elevated-execution contract.

- [ ] **Step 3: Propagate broker evidence in frozen JSON failures**

In `kimi-companion.mjs`, add only `error.data.brokerStartup` to the frozen failure details:

```js
const details = error instanceof NotReviewedError
  ? error.details
  : error?.data?.brokerStartup
    ? { brokerStartup: error.data.brokerStartup }
    : {};
```

- [ ] **Step 4: Encode one narrowly elevated native review invocation**

Update `kimi-review/SKILL.md` so the existing command runs once with `sandbox_permissions: "require_escalated"` and a justification limited to the authenticated local Kimi runtime, `~/.kimi` state/log access, and outbound model connection. Explicitly forbid a preliminary sandboxed attempt and preserve all no-retry/no-fallback/read-only rules.

- [ ] **Step 5: Run focused tests and validators green**

```text
node plugins/kimi/tests/kimi-companion.test.mjs
node plugins/kimi/tests/codex-plugin-surface.test.mjs
python3 /Users/imperix/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/kimi/skills/kimi-review
```

Expected: both suite sentinels and `Skill is valid!`.

- [ ] **Step 6: Update DOX and user-facing documentation**

Update `AGENTS.md`, `README.md`, `docs/PLAN.md`, and `docs/ROADMAP.md` to state that native review requires one approved elevated execution for Kimi's local auth/log state and network, while preserving `NOT REVIEWED` and deferred surfaces. Do not describe broader write access or equivalence.

- [ ] **Step 7: Commit the native permission checkpoint**

```text
git add AGENTS.md README.md docs/PLAN.md docs/ROADMAP.md plugins/kimi/scripts/kimi-companion.mjs plugins/kimi/skills/kimi-review/SKILL.md plugins/kimi/tests/kimi-companion.test.mjs plugins/kimi/tests/codex-plugin-surface.test.mjs
git commit -m "fix: authorize native Kimi review runtime"
```

### Task 3: Verification, installed canary, review, and draft publication

**Files:**
- Modify only if an exact-scope finding requires a reviewed fix; otherwise verification and publication are state changes outside the tree.

**Interfaces:**
- Consumes: the exact final branch diff and local marketplace installation route.
- Produces: deterministic/live evidence, an installed fresh-task canary, final review artifacts, and a draft PR.

- [ ] **Step 1: Run the complete local deterministic gate outside the sandbox**

Run all eight commands from `.github/workflows/ci.yml`, require every named sentinel, and finish with `GATE-GREEN`.

- [ ] **Step 2: Run plugin/skill validators and secret scan**

Validate the plugin plus both native skills. Run gitleaks over the exact branch diff/history scope used by the repository release process. Any real finding blocks publication.

- [ ] **Step 3: Run the bounded live ACP spike**

Run `node spike/acp-spike.mjs`; require `SPIKE-GREEN`. Silence beyond its deadman is failure.

- [ ] **Step 4: Install the branch plugin and perform the fresh-task canary**

Install the local branch marketplace build without modifying repository files. Create a harmless frozen diff containing an explicit divide-by-zero correctness defect, compute SHA-256 and byte count, then create a fresh Codex task whose prompt invokes `$kimi-review` with those values. Require one elevated runtime approval, structured `REVIEWED`, exact SHA/bytes, zero granted permissions, and a finding for the seeded defect before the deadman. Otherwise record `NOT REVIEWED` and stop.

- [ ] **Step 5: Freeze and review the exact final diff**

Run the repository review-loop tier required for broker/permission/security-surface work. Triage every actionable finding. If a material fix changes the diff, rerun affected gates and exact-artifact review.

- [ ] **Step 6: Publish a new branch and draft pull request**

Push `codex/fix-kimi-broker-permissions`, open a draft PR with the root cause, security model, red/green evidence, canary provenance, and explicit no-merge status. Wait for exact-head GitHub Actions and report CodeRabbit/Kimi availability honestly. Do not merge.
