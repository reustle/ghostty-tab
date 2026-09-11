import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import pty from "@lydell/node-pty";
import type { ViteDevServer } from "vite";
import WebSocket, { WebSocketServer } from "ws";

import { MAX_WEBSOCKET_PAYLOAD } from "../shared/protocol.js";
import {
  type PersistentSession,
  SESSION_CLOSE_CODES,
  isValidSessionName,
  isValidSshTarget,
} from "../shared/session.js";
import { attachPty } from "./attachment.js";
import {
  type AuthConfig,
  type AuthDecision,
  createAuthConfig,
  validateTokenRequest,
  validateWebSocketRequest,
} from "./auth.js";
import {
  buildSshTmuxArgs,
  buildTmuxAttachArgs,
  createTmuxEnvironment,
  ensureTmuxSession,
  killTmuxSession,
  listTmuxSessions,
  tmuxSessionExists,
} from "./tmux.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

type PtyProcess = ReturnType<typeof pty.spawn>;
type PtySpawn = typeof pty.spawn;

export interface GhosttyTabServerOptions {
  port: number;
  dev?: boolean;
  authConfig?: AuthConfig;
  env?: NodeJS.ProcessEnv;
  ptySpawn?: PtySpawn;
  staticClientRoot?: string;
  tmuxSessionKill?: (sessionName: string) => Promise<boolean>;
  tmuxSessionList?: () => Promise<readonly string[]>;
  tmuxSessionEnsure?: typeof ensureTmuxSession;
}

export interface GhosttyTabServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  shutdown(): Promise<void>;
}

