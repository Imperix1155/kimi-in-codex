// KMP-32: identity, authority binding, and disclosure rules for Codex
// background jobs — the first Codex-surface feature where a Kimi process
// outlives the invocation that authorized it.
//
// There is no Codex conversation id available to a shell tool, so the
// binding is a CAPABILITY, not an identity: the claim token proves
// possession of the launch output, not "same user" and not "same
// conversation". That is the strongest binding obtainable on today's
// surface, and it is what "exact" means here.

import crypto from "node:crypto";
import os from "node:os";

// Exact ids only. One rule closes two holes: prefix guessing, and the
// `path.join(jobsDir, `${jobId}.json`)` traversal reachable from every
// caller-supplied id (`--codex-job`, `--job-id`).
export const CODEX_JOB_ID_PATTERN = /^(task|review)-[0-9a-z]+-[0-9a-z]{6}$/;

// Owner decision Q2 (2026-08-17): 30-minute default, 60-minute hard
// ceiling. --ttl-minutes may only LOWER the default. Both numbers are a
// stated promise to the user and appear verbatim in the launch consent text.
export const DEFAULT_TTL_MINUTES = 30;
export const HARD_CEILING_TTL_MINUTES = 60;

// os.uptime() drifts by seconds, so bootId is compared with tolerance: a
// false mismatch marks a LIVE job dead, which is its own false claim.
export const BOOT_ID_TOLERANCE_MS = 5000;

// How long a cancel invocation polls broker/status for confirmation, and
// how long a reconciler waits for worker-recorded evidence before it
// labels a cancel-requested job `unknown`.
export const CANCEL_CONFIRM_WINDOW_MS = 5000;
export const CANCEL_CONFIRM_POLL_MS = 400;
export const CANCEL_EVIDENCE_WINDOW_MS = 15000;

export const CODEX_ACTIVE_STATUSES = ["queued", "running", "cancel-requested"];

export function isActiveCodexStatus(status) {
  return CODEX_ACTIVE_STATUSES.includes(status);
}

export function isValidJobId(value) {
  return typeof value === "string" && CODEX_JOB_ID_PATTERN.test(value);
}

export function assertJobId(value) {
  if (!isValidJobId(value)) {
    throw new Error(
      `Invalid job id ${JSON.stringify(String(value ?? ""))}. Job ids are exact and look like task-<base36>-<6 chars>; prefixes, paths, and partial ids are not accepted.`
    );
  }
  return value;
}

export function mintClaimToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashClaimToken(token) {
  return crypto.createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

// Constant-time over FIXED-LENGTH digests: timingSafeEqual throws on a
// length mismatch, so the raw caller-supplied token is never compared
// directly (a malformed token must be refused, not crash).
export function verifyClaimToken(token, storedHash) {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(hashClaimToken(token), "hex"),
    Buffer.from(storedHash, "hex")
  );
}

// Approximate wall-clock time of the last boot. After a reboot pids are
// recycled, so a live unrelated process would otherwise read as a live
// worker — and cancel would signal a stranger's pid.
export function currentBootId(uptimeSeconds = os.uptime()) {
  return Math.round(Date.now() - uptimeSeconds * 1000);
}

export function bootIdMatches(recordedBootId, current = currentBootId()) {
  if (!Number.isFinite(recordedBootId)) {
    return false;
  }
  return Math.abs(recordedBootId - current) <= BOOT_ID_TOLERANCE_MS;
}

// Invariant A: `write` (and the rest of the grant) is written exactly once,
// by the launch invocation. The seal lets the detached worker prove the
// record it is about to act on is the record the user consented to.
export function computeAuthoritySeal(record) {
  const sealed = [
    String(record.id ?? ""),
    record.write === true,
    record.ttlDeadline ?? null,
    record.model ?? null,
    record.resumeSessionId ?? null,
    record.cwd ?? null,
    record.claimTokenHash ?? null
  ];
  return crypto.createHash("sha256").update(JSON.stringify(sealed), "utf8").digest("hex");
}

