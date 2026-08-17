---
name: kimi-job
description: Use when the user wants to check on, read the result of, or stop an existing Kimi background job that was already launched with an exact job ID.
---

# Kimi Job

Observe or stop one existing Kimi background job. This skill never starts work
and never grants Kimi any authority: it reads local job records and may only
stop work that is already running.

Launching a job is a different authority class and belongs to `$kimi-task`.

## Workflow

1. Resolve `PLUGIN_ROOT` from this `SKILL.md` path when it is unset: use the
   ancestor containing `.codex-plugin/plugin.json`.
2. Resolve the exact job ID. `$kimi-task` printed it when it launched the job,
   as `jobId`.

   - Exact IDs only. There is no latest-job default, no prefix matching, and no
     way to select a job from repository history. A partial ID is refused.
   - When the user has no ID, list this workspace's background jobs with
     `status --json` and no job argument. That listing is coarse metadata only.

3. Resolve whether you hold the claim token. `$kimi-task` returned it once, as
   `claimToken`, in the launch output of this conversation.

   - The token proves possession of that launch output. It does not prove the
     same user and does not prove the same conversation; absent a Codex
     conversation ID, possession of the token is what "exact" means here.
   - Content is token-gated: Kimi's message, tool outputs, touched files, the
     progress preview, the prompt text, and the ACP session ID.
     The session ID is content, because disclosing it would reconstruct
     session resume.
   - Metadata is not token-gated: state, write standing, launch time, working
     directory, deadline, elapsed time, and the runtime's own error text.
   - Without the token, report the metadata and say plainly that content stays
     withheld. Do not ask the user to hunt for a token they never saw.

4. Run exactly one foreground invocation with the Codex shell tool for the
   operation the user asked for.

   - `sandbox_permissions: "require_escalated"`
   - `justification: "Allow this call to read local Kimi job records and, if asked, stop a running Kimi background job? It runs with normal user filesystem authority (not an OS sandbox). It starts no new work, grants Kimi no new authority, and can only inspect or terminate an existing job."`

   Do not first attempt the command inside the sandbox. Do not retry after
   denied elevation or a failed runtime call.

   ```bash
   JOB_ARGS=(--codex-job "${JOB_ID}" --json)
   CLAIM_ARGS=()
   if [[ -n "${CLAIM_TOKEN:-}" ]]; then
     CLAIM_ARGS=(--claim "${CLAIM_TOKEN}")
   fi
   node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" "${COMMAND}" "${JOB_ARGS[@]}" "${CLAIM_ARGS[@]}"
   ```

   `COMMAND` is exactly one of `status`, `result`, or `cancel`. `JOB_ID` and
   `CLAIM_TOKEN` are values in their own quoted array elements, never raw
   fragments subject to word splitting.

5. Report the JSON result truthfully.

   - `status` returns `job` metadata always, and `content` only when
     `authenticated` is true. Never infer content from metadata.
   - `result` requires the claim token and refuses without it. A job that is
     still `queued`, `running`, or `cancel-requested` has no result yet.
   - `cancel` needs no token, because a job with no reachable off switch is the
     worse failure. Report its `cancelStatus` exactly:
     - `CANCELLED` means the stop was **confirmed** — the worker recorded a
       cancelled stop reason, or the runtime showed the session gone.
     - `UNKNOWN` means the stop was requested and signalled but
       **could not be confirmed**. Say so, and pass on the `residualRisk`
       text verbatim.
       Never restate `UNKNOWN` as cancelled, stopped, or killed.
   - A job may also read `failed` with "liveness cannot be confirmed" or
     "deadline exceeded". That wording is deliberate: it reports what was
     established, not that the worker died.

## Scope and safety

- This skill observes and terminates. It never launches a job, never grants
  write authority, and never changes a job's access mode.
- Terminating is always allowed; disclosing is not. When in doubt about the
  token, withhold content.
- A background job's prompt text and result are stored on disk in the plugin's
  state directory until the job record is removed.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Reporting `UNKNOWN` as cancelled | Say the cancellation could not be confirmed and give the residual risk. |
| Guessing a job ID from a prefix or from history | Require the exact ID from the launch output. |
| Presenting metadata as if it were Kimi's answer | Content needs the claim token; say what is withheld. |
| Asking for a token so `cancel` can proceed | Cancellation is deliberately token-free. |
