# KMP-32 Design Brief — Codex-native status, result, cancellation, and background-job recovery

**Status:** design only, awaiting OWNER review before implementation. Drafted 2026-08-17 on branch `codex/kmp32-orchestration` (checkpoint base `aa17c72`). Key code claims spot-verified against this worktree.

---

## 1. Framing: what this phase actually is

KMP-30 shipped a *foreground one-shot* whose status, result, and cancellation are terminal properties of a single elevated Codex call. KMP-32 is the first Codex-surface feature where **a Kimi process outlives the invocation that authorized it**. Everything hard in this phase follows from that one fact — not from job bookkeeping, which is already proven.

The legacy machinery (`buildTaskJob` / `enqueueBackgroundTask` / `spawnDetachedTaskWorker` / `runTrackedJob` / `reconcileActiveJobs`) is battle-tested for the *Claude* harness, which supplies two things Codex does not:

1. a per-conversation identity (`KIMI_COMPANION_SESSION_ID`, exported by `plugins/kimi/scripts/session-lifecycle-hook.mjs`), and
2. a session-end signal that reaps workers.

Codex hooks and `PLUGIN_DATA` are deferred to KMP-34. So KMP-32 must supply authority binding **without a conversation id**, and must survive with **no reaper**.

---

## 2. Recommended surface shape

**Two skills, split by authority class:**

| Skill | Role | Elevation justification class |
|---|---|---|
| `$kimi-task` (extend) | Launch: foreground one-shot (today) **plus** `--codex-background` launch | *Authority-granting* — grants normal-user filesystem authority, optionally write, for a job that outlives this invocation |
| `$kimi-job` (new) | Observe (`status`, `result`) and terminate (`cancel`) an existing job by exact id | *De-escalating* — inspects local state and may only stop work; never grants authority |

**Rationale (the load-bearing one):** the two operations require materially different `require_escalated` justification text. `$kimi-task`'s consent prompt must tell the user the job will keep running after this call returns and for how long; `$kimi-job`'s must say the opposite — that it can only read records and stop work. Merging them forces one justification string to cover both, which is exactly how a "no silent write authority" boundary erodes. Separate skills also keep the launch-time write decision, which already lives in `$kimi-task` step 2, as the single place write intent is ever established.

Secondary reasons: three separate skills (`$kimi-status` / `$kimi-result` / `$kimi-cancel`) triple the always-loaded description budget for one coherent user intent and create trigger ambiguity ("show me the kimi job" matches all three); a job-id-first model is preserved *inside* `$kimi-job` regardless of skill count and is where the real safety lives.

**Runtime CLI shape** — mirror the proven `--codex-once` precedent in `plugins/kimi/scripts/kimi-companion.mjs` rather than inventing a namespace, so legacy Claude paths stay byte-untouched:

```
task   --codex-background --json [--write|--read-only] [--ttl-minutes <n>] [--model <id>] --prompt-file <path>
status --codex-job <exact-id> [--claim <token>] --json
result --codex-job <exact-id>  --claim <token>  --json
cancel --codex-job <exact-id> [--claim <token>] --json
```

`--codex-background` and `--codex-job` gate entry into new handlers (`runCodexBackgroundLaunch`, `runCodexJobStatus`, `runCodexJobResult`, `runCodexJobCancel`) exactly as `--codex-once` gates `runCodexOneShotTask` at `kimi-companion.mjs:686`. Legacy `handleTask`/`handleStatus`/`handleResult`/`handleCancel` behavior is unchanged when the flag is absent.

---

## 3. Job identity and authority binding

There is no Codex conversation id available to a shell tool, and KMP-34 is deferred. The binding is therefore a **capability, not an identity**:

- At launch the runtime mints `jobId` (exact, full, non-guessable) and a 32-byte random `claimToken`.
- The job record stores **only a SHA-256 of the token**; the plaintext is returned once, in the launch JSON, to the launching conversation's transcript.
- `--claim` is compared with `crypto.timingSafeEqual` against the stored hash.

**Honesty requirement for the skill text and this brief's own claims:** the token proves *possession of the launch output*, not *same user* and not *same conversation*. It is the strongest binding obtainable on today's Codex surface, and it is precisely the answer to safety rule 2's "what does exact mean across Codex conversations": absent a conversation id, the token **is** the exactness.

