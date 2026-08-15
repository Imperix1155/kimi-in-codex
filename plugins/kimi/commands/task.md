---
description: Delegate a coding or research task to Kimi (write-enabled by default)
argument-hint: '[--background] [--read-only] [--resume|--fresh] [--model <id|highspeed|k3>] [prompt ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a task to Kimi through the shared plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Write policy:
- Task delegation is WRITE-ENABLED by default: prepend `--write ` INSIDE the single quoted argument string (see the invocation below) unless the user's prompt clearly asks for research/investigation with no edits.
- `--read-only` always wins over `--write` in the companion, so a user-supplied `--read-only` inside the arguments is honored even when you prepend `--write`.
- CRITICAL: flags must live INSIDE the one quoted string. The companion re-tokenizes a single argument (the slash-command convention); a separate argv token would turn the rest of the arguments into literal prompt text and silently drop their flags.
- The write policy only affects Kimi's own session. Claude Code's permission layer still governs everything you yourself do afterwards.

Execution mode rules:
- If the raw arguments include `--background`, run the companion once in the foreground of a Claude background task is NOT needed — the companion itself detaches a worker and returns immediately. Just run it and relay the job id line.
- If the raw arguments do not include `--background`, estimate the task size:
  - A quick, single-file, or question-like task can run in the foreground.
  - Anything that sounds like multi-file work, a long investigation, or an open-ended grind should run in the background — that is Kimi's strength (long-horizon autonomy).
- When unsure, use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Run in background`
  - `Wait for results`
- For background runs chosen via the question, append `--background` yourself.

Model selection:
- No `--model` means Kimi's default thinking model.
- `--model highspeed` for quick, mechanical tasks; `--model k3` for whole-repo context work.
- Pass the user's `--model` value through unchanged; the companion validates it.

Resume:
- `--resume` (or `--resume-last`) continues Kimi's most recent task session for this repository with context intact.
- `--fresh` forces a new session.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" task "--write $ARGUMENTS"
```
(drop the `--write ` prefix per the write policy above when the task is read-only; keep everything in ONE quoted string either way)
- Return the command stdout verbatim. Do not paraphrase or summarize it.

Background flow:
- Same single-string invocation with `--background` inside the quotes, e.g. `task "--write --background $ARGUMENTS"`.
- Relay the job id line to the user and mention `/kimi:status <job-id>` for progress and `/kimi:result <job-id>` for the final output.

Exact prompt text:
- The single-string convention re-tokenizes the prompt (quotes and backslashes are shell-split). For a prompt that must arrive byte-exact — or that itself contains flag-like tokens such as `--read-only` as subject matter — write it to a temp file and use `--prompt-file <path>` instead of inline text.

After a write-enabled task completes:
- Report the result verbatim, then check `git status --short` and summarize which files Kimi touched.
- Suggest `/kimi:review --wait` if the user wants the changes reviewed before building on them.
- Do not silently modify or revert what Kimi wrote; surface it and let the user decide.
