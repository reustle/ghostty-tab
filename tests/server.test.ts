import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { createAuthConfig } from "../src/server/auth.js";
import {
  type GhosttyTabServer,
  type GhosttyTabServerOptions,
  createGhosttyTabServer,
} from "../src/server/server.js";
import { buildSshTmuxArgs } from "../src/server/tmux.js";
import {
  MAX_INPUT_LENGTH,
  encodeInputMessages,
} from "../src/shared/protocol.js";
import { SESSION_CLOSE_CODES } from "../src/shared/session.js";
import { createFakePty } from "./fixtures/pty.js";

interface FakePty {
  writes: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
  emitData(data: string): void;
}

interface PtySpawnCall {
  command: string;
  args: string[];
  options: { cols: number; rows: number };
}

const runningServers: GhosttyTabServer[] = [];

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map((server) => server.shutdown()),
  );
});

describe("HTTP and PTY integration", () => {
  test("serves the bundled icon font with its WOFF2 content type", async () => {
    const fontRoot = new URL("../src/client/fonts/", import.meta.url);
    const server = await createGhosttyTabServer({
      port: 0,
      authConfig: createAuthConfig({ token: "font-test-token", env: {} }),
      staticClientRoot: path.resolve(
        fileURLToPath(new URL("../", import.meta.url)),
      ),
    });
    runningServers.push(server);

    const response = await request(
      `${server.url}/src/client/fonts/SymbolsNerdFontMono-Regular.woff2`,
    );
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("font/woff2");
    const data = response.data;
    expect(data.subarray(0, 4).toString()).toBe("wOF2");
    expect(data).toEqual(
      Buffer.from(
        await Bun.file(
          new URL("SymbolsNerdFontMono-Regular.woff2", fontRoot),
        ).arrayBuffer(),
      ),
    );
  });

  test("authenticates a WebSocket and accepts only input and resize messages", async () => {
    const ptys: FakePty[] = [];
    const killedSessions: string[] = [];
    const spawnPty = () => {
      const dataListeners: Array<(data: string) => void> = [];
      const exitListeners: Array<() => void> = [];
      const fake: FakePty = {
        writes: [],
        resizes: [],
        killed: false,
        emitData(data) {
          for (const listener of dataListeners) listener(data);
        },
      };
      ptys.push(fake);
      return {
        pid: 123,
        process: "/bin/sh",
        write: (data: string) => fake.writes.push(data),
        resize: (cols: number, rows: number) => fake.resizes.push([cols, rows]),
        kill: () => {
          fake.killed = true;
        },
        pause() {},
        resume() {},
        clear() {},
        onData(listener: (data: string) => void) {
          dataListeners.push(listener);
          return { dispose() {} };
        },
        onExit(listener: () => void) {
          exitListeners.push(listener);
          return { dispose() {} };
        },
      };
    };

    const authConfig = createAuthConfig({
      bindHost: "127.0.0.1",
      token: "integration-token",
      env: {},
    });
    const server = await createGhosttyTabServer({
      port: 0,
      authConfig,
      env: { SHELL: "/bin/sh" },
      ptySpawn: spawnPty as never,
      tmuxSessionKill: async (sessionName) => {
        killedSessions.push(sessionName);
        return sessionName === "alpha";
      },
      tmuxSessionList: async () => ["zeta", "alpha", "alpha", "../unsafe"],
      staticClientRoot: fileURLToPath(
        new URL("./fixtures/client", import.meta.url),
      ),
    });
    runningServers.push(server);

    const page = await get(server.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain("test client");
    const tokenResponse = await get(`${server.url}/api/token`);
    expect(JSON.parse(tokenResponse.body)).toEqual({
      token: "integration-token",
    });
    const sessionsResponse = await get(`${server.url}/api/sessions`);
    expect(JSON.parse(sessionsResponse.body)).toEqual({
      sessions: ["alpha", "zeta"],
    });
    const deniedClose = await request(`${server.url}/api/sessions/alpha`, {
      method: "DELETE",
      headers: {
        Origin: server.url,
        "X-Ghostty-Token": "wrong-token",
      },
    });
    expect(deniedClose.status).toBe(401);
    expect(killedSessions).toEqual([]);
    const closeResponse = await request(`${server.url}/api/sessions/alpha`, {
      method: "DELETE",
      headers: {
        Origin: server.url,
        "X-Ghostty-Token": "integration-token",
      },
    });
    expect(closeResponse.status).toBe(204);
    expect(killedSessions).toEqual(["alpha"]);

    const socket = new WebSocket(
      `${server.url.replace("http:", "ws:")}/ws?token=integration-token&cols=90&rows=31`,
      { headers: { Origin: server.url } },
    );
    await onceOpen(socket);
    expect(ptys).toHaveLength(1);

    socket.send(JSON.stringify({ type: "input", data: "printf ok\r" }));
    socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await waitFor(
      () => ptys[0].writes.length === 1 && ptys[0].resizes.length === 1,
    );
    expect(ptys[0].writes).toEqual(["printf ok\r"]);
    expect(ptys[0].resizes).toEqual([[120, 40]]);

    const output = onceMessage(socket);
    ptys[0].emitData("shell output");
    expect(await output).toBe("shell output");

    const closed = onceClose(socket);
    socket.send(JSON.stringify({ type: "command", command: "whoami" }));
    expect(await closed).toBe(1008);
    expect(ptys[0].killed).toBe(true);
  });

  test("delivers a large Unicode paste without ending the shell", async () => {
    const fake = createFakePty();
    const server = await createTestServer(() => fake.process);
    const socket = openTestSocket(server);
    await onceOpen(socket);
    const paste = `${"x".repeat(MAX_INPUT_LENGTH - 1)}😀\x1b[201~`;
    for (const message of encodeInputMessages(paste)) socket.send(message);
    await waitFor(() => fake.writes.join("").length === paste.length);
    expect(
      fake.writes.map((chunk) => Buffer.from(chunk).toString("utf8")).join(""),
    ).toBe(paste);
    expect(fake.killCount).toBe(0);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  for (const operation of ["input", "resize"] as const) {
    test(`contains ${operation} failures to one attachment`, async () => {
      const failed = createFakePty();
      const healthy = createFakePty();
      const processes = [failed, healthy];
      const server = await createTestServer(() => processes.shift()?.process);
      const first = openTestSocket(server);
      await onceOpen(first);
      const second = openTestSocket(server);
      await onceOpen(second);
      failed.failInput = operation === "input";
      failed.failResize = operation === "resize";
      const originalError = console.error;
      console.error = () => {};
      try {
        const closed = onceClose(first);
        first.send(
          JSON.stringify(
            operation === "input"
              ? { type: "input", data: "hello" }
              : { type: "resize", cols: 81, rows: 25 },
          ),
        );
        expect(await closed).toBe(1011);
        expect(failed.killCount).toBe(1);
        expect(failed.subscriptionCount).toBe(0);
        second.send(JSON.stringify({ type: "input", data: "still alive" }));
        await waitFor(() => healthy.writes.length === 1);
        expect(healthy.writes).toEqual(["still alive"]);
        expect((await get(`${server.url}/api/token`)).status).toBe(200);
      } finally {
        console.error = originalError;
        second.close();
      }
    });
  }

  test("ignores queued input after exit and releases PTY subscriptions", async () => {
    const fake = createFakePty();
    const server = await createTestServer(() => fake.process);
    const socket = openTestSocket(server);
    await onceOpen(socket);
    const closed = onceClose(socket);
    fake.emitExit();
    // Deliberately deliver an already-queued resize before the close handshake.
    socket.send(JSON.stringify({ type: "resize", cols: 81, rows: 25 }));
    expect(await closed).toBe(SESSION_CLOSE_CODES.SESSION_ENDED);
    expect(fake.resizes).toEqual([]);
    expect(fake.killCount).toBe(0);
    expect(fake.subscriptionCount).toBe(0);
  });

  test("disconnect and shutdown kill an attachment only once", async () => {
    const fake = createFakePty();
    const server = await createTestServer(() => fake.process);
    const socket = openTestSocket(server);
    await onceOpen(socket);
    socket.close();
    await waitFor(() => fake.killCount === 1);
    await server.shutdown();
    expect(fake.killCount).toBe(1);
    expect(fake.subscriptionCount).toBe(0);
  });

  test("keeps HTTP and terminal I/O responsive while tmux setup and listing wait", async () => {
    const setup = deferred<void>();
    const list = deferred<readonly string[]>();
    let setupStarted = false;
    const ptys: ReturnType<typeof createFakePty>[] = [];
    const server = await createTestServer(
      () => {
        const fake = createFakePty();
        ptys.push(fake);
        return fake.process;
      },
      {
        tmuxSessionEnsure: async () => {
          setupStarted = true;
          await setup.promise;
        },
        tmuxSessionList: () => list.promise,
      },
    );
    const pending = openTestSocket(server, "&session=work");
    const pendingOpen = onceOpen(pending);
    const listing = get(`${server.url}/api/sessions`);
    try {
      await waitFor(() => setupStarted);
      expect(ptys).toHaveLength(0);
      const shell = openTestSocket(server);
      await onceOpen(shell);
      shell.send(JSON.stringify({ type: "input", data: "responsive" }));
      await waitFor(() => ptys[0]?.writes.length === 1);
      expect((await get(`${server.url}/api/token`)).status).toBe(200);
      setup.resolve();
      await pendingOpen;
      pending.send(JSON.stringify({ type: "input", data: "first input" }));
      await waitFor(() => ptys[1]?.writes.length === 1);
      expect(ptys[1].writes).toEqual(["first input"]);
      list.resolve(["work"]);
      expect(JSON.parse((await listing).body)).toEqual({ sessions: ["work"] });
      shell.close();
    } finally {
      setup.resolve();
      list.resolve([]);
      pending.close();
    }
  });

  test("shutdown cancels pending tmux setup without spawning a PTY", async () => {
    const setup = deferred<void>();
    let setupSignal: AbortSignal | undefined;
    let spawnCount = 0;
    const server = await createTestServer(
      () => {
        spawnCount++;
        return createFakePty().process;
      },
      {
        tmuxSessionEnsure: async (_session, options) => {
          setupSignal = options?.signal;
          await setup.promise;
        },
      },
    );
    const pending = openTestSocket(server, "&session=work");
    pending.on("error", () => {});
    try {
      await waitFor(() => setupSignal !== undefined);
      await server.shutdown();
      expect(setupSignal?.aborted).toBe(true);
      setup.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnCount).toBe(0);
    } finally {
      setup.resolve();
      pending.terminate();
    }
  });

  test("disconnect cancels pending tmux setup without spawning a PTY", async () => {
    const setup = deferred<void>();
    let setupSignal: AbortSignal | undefined;
    let spawnCount = 0;
    const server = await createTestServer(
      () => {
        spawnCount++;
        return createFakePty().process;
      },
      {
        tmuxSessionEnsure: async (_session, options) => {
          setupSignal = options?.signal;
          await setup.promise;
        },
      },
    );
    const pending = openTestSocket(server, "&session=work");
    pending.on("error", () => {});
    try {
      await waitFor(() => setupSignal !== undefined);
      pending.terminate();
      await waitFor(() => setupSignal?.aborted === true);
      setup.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnCount).toBe(0);
    } finally {
      setup.resolve();
      pending.terminate();
    }
  });

  test("reports tmux setup failures as a final session close", async () => {
    const originalError = console.error;
    console.error = () => {};
    let spawnCount = 0;
    try {
      const server = await createTestServer(
        () => {
          spawnCount++;
          return createFakePty().process;
        },
        {
          tmuxSessionEnsure: async () => {
            throw new Error("tmux timed out");
          },
        },
      );
      const socket = openTestSocket(server, "&session=work");
      expect(await onceClose(socket)).toBe(
        SESSION_CLOSE_CODES.SESSION_SETUP_FAILED,
      );
      expect(spawnCount).toBe(0);
    } finally {
      console.error = originalError;
    }
  });

  test("spawns SSH and attaches to a named tmux session remotely", async () => {
    const ptys: FakePty[] = [];
    const calls: PtySpawnCall[] = [];
    const spawnPty = (
      command: string,
      args: string[],
      options: { cols: number; rows: number },
    ) => {
      calls.push({ command, args, options });
      const dataListeners: Array<(data: string) => void> = [];
      const fake: FakePty = {
        writes: [],
        resizes: [],
        killed: false,
        emitData(data) {
          for (const listener of dataListeners) listener(data);
        },
      };
      ptys.push(fake);
      return {
        pid: 456,
        process: "ssh",
        write: (data: string) => fake.writes.push(data),
        resize: (cols: number, rows: number) => fake.resizes.push([cols, rows]),
        kill: () => {
          fake.killed = true;
        },
        pause() {},
        resume() {},
        clear() {},
        onData(listener: (data: string) => void) {
          dataListeners.push(listener);
          return { dispose() {} };
        },
        onExit() {
          return { dispose() {} };
        },
      };
    };

    const authConfig = createAuthConfig({
      bindHost: "127.0.0.1",
      token: "remote-token",
      env: {},
    });
    const server = await createGhosttyTabServer({
      port: 0,
      authConfig,
      env: { PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent" },
      ptySpawn: spawnPty as never,
      staticClientRoot: fileURLToPath(
        new URL("./fixtures/client", import.meta.url),
      ),
    });
    runningServers.push(server);

    const socket = new WebSocket(
      `${server.url.replace("http:", "ws:")}/ws?token=remote-token&session=deploy&ssh=dev%40prod&cols=100&rows=32`,
      { headers: { Origin: server.url } },
    );
    await onceOpen(socket);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "ssh",
      args: buildSshTmuxArgs("dev@prod", "deploy", 100, 32),
      options: expect.objectContaining({ cols: 100, rows: 32 }),
    });

    socket.close();
    await waitFor(() => ptys[0]?.killed === true);
  });
});

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}

function onceClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for server event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function get(url: string): Promise<{ status: number; body: string }> {
  return request(url);
}

function request(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{
  status: number;
  body: string;
  data: Buffer;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const data = Buffer.concat(chunks);
        resolve({
          status: response.statusCode ?? 0,
          body: data.toString("utf8"),
          data,
          headers: response.headers,
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function createTestServer(
  spawn: () => unknown,
  options: Partial<GhosttyTabServerOptions> = {},
): Promise<GhosttyTabServer> {
  const server = await createGhosttyTabServer({
    port: 0,
    authConfig: createAuthConfig({ token: "test-token", env: {} }),
    ...options,
    ptySpawn: spawn as never,
    staticClientRoot: fileURLToPath(
      new URL("./fixtures/client", import.meta.url),
    ),
  });
  runningServers.push(server);
  return server;
}

function openTestSocket(server: GhosttyTabServer, query = ""): WebSocket {
  return new WebSocket(
    `${server.url.replace("http:", "ws:")}/ws?token=test-token${query}`,
    {
      headers: { Origin: server.url },
    },
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
