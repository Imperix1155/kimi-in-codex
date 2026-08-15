# Codex Broker Permission Design

## Goal

Make native `$kimi-review` work from a fresh Codex task without weakening the frozen-review contract, hiding broker startup evidence, relocating Kimi authentication, or bypassing the existing broker.

## Root cause

The installed plugin verifies the frozen artifact before starting Kimi, then launches `kimi acp` through a detached Node broker. In Codex's default sandbox, Kimi 1.49.0 exits before the ACP `initialize` response because its logging setup opens `~/.kimi/logs/kimi.log` for append and the sandbox denies that home-directory write. The same raw ACP sequence completes through `session/prompt` outside the sandbox, proving that Kimi, authentication, and ACP are healthy.

The broker currently waits for its endpoint, tears down the failed child and temporary session directory, deletes `broker.log`, and returns `null`. The companion consequently reports only `Failed to start the shared agent broker.` The cleanup is correct, but it destroys the evidence needed to distinguish a Kimi startup failure from a socket, timeout, or broker-script failure.

## Approved architecture

Retain the existing shared broker and authenticated Kimi home state. Native `$kimi-review` requests one narrowly justified elevated execution from the outset. The elevated execution is required because Kimi uses its local authenticated state and logs under `~/.kimi` and connects to its model service; neither is available inside the default workspace sandbox.

Do not redirect or copy `KIMI_SHARE_DIR`, Kimi configuration, or OAuth credentials. Do not bypass the broker. Do not retry after a failed review invocation, fall back to Git state, or weaken the ACP permission-rejection policy.

## Broker startup evidence

Broker startup remains bounded. When the endpoint is not ready, capture evidence before teardown:

- whether the child exited before readiness
- its numeric exit code or terminating signal when known
- a capped tail of the broker log, with a fixed maximum size
- the broker script path, working directory, and endpoint kind needed to locate the failing boundary
- whether readiness ended by child exit or timeout

Then perform the existing process, socket, pid-file, log-file, and temporary-directory cleanup. Throw an error carrying the captured evidence instead of returning an evidence-free `null`. The companion's existing frozen-review error envelope must surface the useful bounded reason as structured `NOT REVIEWED` output. Empty logs and unknown exit status remain explicit rather than being invented.

The error must not include environment dumps, OAuth contents, config contents, prompts, artifact contents, or other secrets. Log evidence is capped before it enters the error.

## Native review skill

`plugins/kimi/skills/kimi-review/SKILL.md` continues to require the artifact path and caller-supplied SHA-256, resolve `PLUGIN_ROOT`, and execute the existing foreground command exactly once. Its execution instruction must also require the Codex shell tool's elevated sandbox permission with a concise justification limited to the authenticated local Kimi runtime and outbound model connection.

All existing integrity rules remain unchanged:

- exactly one companion invocation
- no live-Git, branch, working-tree, or alternate-artifact fallback
- no background status/result/cancel route
- no artifact mutation
- ACP review permissions remain reject-only
- nonzero, malformed, missing-provenance, or non-`REVIEWED` results remain `NOT REVIEWED`

## Tests

Use test-driven development.

1. Add a deterministic broker regression whose fake ACP child writes a representative home-log `PermissionError` to stderr and exits before initialization. The pre-fix assertion must fail because only the generic broker-start message is available.
2. Require the post-fix error to identify child exit versus timeout, include the exit code and capped stderr tail, and retain useful non-secret startup context. Assert cleanup still removes the failed broker process, socket, pid file, log file, and temporary session directory.
3. Add a truncation assertion proving an oversized log cannot escape the cap.
4. Extend the native package-surface test to require the narrow elevated-execution instruction while preserving exactly one runtime command and all no-fallback/read-only rules.
5. Run the eight deterministic suites, plugin and skill validators, a secret scan, and the live ACP spike.
6. Install the branch build locally and start a fresh Codex task. Invoke `$kimi-review` conversationally on a harmless frozen seeded diff. The accepted result must be structured `REVIEWED`, report the exact supplied SHA-256 and byte count, preserve zero granted permissions, and identify the seeded correctness bug before the deadman cutoff. Silence or failure is `NOT REVIEWED`.

## Publication boundary

Publish the verified change on a new branch and open a draft pull request. Do not merge. The final exact-head diff requires the repository's normal review evidence and GitHub Actions gate before any later merge decision.

## Explicitly out of scope

- changing Kimi CLI configuration or authentication storage
- copying, linking, printing, or committing OAuth credentials
- changing the broker architecture or using direct ACP for review
- changing review prompts, schemas, frozen-artifact hashing, or permission decisions
- task delegation, job-control, hooks, rescue, mutable-tree review, or VRX integration
- any modification to `Imperix1155/kimi-in-claude-code` or VRX
