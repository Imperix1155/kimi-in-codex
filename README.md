# Kimi in Codex

Use [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) from Codex through a native Codex plugin package built on the existing Agent Client Protocol engine.

> **Status: early Codex port.** Native `$kimi-setup` and foreground `$kimi-review` of a SHA-256-pinned frozen diff are implemented and testable. Task delegation, mutable-tree review orchestration, background job controls, rescue behavior, and lifecycle hooks are not yet ported or claimed equivalent. The fully working Claude Code version remains available at [Imperix1155/kimi-in-claude-code](https://github.com/Imperix1155/kimi-in-claude-code).

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

## Not yet ported

The copied engine already implements these behaviors for Claude Code, but their Codex-native wrappers and semantics still require separate implementation and verification:

- task delegation
- automatic diff freezing and SHA-pinned coverage-ledger orchestration
- mutable working-tree or branch review through the Codex skill
- background status, result, and cancellation workflows
- rescue subagent routing
- slash-command arguments and interactive choice flows
- SessionStart, SessionEnd, and Stop hooks
- Codex-specific plugin data/state naming
- MCP wrapper for universal harness support

Legacy Claude packaging remains in the target tree only as migration source material. The Codex manifest advertises none of these deferred capabilities.

## Repository layout

- `plugins/kimi/.codex-plugin/plugin.json` — native Codex plugin manifest
- `plugins/kimi/skills/kimi-setup/` — the supported Codex setup workflow
- `plugins/kimi/skills/kimi-review/` — foreground review of a verified frozen diff
- `.agents/plugins/marketplace.json` — repository marketplace catalog
- `plugins/kimi/scripts/` — proven Node/ACP engine retained from the source history
- `plugins/kimi/tests/` — deterministic engine and package-surface tests
- `docs/PLAN.md` — architecture and port plan
- `docs/ROADMAP.md` — in-repository tracker
- `spike/acp-spike.mjs` — live ACP regression probe

## License

[Apache-2.0](LICENSE). Portions derive from OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see [NOTICE](NOTICE).
