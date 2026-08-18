# AGENTS.md — Kimi in Codex

## Purpose

A Codex-native plugin that connects Codex to Kimi Code CLI through the existing Agent Client Protocol engine. Public target: `github.com/Imperix1155/kimi-in-codex` (Apache-2.0). The source repository `github.com/Imperix1155/kimi-in-claude-code` is a separate, untouched Claude Code fallback.

The current Codex support boundary is deliberately narrow: `kimi-setup`, foreground `kimi-review` of a caller-supplied frozen diff plus SHA-256, a `$kimi-task` handoff (foreground, or one read-only background job), and `$kimi-job` observation/termination by exact job ID are implemented. Background execution is read-only, one at a time per workspace, TTL-bounded, addressed by exact job ID only, with content released only to the claim token; write-enabled background execution, mutable-tree review orchestration, rescue, and hook surfaces remain migration work and must not be described as equivalent.

## Local contracts

- [`docs/PLAN.md`](./docs/PLAN.md) owns architecture, port scope, gates, and deferred surfaces.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) is the issue tracker (`KMP-##` checkboxes).
- The native plugin lives at [`plugins/kimi/`](./plugins/kimi), with its manifest at `plugins/kimi/.codex-plugin/plugin.json`.
- The repository marketplace is [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json).
- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) is the public pull-request and `main` CI gate; keep its token read-only and its action revisions immutable.
- Preserve the proven Node/ACP engine unless a port requirement has a test that demonstrates the needed change.
- Do not modify a checkout of the separate `Imperix1155/kimi-in-claude-code` source repository.

## Runtime contracts

- Reviews are read-only only when the engine's permission-rejection path is actually used and verified; Codex wrappers must not assume Kimi has a sandbox.
- Native frozen review reads one artifact buffer, verifies its SHA-256 before Kimi starts, inlines that buffer, and uses an empty temporary ACP session cwd. A missing, mismatched, unavailable, or structurally invalid leg is `NOT REVIEWED`.
- The Codex review skill must never fall back from frozen evidence to a mutable working tree, branch, or background job.
- The Codex review skill makes exactly one narrowly elevated foreground runtime call so Kimi can read its existing `~/.kimi` authentication/log state and reach its model service. The process has normal user filesystem authority, not an OS sandbox; the wrapper's read-only claim is limited to its isolated empty session cwd plus verified reject-only ACP permission handling. It must not try inside the sandbox first, redirect credentials, or retry after denial/failure.
- `$kimi-task` defaults to read-only ACP permission rejection; write is available only after explicit user edit intent or explicit write selection, and only on the foreground call. Both modes run with normal user filesystem authority, not an OS sandbox, so write approval grants Kimi normal user filesystem write authority rather than a Codex per-tool sandbox approval.
- `$kimi-task` starts fresh by default and can resume only the exact session ID returned by a successful current-conversation `$kimi-task` call. A foreground call's terminal `taskStatus`, result, cancellation, permission evidence, session ID, and touched files belong only to that call. Rescue workflows remain deferred.
- Background jobs are the one Codex surface where a Kimi process outlives the invocation that authorized it, so the grant is bounded and disclosed rather than assumed. `write` is written exactly once, by the launch invocation, and sealed: the detached worker re-validates the seal and refuses to start on any mismatch. Launch is refused under `KIMI_COMPANION_AGENT_SPAWN`, refused for `--write` (write-enabled background is a deliberate separate decision, still deferred), refused for `--resume-last`/`--resume`, and refused while any job in the workspace is active. TTL is 30 minutes by default with a 60-minute hard ceiling, enforced by the worker's own abort AND externally by any reader.
- Job identity is a capability, not an identity: the claim token proves possession of the launch output, not the same user and not the same conversation. It is minted as 32 random bytes, stored only as SHA-256, and compared in constant time. `cancel` and coarse `status` metadata are token-free; content — Kimi's output, tool outputs, touched files, progress preview, prompt text, and the ACP `sessionId` — is token-gated on the Codex `$kimi-job` surface. A supplied `--claim` is ignored outright by `cancel`, so that termination never depends on a token and never becomes an oracle for one. The gating is scoped to that surface: the LEGACY Claude CLI (`status --all`, `result <job-id>`) still reads a background job's prompt and result with no claim token, ratified in spec §14 as accepted under the same-user threat model.
- No invocation whose purpose is to stop work may declare it stopped. `cancel` writes `cancel-requested`, never a terminal state; only confirming evidence — a worker-recorded `cancelled` stop reason, or `broker/status` showing the session gone — promotes it to `cancelled`. Otherwise the terminal state is `unknown` with the residual risk named, and a later `cancel` of an `unknown` job repeats that truth (`UNKNOWN`, residual risk, nonzero exit) rather than reporting the work inactive. `broker/status` is answered locally before the busy gate, is bounded by a probe budget so a broker that stops answering cannot outlast the confirmation window, and reports "not running" only for a genuinely absent broker record — a present-but-unreadable one establishes nothing. Reconciliation never signals a pid across a reboot boundary; its wording is "worker liveness cannot be confirmed", never "worker died". Every terminal write to a job — reconciler and cancel alike — is one locked compare-and-write that aborts when either the durable record or the index is already terminal.
- Broker startup failures must retain bounded child exit/signal, stderr/log-tail, and launch-context evidence before cleanup and expose it in the structured `NOT REVIEWED` result.
- ACP is bidirectional. Every agent-to-client request must receive a response or the turn can hang. Unknown requests receive JSON-RPC `-32601`.
- Existing state uses `KIMI_COMPANION_DATA`, then the legacy `CLAUDE_PLUGIN_DATA` fallback. Codex-specific `PLUGIN_DATA` behavior is deferred until it is implemented and tested.

