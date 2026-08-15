# Codex-Native Setup Slice Design

## Goal

Establish the smallest honest Codex-native Kimi plugin path while preserving the proven Node/ACP engine and leaving the original `Imperix1155/kimi-in-claude-code` repository unchanged.

## Approved approach

Package the existing engine as a Codex plugin at `plugins/kimi`. Add the required `.codex-plugin/plugin.json`, expose it through a repository marketplace, and add one native skill, `kimi-setup`, which runs the existing `setup` subcommand through `${PLUGIN_ROOT}`. The setup slice is read-only and reports whether the Kimi CLI is installed, authenticated, and compatible.

The existing `plugin/` tree moves mechanically to `plugins/kimi/` so the installed Codex plugin contains its runtime. Existing engine behavior remains unchanged in this slice. Claude-specific commands, agents, and hooks may remain as source material inside the target repository, but the Codex manifest does not advertise them.

## Data flow

1. A user invokes `$kimi-setup` or asks Codex to check Kimi readiness.
2. Codex loads `plugins/kimi/skills/kimi-setup/SKILL.md`.
3. The skill runs `node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup`.
4. The existing runtime probes the local Kimi CLI and prints its setup state.
5. Codex relays the output without claiming capabilities beyond the probe.

## Validation

- A focused Node test must fail before the Codex package exists.
- The test validates the marketplace entry, manifest, skill metadata, UI metadata, plugin-root invocation, and absence of advertised hooks/MCP/apps.
- The plugin and skill validators must pass.
- The existing deterministic runtime suites must remain green after the mechanical move.
- A real setup invocation must complete and produce a recognized state. Authentication availability is reported, not assumed.

## Explicitly deferred

The following are not equivalent and are not advertised by this slice:

- task delegation
- adversarial review
- background status, result, and cancellation workflows
- rescue subagent behavior
- Claude slash-command argument interpolation and `AskUserQuestion` flows
- lifecycle hooks and the stop-time review gate
- Codex-specific writable data/state naming
- MCP wrapper and universal-harness support

Each deferred surface needs its own Codex-native design and behavioral verification before it can be presented as supported.