export async function createGhosttyTabServer(
  options: GhosttyTabServerOptions,
): Promise<GhosttyTabServer> {
  const packageRoot = findPackageRoot(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  const clientRoot =
    options.staticClientRoot ?? path.join(packageRoot, "dist", "client");
  const authConfig =
    options.authConfig ?? createAuthConfig({ env: options.env });
  const tmuxEnvironment = createTmuxEnvironment(options.env);
  const shutdownController = new AbortController();
  const tmuxOptions = {
    env: tmuxEnvironment,
    signal: shutdownController.signal,
  };
  const prepareTmuxSession = options.tmuxSessionEnsure ?? ensureTmuxSession;
  const getTmuxSessions =
    options.tmuxSessionList ?? (() => listTmuxSessions(tmuxOptions));
  const closeTmuxSession =
    options.tmuxSessionKill ??
    ((sessionName: string) => killTmuxSession(sessionName, tmuxOptions));
  const spawnPty = options.ptySpawn ?? pty.spawn;
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("ghostty-web/ghostty-vt.wasm");

  let vite: ViteDevServer | undefined;
  let shuttingDown = false;

  const pendingUpgrades = new Map<Duplex, AbortController>();
  const sessions = new Map<WebSocket, ReturnType<typeof attachPty>>();
  const connectionMetadata = new WeakMap<
    IncomingMessage,
    { session: PersistentSession | null; cols: number; rows: number }
  >();
  const aliveClients = new WeakMap<WebSocket, boolean>();

  const httpServer = http.createServer((request, response) => {
    void handleHttpRequest(request, response).catch((error) => {
      console.error("HTTP request failed:", error);
      if (!response.headersSent) {
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }
      response.end("Internal Server Error");
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD,
  });

  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (aliveClients.get(ws) === false) {
        ws.terminate();
        continue;
      }
      aliveClients.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeatInterval.unref();

  async function handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = parseRequestUrl(request);
    if (!url) {
      writeHttpDecision(response, {
        ok: false,
        status: 400,
        reason: "Bad Request",
      });
      return;
    }

    if (handleTokenRequest(request, response, url, authConfig)) {
      return;
    }

    if (
      await handleSessionsRequest(
        request,
        response,
        url,
        authConfig,
        getTmuxSessions,
        closeTmuxSession,
      )
    ) {
      return;
    }

    if (url.pathname === "/ghostty-vt.wasm") {
      await serveFile(wasmPath, request, response, false);
      return;
    }

    if (vite) {
      vite.middlewares(request, response, (error: unknown) => {
        if (error) {
          console.error("Vite request failed:", error);
          if (!response.headersSent) {
            response.writeHead(500, {
              "Content-Type": "text/plain; charset=utf-8",
            });
          }
          response.end("Internal Server Error");
          return;
        }
        if (!response.writableEnded) {
          writeNotFound(response);
        }
      });
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeClientPath(clientRoot, pathname);
    if (!filePath) {
      writeNotFound(response);
      return;
    }
    await serveFile(filePath, request, response, false);
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const url = parseRequestUrl(request);
    if (!url || url.pathname !== "/ws") {
      if (!options.dev) {
        rejectUpgrade(socket, {
          ok: false,
          status: url ? 404 : 400,
          reason: url ? "Not Found" : "Bad Request",
        });
      }
      return;
    }

    const decision = validateWebSocketRequest(authConfig, {
      host: request.headers.host,
      origin: request.headers.origin,
      token: url.searchParams.get("token"),
    });
    if (!decision.ok) {
      rejectUpgrade(socket, decision);
      return;
    }

    const sessionName = url.searchParams.get("session");
    const sshTarget = url.searchParams.get("ssh");
    if (
      url.searchParams.getAll("session").length > 1 ||
      url.searchParams.getAll("ssh").length > 1 ||
      (sessionName !== null && !isValidSessionName(sessionName))
    ) {
      rejectUpgrade(socket, {
        ok: false,
        status: 400,
        reason: "Invalid tmux session name",
      });
      return;
    }
    if (
      (sshTarget !== null && !isValidSshTarget(sshTarget)) ||
      (sshTarget !== null && sessionName === null)
    ) {
      rejectUpgrade(socket, {
        ok: false,
        status: 400,
        reason: "Invalid SSH target",
      });
      return;
    }

    const session: PersistentSession | null = sessionName
      ? {
          name: sessionName,
          target: sshTarget ? { kind: "ssh", sshTarget } : { kind: "local" },
        }
      : null;

    const cols = parseTerminalDimension(url.searchParams.get("cols"), 80);
    const rows = parseTerminalDimension(url.searchParams.get("rows"), 24);
    connectionMetadata.set(request, { session, cols, rows });

    function completeUpgrade(setupError?: unknown): void {
      if (shuttingDown || socket.destroyed) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        // Also handle errors on connections that fail before a PTY is attached.
        ws.on("error", () => {});
        if (setupError) {
          console.error(
            `Could not open ${describeSession(session)}:`,
            setupError,
          );
          ws.close(
            SESSION_CLOSE_CODES.SESSION_SETUP_FAILED,
            "Session setup failed",
          );
        } else {
          wss.emit("connection", ws, request);
        }
      });
    }

    if (!session || session.target.kind === "ssh") {
      completeUpgrade();
      return;
    }

    // Delay the handshake so the browser cannot send input before the PTY exists.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const onError = () => socket.destroy();
    pendingUpgrades.set(socket, controller);
    socket.once("close", cancel);
    socket.once("error", onError);
    void prepareTmuxSession(
      { sessionName: session.name, cols, rows, cwd: homedir() },
      { env: tmuxEnvironment, signal: controller.signal },
    )
      .then(() => completeUpgrade(), completeUpgrade)
      .catch((error) => {
        console.error("WebSocket upgrade failed:", error);
        socket.destroy();
      })
      .finally(() => {
        pendingUpgrades.delete(socket);
        socket.off("close", cancel);
        socket.off("error", onError);
      });
  });

  wss.on("connection", (ws, request) => {
    const metadata = connectionMetadata.get(request);
    if (!metadata) {
      ws.close(
        SESSION_CLOSE_CODES.SESSION_SETUP_FAILED,
        "Invalid session request",
      );
      return;
    }

    const { cols, rows } = metadata;
    let ptyProcess: PtyProcess;
    try {
      ptyProcess = createPtySession(metadata.session, cols, rows);
    } catch (error) {
      const description = describeSession(metadata.session);
      console.error(`Could not open ${description}:`, error);
      ws.close(
        SESSION_CLOSE_CODES.SESSION_SETUP_FAILED,
        "Session setup failed",
      );
      return;
    }

    aliveClients.set(ws, true);
    ws.on("pong", () => aliveClients.set(ws, true));
    const attachment = attachPty(ws, ptyProcess, {
      onDispose: () => sessions.delete(ws),
      onExit: async () => {
        if (!metadata.session) {
          return {
            code: SESSION_CLOSE_CODES.SESSION_ENDED,
            reason: "Shell exited",
          };
        }
        if (metadata.session.target.kind === "ssh") {
          return {
            code: SESSION_CLOSE_CODES.SESSION_DETACHED,
            reason: "SSH session ended",
          };
        }
        return (await tmuxSessionExists(metadata.session.name, tmuxOptions))
          ? {
              code: SESSION_CLOSE_CODES.SESSION_DETACHED,
              reason: "Session detached",
            }
          : {
              code: SESSION_CLOSE_CODES.SESSION_ENDED,
              reason: "Session ended",
            };
      },
    });
    sessions.set(ws, attachment);
  });

  function createPtySession(
    session: PersistentSession | null,
    cols: number,
    rows: number,
  ): PtyProcess {
    let command: string;
    let args: string[];
    if (!session) {
      command = getShell(options.env);
      args = [];
    } else if (session.target.kind === "ssh") {
      command = "ssh";
      args = buildSshTmuxArgs(
        session.target.sshTarget,
        session.name,
        cols,
        rows,
      );
    } else {
      command = "tmux";
      args = buildTmuxAttachArgs(session.name);
    }

    return spawnPty(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: homedir(),
      env: {
        ...(session ? tmuxEnvironment : (options.env ?? process.env)),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });
  }

  if (options.dev) {
    const { createServer } = await import("vite");
    vite = await createServer({
      root: packageRoot,
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
        allowedHosts: [...authConfig.allowedHosts],
      },
    });
  } else if (!fs.existsSync(path.join(clientRoot, "index.html"))) {
    throw new Error(
      "Client build not found. Run `npm run build` before starting ghostty-tab.",
    );
  }

  await listen(httpServer, options.port, authConfig.bindHost);
  const address = httpServer.address();
  const actualPort =
    typeof address === "object" && address ? address.port : options.port;
  const url = `http://${formatUrlHost(authConfig.bindHost)}:${actualPort}`;

  return {
    host: authConfig.bindHost,
    port: actualPort,
    url,
    async shutdown() {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      shutdownController.abort();
      for (const [socket, controller] of pendingUpgrades) {
        controller.abort();
        socket.destroy();
      }
      clearInterval(heartbeatInterval);
      for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(SESSION_CLOSE_CODES.SERVER_SHUTDOWN, "Server shutting down");
        }
        sessions.get(ws)?.dispose();
      }
      await closeWebSocketServer(wss);
      await closeHttpServer(httpServer);
      await vite?.close();
    },
  };
}

