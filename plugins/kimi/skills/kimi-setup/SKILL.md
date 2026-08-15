---
name: kimi-setup
description: Use when a user asks whether Kimi Code CLI is installed, authenticated, ACP-ready, or prepared for use from Codex.
---

# Kimi Setup

Run the plugin's read-only readiness probe and relay its result accurately.

## Workflow

1. If `PLUGIN_ROOT` is unset, resolve the plugin root from this `SKILL.md` path: it is the ancestor containing `.codex-plugin/plugin.json`.
2. Run exactly once, substituting that resolved absolute path when needed:

   ```bash
   node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup --json
   ```

3. Parse the JSON and report `state`, `node`, `kimi`, `acp`, `auth`, and `versionNote`. Ignore `reviewGateEnabled`, `actionsTaken`, `nextSteps`, and `sessionRuntime`; those fields describe Claude-only or not-yet-ported workflows.
4. For `not-installed`, point to the installer URL reported by the probe.
5. For `logged-out`, ask the user to run `kimi login` in their terminal, then invoke `$kimi-setup` again.
6. For `ready`, say setup is ready. Treat a version-drift note as informational.

## Scope

This initial Codex skill verifies setup only. Do not represent delegation, review, background job control, rescue, or lifecycle hooks as implemented by this skill.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Inferring authentication from `kimi --version` | Use the plugin probe; it performs a live session check. |
| Installing or logging in for the user | Report the required user action. |
| Relaying Claude-only next steps | Report only the selected structured fields above. |
