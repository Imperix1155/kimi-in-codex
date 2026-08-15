# Codex-Native Setup Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing Kimi engine as a Codex plugin and verify one native `kimi-setup` workflow.

**Architecture:** Move the existing plugin tree to the repo-standard `plugins/kimi` location without changing the engine. Add a Codex manifest, repo marketplace entry, and one setup skill that calls the existing runtime through `${PLUGIN_ROOT}`.

**Tech Stack:** Node.js ESM, JSON plugin manifests, Agent Skills Markdown/YAML.

## Global Constraints

- Never modify a checkout of the separate `Imperix1155/kimi-in-claude-code` source repository.
- Preserve the full source history in the target repository.
- Advertise only `kimi-setup` in this slice.
- Do not claim behavioral equivalence for tasks, reviews, job controls, rescue, or hooks.
- Every verification gate must print and confirm `GATE-GREEN` or `GATE-FAILED`.

---

### Task 1: Codex package contract

**Files:**
- Create: `plugin/tests/codex-plugin-surface.test.mjs`, then move with the plugin tree to `plugins/kimi/tests/codex-plugin-surface.test.mjs`
- Create: `plugins/kimi/.codex-plugin/plugin.json`
- Create: `.agents/plugins/marketplace.json`

**Interfaces:**
- Consumes: the existing `plugin/` runtime tree
- Produces: a validated plugin named `kimi` at `plugins/kimi`

- [x] **Step 1: Write the failing package-surface test**

Assert the exact marketplace path `./plugins/kimi`, manifest name/version/skills path, and that the manifest does not advertise hooks, MCP servers, or apps.

- [x] **Step 2: Run the test to verify it fails**

Run: `node plugin/tests/codex-plugin-surface.test.mjs`

Expected: FAIL because `plugins/kimi/.codex-plugin/plugin.json` does not exist.

- [x] **Step 3: Move the plugin tree and scaffold the Codex manifest**

Run the plugin-creator scaffold against `plugins/kimi`, then replace its generic metadata with repository-specific values.

- [x] **Step 4: Add the repository marketplace entry**

Create `.agents/plugins/marketplace.json` with marketplace `imperix`, plugin `kimi`, and source `./plugins/kimi`.

### Task 2: Native setup skill

**Files:**
- Create: `plugins/kimi/skills/kimi-setup/SKILL.md`
- Create: `plugins/kimi/skills/kimi-setup/agents/openai.yaml`
- Modify: `plugins/kimi/tests/codex-plugin-surface.test.mjs`

**Interfaces:**
- Consumes: `${PLUGIN_ROOT}/scripts/kimi-companion.mjs setup`
- Produces: explicit/implicit Codex setup workflow named `kimi-setup`

- [x] **Step 1: Extend the failing test**

Assert the skill has only `name` and `description` frontmatter, uses `${PLUGIN_ROOT}`, calls exactly the `setup` subcommand, and does not mention the deferred task/review/job workflows as supported behavior.

- [x] **Step 2: Run the test to verify it fails**

Run: `node plugins/kimi/tests/codex-plugin-surface.test.mjs`

Expected: FAIL because `skills/kimi-setup/SKILL.md` does not exist.

- [x] **Step 3: Initialize and write the minimal skill**

Use the skill-creator initializer, then write imperative setup instructions and matching `agents/openai.yaml` metadata.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `node plugins/kimi/tests/codex-plugin-surface.test.mjs`

Expected: `CODEX-PLUGIN-SURFACE-GREEN`.

### Task 3: Documentation and full verification

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/PLAN.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: verified package and setup behavior
- Produces: accurate Codex scope and deferred-port ledger

- [x] **Step 1: Update repository documentation**

Describe the Codex target, installation surface, setup-only support, and deferred capabilities.

- [x] **Step 2: Validate generated artifacts**

Run the plugin validator, skill validator, migration target validator, focused surface test, all existing deterministic runtime tests, and the real setup probe.

- [ ] **Step 3: Re-run the secret scan**

Run gitleaks over all history and the new working tree before public push.

- [ ] **Step 4: Commit and publish**

Commit the target-only changes, push `main` to `Imperix1155/kimi-in-codex`, and verify remote visibility and HEAD.