export function findPackageRoot(startDirectory: string): string {
  let directory = path.resolve(startDirectory);
  while (true) {
    const packagePath = path.join(directory, "package.json");
    if (fs.existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(
          fs.readFileSync(packagePath, "utf8"),
        ) as { name?: string };
        if (packageJson.name === "ghostty-tab") {
          return directory;
        }
      } catch {
        // Continue searching parent directories.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("Could not locate the ghostty-tab package root");
    }
    directory = parent;
  }
}

function parseRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

function handleTokenRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  authConfig: AuthConfig,
): boolean {
  if (url.pathname !== "/api/token") {
    return false;
  }
  if (request.method !== "GET") {
    response.writeHead(405, {
      Allow: "GET",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Method Not Allowed");
    return true;
  }

  const decision = validateTokenRequest(authConfig, {
    host: request.headers.host,
    origin: request.headers.origin,
  });
  if (!decision.ok) {
    writeHttpDecision(response, decision);
    return true;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify({ token: authConfig.token }));
  return true;
}

async function handleSessionsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  authConfig: AuthConfig,
  getTmuxSessions: () => Promise<readonly string[]>,
  closeTmuxSession: (sessionName: string) => Promise<boolean>,
): Promise<boolean> {
  const sessionPathPrefix = "/api/sessions/";
  if (
    url.pathname !== "/api/sessions" &&
    !url.pathname.startsWith(sessionPathPrefix)
  ) {
    return false;
  }

  if (url.pathname.startsWith(sessionPathPrefix)) {
    if (request.method !== "DELETE") {
      response.writeHead(405, {
        Allow: "DELETE",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end("Method Not Allowed");
      return true;
    }

    const tokenHeader = request.headers["x-ghostty-token"];
    const decision = validateWebSocketRequest(authConfig, {
      host: request.headers.host,
      origin: request.headers.origin,
      token: Array.isArray(tokenHeader) ? null : (tokenHeader ?? null),
    });
    if (!decision.ok) {
      writeHttpDecision(response, decision);
      return true;
    }

    let sessionName: string;
    try {
      sessionName = decodeURIComponent(
        url.pathname.slice(sessionPathPrefix.length),
      );
    } catch {
      sessionName = "";
    }
    if (!isValidSessionName(sessionName)) {
      writeHttpDecision(response, {
        ok: false,
        status: 400,
        reason: "Invalid tmux session name",
      });
      return true;
    }

    if (!(await closeTmuxSession(sessionName))) {
      writeHttpDecision(response, {
        ok: false,
        status: 404,
        reason: "Session not found",
      });
      return true;
    }

    response.writeHead(204, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end();
    return true;
  }

  if (request.method !== "GET") {
    response.writeHead(405, {
      Allow: "GET",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Method Not Allowed");
    return true;
  }

  const decision = validateTokenRequest(authConfig, {
    host: request.headers.host,
    origin: request.headers.origin,
  });
  if (!decision.ok) {
    writeHttpDecision(response, decision);
    return true;
  }

  const sessions = [
    ...new Set((await getTmuxSessions()).filter(isValidSessionName)),
  ].sort((left, right) => left.localeCompare(right));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify({ sessions }));
  return true;
}

function writeHttpDecision(
  response: ServerResponse,
  decision: Extract<AuthDecision, { ok: false }>,
): void {
  response.writeHead(decision.status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(decision.reason);
}

function safeClientPath(clientRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const resolved = path.resolve(clientRoot, `.${decoded}`);
  return resolved === clientRoot ||
    resolved.startsWith(`${clientRoot}${path.sep}`)
    ? resolved
    : null;
}

async function serveFile(
  filePath: string,
  request: IncomingMessage,
  response: ServerResponse,
  immutable: boolean,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  let data: Buffer;
  try {
    data = await fs.promises.readFile(filePath);
  } catch {
    writeNotFound(response);
    return;
  }

  response.writeHead(200, {
    "Cache-Control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Length": data.byteLength,
    "Content-Type":
      MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : data);
}

function writeNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end("Not Found");
}

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  decision: Extract<AuthDecision, { ok: false }>,
): void {
  if (socket.destroyed) {
    return;
  }
  const body = `${decision.reason}\n`;
  socket.write(
    [
      `HTTP/1.1 ${decision.status} ${decision.reason}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      "X-Content-Type-Options: nosniff",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}

function parseTerminalDimension(
  value: string | null,
  fallback: number,
): number {
  if (!value || !/^[0-9]+$/.test(value)) {
    return fallback;
  }
  const dimension = Number.parseInt(value, 10);
  return dimension >= 1 && dimension <= 1000 ? dimension : fallback;
}

function getShell(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "win32"
    ? env.COMSPEC || "cmd.exe"
    : env.SHELL || "/bin/bash";
}

function describeSession(session: PersistentSession | null): string {
  if (!session) {
    return "shell session";
  }
  return session.target.kind === "ssh"
    ? `tmux session "${session.name}" on "${session.target.sshTarget}"`
    : `tmux session "${session.name}"`;
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function listen(
  server: http.Server,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 250);
    const fallbackTimer = setTimeout(resolve, 1000);
    server.close((error) => {
      clearTimeout(forceCloseTimer);
      clearTimeout(fallbackTimer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      clearTimeout(fallbackTimer);
      resolve();
    };
    const forceCloseTimer = setTimeout(() => {
      for (const socket of server.clients) socket.terminate();
    }, 250);
    const fallbackTimer = setTimeout(finish, 1000);
    server.close(finish);
  });
}
