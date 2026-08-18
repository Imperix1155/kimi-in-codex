import fs from "node:fs";
import process from "node:process";

import {
  assertJobId,
  bootIdMatches,
  CANCEL_EVIDENCE_WINDOW_MS,
  DEADLINE_EXCEEDED_MESSAGE,
  isPastTtlDeadline,
  LIVENESS_UNCONFIRMED_MESSAGE,
  REBOOT_LIVENESS_MESSAGE,
  TTL_SELF_ABORT_MESSAGE
} from "./codex-jobs.mjs";
import { getSessionRuntimeStatus } from "./kimi.mjs";
import { getConfig, listJobs, patchJobUnderLock, readJobFile, resolveJobFile, upsertJob } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but is not ours.
    return error?.code === "EPERM";
  }
}

// An externally killed or crashed worker cannot update its own record, so
// active statuses are reconciled against process liveness on every read.
// This also keeps /kimi:cancel from signalling a recycled pid for a job
// whose worker died long ago.
export function reconcileActiveJobs(workspaceRoot, options = {}) {
  const isAlive = options.isProcessAliveImpl ?? isProcessAlive;
  for (const job of listJobs(workspaceRoot)) {
    // KMP-32: Codex background records carry a boot identity and a wall-clock
    // deadline, and their reconciliation must never signal a pid. Legacy
    // Claude records keep the original path and message byte-for-byte.
    if (job.codexBackground) {
      reconcileCodexBackgroundJob(workspaceRoot, job, options, isAlive);
      continue;
    }
    if (job.status !== "queued" && job.status !== "running") {
      continue;
    }
    if (!Number.isFinite(job.pid) || isAlive(job.pid)) {
      continue;
    }
    upsertJob(workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: "Worker process died without recording a result.",
      completedAt: new Date().toISOString()
    });
  }
}

// Terminal writes go to BOTH the index and the durable record, so an
// observer reading either sees the same truth — and both go out inside ONE
// lock hold. The unlocked index-write-then-record-read-then-record-write it
// replaces is the same read-then-write family as F1: the worker settles in
// two writes, so a completion landing between the reconciler's own two
// writes was relabelled `failed`/`unknown` and its result payload wiped.
//
// `abortIfSettled` is the RECONCILER's guard, not a blanket one. TTL
// attribution (attributeTtlExpiry) exists precisely to relabel a record that
// is already terminal — `cancelled`, or `failed` with the wedged-agent
// message — so applying the guard there would turn it into a no-op.
function markCodexJobTerminal(workspaceRoot, job, status, errorMessage, { abortIfSettled = false } = {}) {
  const completedAt = new Date().toISOString();
  const patch = {
    id: job.id,
    status,
    phase: status,
    pid: null,
    errorMessage,
    completedAt
  };
  return patchJobUnderLock(workspaceRoot, job.id, ({ stored, indexed }) => {
    if (abortIfSettled && settledCodexJobStatus(stored, indexed)) {
      return null;
    }
    return patch;
  }).applied;
}

// TTL self-abort attribution (§14 Q2): a worker whose own deadline timer
// fired ends the turn as a graceful ACP cancel, which runTrackedJob records
// as `cancelled` — indistinguishable from a user cancellation. The contract
// says expiry is reported `failed`/deadline-exceeded, and the label must not
// depend on which enforcer (self-abort vs reconciler) won the race. A job
// that beat the timer to `completed` keeps its result (the same
// never-destroy-a-settled-result rule cancel follows).
//
// Called ONLY under the worker's own ttlExpired flag, which is set nowhere
// but inside the deadline timer's callback.
export function attributeTtlExpiry(workspaceRoot, jobId) {
  const stored = readStoredJob(workspaceRoot, jobId);
  if (!stored || !stored.codexBackground) {
    return false;
  }
  // C1 (driver ruling, 2026-08-17): a record carrying cancelRequestedAt had a
  // USER cancellation in play, and the user's label wins — TTL attribution is
  // for jobs nobody asked to stop. Read from both sources: runTrackedJob's
  // completion write rebuilds the record from a snapshot taken at job start,
  // dropping cancelRequestedAt from the durable file, while its index write
  // is a merge patch that keeps it.
  const indexed = listJobs(workspaceRoot).find((job) => job.id === jobId) ?? null;
  if (stored.cancelRequestedAt || indexed?.cancelRequestedAt) {
    return false;
  }
  if (!isTtlAttributableStatus(stored)) {
    return false;
  }
  markCodexJobTerminal(workspaceRoot, stored, "failed", TTL_SELF_ABORT_MESSAGE);
  return true;
}

function isTtlAttributableStatus(stored) {
  // The agent honored the abort: a graceful cancel with no user behind it.
  if (stored.status === "cancelled") {
    return true;
  }
  // The WEDGED agent — the case the deadline exists for. It never
  // acknowledges the abort, so runKimiTurn throws "Cancellation unconfirmed:
  // ..." instead of returning a cancelled stop reason, and the job lands
  // `failed` naming a cancellation nobody requested and never naming the
  // deadline. Neither enforcer would otherwise attribute it: the reader-side
  // reconciler early-returns on a terminal status.
  return stored.status === "failed" && /^Cancellation unconfirmed:/.test(stored.errorMessage ?? "");
}

