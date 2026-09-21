// Run in Node, the shipped server runtime, from tmux-smoke.test.ts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pty from "@lydell/node-pty";
import WebSocket from "ws";

import { createAuthConfig } from "../../src/server/auth.js";
import {
  type GhosttyTabServer,
  createGhosttyTabServer,
} from "../../src/server/server.js";
import {
  TMUX_SOCKET_NAME,
  createTmuxEnvironment,
  tmuxSessionExists,
} from "../../src/server/tmux.js";
import { encodeInputMessage } from "../../src/shared/protocol.js";
import { SESSION_CLOSE_CODES } from "../../src/shared/session.js";

const exec = promisify(execFile);
const remote = process.argv[2] === "remote";
// Keep the Unix socket path below macOS's length limit.
const directory = await mkdtemp("/tmp/gt-smoke-");
const env = createTmuxEnvironment({
  ...process.env,
  TMUX_TMPDIR: directory,
  SHELL: "/bin/sh",
  // SSH hosts may not receive a UTF-8 locale. The browser still supports UTF-8.
  LANG: "C",
  LC_ALL: "C",
  LC_CTYPE: "C",
});
let server: GhosttyTabServer | undefined;
const sockets: WebSocket[] = [];

async function tmux(...args: string[]) {
  return (
    await exec("tmux", ["-L", TMUX_SOCKET_NAME, ...args], {
      env,
      timeout: 5_000,
    })
  ).stdout.trim();
}
async function startServer() {
  return createGhosttyTabServer({
    port: 0,
    env,
    ptySpawn: remote
      ? (command, args, options) => {
          assert.equal(command, "ssh");
          assert.ok(Array.isArray(args));
          assert.deepEqual(args.slice(0, 2), ["-tt", "fixture-host"]);
          // Execute the real remote command on the isolated tmux server without
          // requiring an SSH daemon or touching a user's remote machine.
          return pty.spawn("/bin/sh", ["-c", args[2]], options);
        }
      : undefined,
    authConfig: createAuthConfig({ token: "smoke-token", env: {} }),
    staticClientRoot: fileURLToPath(new URL("./client", import.meta.url)),
  });
}
function connect(activeServer: GhosttyTabServer) {
  const socket = new WebSocket(
    `${activeServer.url.replace("http:", "ws:")}/ws?token=smoke-token&session=work${remote ? "&ssh=fixture-host" : ""}`,
    {
      headers: { Origin: activeServer.url },
    },
  );
  sockets.push(socket);
  let output = "";
  socket.on("message", (data) => {
    output += data.toString();
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise<number>((resolve) =>
    socket.once("close", resolve),
  );
  return { socket, opened, closed, output: () => output };
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for tmux lifecycle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function expectUnicodeOutput(connection: ReturnType<typeof connect>) {
  const sample = "straight=' curly=’ arrows=←→ dash=— bullet=• box=┌─┐";
  // Send ASCII escapes so echoed input cannot satisfy the output assertion.
  const escaped = [...Buffer.from(sample)]
    .map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`)
    .join("");
  connection.socket.send(encodeInputMessage(`printf '%b\\n' '${escaped}'\r`));
  await waitFor(() => connection.output().includes(sample));
}

try {
  // Seed only the isolated test server, explicitly ignoring the user's tmux config.
  await tmux(
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "fixture",
    "/bin/sh",
  );
  // A user's config may select another session when the current one ends.
  await tmux("set-option", "-g", "detach-on-destroy", "off");
  server = await startServer();
  const first = connect(server);
  await first.opened;
  first.socket.send(
    encodeInputMessage(
      "export GHOSTTY_TEST_VALUE=survived; printf '__GT_%s__\\n' ready\r",
    ),
  );
  await waitFor(() => first.output().includes("__GT_ready__"));
  await expectUnicodeOutput(first);
  assert.equal(await tmux("show-options", "-v", "-t", "=work:", "mouse"), "on");
  first.socket.send(
    encodeInputMessage(
      'i=1; while [ "$i" -le 200 ]; do printf \'history-line-%03d\\n\' "$i"; i=$((i+1)); done\r',
    ),
  );
  await waitFor(() => first.output().includes("history-line-200"));
  const screenBeforeScroll = await tmux("capture-pane", "-p", "-t", "=work:");
  const paneFormat = (format: string) =>
    tmux("display-message", "-p", "-t", "=work:", format);
  const scrollPosition = async () =>
    Number(await paneFormat("#{scroll_position}"));
  for (const mode of ["emacs", "vi"]) {
    await tmux("set-window-option", "-t", "=work:", "mode-keys", mode);
    first.socket.send(encodeInputMessage("\x1b[<64;10;10M"));
    await waitFor(async () => (await paneFormat("#{pane_in_mode}")) === "1");
    // The first gesture enters copy mode; each subsequent event moves one row.
    const initialPosition = await scrollPosition();
    for (let step = 1; step <= 2; step++) {
      first.socket.send(encodeInputMessage("\x1b[<64;10;10M"));
      await waitFor(
        async () => (await scrollPosition()) !== initialPosition + step - 1,
      );
      assert.equal(await scrollPosition(), initialPosition + step, mode);
    }
    first.socket.send(encodeInputMessage("\x1b[<65;10;10M"));
    await waitFor(async () => (await scrollPosition()) !== initialPosition + 2);
    assert.equal(await scrollPosition(), initialPosition + 1, mode);
    first.socket.send(
      encodeInputMessage("\x1b[<65;10;10M".repeat(initialPosition + 2)),
    );
    await waitFor(async () => (await paneFormat("#{pane_in_mode}")) === "0");
    assert.equal(
      await tmux("capture-pane", "-p", "-t", "=work:"),
      screenBeforeScroll,
    );
  }
  const originalPid = await tmux(
    "display-message",
    "-p",
    "-t",
    "=work:",
    "#{pane_pid}",
  );
  first.socket.close();
  await first.closed;
  await waitFor(async () => (await tmux("list-clients", "-t", "=work")) === "");
  assert.equal(await tmuxSessionExists("work", { env }), true);
  // Reattaching must also correct an existing session's option.
  await tmux("set-option", "-t", "=work:", "detach-on-destroy", "off");

  const second = connect(server);
  await second.opened;
  second.socket.send(
    encodeInputMessage("printf '__GT_%s__\\n' \"$GHOSTTY_TEST_VALUE\"\r"),
  );
  await waitFor(() => second.output().includes("__GT_survived__"));
  await expectUnicodeOutput(second);
  assert.equal(
    await tmux("display-message", "-p", "-t", "=work:", "#{pane_pid}"),
    originalPid,
  );

  await server.shutdown();
  assert.equal(await second.closed, SESSION_CLOSE_CODES.SERVER_SHUTDOWN);
  assert.equal(await tmuxSessionExists("work", { env }), true);
  server = await startServer();
  const third = connect(server);
  await third.opened;
  third.socket.send(
    encodeInputMessage("printf '__GT_%s__\\n' \"$GHOSTTY_TEST_VALUE\"\r"),
  );
  await waitFor(() => third.output().includes("__GT_survived__"));
  await expectUnicodeOutput(third);
  assert.equal(
    await tmux("display-message", "-p", "-t", "=work:", "#{pane_pid}"),
    originalPid,
  );
  third.socket.send(encodeInputMessage("exit\r"));
  await waitFor(
    async () =>
      third.socket.readyState === WebSocket.CLOSED ||
      (await tmux("list-clients", "-t", "=fixture")) !== "",
  );
  assert.equal(
    await tmux("list-clients", "-t", "=fixture"),
    "",
    "Exiting work must not switch the client to the unrelated fixture session",
  );
  assert.equal(
    await third.closed,
    remote
      ? SESSION_CLOSE_CODES.SESSION_DETACHED
      : SESSION_CLOSE_CODES.SESSION_ENDED,
  );
  assert.equal(await tmuxSessionExists("work", { env }), false);
  assert.equal(await tmuxSessionExists("fixture", { env }), true);
  console.log(
    "tmux Unicode, detach, reattach, server restart and shell exit passed",
  );
} finally {
  for (const socket of sockets) socket.terminate();
  await server?.shutdown();
  try {
    await tmux("kill-server");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