**Privileged vs unprivileged split** (this resolves the stranded-write-job tension):

| Operation | Token required? | Why |
|---|---|---|
| `cancel` | **No** | Termination de-escalates. A write-enabled job with no reachable off switch is a worse safety failure than a stranger stopping your job. |
| `status` (metadata: state, write-grant, launch time, cwd, deadline, elapsed) | **No** | Non-content; needed to find the id to cancel. |
| `status`/`result` **content** (agent message, tool outputs, touched files, `sessionId`, prompt text, progress preview) | **Yes** | Content disclosure. Critically, `sessionId` is content: leaking it across conversations reconstructs resume-by-history through the back door. |

**Enumeration:** `status` with no `--codex-job` returns **only** jobs' coarse metadata, never content, and never a resume-capable `sessionId`. There is no "latest job" default anywhere on the Codex surface.

**Job-id validation:** every `--codex-job` / `--job-id` value must match a strict pattern (`^(task|review)-[0-9a-z]+-[0-9a-z]{6}$`) before reaching `resolveJobFile` in `plugins/kimi/scripts/lib/state.mjs:330`. One rule closes two holes: the `matchJobReference` prefix-guessing hazard in `job-control.mjs:225` and the unsanitized `path.join(jobsDir, ${jobId}.json)` traversal reachable via `handleTaskWorker`'s `--job-id`.

---

## 4. Concurrency rule (a constraint the legacy code silently violates)

`plugins/kimi/scripts/acp-broker.mjs:218-224` returns `BROKER_BUSY` to any socket that is not `activeSocket`, and a background worker holds `activeSocket` for its entire `session/prompt`. Legacy `enqueueBackgroundTask` spawns a worker per job with **no queue discipline** — a second concurrent background job fails at `session/new` before it ever prompts.

**Rule:** *at most one active Codex background job per workspace.* A launch that finds an existing `queued` / `running` / `cancel-requested` job for the workspace is **refused at launch time** with the blocking job's id and state. This is consistent with KMP-30's one-at-a-time posture and avoids building a real queue for a phase whose risk budget is already spent on elevation. Make it an explicit state-machine precondition, not emergent broker behavior.

---

## 5. Authority / lifecycle state machine

### States

`queued` → `running` → { `completed` | `failed` | `cancelled` | `unknown` }, with `cancel-requested` as the only intermediate.

### Transition authority table

| Transition | Who may perform it | Authority effect | Notes |
|---|---|---|---|
| ∅ → `queued` | **Launch invocation only** (elevated `$kimi-task --codex-background`) | The *only* transition that may set `write: true`, `ttlDeadline`, `model`, `resumeSessionId`, `claimTokenHash` | Refused if another job is active (§4), if `KIMI_COMPANION_AGENT_SPAWN` is set, or if `--resume-session` is supplied without an exact id |
| `queued` → `running` | Detached worker (`task-worker`) | None. Worker **re-reads** the record and must fail loudly if `write` differs from the launch-recorded value | `runTrackedJob` in `tracked-jobs.mjs:142` already writes this |
| `running` → `completed`/`failed` | Worker only | None | `runTrackedJob` completion semantics port as-is |
| `running` → `cancelled` | **Worker only**, and only on `stopReason === "cancelled"` | None | This is the *confirmed* cancel path |
| `queued`/`running` → `cancel-requested` | Cancel invocation | **May never grant authority; may never write a terminal state** | The single most important rule in this brief |
| `cancel-requested` → `cancelled` | **Reconciler only, on evidence** | None | Evidence = worker-recorded `stopReason: cancelled`, **or** `broker/status` shows the session no longer in flight |
| `cancel-requested` → `unknown` | Reconciler, after the confirmation window elapses with no evidence | None | Labeled truthfully (§7) |
| `running` → `failed` | Reconciler, when worker liveness cannot be confirmed or the TTL deadline passed | None | Message must be *"worker liveness cannot be confirmed"*, not *"worker died"* |
| any → any | `status` / `result` invocations | **None** | Read-only; they merely trigger the shared reconcile pass |

