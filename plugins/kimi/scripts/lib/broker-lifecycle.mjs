import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "KIMI_COMPANION_BROKER_PID_FILE";
export const LOG_FILE_ENV = "KIMI_COMPANION_BROKER_LOG_FILE";
export const BROKER_LOG_TAIL_BYTES = 8 * 1024;
const BROKER_STATE_FILE = "broker.json";
const BROKER_SPAWN_ERROR_CODES = new Set([
  "E2BIG", "EACCES", "EAGAIN", "EINVAL", "EMFILE", "ENFILE",
  "ENOENT", "ENOEXEC", "ENOMEM", "EPERM"
]);

export class BrokerStartupError extends Error {
  constructor(message, brokerStartup) {
    super(message);
    this.name = "BrokerStartupError";
    this.data = { brokerStartup };
  }
}

export function createBrokerSessionDir(prefix = "kmc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, extraArgs = [], env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile, ...extraArgs],
    {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    }
  );
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function waitForChildClose(child) {
  return new Promise((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ reason: "child-exit", exitCode, signal }));
    child.once("error", (error) => {
      const spawnErrorCode = typeof error?.code === "string" && BROKER_SPAWN_ERROR_CODES.has(error.code)
        ? error.code
        : null;
      resolve({ reason: "spawn-error", exitCode: null, signal: null, spawnErrorCode });
    });
  });
}

