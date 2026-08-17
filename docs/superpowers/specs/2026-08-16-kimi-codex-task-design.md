# Codex-Native Kimi Task Handoff Design

## Status and scope

This design defines the first native Codex task-delegation slice for the base Kimi plugin. It adds one foreground, one-shot `$kimi-task` handoff while retaining the proven Node/ACP engine. It does not port the Claude background-job user experience.

Included:

- one foreground Kimi task per skill invocation;
- read-only and write-enabled permission policies;
- model selection;
- fresh sessions and exact-session resume;
- Codex-owned progress, final-result handling, and safe interruption;
- explicit, truthful elevation and filesystem-authority messaging.

Excluded:

- detached/background tasks;
- durable job IDs, later status lookup, result recovery, or cancel-by-ID;
- repository-global “resume last” selection;
- rescue-agent routing, hooks, mutable review orchestration, and MCP tools;
- changes to the separate `kimi-in-claude-code` repository.

The excluded durable lifecycle remains KMP-32. This slice advances KMP-30 without claiming KMP-32 equivalence.

## Decision

Add a public `plugins/kimi/skills/kimi-task/` skill over a narrow one-shot mode on the existing companion task command:

```text
node "${PLUGIN_ROOT}/scripts/kimi-companion.mjs" task \
  --codex-once --json --prompt-file "${PROMPT_FILE}" \
  (--read-only | --write) \
  (--fresh | --resume-session "${SESSION_ID}") \
  [--model "${MODEL}"]
```

The skill makes exactly one foreground runtime invocation. The new `--codex-once` path reuses `runKimiTurn` and the shared ACP broker, but bypasses `createJobRecord`, `runTrackedJob`, detached workers, and the legacy status/result store. Progress belongs to the current Codex tool call; the final structured result returns in that same call.

The shared broker remains a transport and concurrency guard, not a user-facing job system. It must gain one-shot cancellation ownership so a disconnected or interrupted Codex caller cannot leave Kimi running invisibly.

## Why the existing task wrapper is insufficient

A skill-only call to the existing foreground `task --json` path would be smaller in line count, but it would preserve three wrong semantics:

1. it writes legacy job records even though Codex is meant to own this run;
2. `--resume-last` becomes repository-global when Codex has no `KIMI_COMPANION_SESSION_ID`, so it may select another task’s session;
3. the broker deliberately lets a turn continue when its client disconnects, so stopping Codex can leave an invisible write-capable Kimi turn running.

The one-shot boundary fixes only those semantics and otherwise reuses the existing engine.

## Public controls

### Prompt

The skill writes the user’s task text to a uniquely named temporary UTF-8 file and passes it with `--prompt-file`. This preserves embedded quotes, backslashes, newlines, and flag-like text without shell re-tokenization. The file is removed after the runtime returns. It is not created inside the repository.

The skill forwards task intent without adding independent implementation advice. Routing controls are translated into CLI flags rather than included in the prompt.

### Model

With no model flag, Kimi uses its default thinking model. Supported aliases remain:

- `highspeed` → `kimi-code/kimi-for-coding-highspeed,thinking`
- `k3` → `kimi-code/k3,thinking`

The six exact model IDs already declared by `agent-profile.mjs` also remain valid. Unknown models fail with the catalog. Reasoning-effort flags remain unsupported because thinking is part of the model variant.

### Read and write authority

Native task delegation defaults to read-only. This deliberately differs from the Claude command’s write-enabled default because its safety rationale does not transfer: once Codex approves an elevated Kimi process, Codex cannot interpose on Kimi’s internal tool calls.

- `--read-only` sets the ACP session permission policy to `reject`. The existing read-only preamble and one-turn rejection recovery remain active. If both access flags are present, read-only wins.
- `--write` sets the ACP session permission policy to `allow`. The skill uses it only when the user explicitly asks Kimi to modify files or explicitly selects write access.

Both modes require one elevated foreground invocation before Kimi starts because Kimi opens `~/.kimi/logs/kimi.log`, reads its existing authentication state, and reaches its model service. There is no sandbox-first attempt or retry.

