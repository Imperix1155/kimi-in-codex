# Kimi in Codex

Use [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) from Codex through a native Codex plugin package built on the existing Agent Client Protocol engine.

> **Status: early Codex port.** The native `$kimi-setup` workflow is implemented and testable. Task delegation, review, background job controls, rescue behavior, and lifecycle hooks are not yet ported or claimed equivalent. The fully working Claude Code version remains available at [Imperix1155/kimi-in-claude-code](https://github.com/Imperix1155/kimi-in-claude-code).

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

## Not yet ported

The copied engine already implements these behaviors for Claude Code, but their Codex-native wrappers and semantics still require separate implementation and verification:

- task delegation
- adversarial review and its client-enforced read-only policy
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
- `.agents/plugins/marketplace.json` — repository marketplace catalog
- `plugins/kimi/scripts/` — proven Node/ACP engine retained from the source history
- `plugins/kimi/tests/` — deterministic engine and package-surface tests
- `docs/PLAN.md` — architecture and port plan
- `docs/ROADMAP.md` — in-repository tracker
- `spike/acp-spike.mjs` — live ACP regression probe

## License

[Apache-2.0](LICENSE). Portions derive from OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc); see [NOTICE](NOTICE).