**Invariant A (no silent write authority):** `write` is written exactly once, by the launch invocation, from the explicitly resolved `--write` flag. No other code path may set or widen it. The worker asserts the record's `write` value matches the value hashed into the launch attestation before starting the turn.

**Invariant B (no unsafe resume):** background launch accepts `--resume-session <exact-id>` only, never `--resume-last`. `resolveLatestTrackedTaskSession` and `findLatestResumableTaskJob` (`kimi-companion.mjs:190-212`) are **not reachable** from any Codex path.

**Invariant C (cancellation truthfulness):** no invocation whose purpose is to stop work may declare it stopped. Only a confirming reader may.

---

## 6. Elevation model — the thorniest question, stated plainly

**The problem, without softening it:** Codex elevation is per-invocation and non-renewable. A detached worker holds the authority of a grant whose UI affordance has already closed. The user approved *"run this now"*; a background job converts that into *"hold normal user filesystem authority — possibly write authority — for the next N minutes while I am doing something else."* Record immutability does not touch this; it only prevents *widening*.

There is no way to make a detached worker re-request elevation. So the mitigations are bounding and disclosure:

1. **Wall-clock TTL with two independent enforcers.**
   - *Self-abort:* the worker arms an `AbortController` on the same path `runCodexOneShotTask` uses (`kimi-companion.mjs:687-691`), firing at `ttlDeadline`, producing the same `Cancellation unconfirmed:` discipline already in `runKimiTurn` (`lib/kimi.mjs:~740-770`).
   - *External enforcement:* the reconciler marks any record past `ttlDeadline` terminal (`failed`, reason "deadline exceeded; liveness unconfirmed") when **any** reader arrives. A wedged worker will not honor its own timer.
   - Default ceiling 30 minutes; `--ttl-minutes` may only *lower* it; hard max enforced in the runtime, not the skill.

2. **The consent text must state what is being granted.** `$kimi-task`'s background justification must say, in the `require_escalated` justification string: that the job continues after this call returns, the maximum duration, and — for write — that Kimi holds normal user filesystem write authority for that whole window without further prompts. This is pinnable by the surface test exactly like the existing `normal user filesystem authority` / `not an OS sandbox` assertions.

3. **Env sanitization at spawn.** `spawnDetachedTaskWorker` (`kimi-companion.mjs:714`) currently passes `env: process.env` wholesale. The Codex path must spawn with a curated env (`PATH`, `HOME`, `KIMI_COMPANION_DATA`, model/locale essentials) and must **refuse launch entirely when `KIMI_COMPANION_AGENT_SPAWN` is set** — `getKimiAvailability` returns `available: true` unconditionally under that override (`lib/kimi.mjs:357-362`), so a test seam would otherwise let a detached process outlive the shell that set it.

4. **New disclosure property.** Foreground one-shots delete the temp prompt file in `finally`. Background necessarily persists the prompt text **and** the result into the state dir (`enqueueBackgroundTask` stores `request` in the job file). The skill text must say so; the record must be removed with the job.

**Recommendation to the OWNER** (see Q1): land read-only background first and treat write-enabled background as a separate, explicit decision. That mirrors KMP-30's shipped posture and puts the irreducible elevation risk where it belongs — with the owner, not inside a design brief.

---

## 7. Cancellation truthfulness for detached workers

**Verified finding — legacy `handleCancel` can make a false CANCELLED claim.** `kimi-companion.mjs:1028-1099` requires only that *one of* `cancel.attempted`, `postKillCancel.attempted`, or `kill.delivered` be true, then unconditionally writes `status: "cancelled"`. But:

- `cancel.attempted` means only *"a `session/cancel` notification was written to the broker socket"* (`cancelKimiSession`, `lib/kimi.mjs:784-803`) — no acknowledgement exists.
- `kill.delivered` means only *"the worker got SIGTERM."* The broker **deliberately** keeps a dead socket's turn alive (comment at `acp-broker.mjs:71-77`).

So the legacy path can report `CANCELLED` while Kimi is still mid-turn writing files. Under safety rule 3 that does **not** port verbatim. *(Spot-verified 2026-08-17: the only guard is the throw when nothing at all was signalled; `status: "cancelled"` is then written unconditionally.)*

