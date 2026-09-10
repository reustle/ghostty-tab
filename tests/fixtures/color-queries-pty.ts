// Exercise both transport paths under Node, the shipped server runtime.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { type CanvasRenderer, Ghostty, Terminal } from "ghostty-web";
import WebSocket from "ws";

import { fixColorQueries } from "../../src/client/color-queries.js";
import { createAuthConfig } from "../../src/server/auth.js";
import {
  type GhosttyTabServer,
  createGhosttyTabServer,
} from "../../src/server/server.js";
import { createTmuxEnvironment } from "../../src/server/tmux.js";
import { encodeInputMessages } from "../../src/shared/protocol.js";

const exec = promisify(execFile);
// The browser bundle's file loader is stubbed under Node; a data URL loads the
// exact same installed WASM without starting an extra asset server.
const wasm = await readFile(
  new URL(import.meta.resolve("ghostty-web/ghostty-vt.wasm")),
);
const ghostty = await Ghostty.load(
  `data:application/wasm;base64,${wasm.toString("base64")}`,
);
const directory = await mkdtemp("/tmp/gt-colors-");
const env = createTmuxEnvironment({
  ...process.env,
  TMUX_TMPDIR: directory,
  SHELL: "/bin/sh",
});
let server: GhosttyTabServer | undefined;
const sockets: WebSocket[] = [];
const terminals: Terminal[] = [];
const marker = "__GT_COLOR_REPLY__";

// A real program inside the shell asks exactly as Codex does, then prints the
// received colors. Raw mode prevents the terminal reply from being line buffered.
const probe = String.raw`
process.stdin.setRawMode(true);
process.stdin.resume();
let input = "";
const timer = setTimeout(() => process.exit(2), 3000);
process.stdin.on("data", (data) => {
  input += data.toString();
  const colors = {};
  for (const match of input.matchAll(/\x1b\](10|11);rgb:([0-9a-f/]+)(?:\x07|\x1b\\)/g)) {
    colors[match[1]] = match[2];
  }
  if (colors[10] && colors[11]) {
    clearTimeout(timer);
    process.stdin.setRawMode(false);
    console.log("\r\n__GT_COLOR_REPLY__" + colors[10] + ":" + colors[11]);
    process.exit(0);
  }
});
process.stdout.write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = `${quote(process.execPath)} -e ${quote(probe)}\r`;

async function tmux(...args: string[]) {
  return exec("tmux", ["-L", "ghostty-tab", ...args], { env, timeout: 5_000 });
}

async function verify(session: string | null, light: boolean) {
  assert(server);
  const terminal = new Terminal({
    ghostty,
    theme: light
      ? { foreground: "#010101", background: "#ffffff" }
      : { foreground: "#d4d4d4", background: "#1e1e1e" },
  });
  // Replace only open()'s DOM setup, retaining the real Terminal/WASM methods.
  const internals = terminal as unknown as {
    isOpen: boolean;
    buildWasmConfig(): Parameters<Ghostty["createTerminal"]>[2];
  };
  terminal.wasmTerm = ghostty.createTerminal(
    80,
    24,
    internals.buildWasmConfig(),
  );
  terminal.renderer = { clear() {}, dispose() {} } as CanvasRenderer;
  internals.isOpen = true;
  terminals.push(terminal);
  fixColorQueries(terminal);

  const url = new URL(`${server.url.replace("http:", "ws:")}/ws`);
  url.searchParams.set("token", "color-test-token");
  if (session) url.searchParams.set("session", session);
  const socket = new WebSocket(url, { headers: { Origin: server.url } });
  sockets.push(socket);
  terminal.onData((data) => {
    for (const message of encodeInputMessages(data)) socket.send(message);
  });
  let output = "";
  socket.on("message", (data) => {
    const chunk = data.toString();
    output += chunk;
    terminal.write(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  for (const message of encodeInputMessages(command)) socket.send(message);
  const expected = light
    ? `${marker}0101/0101/0101:ffff/ffff/ffff`
    : `${marker}d4d4/d4d4/d4d4:1e1e/1e1e/1e1e`;
  const deadline = Date.now() + 5_000;
  while (!output.includes(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(
    output.includes(expected),
    `${session ?? "PTY"} ${light ? "light" : "dark"}: ${JSON.stringify(output)}`,
  );
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  socket.close();
  await closed;
}

try {
  // An isolated socket and empty config avoid touching the user's tmux sessions.
  await tmux(
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "fixture",
    "/bin/sh",
  );
  server = await createGhosttyTabServer({
    port: 0,
    env,
    authConfig: createAuthConfig({ token: "color-test-token", env: {} }),
    staticClientRoot: fileURLToPath(new URL("./client", import.meta.url)),
  });
  for (const light of [true, false]) {
    await verify(null, light);
    await verify(light ? "light" : "dark", light);
  }
  console.log("PTY and tmux color queries passed");
} finally {
  for (const socket of sockets) socket.terminate();
  await server?.shutdown();
  for (const terminal of terminals) terminal.dispose();
  await tmux("kill-server").catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
