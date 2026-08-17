---
name: kimi-task
description: Use when a user wants to hand one bounded task to Kimi — foreground by default, or as one read-only detached job that keeps running after this call returns.
---

# Kimi Task

Hand one task to Kimi. The default is a foreground call that returns Kimi's
terminal result, read-only. A detached read-only job is available when the user
explicitly wants work to continue after this call returns.

## Workflow

1. Resolve `PLUGIN_ROOT` from this `SKILL.md` path when it is unset: use the ancestor containing `.codex-plugin/plugin.json`.
2. Resolve the access mode before launching Kimi.

   - Default to `--read-only`. Kimi receives reject-only ACP permissions for mutation and shell/execute requests.
   - Use `--write` only when the user explicitly asks Kimi to edit or otherwise mutate files, or explicitly selects write access. Say that this grants Kimi normal user filesystem write authority; Kimi's internal edits are not mediated by Codex per-tool sandbox approvals.
   - The elevated foreground process has normal user filesystem authority, not an OS sandbox. The read-only claim comes from ACP permission rejection, not an operating-system filesystem sandbox.

3. Resolve the session mode without guessing.

   - Use `--fresh` for a new task by default.
   - Use `--resume-session <exact-session-id>` only when the user supplies the exact ID returned by a successful `$kimi-task` call in this conversation.
   - Do not infer an ID from repository history or use legacy resume selectors. Fresh and exact resume are mutually exclusive.
   - Represent the chosen mode as an argument array: fresh is `SESSION_ARGS=(--fresh)`; exact resume is `SESSION_ARGS=(--resume-session "${SESSION_ID}")`. The flag and ID are two separate array elements.

4. Preserve the user's task text exactly: write it once as UTF-8 to a unique temporary prompt file outside the repository. Do not trim, concatenate, or substitute the prompt; remove the temporary file in `finally` after the runtime returns.
5. Build the runtime argument array from literal flags plus separate values. Do not interpolate an untrusted model, session ID, or path into a shell string, and do not use a compound `SESSION_FLAG` value. `MODEL_ARGS` is either empty or the two separate arguments `--model` and an explicitly selected supported model (`highspeed`, `k3`, or an exact supported model ID).
6. Run exactly one foreground invocation with the Codex shell tool.

   - `sandbox_permissions: "require_escalated"`
   - For read-only: `justification: "Allow the authenticated local Kimi runtime to run with normal user filesystem authority (not an OS sandbox) so it can access ~/.kimi state/logs and its model service? ACP will reject mutation and shell/execute requests for this read-only task."`
   - For write: `justification: "Allow the authenticated local Kimi runtime to run with normal user filesystem write authority (not an OS sandbox) so it can access ~/.kimi state/logs and its model service and perform the user-approved edits?"`

   Do not first attempt the command inside the sandbox. Do not retry after denied elevation or a failed runtime call. Use zsh/Bash argument arrays; the `node` line below is the one foreground invocation. `SESSION_ID` and `MODEL_ID` are values in their own quoted array elements, never raw fragments subject to word splitting.

   ```bash
   ACCESS_FLAG=--read-only # or --write after explicit user approval
   SESSION_ARGS=(--fresh)
   if [[ -n "${SESSION_ID:-}" ]]; then
     SESSION_ARGS=(--resume-session "${SESSION_ID}")
   fi
   MODEL_ARGS=()
   if [[ -n "${MODEL_ID:-}" ]]; then
     MODEL_ARGS=(--model "${MODEL_ID}")
   fi
   TASK_ARGS=(task --codex-once --json --prompt-file "${PROMPT_FILE}" "${ACCESS_FLAG}" "${SESSION_ARGS[@]}" "${MODEL_ARGS[@]}")
   node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" "${TASK_ARGS[@]}"
   ```

7. Parse the JSON terminal result. Accept only `taskStatus` values `COMPLETED`, `CANCELLED`, or `FAILED`.

   - For `COMPLETED`, present Kimi's result, `permissionEvents`, `sessionId`, and `touchedFiles`.
   - For `CANCELLED`, report that the foreground call was cancelled and include the returned session ID when present.
   - For `FAILED`, report the runtime error and any returned permission evidence; do not present partial output as completion.

## Detached read-only job

Use this only when the user explicitly wants the work to continue after this
call returns. Everything in steps 1 and 3-5 still applies.

- The job is **read-only, always**. `--write` is refused for a detached job.
  When the user wants Kimi to edit files, run the foreground call instead;
  write delegation stays foreground-only, where the user supervises it.
- **One at a time per workspace.** A launch is refused, naming the blocking
  job, while another Kimi job is queued, running, or awaiting cancellation.
- **Exact IDs only.** The launch prints a `jobId` and, once, a `claimToken`.
  Observing or stopping the job afterwards is `$kimi-job`, and only `$kimi-job`.
  Preserve both values in your reply; the token is never shown again and cannot
  be recovered from the job record.
- **The prompt text and the result are written to disk** in the plugin's state
  directory and stay there until the job record is removed.
- `--ttl-minutes` may only lower the 30-minute default; the runtime's hard
  ceiling is 60 minutes. At the deadline the job is terminated and reported
  `failed`, never silently extended and never auto-resumed.

Run exactly one foreground invocation with the Codex shell tool:

- `sandbox_permissions: "require_escalated"`
- `justification: "Allow the authenticated local Kimi runtime to start a detached read-only job that KEEPS RUNNING after this call returns, for up to 30 minutes and never more than 60 minutes? It runs with normal user filesystem authority (not an OS sandbox), so it can read anything you can read for that whole window without further prompts. ACP will reject mutation and shell/execute requests; the job is sealed read-only and cannot be given write authority later. Its prompt text and result are stored on disk until the job record is removed."`

```bash
TTL_ARGS=()
if [[ -n "${TTL_MINUTES:-}" ]]; then
  TTL_ARGS=(--ttl-minutes "${TTL_MINUTES}")
fi
JOB_ARGS=(task --codex-background --json --prompt-file "${PROMPT_FILE}" --read-only "${TTL_ARGS[@]}" "${MODEL_ARGS[@]}")
node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" "${JOB_ARGS[@]}"
```

Parse the JSON envelope. `launchStatus` is `QUEUED` on success and `REFUSED`
otherwise; report a refusal's reason as-is rather than retrying or falling back
to a foreground call without saying so.

## Scope and safety

- A foreground call owns only its own terminal result. A detached job is
  observed and stopped exclusively through `$kimi-job`.
- Do not invoke rescue behavior, retry a denied/failed elevation, or modify repository content while preparing the prompt file.
- Do not launch a detached job to work around a busy runtime or a refused write.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Enabling writes because the task sounds useful | Require explicit user edit intent or write selection. |
| Treating read-only as an OS sandbox | Report the ACP reject-policy boundary accurately. |
| Resuming the latest historical session | Require the exact session ID from the current conversation. |
| Passing task text as a shell argument | Use the temporary UTF-8 prompt file so boundary whitespace survives. |
| Detaching a job the user only asked to run | Detach only on explicit intent; the consent text differs. |
| Dropping the claim token from your reply | It is shown once; without it the job's content is unrecoverable. |