**Carried forward as-is** (these parts are good and should be preserved): the `terminateProcessTree` direct-pid fallback for non-group-leader pids (`lib/process.mjs:104-118`), and the refusal to report success when provably nothing was signalled (`kimi-companion.mjs:1061`).

**Redesign — killing is the trigger, the broker is the confirmation.** The broker already has the right primitive: `handleSocketDisconnect` (`acp-broker.mjs:109-123`) fires `session/cancel` when the owning socket dies, gated on `cancelOnDisconnectSessions` + `sessionOwners` + `activeSessionBySocket`. A background worker that sets `cancelOnDisconnect: true` converts "kill the worker" into "the broker cancels the turn."

Add one broker method:

```
broker/status → { agentAlive, busy, activeSessions: [sessionId] }
```

**Implementation constraint:** it must be answered locally *before* the busy gate — same position as `initialize` (`acp-broker.mjs:185`) and `broker/session_policy` (`:196`). Placed after the gate, a busy broker returns `BROKER_BUSY` to the probe and the caller learns nothing about *which* session is in flight, which is the entire point. *(Spot-verified: both existing methods are answered ahead of the `activeSocket` busy check.)*

**Cancel sequence:**
1. `cancel` writes `cancel-requested` (never terminal), records `cancelRequestedAt`.
2. Sends `session/cancel` for the recorded `sessionId`.
3. `terminateProcessTree(job.pid)` — which also triggers broker-side `cancelOnDisconnect`.
4. Polls `broker/status` for a bounded window (~5s, several probes).
5. Terminal `cancelled` **only** if the session is absent from `activeSessions` or the worker recorded `stopReason: cancelled`. Otherwise `unknown`, with a message naming the residual risk *and the write grant if it had one*: "Cancellation unconfirmed — Kimi may still be running with write authority; check `git status`."

---

## 8. Recovery matrix

| Failure | Broker/agent effect | What the observer sees | Recoverable? | Must fail loudly |
|---|---|---|---|---|
| Launching Codex shell exits (normal case) | none | job continues; `status` works | Yes — this is the feature | no |
| Worker killed (SIGKILL / OOM) | broker's `cancelOnDisconnect` fires `session/cancel` on socket death | reconciler: `running` → `failed`, "worker liveness cannot be confirmed"; if `write` was granted, status says edits may be partial | Partially — no result; `sessionId` preserved for explicit resume | yes |
| Broker dies | worker's pending `session/prompt` rejects (`acp-client.mjs:231-234`) | `runTrackedJob` catch → `failed` with the transport error | No | yes |
| Agent (`kimi acp`) dies | broker exits via `appClient.exitPromise` → `shutdown` → `exit(1)` (`acp-broker.mjs:328-334`) | same as broker death | No | yes |
| Machine reboot | all processes gone; `broker.json` stale but `reuseExistingBroker` probes before trusting | reconciler must mark `failed` **without signalling any pid** | No | yes |
| TTL exceeded, worker wedged | turn may still be live on the broker | `failed`, "deadline exceeded; liveness unconfirmed"; `broker/status` consulted before any claim about the turn | No | yes |
| Claim token lost | none | `cancel` and coarse `status` still work; content and `sessionId` are unrecoverable | Deliberately not | no (by design) |

**Does `reconcileActiveJobs` port as-is? No — it adapts.** `job-control.mjs:33-50` reconciles purely on `process.kill(pid, 0)`. After a reboot, pids are recycled: a live unrelated process yields a false `running`, and `handleCancel` would then signal a stranger's pid. Additions:

- Record `bootId` (derived from `Date.now() - os.uptime()*1000`) and the worker's own start time at launch. A `bootId` mismatch means the process is definitionally gone → mark terminal **without signalling**.
- Compare `bootId` **with a tolerance** (`os.uptime()` drifts by seconds); a false mismatch marks a live job dead, which is its own false claim. Tolerance ≈ 5s, and the failure text is *"worker liveness cannot be confirmed"*, never *"worker died."*
- Enforce `ttlDeadline` here (§6).

