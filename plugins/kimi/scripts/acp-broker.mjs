#!/usr/bin/env node

// Shared-agent broker: keeps ONE agent process (`kimi acp`) alive and serves
// it to companion calls over a local socket. Modeled on the codex plugin's
// app-server-broker.mjs, simplified for ACP: session/prompt BLOCKS until the
// turn completes, so holding the active socket for a request's duration IS
// the busy model — no stream-ownership machinery. Additions ACP forces:
// permission requests are answered BROKER-side (per-session policy set via
// broker/session_policy, fail-safe reject — so a client dying mid-turn can
// never leave the agent hanging or fail open), and session/cancel
// notifications pass through from ANY socket, busy or not, because /cancel
// runs from a fresh shell.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { AcpClient, BROKER_BUSY_RPC_CODE } from "./lib/acp-client.mjs";
import { getAgentProfile } from "./lib/agent-profile.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { clearBrokerSession, loadBrokerSession } from "./lib/broker-lifecycle.mjs";

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node <plugin-root>/scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--agent-spawn <json>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "agent-spawn"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  let profile = getAgentProfile();
  if (options["agent-spawn"]) {
    // Test escape hatch: override the agent spawn target (e.g. the scripted
    // fake agent) while keeping every other profile behavior.
    profile = { ...profile, spawn: JSON.parse(String(options["agent-spawn"])) };
  }

  // Ownership model: activeSocket holds the broker while it has in-flight
  // agent requests. Release happens ONLY in the request's finally — never on
  // socket close — so a client dying mid-turn keeps the broker correctly
  // busy until the agent finishes (sends to the dead socket are no-ops, and
  // session/cancel remains the cross-socket escape hatch). Clearing on close
  // would let another socket become active and receive the dead turn's
  // notifications, and would corrupt the count when the request settles.
  let activeSocket = null;
  let activeCount = 0;
  let shuttingDown = false;
  const sockets = new Set();
  // sessionId -> creating socket. A session's permission policy may only be
  // changed by its owner while that owner is still connected; a dead owner's
  // session can be reclaimed (fresh-shell recovery).
  const sessionOwners = new Map();

  const appClient = await AcpClient.connect(cwd, {
    disableBroker: true,
    profile,
    // Relay is best-effort while a socket owns the turn; the POLICY answer
    // itself is unconditional (appClient answers even with no socket to
    // notify), so a late or orphaned permission request still fails safe.
    onPermissionRequest: (event) => {
      if (activeSocket) {
        send(activeSocket, { method: "broker/permission_event", params: event });
      }
    }
  });

  appClient.setNotificationHandler((message) => {
    if (activeSocket) {
      send(activeSocket, message);
    }
  });

  async function shutdown(server) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    // Remove our own state record so reuse paths can't trust a dead broker.
    try {
      if (loadBrokerSession(cwd)?.endpoint === endpoint) {
        clearBrokerSession(cwd);
      }
    } catch {}
  }

  async function handleSocketLine(socket, line, server) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      send(socket, {
        id: null,
        error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
      });
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      send(socket, { id: null, error: buildJsonRpcError(-32600, "Invalid request envelope.") });
      return;
    }

    // Client notifications: session/cancel passes through from any socket,
    // busy or not — it is the escape hatch for a running turn.
    if (message.id === undefined) {
      if (message.method === "session/cancel") {
        appClient.notify("session/cancel", message.params ?? {});
      }
      return;
    }

    if (typeof message.method !== "string" || message.method.length === 0) {
      send(socket, { id: message.id, error: buildJsonRpcError(-32600, "Request method must be a non-empty string.") });
      return;
    }

    // Answered locally, before the busy check, so new sockets can always
    // complete their handshake while a turn runs elsewhere.
    if (message.method === "initialize") {
      send(socket, { id: message.id, result: appClient.agentInfo ?? {} });
      return;
    }

    if (message.method === "broker/shutdown") {
      send(socket, { id: message.id, result: {} });
      await shutdown(server);
      process.exit(0);
    }

    if (message.method === "broker/session_policy") {
      const sessionId = message.params?.sessionId;
      if (!sessionId) {
        send(socket, { id: message.id, error: buildJsonRpcError(-32602, "broker/session_policy requires a sessionId.") });
        return;
      }
      const owner = sessionOwners.get(sessionId);
      if (owner && owner !== socket && sockets.has(owner)) {
        send(socket, { id: message.id, error: buildJsonRpcError(-32602, "Session belongs to another active client.") });
        return;
      }
      sessionOwners.set(sessionId, socket);
      appClient.setSessionPermissionDecision(sessionId, message.params?.decision);
      send(socket, { id: message.id, result: {} });
      return;
    }

    if (activeSocket && activeSocket !== socket) {
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared agent broker is busy.")
      });
      return;
    }

    activeSocket = socket;
    activeCount += 1;
    try {
      const result = await appClient.request(message.method, message.params ?? {});
      if (message.method === "session/new" && result?.sessionId) {
        // Bind the session to its creator and reset its policy to the
        // fail-safe so a policy planted for a guessed id can never carry
        // over onto a session someone else creates.
        sessionOwners.set(result.sessionId, socket);
        appClient.setSessionPermissionDecision(result.sessionId, "reject");
      }
      send(socket, { id: message.id, result });
    } catch (error) {
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(error.code ?? -32000, error.message, error.data)
      });
    } finally {
      activeCount -= 1;
      if (activeCount === 0 && activeSocket === socket) {
        activeSocket = null;
      }
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");

    // Lines are extracted SYNCHRONOUSLY per data event and processed by a
    // single serialized consumer: an async data handler sharing the buffer
    // across interleaved data events can slice stale offsets and duplicate
    // or corrupt requests.
    let buffer = "";
    const lineQueue = [];
    let processing = false;

    async function processQueue() {
      if (processing) {
        return;
      }
      processing = true;
      try {
        while (lineQueue.length > 0) {
          await handleSocketLine(socket, lineQueue.shift(), server);
        }
      } finally {
        processing = false;
      }
    }

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        lineQueue.push(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
      void processQueue();
    });

    socket.on("close", () => {
      sockets.delete(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
    });
  });

  // A broker without its agent is useless and invisible-broken: exit so the
  // next companion call detects the dead endpoint and respawns cleanly.
  appClient.exitPromise.then(async () => {
    if (shuttingDown) {
      return;
    }
    await shutdown(server).catch(() => {});
    process.exit(1);
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
