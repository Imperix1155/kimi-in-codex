# Kimi in Codex

Use [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) from Codex through a native Codex plugin package built on the existing Agent Client Protocol engine.

> **Status: early Codex port.** Native `$kimi-setup`, foreground `$kimi-review` of a SHA-256-pinned frozen diff, a `$kimi-task` handoff, and one bounded read-only background job observed through `$kimi-job` are implemented. Mutable-tree review orchestration, write-enabled background execution, rescue behavior, and lifecycle hooks remain deferred and are not claimed equivalent. The fully working Claude Code version remains available at [Imperix1155/kimi-in-claude-code](https://github.com/Imperix1155/kimi-in-claude-code).

## Requirements

- Codex in the ChatGPT desktop app or Codex CLI with plugin support
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) on `PATH`
- Node.js 18 or newer

## Install from this repository

Add the repository marketplace, install `kimi`, and start a new Codex task:

```text
codex plugin marketplace add Imperix1155/kimi-in-codex
```

Then open the plugin browser with `/plugins`, choose the `imperix` marketplace, and install `kimi`.

## Supported now

Invoke `$kimi-setup` or ask Codex to check whether Kimi is ready. The skill runs the existing read-only setup probe and reports one of these states:

- `ready`
- `logged-out`
- `not-installed`
- `error`

The probe checks Node.js, the Kimi executable, ACP runtime availability, and live authentication. It also reports drift from the known-good Kimi version.

Invoke `$kimi-review` with a saved UTF-8 diff artifact and its SHA-256. The runtime reads the artifact once, verifies the digest before Kimi starts, inlines exactly those bytes, and creates the read-only ACP session in an empty temporary workspace so it cannot silently review a newer checkout. Successful JSON includes `reviewStatus: "REVIEWED"`, the verified `diffSha256`, byte count, verdict, and structured findings.

Each review requests one narrowly justified elevated Codex shell execution so the existing authenticated Kimi runtime can read its `~/.kimi` state and logs and reach its model service. That process runs with the user's normal filesystem authority; this is not an OS sandbox. Review safety instead comes from an isolated empty session workspace plus reject-only ACP permission handling, and must not be described as stronger confinement. There is no sandbox-first retry. An approval denial stops before the runtime and the skill reports explicit `NOT REVIEWED`; runtime startup failures return structured `NOT REVIEWED` with bounded, sanitized broker exit/log/context evidence where available.

Any missing artifact, malformed or mismatched digest, unavailable Kimi/auth, permission-policy regression, or invalid structured response exits nonzero as `NOT REVIEWED`. The skill never falls back to a live Git diff.

Invoke `$kimi-task` to hand Kimi one bounded foreground task. It defaults to read-only: the ACP client rejects mutation and shell/execute permission requests. Use write mode only after the user explicitly asks Kimi to edit files or otherwise mutate state. Each task is one elevated foreground call with normal user filesystem authority, not an OS sandbox; read-only is an ACP permission boundary, not operating-system confinement.

Tasks start fresh by default. Resume is available only with the exact session ID returned by a successful `$kimi-task` call in the current conversation; the skill never guesses a session, scans history, or uses resume-last. The foreground call owns its terminal `taskStatus`, result, permission events, session ID, and touched files. It does not provide rescue behavior.

`$kimi-task` can also start one detached background job, and `$kimi-job` observes or stops it. That surface is deliberately bounded, because a detached job holds authority whose consent prompt has already closed:

- **Read-only, always.** A background job is sealed read-only at launch and cannot be widened afterwards; the worker refuses to run a record whose sealed authority no longer matches. Write-enabled background execution is a separate decision that has not been taken and remains deferred — write delegation stays foreground-only.
- **One at a time per workspace.** A launch is refused, naming the blocking job, while another Kimi job is active.
- **TTL-bounded.** 30-minute default, 60-minute hard ceiling, enforced both by the worker's own timer and externally by any reader — a wedged worker will not honor its own deadline.
- **Exact job ID only.** No latest-job default, no prefix matching, no selection from repository history.
- **Content is claim-token-gated.** The launch prints a claim token once; without it, only coarse metadata (state, write standing, deadline, working directory) is available. Kimi's output, touched files, the prompt text, and the ACP session ID stay withheld. Cancellation is deliberately token-free, because a job with no reachable off switch is the worse failure.
- **Cancellation never overclaims.** `cancel` records intent, signals, then reports a terminal cancelled state only when it is confirmed — the worker recorded a cancelled stop reason, or the runtime showed the session gone. Otherwise it reports `unknown` and names the residual risk. Recovery states say "liveness cannot be confirmed", not "the worker died".
- A background job's prompt text and result are stored in the plugin's state directory until the record is removed.

## Not yet ported

The copied engine already implements these behaviors for Claude Code, but their Codex-native wrappers and semantics still require separate implementation and verification:

- automatic diff freezing and SHA-pinned coverage-ledger orchestration
- mutable working-tree or branch review through the Codex skill
- write-enabled background execution (background jobs are sealed read-only)
- rescue subagent routing and rescue fallback behavior
- slash-command arguments and interactive choice flows
- SessionStart, SessionEnd, and Stop hooks
- Codex-specific plugin data/state naming
- MCP wrapper for universal harness support

Legacy Claude packaging remains in the target tree only as migration source material. The Codex manifest advertises none of these deferred capabilities.

## Repository layout

- `plugins/kimi/.codex-plugin/plugin.json` — native Codex plugin manifest
- `plugins/kimi/skills/kimi-setup/` — the supported Codex setup workflow
- `plugins/kimi/skills/kimi-review/` — foreground review of a verified frozen diff
- `plugins/kimi/skills/kimi-task/` — task handoff with explicit access controls: foreground, or one read-only background job
- `plugins/kimi/skills/kimi-job/` — observe or stop one existing background job by exact ID
- `.agents/plugins/marketplace.json` — repository marketplace catalog
- `plugins/kimi/scripts/` — proven Node/ACP engine retained from the source history
- `plugins/kimi/tests/` — deterministic engine and package-surface tests
- `docs/PLAN.md` — architecture and port plan
- `docs/ROADMAP.md` — in-repository tracker
- `spike/acp-spike.mjs` — live ACP regression probe

## License

[Apache-2.0](LICENSE). Portions derive from OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see [NOTICE](NOTICE).