---

## 9. Port / adapt / do-not-port

| Item | Location | Verdict | Reason |
|---|---|---|---|
| `state.mjs` locking, namespacing, migration | `lib/state.mjs` | **Port verbatim** | KMP-23-hardened; nothing Codex-specific |
| `runTrackedJob` completion semantics (cancelled ≠ failed) | `lib/tracked-jobs.mjs:142` | **Port verbatim** | Already prevents mislabeling a cancelled job |
| `createJobLogFile` / `readJobProgressPreview` | `tracked-jobs.mjs`, `job-control.mjs:95` | **Port verbatim** | Progress preview is content → token-gated at the surface, not here |
| `terminateProcessTree` direct-pid fallback | `lib/process.mjs:104-118` | **Port verbatim** | Correct and load-bearing |
| "Refuse to claim success when nothing was signalled" | `kimi-companion.mjs:1061` | **Port verbatim** | Necessary but not sufficient (§7) |
| `reconcileActiveJobs` | `job-control.mjs:33` | **Adapt** | Add bootId + start-time + TTL; never signal across a reboot boundary |
| `enqueueBackgroundTask` / `spawnDetachedTaskWorker` | `kimi-companion.mjs:714-758` | **Adapt** | Curated env; refuse under `AGENT_SPAWN` override; store `claimTokenHash`, `ttlDeadline`, `bootId`; single-active-job precondition |
| `handleCancel` | `kimi-companion.mjs:1028` | **Adapt (materially)** | Terminal `cancelled` requires confirmation; add `cancel-requested` and `unknown` |
| `buildStatusSnapshot` | `job-control.mjs:247` | **Adapt** | Content stripped unless token-authenticated; no "latest finished" default |
| `MAX_JOBS` pruning | `state.mjs:166-170` | **Adapt** | Exclude active jobs. Reason is stronger than "updatedAt is recent": `createJobProgressUpdater` upserts only when phase/threadId/turnId *changes*, so `updatedAt` is **not** a liveness proxy |
| `matchJobReference` prefix matching | `job-control.mjs:225-245` | **Do not port** | Guessing surface + traversal vector; exact ids only |
| `filterJobsForCurrentSession` | `job-control.mjs:56-62` | **Do not port** | Fails **open**: `if (!sessionId) return jobs`. On Codex there is no session env, so it degrades to "show everything" *(spot-verified verbatim)* |
| `--resume-last` / `resolveLatestTrackedTaskSession` / `findLatestResumableTaskJob` / `task-resume-candidate` | `kimi-companion.mjs:190-212, 994-1026` | **Do not port** | Resume-by-history; banned by safety rule 2 |
| `resolveResultJob(reference = "")` "latest finished" | `job-control.mjs:292` | **Do not port** | Same class of history guessing, for results |
| `session-lifecycle-hook.mjs` job cleanup | whole file | **Do not port (KMP-34)** | No Codex hook surface; and `cleanupSessionJobs` *deletes* records, destroying the audit trail a recovery feature exists to provide |
| Broker teardown at session end | `session-lifecycle-hook.mjs:104` | **Do not port** | Would kill a live background job's runtime |
| `broker/status` | *(new)* | **New** | Cancellation and status truthfulness both depend on it |

---

## 10. Rejected alternatives

| Alternative | Rejected because |
|---|---|
| Three skills (`$kimi-status` / `$kimi-result` / `$kimi-cancel`) | Triples always-loaded description budget for one intent; creates trigger ambiguity; splits nothing that differs in authority class |
| Single mega-skill covering launch + observe + cancel | Forces one `require_escalated` justification to describe both granting and de-escalating authority — the exact wording erosion that safety rule 1 guards against |
| Recovery-only (no background launch; port status/result/cancel purely to recover orphaned foreground one-shots) | Genuinely safer and worth the owner's consideration, but a foreground one-shot writes no durable record, so there is nothing to recover — it would require inventing the record anyway. Kept as a fallback if Q1 goes the conservative way |
| Reuse `KIMI_COMPANION_SESSION_ID` for conversation binding | No producer on the Codex surface (hook deferred to KMP-34) and its consumer fails open |
| Real job queueing (N background jobs) | The broker serializes turns by design; a queue is substantial new machinery whose failure modes (starvation, stale queue entries, ordering vs TTL) exceed this phase's risk budget |
| Kill-and-declare cancellation (legacy behavior) | Provably capable of a false `CANCELLED` while Kimi is mid-write (§7) |
| Encrypting/redacting the persisted prompt | False assurance: same-user threat model; the honest move is disclosure in the skill text plus removal with the job |
| Storing the claim token in plaintext in the record | Any local reader of the state dir gains content access; hashing costs nothing |

