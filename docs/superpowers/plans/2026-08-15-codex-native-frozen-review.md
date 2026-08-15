# Codex-Native Frozen Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-native Kimi review leg that verifies and reviews one frozen diff artifact by SHA-256 and returns explicit, structured review provenance.

**Architecture:** Extend the existing foreground `review` command with a mutually exclusive frozen-artifact input mode. Keep broker/job state rooted in the caller repository, but create the Kimi session in a temporary empty directory and inline only the verified artifact bytes. Add a narrow `$kimi-review` skill over that mode; retain live Git modes only for legacy compatibility.

**Tech Stack:** Node.js ESM, Agent Client Protocol, SHA-256 via `node:crypto`, plain Node assertion tests, Codex plugin skills.

## Global Constraints

- Never modify the separate `Imperix1155/kimi-in-claude-code` checkout.
- Do not push, publish, or open a PR.
- Verify the saved artifact bytes and SHA-256 before probing or starting Kimi.
- Never fall back from frozen-artifact mode to live Git collection.
- A missing, unavailable, failed, empty, or invalid review is `NOT REVIEWED`, never clean.
- Preserve the existing client-enforced permission rejection and structured review schema.
- End compound gates with `GATE-GREEN` or `GATE-FAILED` and confirm the sentinel.

---

### Task 1: Frozen artifact runtime contract

**Files:**
- Modify: `plugins/kimi/tests/kimi-companion.test.mjs`
- Modify: `plugins/kimi/tests/fixtures/fake-acp-agent.mjs`
- Modify: `plugins/kimi/scripts/kimi-companion.mjs`
- Modify: `plugins/kimi/scripts/lib/kimi.mjs`

**Interfaces:**
- Consumes: `review --diff-file <path> --diff-sha256 <64-hex> --json [focus]`
- Produces: success payload `{ reviewStatus: "REVIEWED", target: { mode: "frozen-diff", diffSha256, byteCount }, result }`
- Produces: nonzero failure payload `{ reviewStatus: "NOT REVIEWED", error, expectedDiffSha256?, actualDiffSha256? }`
- Produces: `runKimiTurn(cwd, { sessionCwd })`, where broker state uses `cwd` and `session/new` uses `sessionCwd`

- [x] **Step 1: Write failing runtime tests**

Add cases that create a UTF-8 patch buffer and assert:

```js
const diff = "diff --git a/src/math.mjs b/src/math.mjs\n+const answer = 42;\n";
const digest = createHash("sha256").update(Buffer.from(diff)).digest("hex");
const review = runCli(["review", "--diff-file", diffFile, "--diff-sha256", digest, "--json"], { env, cwd });
assert.equal(review.status, 0);
const payload = JSON.parse(review.stdout);
assert.equal(payload.reviewStatus, "REVIEWED");
assert.equal(payload.target.mode, "frozen-diff");
assert.equal(payload.target.diffSha256, digest);
assert.equal(payload.target.byteCount, Buffer.byteLength(diff));
```

Also assert a malformed digest, mismatch, empty file, missing paired option, invalid structured Kimi response, and granted permission all exit nonzero with `reviewStatus: "NOT REVIEWED"`. For mismatch, configure the fake agent with a startup-marker path and assert the marker does not exist.

- [x] **Step 2: Run the focused suite and confirm RED**

Run:

```bash
node plugins/kimi/tests/kimi-companion.test.mjs
```

Expected: FAIL because `--diff-file` and `--diff-sha256` are unsupported and no provenance fields exist.

- [x] **Step 3: Implement verified artifact loading and explicit failures**

Add a `NotReviewedError` carrying optional expected/actual hashes. Add a helper that validates `/^[0-9a-fA-F]{64}$/`, reads one `Buffer`, rejects zero bytes, computes SHA-256, compares with `timingSafeEqual`, and decodes with `new TextDecoder("utf-8", { fatal: true })`. Parse `diff-file` and `diff-sha256` as paired value options and prohibit combining them with `--base`, `--scope`, or `--background`.

For JSON failures, print:

```json
{
  "reviewStatus": "NOT REVIEWED",
  "error": "Frozen diff SHA-256 mismatch.",
  "expectedDiffSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "actualDiffSha256": "1111111111111111111111111111111111111111111111111111111111111111"
}
```

For text failures, print `NOT REVIEWED: <reason>` to stderr and exit nonzero.

- [x] **Step 4: Implement exact prompt input and isolated session cwd**

Build frozen context directly from the verified buffer:

```js
{
  repoRoot,
  branch,
  target: { mode: "frozen-diff", label, diffSha256, byteCount },
  summary: `Reviewing frozen diff ${diffSha256} (${byteCount} bytes).`,
  inputMode: "frozen-inline-diff",
  collectionGuidance: "The inlined frozen diff is the complete review evidence. Do not inspect the live repository or use tools to collect other content.",
  content: decodedDiff
}
```

Create an empty directory with `fs.mkdtempSync(path.join(os.tmpdir(), "kimi-frozen-review-"))`; pass it as `sessionCwd` to `runKimiTurn`, then remove it in `finally`. Update `runKimiTurn` so only `session/new`/`session/load` receive `sessionCwd ?? cwd`; connection and state remain on `cwd`.

