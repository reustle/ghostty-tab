import { afterEach, describe, expect, test } from "bun:test";

import { startTerminalSession } from "../src/client/session.js";
import {
  SESSION_CLOSE_CODES,
  parseSessionHash,
} from "../src/shared/session.js";

import {
  MAX_INPUT_LENGTH,
  parseClientMessage,
} from "../src/shared/protocol.js";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalWindowSetTimeout = window.setTimeout;
const originalWindowClearTimeout = window.clearTimeout;
const originalConsoleError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  window.setTimeout = originalWindowSetTimeout;
  window.clearTimeout = originalWindowClearTimeout;
  console.error = originalConsoleError;
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
});

describe("browser session lifecycle", () => {
  test("cleans subscriptions even after a final server close", async () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static instances: FakeWebSocket[] = [];

      readyState = FakeWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      sent: string[] = [];

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      send(value: string): void {
        this.sent.push(value);
      }

      close(): void {
        this.readyState = FakeWebSocket.CLOSING;
      }
    }

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: "test-token" })),
      )) as unknown as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    let sendInput = (_data: string) => {};
    let dataDisposed = false;
    let resizeDisposed = false;
    let focusCount = 0;
    const writes: Array<string | Uint8Array> = [];
    const terminal = {
      cols: 80,
      rows: 24,
      onData(listener: (data: string) => void) {
        sendInput = listener;
        return {
          dispose() {
            dataDisposed = true;
          },
        };
      },
      onResize() {
        return {
          dispose() {
            resizeDisposed = true;
          },
        };
      },
      focus() {
        focusCount += 1;
      },
      reset() {},
      write(data: string | Uint8Array) {
        writes.push(data);
      },
    };

    const starting = startTerminalSession(terminal);
    const temporary = document.querySelector<HTMLInputElement>(
      'input[value="temporary"]',
    );
    if (!temporary) throw new Error("Temporary shell choice is missing");
    temporary.checked = true;
    temporary.dispatchEvent(new Event("change"));
    document.querySelector<HTMLFormElement>("form")?.requestSubmit();
    const controller = await starting;
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket.onopen?.();
    expect(socket.sent[0]).toContain("resize");
    expect(focusCount).toBeGreaterThanOrEqual(2);

    const paste = `${"x".repeat(MAX_INPUT_LENGTH - 1)}😀${"y".repeat(MAX_INPUT_LENGTH)}`;
    sendInput(paste);
    const inputMessages = socket.sent.slice(1).map(parseClientMessage);
    expect(inputMessages.length).toBeGreaterThan(1);
    expect(
      inputMessages
        .map((message) => (message?.type === "input" ? message.data : ""))
        .join(""),
    ).toBe(paste);

    socket.onclose?.({
      code: SESSION_CLOSE_CODES.SESSION_ENDED,
      reason: "Shell exited",
    } as CloseEvent);
    expect(writes.join("")).toContain("Shell session ended");

    controller.dispose();
    expect(dataDisposed).toBe(true);
    expect(resizeDisposed).toBe(true);
  });

  test("opens a bookmarked SSH target with WebSocket variables", async () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static instances: FakeWebSocket[] = [];

      readyState = FakeWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      send(): void {}

      close(): void {
        this.readyState = FakeWebSocket.CLOSING;
      }
    }

    window.location.hash = "#tmux=deploy&ssh=dev%40prod";
    expect(parseSessionHash(window.location.hash)).toEqual({
      ok: true,
      session: {
        name: "deploy",
        target: { kind: "ssh", sshTarget: "dev@prod" },
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: "test-token" })),
      )) as unknown as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const terminal = {
      cols: 100,
      rows: 30,
      onData() {
        return { dispose() {} };
      },
      onResize() {
        return { dispose() {} };
      },
      focus() {},
      reset() {},
      write() {},
    };

    const controller = await startTerminalSession(terminal);
    await waitFor(() => FakeWebSocket.instances.length === 1);
    expect(controller.session).toEqual({
      name: "deploy",
      target: { kind: "ssh", sshTarget: "dev@prod" },
    });
    const socketUrl = new URL(FakeWebSocket.instances[0].url);
    expect(socketUrl.searchParams.get("session")).toBe("deploy");
    expect(socketUrl.searchParams.get("ssh")).toBe("dev@prod");
    expect(socketUrl.searchParams.get("cols")).toBe("100");
    expect(socketUrl.searchParams.get("rows")).toBe("30");

    controller.dispose();
  });

  test("backs off reconnects and redraws a single status line", async () => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static instances: FakeWebSocket[] = [];

      readyState = FakeWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }

      send(): void {}

      close(): void {
        this.readyState = FakeWebSocket.CLOSING;
      }
    }

    const pendingTimers: Array<{ callback: () => void; delay: number }> = [];
    window.setTimeout = ((callback: () => void, delay?: number) => {
      pendingTimers.push({ callback, delay: delay ?? 0 });
      return pendingTimers.length;
    }) as typeof window.setTimeout;
    window.clearTimeout = (() => {}) as typeof window.clearTimeout;
    console.error = () => {};

    let fetchAttempts = 0;
    globalThis.fetch = (() => {
      fetchAttempts += 1;
      return fetchAttempts <= 3
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(
            new Response(JSON.stringify({ token: "test-token" })),
          );
    }) as unknown as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    window.location.hash = "#tmux=work";

    let resetCount = 0;
    const writes: string[] = [];
    const controller = await startTerminalSession({
      cols: 80,
      rows: 24,
      onData() {
        return { dispose() {} };
      },
      onResize() {
        return { dispose() {} };
      },
      focus() {},
      reset() {
        resetCount += 1;
      },
      write(data: string | Uint8Array) {
        writes.push(String(data));
      },
    });

    await waitFor(() => pendingTimers.length === 1);
    expect(pendingTimers[0].delay).toBe(2000);
    pendingTimers.shift()?.callback();
    await waitFor(() => pendingTimers.length === 1);
    expect(pendingTimers[0].delay).toBe(4000);
    pendingTimers.shift()?.callback();
    await waitFor(() => pendingTimers.length === 1);
    expect(pendingTimers[0].delay).toBe(8000);
    pendingTimers.shift()?.callback();

    await waitFor(() => FakeWebSocket.instances.length === 1);
    expect(writes[0]).toContain("Reconnecting in 2s");
    expect(writes[1]).toStartWith("\r\x1b[2K");
    expect(writes[1]).toContain("Reconnecting in 4s");
    expect(writes[2]).toStartWith("\r\x1b[2K");
    expect(writes[2]).toContain("Reconnecting in 8s");

    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();
    expect(resetCount).toBe(1);
    socket.onclose?.({ code: 1006, reason: "" } as CloseEvent);
    expect(pendingTimers[0].delay).toBe(2000);
    expect(writes.at(-1)).toContain("Connection lost. Reconnecting in 2s");

    controller.dispose();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for browser session event");
    await new Promise((resolve) => originalWindowSetTimeout(resolve, 0));
  }
}