function readBrokerLogTail(logFile, maxBytes = BROKER_LOG_TAIL_BYTES) {
  if (!fs.existsSync(logFile)) {
    return { logTail: "", logTruncated: false };
  }
  const size = fs.statSync(logFile).size;
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(logFile, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  let logTail = buffer.toString("utf8");
  while (Buffer.byteLength(logTail, "utf8") > maxBytes) {
    logTail = Array.from(logTail).slice(1).join("");
  }
  return {
    logTail,
    logTruncated: size > maxBytes
  };
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

// KMP-32: ABSENT and UNREADABLE are different facts, and a caller that treats
// "no endpoint" as proof that no runtime is up must not conflate them. A
// missing record means none was ever written; a present-but-unparseable one
// means we know nothing — the broker may be alive with a turn in flight.
export function readBrokerSessionState(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return { present: false, session: null };
  }

  try {
    return { present: true, session: JSON.parse(fs.readFileSync(stateFile, "utf8")) };
  } catch {
    return { present: true, session: null };
  }
}

export function loadBrokerSession(cwd) {
  return readBrokerSessionState(cwd).session;
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

// KMP-23: compare-and-delete for the heal path. The foreign handshake runs
// outside the broker lock, so by the time a healer wants to discard the
// pointer, a concurrent healer may already have published a healthy
// replacement — unconditional clearing would delete THAT. Under the lock,
// delete only if the record still names the endpoint we proved foreign.
// Returns "cleared" (pointer removed or already gone), "superseded" (a
// DIFFERENT record exists — a concurrent healer already published a
// replacement; retrying the connect will adopt it), or "contended" (lock
// never acquired — the pointer may still name the foreign endpoint).
export function clearBrokerSessionIfEndpoint(cwd, endpoint) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (tryAcquireBrokerLock(cwd)) {
      try {
        const current = loadBrokerSession(cwd);
        if (!current) {
          return "cleared";
        }
        if (current.endpoint !== endpoint) {
          return "superseded";
        }
        clearBrokerSession(cwd);
        return "cleared";
      } finally {
        releaseBrokerLock(cwd);
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return "contended";
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

function brokerLockDir(cwd) {
  return path.join(resolveStateDir(cwd), "broker.lock");
}

// How long a broker.lock may sit untouched before a waiter treats its holder
// as crashed and steals it. Exported because ensureBrokerSession's own
// give-up deadline MUST outlast it — see the deadline note there.
export const BROKER_LOCK_STALE_MS = 15_000;

// mkdir is atomic across processes, so it serializes concurrent broker
// starts for one workspace. A crashed holder's stale lock is stolen after
// BROKER_LOCK_STALE_MS (its mtime stops advancing).
function tryAcquireBrokerLock(cwd) {
  const lockDir = brokerLockDir(cwd);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    try {
      const stat = fs.statSync(lockDir);
      if (Date.now() - stat.mtimeMs > BROKER_LOCK_STALE_MS) {
        fs.rmdirSync(lockDir);
        fs.mkdirSync(lockDir);
        return true;
      }
    } catch {}
    return false;
  }
}

function releaseBrokerLock(cwd) {
  try {
    fs.rmdirSync(brokerLockDir(cwd));
  } catch {}
}

export async function ensureBrokerSession(cwd, options = {}) {
  // The broker was spawned detached (its own process group), so the group
  // kill takes its agent child down with it.
  const killImpl = options.killProcess ?? ((pid) => terminateProcessTree(pid));
  // Non-holders wait long enough for the holder's spawn to finish — AND long
  // enough to reach their own stale-lock steal. At (timeoutMs + 3000) ≈ 5s
  // this deadline expired 10s before tryAcquireBrokerLock could steal a
  // BROKER_LOCK_STALE_MS-old lock, so a holder killed mid-spawn left every
  // arriving client guaranteed to fail for the next ~10s, and to fail with
  // "Failed to start the shared agent broker" — a start it never attempted.
  // The recovery path must be reachable before the caller gives up on it.
  const deadline =
    Date.now() + Math.max((options.timeoutMs ?? 2000) + 3000, BROKER_LOCK_STALE_MS + 2000);

  for (;;) {
    const existing = loadBrokerSession(cwd);
    if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
      // reused (not persisted): lets the client distinguish "adopted an
      // already-running broker" (heal-eligible on foreign identity, KMP-23)
      // from "spawned it ourselves" (foreign identity = spawn misconfig).
      return { ...existing, reused: true };
    }
    if (tryAcquireBrokerLock(cwd)) {
      try {
        return await startBrokerSessionLocked(cwd, options, killImpl);
      } finally {
        releaseBrokerLock(cwd);
      }
    }
    if (Date.now() > deadline) {
      // Truthful by construction: reaching here means the lock was never
      // acquired, so no broker start was ever attempted. Callers must not
      // describe this as a failed startup.
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startBrokerSessionLocked(cwd, options, killImpl) {
  // Re-check under the lock: the previous holder may have started a broker
  // while we were waiting to acquire.
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return { ...existing, reused: true };
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: killImpl
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../acp-broker.mjs", import.meta.url));

  const child = (options.spawnBrokerProcess ?? spawnBrokerProcess)({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    extraArgs: options.extraBrokerArgs ?? [],
    env: options.env ?? process.env
  });

  const outcome = await Promise.race([
    waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000).then((ready) => ({ reason: ready ? "ready" : "timeout" })),
    waitForChildClose(child)
  ]);
  if (outcome.reason !== "ready") {
    const exitCode = outcome.exitCode ?? child.exitCode ?? null;
    const signal = outcome.signal ?? child.signalCode ?? null;
    let log = { logTail: "", logTruncated: false };
    try {
      log = (options.readBrokerLogTail ?? readBrokerLogTail)(logFile);
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
        ? ` (${error.code})`
        : "";
      log = { logTail: "", logTruncated: false, logReadError: `broker log read failed${code}` };
    }
    let brokerStartup;
    try {
      brokerStartup = {
        reason: outcome.reason,
        exitCode,
        signal,
        ...log,
        scriptPath,
        cwd,
        endpointKind: parseBrokerEndpoint(endpoint).kind,
        ...(outcome.spawnErrorCode ? { spawnErrorCode: outcome.spawnErrorCode } : {})
      };
    } finally {
      // A broker that never came up (e.g. its agent hung during initialize)
      // must not linger detached and untracked, even if evidence capture fails.
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: killImpl
      });
    }
    const outcomeLabel = outcome.reason === "child-exit"
      ? signal ? `child exited with signal ${signal}` : `child exited with code ${exitCode ?? "unknown"}`
      : outcome.reason === "spawn-error"
        ? `child spawn failed${outcome.spawnErrorCode ? ` (${outcome.spawnErrorCode})` : ""}`
        : "readiness timed out";
    throw new BrokerStartupError(`Failed to start the shared agent broker (${outcomeLabel}).`, brokerStartup);
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null
  };
  saveBrokerSession(cwd, session);
  return { ...session, reused: false };
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
