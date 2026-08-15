// ACP (Agent Client Protocol v1) client: JSON-RPC 2.0 over newline-delimited
// stdio. Promoted from spike/acp-spike.mjs; lifecycle modeled on the codex
// plugin's app-server.mjs. All agent-specific values come from the profile
// (agent-profile.mjs) — nothing in here may name a concrete agent.
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { getAgentProfile } from "./agent-profile.mjs";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { clearBrokerSessionIfEndpoint, ensureBrokerSession, loadBrokerSession, teardownBrokerSession, waitForBrokerEndpoint } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

export const BROKER_ENDPOINT_ENV = "KIMI_COMPANION_BROKER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// Long-lived broker processes accumulate agent stderr; keep only the tail.
const STDERR_CAP = 64 * 1024;

// Rejections preserve the structured JSON-RPC error shape ({ code, message,
// data }) — agent-profile.isAuthRequiredError depends on .code surviving.
export class AcpError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message);
    this.name = "AcpError";
    if (code !== undefined) {
      this.code = code;
    }
    if (data !== undefined) {
      this.data = data;
    }
    if (method !== undefined) {
      this.method = method;
    }
  }
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.profile = options.profile ?? getAgentProfile();
    // "reject" is the fail-safe default: review mode's read-only guarantee
    // is enforced by this policy. Task flows opt in to "allow" explicitly.
    // Per-session decisions (setSessionPermissionDecision) override this so
    // a shared long-lived client can host review and task sessions at once.
    this.permissionDecision = options.permissionDecision === "allow" ? "allow" : "reject";
    this.sessionPermissionDecisions = new Map();
    this.onPermissionRequest = options.onPermissionRequest ?? null;
    this.notificationHandler = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    this.exitResolved = false;
    this.agentInfo = null;
    this.transport = "unknown";
    this.lineBuffer = "";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setPermissionDecision(decision) {
    this.permissionDecision = decision === "allow" ? "allow" : "reject";
  }

  setSessionPermissionDecision(sessionId, decision) {
    if (sessionId == null) {
      return;
    }
    this.sessionPermissionDecisions.set(sessionId, decision === "allow" ? "allow" : "reject");
  }

  request(method, params) {
    if (this.closed || this.exitResolved) {
      return Promise.reject(new AcpError(`${this.profile.displayName} ACP client is closed.`, { method }));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  // Fire-and-forget JSON-RPC notification (e.g. session/cancel).
  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    try {
      this.sendMessage({ method, params });
    } catch {}
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(new AcpError(`Failed to parse ACP JSONL from ${this.profile.displayName}: ${error.message}`, { data: { line } }));
      return;
    }

    // Valid JSON is not necessarily a valid envelope ("null", "[]", "42"
    // all parse) — never let agent output throw in this handler.
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.handleExit(new AcpError(`Received non-object ACP message from ${this.profile.displayName}.`, { data: { line } }));
      return;
    }

    const hasId = message.id !== undefined;
    const isRequest = hasId && typeof message.method === "string" && message.method.length > 0;

    // Agent -> client REQUEST (id + method): must be answered or the turn
    // hangs (AGENTS.md work guidance).
    if (isRequest) {
      this.handleAgentRequest(message);
      return;
    }

    if (hasId && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (Object.hasOwn(message, "error")) {
        const error = message.error ?? {};
        pending.reject(new AcpError(error.message ?? `${pending.method} failed.`, {
          code: error.code,
          data: error.data,
          method: pending.method
        }));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (hasId) {
      return;
    }

    if (typeof message.method === "string") {
      // Brokered transports relay the broker-side permission answers as
      // synthetic notifications so observers work across transports.
      if (message.method === "broker/permission_event") {
        try {
          this.onPermissionRequest?.(message.params ?? {});
        } catch {}
        return;
      }
      if (this.notificationHandler) {
        // A throwing observer must not take down the transport.
        try {
          this.notificationHandler(message);
        } catch {}
      }
    }
  }

  handleAgentRequest(message) {
    if (message.method === "session/request_permission") {
      // The decision is looked up from the request's OWN sessionId so a
      // policy change for one session can never leak into another's turn;
      // unknown sessions get the fail-safe default.
      const decision = this.sessionPermissionDecisions.get(message.params?.sessionId) ?? this.permissionDecision;
      const option = this.profile.pickPermissionOption(message.params?.options, decision);
      // No acceptable option (fail-closed reject path) -> cancel the request.
      const outcome = option
        ? { outcome: "selected", optionId: option.optionId }
        : { outcome: "cancelled" };
      this.sendMessage({ id: message.id, result: { outcome } });
      try {
        this.onPermissionRequest?.({ params: message.params, decision, outcome });
      } catch {}
      return;
    }

    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported agent request: ${message.method}`)
    });
  }

  // Responses still buffered when the process exits are dropped — their
  // pending requests are rejected here first, so nothing strands.
  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new AcpError(`${this.profile.displayName} ACP connection closed.`));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn(this.profile.spawn.command, this.profile.spawn.args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_CAP);
    });

    // A late async write failure (EPIPE etc.) means the agent is gone: treat
    // it as fatal so pending requests reject instead of hanging the turn.
    this.proc.stdin.on("error", (error) => {
      this.handleExit(new AcpError(`${this.profile.displayName} agent stdin write failed: ${error.message}`, { data: { cause: error.code } }));
    });

    this.proc.on("error", (error) => {
      this.handleExit(new AcpError(`Failed to launch ${this.profile.displayName} agent: ${error.message}`, { data: { cause: error.code } }));
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : new AcpError(
            `${this.profile.displayName} agent exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`,
            { data: { stderr: this.stderr } }
          );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    // ACP handshake is a single request; there is no "initialized"
    // notification (verified live in the spike).
    this.agentInfo = await this.request("initialize", {
      protocolVersion: this.profile.protocolVersion,
      clientCapabilities: this.profile.clientCapabilities
    });

    // KMP-23 (Kimi review 2026-07-30): same fail-closed identity check as
    // the broker transport — a spawn override or hijacked PATH serving a
    // foreign ACP binary must fail at the handshake, not mid-turn.
    if (this.profile.isForeignAgentInfo?.(this.agentInfo)) {
      const foreignName = this.agentInfo?.agentInfo?.name ?? "unknown agent";
      throw new AcpError(
        `The spawned agent identifies as "${foreignName}", not ${this.profile.expectedAgentName} — check KIMI_COMPANION_AGENT_SPAWN and PATH.`,
        { data: { foreignBroker: true, foreignName } }
      );
    }
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          // On Windows with shell: true the direct child is cmd.exe; kill the
          // whole tree so the agent process goes with it (taskkill /F is
          // already forceful, so no separate escalation there).
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
      if (process.platform !== "win32") {
        // Escalate if the agent ignores SIGTERM, so close() cannot hang a
        // broker restart forever.
        setTimeout(() => {
          if (this.proc && this.proc.exitCode === null) {
            try {
              this.proc.kill("SIGKILL");
            } catch {}
          }
        }, 2000).unref?.();
      }
    }

    await this.exitPromise;
  }

  // stdin backpressure is intentionally unhandled: outbound traffic is small
  // (prompts + permission answers), matching the codex reference client.
  sendMessage(message) {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable) {
      throw new AcpError(`${this.profile.displayName} agent stdin is not available.`);
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}

class BrokerAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        const wrapped = new AcpError(`Broker connection failed: ${error.message}`, { data: { cause: error.code } });
        if (!this.exitResolved) {
          reject(wrapped);
        }
        this.handleExit(wrapped);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    // The broker answers initialize locally with the real agent's info.
    this.agentInfo = await this.request("initialize", {
      protocolVersion: this.profile.protocolVersion,
      clientCapabilities: this.profile.clientCapabilities
    });

    // KMP-23: a live socket at the recorded endpoint proves nothing about
    // WHOSE broker it is — the codex companion records broker state at a
    // colliding path and its app-server happily answers initialize. Validate
    // identity fail-closed before any session/* request can die downstream.
    if (this.profile.isForeignAgentInfo?.(this.agentInfo)) {
      const foreignName = this.agentInfo?.agentInfo?.name ?? "unknown agent";
      throw new AcpError(
        `The broker at this endpoint is serving "${foreignName}", not ${this.profile.expectedAgentName} — foreign broker state (KMP-23).`,
        { data: { foreignBroker: true, foreignName } }
      );
    }
  }

  // Permission answers happen broker-side, so the policy must live there
  // too. Returns a promise; await it before starting the session's turn.
  setSessionPermissionDecision(sessionId, decision) {
    super.setSessionPermissionDecision(sessionId, decision);
    return this.request("broker/session_policy", { sessionId, decision });
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new AcpError("Broker connection is not available.");
    }
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
}

export class AcpClient {
  // Transport selection. Unlike the codex reference (broker by default),
  // broker use is explicit here: an endpoint passed in options, the
  // KIMI_COMPANION_BROKER_ENDPOINT env var, reuseExistingBroker (attach to a
  // live broker session if one exists, else spawn direct), or useBroker
  // (start the shared broker on demand). Default is a dedicated spawned
  // agent process. disableBroker forces direct spawn regardless — the
  // broker's own internal client uses it to prevent recursion.
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    // KMP-23: one heal retry when a REUSED broker turns out to be foreign.
    let healedForeignBroker = false;

    for (;;) {
      brokerEndpoint = null;
      let endpointWasExplicit = false;
      let brokerWasReused = false;
      let brokerSession = null;

      if (!options.disableBroker) {
        brokerEndpoint =
          options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
        endpointWasExplicit = Boolean(brokerEndpoint);
        if (!brokerEndpoint && options.reuseExistingBroker) {
          // Never trust a state record blindly — the broker may have died
          // without cleaning up. Probe before committing to the endpoint.
          const existing = loadBrokerSession(cwd)?.endpoint ?? null;
          if (existing && (await waitForBrokerEndpoint(existing, 150))) {
            brokerEndpoint = existing;
            brokerWasReused = true;
          }
        }
        if (!brokerEndpoint && options.useBroker) {
          brokerSession = await ensureBrokerSession(cwd, { env: options.env, ...(options.brokerOptions ?? {}) });
          brokerEndpoint = brokerSession?.endpoint ?? null;
          brokerWasReused = Boolean(brokerSession?.reused);
          if (!brokerEndpoint) {
            throw new AcpError("Failed to start the shared agent broker.");
          }
        }
      }

      const client = brokerEndpoint
        ? new BrokerAcpClient(cwd, { ...options, brokerEndpoint })
        : new SpawnedAcpClient(cwd, options);
      try {
        // connectTimeoutMs bounds the whole handshake; enforced HERE because
        // only this scope holds the client handle needed to kill a wedged
        // agent process (a caller-side race would leak it).
        if (options.connectTimeoutMs) {
          let timer;
          await Promise.race([
            client.initialize(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new AcpError(`Agent did not complete the ACP handshake within ${options.connectTimeoutMs / 1000}s.`)),
                options.connectTimeoutMs
              );
              timer.unref?.();
            })
          ]).finally(() => clearTimeout(timer));
        } else {
          await client.initialize();
        }
      } catch (error) {
        // A failed or timed-out handshake must not orphan the agent process.
        await client.close().catch(() => {});
        if (error?.data?.foreignBroker && !endpointWasExplicit) {
          if (brokerWasReused && !healedForeignBroker) {
            // Adopted broker belongs to another plugin: discard OUR pointer
            // to it and retry once with a fresh spawn. Compare-and-delete —
            // a concurrent healer may have already published a healthy
            // replacement, which must survive. Never kill the foreign
            // process — it is not ours to stop.
            healedForeignBroker = true;
            const cleared = clearBrokerSessionIfEndpoint(cwd, brokerEndpoint);
            if (cleared === "contended") {
              // The pointer may still name the foreign endpoint; retrying
              // would re-adopt it and burn the single heal for nothing
              // (Kimi review 2026-07-30). Fail with the actual cause.
              throw new AcpError(
                `${error.message} Could not replace the broker pointer (lock contended) — retry the command.`,
                { data: error.data }
              );
            }
            continue;
          }
          if (!brokerWasReused) {
            // We SPAWNED this broker and its agent still identifies as
            // foreign: the spawn override or PATH is serving the wrong
            // binary. Respawning would reproduce it — kill what we spawned
            // (ours, unlike the reused case) and fail loudly. Conditional
            // clear for the same concurrent-healer reason.
            if (brokerSession) {
              teardownBrokerSession({ ...brokerSession, killProcess: terminateProcessTree });
            }
            clearBrokerSessionIfEndpoint(cwd, brokerEndpoint);
            throw new AcpError(
              `${error.message} The broker was freshly spawned, so the agent command itself is wrong — check KIMI_COMPANION_AGENT_SPAWN and PATH.`,
              { data: error.data }
            );
          }
        }
        throw error;
      }
      return client;
    }
  }
}