// The reconciler is the EXTERNAL enforcer: a wedged worker will not honor
// its own timer, and a killed one cannot record anything at all. Every
// terminal state it writes is labeled with what was actually established —
// "liveness cannot be confirmed", never "the worker died".
//
// Invariant C: this function may promote cancel-requested to `cancelled`
// only on worker-recorded evidence. With no evidence it says `unknown`.
function reconcileCodexBackgroundJob(workspaceRoot, job, options, isAlive) {
  const now = options.now ?? Date.now();
  if (!isActiveCodexJobStatus(job.status)) {
    return;
  }
  const cancelRequested = job.status === "cancel-requested";
  const unresolvedStatus = cancelRequested ? "unknown" : "failed";

  // Reboot boundary first, and WITHOUT any liveness probe: after a reboot
  // pids are recycled, so probing one risks reading (or later signalling) an
  // unrelated process. A bootId mismatch means the worker is definitionally
  // gone.
  if (!bootIdMatches(job.bootId, options.bootId)) {
    markCodexJobTerminal(
      workspaceRoot,
      job,
      unresolvedStatus,
      cancelRequested ? `${REBOOT_LIVENESS_MESSAGE} The cancellation was never confirmed.` : REBOOT_LIVENESS_MESSAGE,
      { abortIfSettled: true }
    );
    return;
  }

  if (isPastTtlDeadline(job, now)) {
    markCodexJobTerminal(
      workspaceRoot,
      job,
      unresolvedStatus,
      cancelRequested ? `${DEADLINE_EXCEEDED_MESSAGE} The cancellation was never confirmed.` : DEADLINE_EXCEEDED_MESSAGE,
      { abortIfSettled: true }
    );
    return;
  }

  const workerGone = Number.isFinite(job.pid) && !isAlive(job.pid);
  if (workerGone) {
    markCodexJobTerminal(
      workspaceRoot,
      job,
      unresolvedStatus,
      cancelRequested
        ? `${LIVENESS_UNCONFIRMED_MESSAGE} The worker never recorded a cancelled stop reason, so the turn's fate is unknown.`
        : LIVENESS_UNCONFIRMED_MESSAGE,
      { abortIfSettled: true }
    );
    return;
  }

  // Still alive: only a cancel-requested job that has waited out the
  // confirmation window without evidence becomes terminal, as `unknown`.
  if (cancelRequested) {
    const requestedAt = Date.parse(job.cancelRequestedAt ?? "");
    if (Number.isFinite(requestedAt) && now - requestedAt > CANCEL_EVIDENCE_WINDOW_MS) {
      markCodexJobTerminal(
        workspaceRoot,
        job,
        "unknown",
        "Cancellation was requested but never confirmed: no cancelled stop reason was recorded and the session could not be shown gone.",
        { abortIfSettled: true }
      );
    }
  }
}

function isActiveCodexJobStatus(status) {
  return status === "queued" || status === "running" || status === "cancel-requested";
}

// KMP-32 F1: NEITHER source is authoritative on its own. The worker settles a
// job in two writes — the durable record first, the index second — so the
// index is stale during the gap; the reconciler patches the index, so the
// durable record is stale on that path. A job is SETTLED as soon as either
// says so, and reading only one is how a cancel comes to overwrite a
// `completed` record and report a confirmed cancellation of finished work.
export function settledCodexJobStatus(stored, indexed) {
  for (const record of [stored, indexed]) {
    const status = record?.status;
    if (status && !isActiveCodexJobStatus(status)) {
      return status;
    }
  }
  return null;
}

export function findActiveJob(jobs) {
  return sortJobsNewestFirst(jobs).find((job) => isActiveCodexJobStatus(job.status)) ?? null;
}

// Exact ids only, and only Codex background records. There is no
// "latest job" default anywhere on the Codex surface.
export function resolveCodexBackgroundJob(cwd, jobId, options = {}) {
  assertJobId(jobId);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (options.reconcile !== false) {
    reconcileActiveJobs(workspaceRoot, options);
  }
  const stored = readStoredJob(workspaceRoot, jobId);
  const indexed = listJobs(workspaceRoot).find((job) => job.id === jobId) ?? null;
  if (!stored || !stored.codexBackground) {
    throw new Error(
      `No Codex background job found for "${jobId}". Exact job ids only; run status with no job id to list this workspace's background jobs.`
    );
  }
  // The index carries the freshest status (the reconciler and concurrent
  // writers patch it); the durable record carries the result payload. Both
  // are returned UNMERGED as well, because the merged view hides a terminal
  // status that only one of them has seen yet (see settledCodexJobStatus).
  return { workspaceRoot, job: { ...stored, ...(indexed ?? {}), id: jobId }, stored, indexed };
}

export function listCodexBackgroundJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot, options);
  return {
    workspaceRoot,
    jobs: sortJobsNewestFirst(listJobs(workspaceRoot).filter((job) => job.codexBackground))
  };
}

export function findActiveWorkspaceJob(workspaceRoot, options = {}) {
  reconcileActiveJobs(workspaceRoot, options);
  return findActiveJob(listJobs(workspaceRoot));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "task";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "task";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting kimi") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("kimi error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /kimi:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /kimi:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /kimi:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /kimi:status to inspect active jobs.`);
  }

  throw new Error("No finished Kimi jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileActiveJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Kimi jobs are active. Pass a job id to /kimi:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Kimi jobs to cancel for this session.");
  }

  throw new Error("No active Kimi jobs to cancel.");
}
