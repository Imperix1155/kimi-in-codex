# AGENTS.md — Kimi in Codex

## Purpose

A Codex-native plugin that connects Codex to Kimi Code CLI through the existing Agent Client Protocol engine. Public target: `github.com/Imperix1155/kimi-in-codex` (Apache-2.0). The source repository `github.com/Imperix1155/kimi-in-claude-code` is a separate, untouched Claude Code fallback.

The current Codex support boundary is deliberately narrow: `kimi-setup` and foreground `kimi-review` of a caller-supplied frozen diff plus SHA-256 are implemented. Task, mutable-tree review orchestration, job-control, rescue, and hook surfaces remain migration work and must not be described as equivalent.

## Local contracts

- [`docs/PLAN.md`](./docs/PLAN.md) owns architecture, port scope, gates, and deferred surfaces.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) is the issue tracker (`KMP-##` checkboxes).
- The native plugin lives at [`plugins/kimi/`](./plugins/kimi), with its manifest at `plugins/kimi/.codex-plugin/plugin.json`.
- The repository marketplace is [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json).
- Preserve the proven Node/ACP engine unless a port requirement has a test that demonstrates the needed change.
- Do not modify a checkout of the separate `Imperix1155/kimi-in-claude-code` source repository.

## Runtime contracts

- Reviews are read-only only when the engine's permission-rejection path is actually used and verified; Codex wrappers must not assume Kimi has a sandbox.
- Native frozen review reads one artifact buffer, verifies its SHA-256 before Kimi starts, inlines that buffer, and uses an empty temporary ACP session cwd. A missing, mismatched, unavailable, or structurally invalid leg is `NOT REVIEWED`.
- The Codex review skill must never fall back from frozen evidence to a mutable working tree, branch, or background job.
- ACP is bidirectional. Every agent-to-client request must receive a response or the turn can hang. Unknown requests receive JSON-RPC `-32601`.
- Existing state uses `KIMI_COMPANION_DATA`, then the legacy `CLAUDE_PLUGIN_DATA` fallback. Codex-specific `PLUGIN_DATA` behavior is deferred until it is implemented and tested.

## Verification

- Native package surface: `node plugins/kimi/tests/codex-plugin-surface.test.mjs` → `CODEX-PLUGIN-SURFACE-GREEN`.
- Legacy package consistency: `node plugins/kimi/tests/plugin-surface.test.mjs` → `PLUGIN-SURFACE-TESTS-GREEN`.
- Deterministic engine suites: `acp-client`, `kimi`, `acp-broker`, `kimi-companion`, `hooks`, and `render` under `plugins/kimi/tests/`; each prints its own `*-GREEN` sentinel.
- Run all package and engine suites after changes under `plugins/kimi/scripts/` or hook scripts.
- Live ACP regression: `node spike/acp-spike.mjs` → `SPIKE-GREEN` (requires `kimi login`).
- Validate the plugin with the plugin-creator validator and every new skill with the skill-creator validator.
- Frozen review live probe: `node plugins/kimi/scripts/kimi-companion.mjs review --diff-file <path> --diff-sha256 <64-hex> --json` must return `REVIEWED` with matching hash/bytes, or explicit `NOT REVIEWED` nonzero.
- End compound gates with `&& echo GATE-GREEN || echo GATE-FAILED` and confirm the printed sentinel.

## Child DOX index

- `plugins/kimi/.codex-plugin/plugin.json` — advertised Codex components; currently skills only.
- `plugins/kimi/skills/kimi-setup/` — native setup readiness workflow.
- `plugins/kimi/skills/kimi-review/` — native SHA-pinned frozen-diff review workflow.
- `plugins/kimi/scripts/` — Node/ACP engine and broker/job-control implementation.
- `plugins/kimi/tests/` — plain Node assertion suites and scripted fake ACP agent.
- `plugins/kimi/commands/`, `agents/`, `.claude-plugin/`, and `hooks/` — Claude migration source material; not Codex-supported merely because it remains in the tree.
- `.claude-plugin/marketplace.json` and `CLAUDE.md` — legacy compatibility artifacts in the target copy, not the target distribution surface.