- [x] **Step 5: Verify GREEN and commit the runtime unit**

Run:

```bash
node plugins/kimi/tests/kimi-companion.test.mjs && echo GATE-GREEN || echo GATE-FAILED
```

Expected: `KIMI-COMPANION-TESTS-GREEN` then `GATE-GREEN`.

Commit locally:

```bash
git add plugins/kimi/scripts/kimi-companion.mjs plugins/kimi/scripts/lib/kimi.mjs plugins/kimi/tests/kimi-companion.test.mjs plugins/kimi/tests/fixtures/fake-acp-agent.mjs
git commit -m "feat: review frozen diffs by verified hash"
```

### Task 2: Native Codex review skill

**Files:**
- Modify: `plugins/kimi/tests/codex-plugin-surface.test.mjs`
- Create: `plugins/kimi/skills/kimi-review/SKILL.md`
- Create: `plugins/kimi/skills/kimi-review/agents/openai.yaml`
- Modify: `plugins/kimi/.codex-plugin/plugin.json`

**Interfaces:**
- Consumes: a caller-supplied absolute or cwd-relative diff artifact path plus 64-hex SHA-256
- Produces: one foreground invocation of the frozen runtime mode and a truthful `REVIEWED` or `NOT REVIEWED` report

- [x] **Step 1: Extend the package test and confirm RED**

Assert `kimi-review/SKILL.md` exists, has only `name` and `description` frontmatter, invokes:

```bash
node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" review --diff-file "${DIFF_FILE}" --diff-sha256 "${DIFF_SHA256}" --json
```

Assert the skill requires both inputs, forbids live-Git fallback/background behavior, preserves `NOT REVIEWED`, and contains no `$ARGUMENTS`, `AskUserQuestion`, or `CLAUDE_PLUGIN_ROOT`.

Run `node plugins/kimi/tests/codex-plugin-surface.test.mjs`; expect FAIL because `kimi-review` is absent.

- [x] **Step 2: Initialize and write the minimal skill**

Run the skill-creator initializer for `kimi-review` under `plugins/kimi/skills`. Write imperative instructions that resolve `PLUGIN_ROOT`, require `DIFF_FILE` and `DIFF_SHA256`, invoke the runtime exactly once, validate the returned status/hash/byte count, relay findings, and report any nonzero, malformed, or missing provenance as `NOT REVIEWED` without retrying another scope.

Use UI metadata:

```yaml
interface:
  display_name: "Kimi Review"
  short_description: "Review a frozen diff with Kimi"
  default_prompt: "Use $kimi-review to review this frozen diff artifact and verify its SHA-256."
```

Update plugin copy to advertise setup plus frozen adversarial review, while still excluding hooks, MCP, apps, task, and job-control equivalence.

- [x] **Step 3: Verify the skill and package surface**

Run:

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/kimi/skills/kimi-review && node plugins/kimi/tests/codex-plugin-surface.test.mjs && echo GATE-GREEN || echo GATE-FAILED
```

Expected: `Skill is valid!`, `CODEX-PLUGIN-SURFACE-GREEN`, `GATE-GREEN`.

- [x] **Step 4: Commit the native skill unit**

```bash
git add plugins/kimi/.codex-plugin/plugin.json plugins/kimi/skills/kimi-review plugins/kimi/tests/codex-plugin-surface.test.mjs
git commit -m "feat: add native frozen Kimi review skill"
```

### Task 3: Honest docs and verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/PLAN.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/superpowers/plans/2026-08-15-codex-native-frozen-review.md`

**Interfaces:**
- Consumes: verified runtime and skill behavior
- Produces: public documentation that distinguishes supported frozen review from deferred workflow orchestration

- [x] **Step 1: Update the closest owning documentation**

Document the exact command/skill contract, SHA-256 provenance, isolation, explicit failure semantics, and local-only auth. Mark only the frozen foreground review slice complete. Keep mutable Git review, background/status/result/cancel, hooks, task, rescue, automatic freezing/ledger orchestration, and MCP deferred.

- [x] **Step 2: Run validators and the deterministic battery**

Run the plugin validator, both skill validators, package surfaces, and all six engine suites. Confirm each named `*-GREEN` sentinel and finish with `GATE-GREEN`.

- [x] **Step 3: Run a safe live frozen review**

Create a temporary UTF-8 diff outside the repository, compute SHA-256, invoke frozen review with `--json`, and verify `reviewStatus`, `target.diffSha256`, `target.byteCount`, structured verdict, and zero permission grants. If local Kimi authentication is unavailable, record `NOT REVIEWED` and do not simulate success.

- [x] **Step 4: Run the DOX and secret/state checks**

Confirm the source checkout is clean and unchanged, target docs match the changed surfaces, `git diff --check` passes, no local paths or credential patterns were introduced, and the target worktree contains only intended changes.

- [x] **Step 5: Commit locally and stop before publication**

```bash
git add AGENTS.md README.md docs/PLAN.md docs/ROADMAP.md docs/superpowers/plans/2026-08-15-codex-native-frozen-review.md
git commit -m "docs: document frozen Kimi review support"
```

Verify local `HEAD` is ahead of `origin/main`, the worktree is clean, and do not push.