export function assertSealedLaunchAuthority(record) {
  const expected = computeAuthoritySeal(record);
  if (typeof record.authoritySeal !== "string" || record.authoritySeal.length !== 64) {
    throw new Error(`Refusing to run ${record.id}: the job record carries no sealed launch authority.`);
  }
  if (
    !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(record.authoritySeal, "hex"))
  ) {
    throw new Error(
      `Refusing to run ${record.id}: the sealed launch authority does not match the job record. The record was modified after launch; no turn will start.`
    );
  }
  if (record.write !== false) {
    throw new Error(
      `Refusing to run ${record.id}: background Kimi jobs are sealed read-only, but the record grants write authority.`
    );
  }
  // The request payload is a convenience copy. The SEALED record is the
  // authority; a divergence means something rewrote one of the two.
  const requestWrite = record.request?.write;
  if (requestWrite !== record.write) {
    throw new Error(
      `Refusing to run ${record.id}: the request payload's write authority (${JSON.stringify(requestWrite)}) does not match the sealed record (${JSON.stringify(record.write)}).`
    );
  }
  return record;
}

export function resolveTtlMinutes(raw) {
  if (raw == null || raw === "") {
    return DEFAULT_TTL_MINUTES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--ttl-minutes requires a whole number of minutes, at least 1.");
  }
  if (value > DEFAULT_TTL_MINUTES) {
    throw new Error(
      `--ttl-minutes may only lower the ${DEFAULT_TTL_MINUTES}-minute default (the runtime's hard ceiling is ${HARD_CEILING_TTL_MINUTES} minutes).`
    );
  }
  return value;
}

export function computeTtlDeadline(ttlMinutes, from = Date.now()) {
  const minutes = Math.min(ttlMinutes, HARD_CEILING_TTL_MINUTES);
  return new Date(from + minutes * 60_000).toISOString();
}

export function isPastTtlDeadline(record, now = Date.now()) {
  const deadline = Date.parse(record.ttlDeadline ?? "");
  return Number.isFinite(deadline) && now > deadline;
}

// Coarse metadata: everything a caller needs to FIND the job it wants to
// cancel, and nothing that discloses what Kimi saw or said. `sessionId` is
// deliberately absent — leaking it across conversations reconstructs
// resume-by-history through the back door.
export function buildCodexJobMetadata(job, now = Date.now()) {
  const deadline = Date.parse(job.ttlDeadline ?? "");
  return {
    jobId: job.id ?? null,
    status: job.status ?? "unknown",
    phase: job.phase ?? null,
    write: job.write === true,
    model: job.model ?? null,
    cwd: job.cwd ?? null,
    workspaceRoot: job.workspaceRoot ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    cancelRequestedAt: job.cancelRequestedAt ?? null,
    ttlMinutes: job.ttlMinutes ?? null,
    ttlDeadline: job.ttlDeadline ?? null,
    expiresInSeconds: Number.isFinite(deadline) ? Math.max(0, Math.round((deadline - now) / 1000)) : null,
    stopReason: job.result?.stopReason ?? job.stopReason ?? null,
    // Runtime diagnostics and the cancellation residual-risk message. Not
    // agent content, and withholding it would hide exactly the truths this
    // phase exists to tell.
    errorMessage: job.errorMessage ?? null
  };
}

export function buildResidualRiskMessage(write) {
  return write
    ? "Cancellation unconfirmed - Kimi may still be running with write authority; check `git status`."
    : "Cancellation unconfirmed - Kimi may still be running. This job was sealed read-only, so it holds no write authority and cannot change files.";
}

export const LIVENESS_UNCONFIRMED_MESSAGE = "Worker liveness cannot be confirmed; no result was recorded.";
export const REBOOT_LIVENESS_MESSAGE =
  "Worker liveness cannot be confirmed: the recorded worker did not survive a reboot boundary. No signal was sent to any process.";
export const DEADLINE_EXCEEDED_MESSAGE = "Deadline exceeded; worker liveness cannot be confirmed.";
