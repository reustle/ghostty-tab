import type { IDisposable } from "ghostty-web";

import {
  encodeInputMessages,
  encodeResizeMessage,
} from "../shared/protocol.js";
import {
  type PersistentSession,
  SESSION_CLOSE_CODES,
  parseSessionHash,
  sessionsEqual,
  shouldReconnect,
} from "../shared/session.js";

import { fetchAuthToken } from "./api.js";
import { resolveSession } from "./launcher.js";

const INITIAL_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface SessionTerminal {
  cols: number;
  rows: number;
  onData(listener: (data: string) => void): IDisposable;
  onResize(
    listener: (size: { cols: number; rows: number }) => void,
  ): IDisposable;
  focus(): void;
  reset(): void;
  write(data: string | Uint8Array): void;
}

export interface TerminalSessionController {
  session: PersistentSession | null;
  dispose(): void;
}

export async function startTerminalSession(
  terminal: SessionTerminal,
): Promise<TerminalSessionController> {
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let connecting = false;
  let stopped = false;
  let disposed = false;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectStatusVisible = false;

  const session = await resolveSession();
  terminal.focus();

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  function buildWebSocketUrl(token: string): string {
    const params = new URLSearchParams({
      cols: String(terminal.cols),
      rows: String(terminal.rows),
      token,
    });
    if (session) {
      params.set("session", session.name);
      if (session.target.kind === "ssh") {
        params.set("ssh", session.target.sshTarget);
      }
    }
    return `${protocol}//${window.location.host}/ws?${params}`;
  }

  function scheduleReconnect(message: string): void {
    if (stopped || reconnectTimer !== undefined) {
      return;
    }

    const delayMs = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    terminal.write(
      `${reconnectStatusVisible ? "\r\x1b[2K" : "\r\n"}\x1b[31m${message}. Reconnecting in ${delayMs / 1000}s...\x1b[0m`,
    );
    reconnectStatusVisible = true;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delayMs);
  }

  async function connect(): Promise<void> {
    if (connecting || stopped) {
      return;
    }
    connecting = true;

    let token: string;
    try {
      token = await fetchAuthToken();
    } catch (error) {
      connecting = false;
      console.error("Authentication failed:", error);
      scheduleReconnect("Authentication failed");
      return;
    }

    if (stopped) {
      connecting = false;
      return;
    }

    const nextSocket = new WebSocket(buildWebSocketUrl(token));
    socket = nextSocket;
    connecting = false;

    nextSocket.onopen = () => {
      if (socket !== nextSocket || stopped) {
        return;
      }
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      reconnectStatusVisible = false;
      terminal.reset();
      terminal.focus();
      nextSocket.send(encodeResizeMessage(terminal.cols, terminal.rows));
    };

    nextSocket.onmessage = (event: MessageEvent<unknown>) => {
      if (socket !== nextSocket) {
        return;
      }
      if (typeof event.data === "string") {
        terminal.write(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
      }
    };

    nextSocket.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    nextSocket.onclose = (event) => {
      if (socket !== nextSocket || stopped) {
        return;
      }
      socket = undefined;

      if (shouldReconnect(event.code)) {
        scheduleReconnect("Connection lost");
        return;
      }

      stopped = true;
      if (reconnectStatusVisible) {
        terminal.write("\r\x1b[2K");
        reconnectStatusVisible = false;
      }
      writeStoppedMessage(terminal, session, event.code, event.reason);
    };
  }

  const dataSubscription = terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) {
      for (const message of encodeInputMessages(data)) socket.send(message);
    }
  });

  const resizeSubscription = terminal.onResize(({ cols, rows }) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(encodeResizeMessage(cols, rows));
    }
  });

  const handleHashChange = () => {
    const nextSession = parseSessionHash(window.location.hash);
    if (
      !session ||
      !nextSession.ok ||
      !sessionsEqual(nextSession.session, session)
    ) {
      window.location.reload();
    }
  };
  window.addEventListener("hashchange", handleHashChange);

  void connect();

  return {
    session,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      dataSubscription.dispose();
      resizeSubscription.dispose();
      window.removeEventListener("hashchange", handleHashChange);
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, "Page closed");
      }
      socket = undefined;
    },
  };
}

function writeStoppedMessage(
  terminal: Pick<SessionTerminal, "write">,
  session: PersistentSession | null,
  code: number,
  reason: string,
): void {
  const detail = reason ? `: ${reason}` : "";
  if (!session) {
    const message =
      code === SESSION_CLOSE_CODES.SESSION_ENDED
        ? `Shell session ended${detail}. Reload to start a new session.`
        : `Could not open shell session${detail}. Reload to retry.`;
    writeStatus(
      terminal,
      message,
      code === SESSION_CLOSE_CODES.SESSION_ENDED ? 33 : 31,
    );
    return;
  }

  const description =
    session.target.kind === "ssh"
      ? `tmux session "${session.name}" on "${session.target.sshTarget}"`
      : `tmux session "${session.name}"`;

  if (code === SESSION_CLOSE_CODES.SESSION_ENDED) {
    writeStatus(terminal, `${description} ended. Reload to recreate it.`, 33);
  } else if (code === SESSION_CLOSE_CODES.SESSION_DETACHED) {
    writeStatus(
      terminal,
      `Detached from ${description}. Reload to reattach.`,
      33,
    );
  } else {
    writeStatus(
      terminal,
      `Could not open ${description}${detail}. Reload to retry.`,
      31,
    );
  }
}

function writeStatus(
  terminal: Pick<SessionTerminal, "write">,
  message: string,
  color: number,
): void {
  terminal.write(`\r\n\x1b[${color}m${message}\x1b[0m\r\n`);
}
