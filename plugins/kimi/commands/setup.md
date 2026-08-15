---
description: Check whether the Kimi Code CLI is installed, logged in, and ready; optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup "$ARGUMENTS"
```

Present the command output to the user verbatim.

Follow-ups by reported state:
- `not-installed`: relay the install pointer (https://github.com/MoonshotAI/kimi-code). Do NOT attempt to install anything yourself — installation method varies by platform and is the user's call.
- `logged-out`: tell the user to run `kimi login` in their own terminal (it is an interactive browser flow you cannot complete for them), then rerun `/kimi:setup`.
- `ready`: nothing to do; mention the optional review gate if the output suggests it.
- A version-drift note is informational; relay it as-is.