---

## 11. Documentation and surface-test fan-out

KMP-30 deliberately pinned the narrow boundary in `plugins/kimi/tests/codex-plugin-surface.test.mjs`. Widening the surface **must update every pin**, and the implementer will be tempted to delete assertions. **Rule: each narrow-boundary assertion is replaced by a narrower, still-true one — never removed.**

In scope:

- `codex-plugin-surface.test.mjs:163` — `doesNotMatch($kimi-status|$kimi-result|$kimi-cancel)` → replaced by an assertion that `$kimi-task` references `$kimi-job` and *only* `$kimi-job`
- `:162` — `background.*not supported` → replaced by "background is one-at-a-time, TTL-bounded, exact-id only"
- `:174` — `longDescription` must match `background.*lifecycle.*not included` → replaced with the bounded description
- `:57-66` — README / AGENTS / PLAN must all assert `background.*durable.*deferred` and `rescue.*deferred` → the rescue clause stays (KMP-33), the background clause is replaced
- `plugins/kimi/.codex-plugin/plugin.json` — `description`, `interface.longDescription`, `interface.defaultPrompt`, version bump; `:16` pins `version === "0.1.5"`
- `AGENTS.md` lines 7 and 25-26; `docs/PLAN.md` §0 and the §5 M2 deferral note; `docs/ROADMAP.md` KMP-32 entry
- New assertions for `$kimi-job`: exact-id requirement, token-gated content, cancel-never-claims-unconfirmed, TTL disclosure in the launch justification

---

## 12. Verification plan (KMP-30 Phase-5 style)

### Deterministic suites

**`plugins/kimi/tests/kimi-companion.test.mjs`** — new scenarios:
1. Background launch returns `jobId` + `claimToken`; record stores only the hash.
2. `result` without `--claim` → refused; with a wrong token → refused (constant-time compare exercised); with the right token → content returned.
3. `status` without token returns metadata **and no** `sessionId`, `rawOutput`, `toolOutputs`, or `progressPreview`.
4. Second concurrent background launch is refused, naming the active job.
5. `--resume-last`, `--resume`, and `task-resume-candidate` are unreachable with `--codex-background`.
6. Malformed / traversing job ids (`../../x`, prefix fragments) are rejected before any filesystem access.
7. Launch refused when `KIMI_COMPANION_AGENT_SPAWN` is set.
8. Worker whose record says `write: false` refuses to run if the record is mutated to `write: true` after launch.
9. TTL exceeded → reconciler marks `failed` with "liveness unconfirmed" wording, no signal sent.
10. Simulated reboot (bootId mismatch) → terminal without any `process.kill` call (assert via injected kill impl).
11. Active job is never pruned by `MAX_JOBS`.

**`plugins/kimi/tests/acp-broker.test.mjs`** — new scenarios:
12. `broker/status` is answered while the broker is busy (proves it sits before the busy gate) and names the in-flight session.
13. `cancelOnDisconnect` fires `session/cancel` when the owning worker socket dies (extend existing coverage to the background-worker shape).

**`plugins/kimi/tests/fixtures/fake-acp-agent.mjs`** — new scenarios:
- `turn-survives-socket-death` — the turn keeps running after its socket dies. **This is the fixture that exercises the false-cancel path.**
- `cancel-ignored` — agent ignores `session/cancel`; the runtime must land on `unknown`, never `cancelled`.
- `broker-dies-mid-turn` — verifies (rather than assumes) that the pending `session/prompt` rejects and `runTrackedJob` records `failed`.

**`plugins/kimi/tests/codex-plugin-surface.test.mjs`** — the replacements in §11.