## Verification

- Native package surface: `node plugins/kimi/tests/codex-plugin-surface.test.mjs` → `CODEX-PLUGIN-SURFACE-GREEN`.
- Legacy package consistency: `node plugins/kimi/tests/plugin-surface.test.mjs` → `PLUGIN-SURFACE-TESTS-GREEN`.
- Deterministic engine suites: `acp-client`, `kimi`, `acp-broker`, `kimi-companion`, `hooks`, and `render` under `plugins/kimi/tests/`; each prints its own `*-GREEN` sentinel.
- Run all package and engine suites after changes under `plugins/kimi/scripts/` or hook scripts.
- The suites are POSIX-only by design (the background cases need real `kimi` discovery on `PATH`, so they write a `#!/bin/sh` shim, join `PATH` with `:`, and read liveness with `ps`); the runtime itself still supports `win32`. CI runs them on `ubuntu-latest`. Their timeouts and poll bounds are hang detectors, not speed assertions — a shared runner is several times slower than a dev machine, so widen a bound rather than reading runner load as a verdict.
- Live ACP regression: `node spike/acp-spike.mjs` → `SPIKE-GREEN` (requires `kimi login`).
- Validate the plugin with the plugin-creator validator and every new skill with the skill-creator validator.
- Frozen review live probe: `node plugins/kimi/scripts/kimi-companion.mjs review --diff-file <path> --diff-sha256 <64-hex> --json` must return `REVIEWED` with matching hash/bytes, or explicit `NOT REVIEWED` nonzero.
- GitHub CI must pass the same eight deterministic suites on the exact pull-request head before merge.
- End compound gates with `&& echo GATE-GREEN || echo GATE-FAILED` and confirm the printed sentinel.

## Child DOX index

- `plugins/kimi/.codex-plugin/plugin.json` — advertised Codex components; currently skills only.
- `plugins/kimi/skills/kimi-setup/` — native setup readiness workflow.
- `plugins/kimi/skills/kimi-review/` — native SHA-pinned frozen-diff review workflow.
- `plugins/kimi/skills/kimi-task/` — native task handoff; default read-only, explicit write (foreground only), exact-session resume only, plus one sealed read-only background launch.
- `plugins/kimi/skills/kimi-job/` — native background-job observation and termination by exact job ID; token-gated content, token-free cancel.
- `plugins/kimi/scripts/` — Node/ACP engine and broker/job-control implementation.
- `plugins/kimi/tests/` — plain Node assertion suites and scripted fake ACP agent.
- `plugins/kimi/commands/`, `agents/`, `.claude-plugin/`, and `hooks/` — Claude migration source material; not Codex-supported merely because it remains in the tree.
- `.claude-plugin/marketplace.json` and `CLAUDE.md` — legacy compatibility artifacts in the target copy, not the target distribution surface.
- `.github/workflows/ci.yml` — read-only GitHub Actions gate for pull requests and `main`.
