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
const BROKER_STATE_FILE = "broker.json";

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

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
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

// mkdir is atomic across processes, so it serializes concurrent broker
// starts for one workspace. A crashed holder's stale lock is stolen after
// 15s (its mtime stops advancing).
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
      if (Date.now() - stat.mtimeMs > 15_000) {
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
  // Non-holders wait long enough for the holder's spawn to finish.
  const deadline = Date.now() + (options.timeoutMs ?? 2000) + 3000;

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

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    extraArgs: options.extraBrokerArgs ?? [],
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    // A broker that never came up (e.g. its agent hung during initialize)
    // must not linger detached and untracked.
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: killImpl
    });
    return null;
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