### Mutation checks (each must turn a specific test red)

| Mutation | Test that must fail |
|---|---|
| Remove the `broker/status` confirmation from cancel | "claims CANCELLED unconfirmed" test |
| Remove the `--claim` check from `result` | content-disclosure test (#2) |
| Restore `write` from a request payload instead of the sealed record | #8 |
| Drop the bootId guard from `reconcileActiveJobs` | #10 (a kill would be issued) |
| Move `broker/status` after the busy gate | #12 |
| Remove the single-active-job precondition | #4 |

### Live canaries (Kimi 1.49, GATE-KMP-32)

1. Read-only background launch; launching shell exits immediately; `status` from a fresh invocation shows `running`; `result` after completion returns the answer with matching `sessionId`.
2. Same, but the worker is `kill -9`'d mid-turn → observer gets `failed` / "liveness cannot be confirmed", never `completed`.
3. Cancel of a live background job → `CANCELLED` **only** after `broker/status` confirms the session is gone; assert no post-cancel file mutation within the full window (mirrors KMP-30's delayed-write check).
4. Cancel of a `cancel-ignored`-style long turn → `UNKNOWN` with the residual-risk message; assert the runtime does *not* print `CANCELLED`.
5. `result` with a wrong token → refused; with the right token → full content.
6. TTL set to 1 minute on a longer task → job terminates and is reported truthfully by both enforcers (worker self-abort *and* an external reader).
7. (If Q1 permits write background) Write-enabled background job edits a scratch repo; `touchedFiles` exact; the consent justification stating the duration ceiling was displayed.

Plus the standing gates: all eight deterministic sentinels on the exact head, plugin + skill validators, `node spike/acp-spike.mjs` → `SPIKE-GREEN`, and a stale-process audit before and after (background jobs make process leaks materially more likely than KMP-30 did).

---

## 13. Open questions for the OWNER

> **Q1 — Does write-enabled background land in this phase, or read-only only?**
> Recommendation: design the full state machine now (as above) but gate the *first landing* to read-only background, with write-enabled background as a separate explicit decision. Rationale: the elevation gap in §6 is irreducible — a detached worker holds authority whose consent affordance has closed — and read-only background carries only the "Kimi reads your repo unattended" risk, while write background carries "Kimi edits your repo unattended, unprompted, for up to 30 minutes." This mirrors KMP-30's shipped posture.

> **Q2 — What is the maximum background TTL, and what happens at expiry?**
> Recommendation: 30-minute default, 60-minute hard ceiling, expiry = terminate and report `failed`/"deadline exceeded" (never silently extend, never auto-resume). The ceiling must appear verbatim in the `require_escalated` justification. The owner should set the numbers because they are a stated promise to the user, not an implementation detail.

> **Q3 — Is `cancel` correctly unprivileged (no claim token)?**
> Recommendation: yes — termination de-escalates, and a write-enabled job with no reachable off switch is the worse failure. The cost is that any local caller can stop any job in the workspace. If the owner prefers token-gated cancel, we need a documented break-glass path, or a lost token means a live write job that only `kill` can stop.

---

## Critical files for implementation

- `plugins/kimi/scripts/kimi-companion.mjs` — new `runCodexBackgroundLaunch` / `runCodexJob{Status,Result,Cancel}` handlers beside `runCodexOneShotTask`; adapts `enqueueBackgroundTask`, `spawnDetachedTaskWorker`, `handleTaskWorker`, `handleCancel`
- `plugins/kimi/scripts/lib/job-control.mjs` — `reconcileActiveJobs` (bootId + TTL + no-signal-across-reboot), token-scoped snapshot builders, removal of `matchJobReference` prefix matching and `filterJobsForCurrentSession`
- `plugins/kimi/scripts/acp-broker.mjs` — `broker/status`, answered locally before the busy gate
- `plugins/kimi/skills/kimi-task/SKILL.md` + new `plugins/kimi/skills/kimi-job/SKILL.md` (and `agents/openai.yaml`) — the two authority-class justifications
- `plugins/kimi/tests/codex-plugin-surface.test.mjs` — every narrow-boundary pin replaced, never deleted
