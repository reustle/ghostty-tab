import type pty from "@lydell/node-pty";
import WebSocket, { type RawData } from "ws";

import { parseClientMessage } from "../shared/protocol.js";
import { SESSION_CLOSE_CODES } from "../shared/session.js";

const MAX_BUFFERED_OUTPUT = 4 * 1024 * 1024;

type PtyProcess = ReturnType<typeof pty.spawn>;
interface CloseStatus {
  code: number;
  reason: string;
}

/** Owns one connection's I/O and releases its PTY exactly once. */
export function attachPty(
  ws: WebSocket,
  process: PtyProcess,
  options: {
    onExit(): CloseStatus | Promise<CloseStatus>;
    onDispose(): void;
  },
): { dispose(): void } {
  let stopped = false;
  const subscriptions: Array<{ dispose(): void }> = [];

  function dispose(kill = true): void {
    if (stopped) return;
    stopped = true;
    ws.off("message", onMessage);
    for (const subscription of subscriptions) subscription.dispose();
    options.onDispose();
    if (kill) {
      try {
        process.kill();
      } catch {
        // The process may already have exited.
      }
    }
  }

  function close(code: number, reason: string): void {
    dispose();
    if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  }

  function onMessage(data: RawData, isBinary: boolean): void {
    if (stopped || ws.readyState !== WebSocket.OPEN) return;
    const message = isBinary ? null : parseClientMessage(rawDataToString(data));
    if (!message) {
      close(1008, "Invalid client message");
      return;
    }
    try {
      if (message.type === "input") process.write(message.data);
      else process.resize(message.cols, message.rows);
    } catch (error) {
      console.error("Terminal I/O failed:", error);
      close(1011, "Terminal process failed");
    }
  }

  subscriptions.push(
    process.onData((data) => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_OUTPUT) {
        close(1013, "Terminal output exceeded client capacity");
        return;
      }
      ws.send(data);
    }),
    process.onExit(() => {
      if (stopped) return;
      dispose(false);
      if (ws.readyState !== WebSocket.OPEN) return;
      void Promise.resolve()
        .then(() => options.onExit())
        .then(({ code, reason }) => close(code, reason))
        .catch((error) => {
          console.error("Could not determine terminal exit status:", error);
          close(
            SESSION_CLOSE_CODES.SESSION_SETUP_FAILED,
            "Session status failed",
          );
        });
    }),
  );
  ws.on("message", onMessage);
  ws.on("close", () => dispose());
  ws.on("error", () => dispose());
  return { dispose };
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(
    data instanceof ArrayBuffer ? new Uint8Array(data) : data,
  ).toString("utf8");
}