The approval text must be mode-specific:

- read-only: disclose normal user read authority and explain that mutation and shell/execute permission requests are rejected by ACP policy;
- write: disclose normal user filesystem write authority and state that Kimi’s internal edits are not mediated by Codex’s per-tool sandbox approvals.

Neither mode is an OS sandbox. Read-only Kimi can use built-in reads anywhere the user account can read. `touchedFiles` is evidence reported after a write turn, not confinement.

### Foreground and background

`--codex-once` is foreground-only. Supplying `--background` is an error that points to the deferred durable-job work. Codex may yield and poll its own running shell session internally, but the skill does not return control to the user before the Kimi result is terminal.

The plugin advertises no `$kimi-status`, `$kimi-result`, or `$kimi-cancel` skill in this stage.

### Fresh and resume

Fresh is the default and starts a new ACP session.

Resume requires an exact `sessionId` returned by a prior successful `$kimi-task` call in the current Codex conversation. The companion accepts it as `--resume-session <id>` and passes it directly to the existing `runKimiTurn({ resumeSessionId })` path, which uses `session/load`.

Native one-shot mode rejects `--resume`, `--resume-last`, and any resume request for which Codex does not possess an exact prior session ID. It never scans repository job history to guess. `--fresh` and `--resume-session` are mutually exclusive. A resumed call may omit task text, in which case the existing continue prompt is used.

## Runtime boundary and data flow

1. `$kimi-task` resolves `PLUGIN_ROOT`, the repository root, access mode, model, and fresh/resume mode.
2. It creates the temporary prompt file when prompt text is present.
3. It requests one mode-specific elevated foreground shell call. Denial ends the handoff without a Kimi invocation.
4. `handleTask` validates one-shot-only options before starting Kimi.
5. The one-shot runner calls `executeTaskRun`/`runKimiTurn` without creating a job record.
6. Progress events continue to stderr as `[kimi] ...`; stdout is reserved for one JSON result envelope.
7. The skill validates and presents the envelope using the result-handling contract, then removes the prompt file.

The terminal envelope is:

```json
{
  "taskStatus": "COMPLETED | FAILED | CANCELLED",
  "status": 0,
  "stopReason": "end_turn",
  "sessionId": "exact ACP session id",
  "rawOutput": "complete assistant output",
  "lastAgentMessage": "final assistant segment",
  "toolOutputs": [],
  "touchedFiles": [],
  "permissionEvents": [],
  "reasoning": "captured reasoning summary",
  "stderr": "diagnostic output only"
}
```

`status` remains the process exit-oriented numeric status already produced by the engine. `taskStatus` is the adapter’s terminal classification. A thrown error returns `taskStatus: "FAILED"` with a concrete `error`; it cannot be rendered as a completed Kimi answer. An empty `end_turn` remains a failure.

## Status, result, and cancellation ownership

During a one-shot handoff, Codex owns only the current invocation lifecycle:

- running status is the active Codex tool call plus streamed progress;
- the result is the terminal JSON returned by that call;
- cancellation is interruption of that call.

There is no durable result lookup after the Codex call is gone.

Safe cancellation has two layers:

1. graceful interruption: the one-shot runner accepts an abort signal, sends ACP `session/cancel` for its exact session, waits for a bounded cancelled terminal result, and closes its client;
2. disconnect fallback: the broker marks the one-shot session as cancel-on-disconnect and sends `session/cancel` if that client socket closes while its prompt is active.

The broker keeps `activeSocket` ownership until the underlying request settles, so another task cannot receive the cancelled turn’s output. Legacy callers retain their existing survive-disconnect behavior; cancel-on-disconnect is opt-in for Codex one-shot sessions only.

If cancellation cannot be confirmed inside the bound, the adapter returns `FAILED` with an explicit “cancellation unconfirmed” error. It never says cancelled merely because the wrapper process received a signal.

## Failure behavior

