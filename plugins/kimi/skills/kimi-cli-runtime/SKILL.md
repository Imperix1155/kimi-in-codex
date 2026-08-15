---
name: kimi-cli-runtime
description: Internal helper contract for calling the kimi-companion runtime from Claude Code
user-invocable: false
---

# Kimi Runtime

Use this skill only inside the `kimi:kimi-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task "<arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Kimi CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `status`, `result`, or `cancel` from `kimi:kimi-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Forward the user's request text as-is; the only Claude-side work allowed is stripping routing flags. Do not inspect the repo, solve the task yourself, or add independent analysis.
- Default to a write-capable run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits (then add `--read-only`; it always wins over `--write`).

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat `--wait` as Claude-side execution control only and strip it; pass `--background` through to `task` (the companion detaches its own worker).
- If the forwarded request includes `--model`, pass it through to `task` unchanged. Valid values: exact model ids, or the aliases `highspeed` (fast/cheap tier) and `k3` (1M-context tier). The companion validates and errors with the menu on unknown values.
- Kimi has no reasoning-effort parameter. If the forwarded request includes an effort flag, drop it — thinking is part of the model variant.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- For task text that must arrive byte-exact (embedded quotes, backslashes, flag-like tokens as subject matter), write it to a temp file and pass `--prompt-file <path>` instead of inline text.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Kimi cannot be invoked, return the command's error output verbatim — never suppress it; it carries the fix (e.g. `/kimi:setup`). Add no commentary and do no independent work.