- Elevation denied: report that Kimi was not invoked; do not retry.
- Kimi unavailable or logged out: return a failed envelope and direct the user to `$kimi-setup`; do not automate login.
- Broker busy: report the active-runtime conflict; do not start a second turn or suggest legacy status commands.
- Unknown model, conflicting access/session flags, background request, or missing prompt/session: fail before Kimi starts.
- ACP rejection in read-only mode: record the permission event and continue through the existing bounded recovery behavior.
- Empty, refused, disconnected, or malformed terminal output: return failed, preserving actionable diagnostics.
- Write completion: state that Kimi made edits when `touchedFiles` is non-empty and list those paths exactly. Do not modify or revert them automatically.

## Packaging

The implementation adds:

- `plugins/kimi/skills/kimi-task/SKILL.md`
- `plugins/kimi/skills/kimi-task/agents/openai.yaml`

The Codex manifest and README must advertise foreground task delegation and describe the read/write authority honestly. Background jobs, durable status/result/cancel, rescue, and hooks remain explicitly excluded. The manifest’s capability declaration must include write capability only alongside the explicit-write disclosure; it must not imply sandboxed writes.

## Acceptance criteria

### Package contract

- The Codex surface test finds exactly one public `kimi-task` skill with valid frontmatter and metadata.
- The skill contains exactly one companion task invocation, requires elevation up front, and forbids sandbox-first/fallback invocation.
- The skill does not advertise background tasks or durable status/result/cancel.
- The skill validator and plugin validator pass.

### Input and controls

- A multiline prompt containing quotes, backslashes, and literal `--write` text reaches Kimi byte-for-byte through `--prompt-file`.
- No model flag leaves Kimi’s model unchanged; both aliases reach the exact expected wire IDs; invalid model and effort values fail before the prompt.
- Read-only is the default and wins if both access flags appear.
- `--background`, `--resume-last`, and ambiguous resume fail before Kimi starts.

### Permission safety

- A fake-agent mutation request in default mode receives a recorded reject decision and the scratch file remains unchanged.
- An explicit-write run receives a recorded allow decision, changes the intended scratch file, and reports that file in `touchedFiles`.
- The write approval copy states normal user filesystem authority and no Codex per-tool mediation.
- Mutating away the read-only default makes the regression test fail.

### Session behavior

- Fresh calls return different session IDs.
- Exact-ID resume calls `session/load` for that ID and recalls a seeded codeword.
- A missing, malformed, or unavailable session ID fails explicitly without falling back to a new session.
- Resuming a write session as read-only rebinds the permission policy to reject.

### Lifecycle safety

- One-shot mode creates no legacy task job record.
- Progress appears on stderr while stdout remains one parseable JSON object.
- SIGINT and client-disconnect tests both send `session/cancel`, reach a confirmed terminal state within the bound, and leave the broker available for the next task.
- A cancellation mutation that omits the ACP notification or disconnect fallback makes at least one lifecycle test fail.
- No file changes continue after a confirmed cancellation in the scratch write canary.

### Live gate

Against the installed Kimi 1.49 runtime, run one narrowly elevated invocation per canary:

1. read-only investigation completes with no writes;
2. explicit-write task edits only a disposable scratch repository target and reports it;
3. exact-session resume recalls a unique codeword;
4. interrupted slow task confirms cancellation and a subsequent task starts without `BROKER_BUSY`.

The full eight-suite deterministic gate, plugin/skill validators, and these live canaries must be green before the manifest claims task delegation.

## Implementation sequence

1. Add failing engine tests for one-shot option validation, no job persistence, exact resume, progress/final output separation, and cancellation ownership.
2. Implement the one-shot runtime path and cancel-on-disconnect broker contract by reusing existing task and ACP primitives.
3. Add failing Codex package tests, then add the task skill, metadata, manifest, and documentation changes.
4. Run mutation checks for the read-only default and both cancellation legs.
5. Run all deterministic and live gates; only then mark KMP-30 complete. KMP-32 remains open.
