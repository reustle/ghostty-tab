# Usage guide

`ghostty-tab` puts a real shell in a browser tab, rendered by
[`ghostty-web`](https://github.com/coder/ghostty-web).

Each browser tab can use either:

- a **temporary shell**, which ends when the browser connection closes; or
- a **persistent session**, backed by a named local or remote tmux session that can be
  bookmarked and reopened later.

The server runs locally and listens only on `127.0.0.1` by default.

## Install and run

Requirements:

- Node.js 20 or newer
- Bun 1.3.13 to install and build the project
- a platform supported by `@lydell/node-pty`
- `tmux` if you want persistent sessions
- `ssh` if you want persistent sessions on a remote machine

From this checkout:

```bash
bun install
bun run build
bun run start
```

Open [http://127.0.0.1:1036](http://127.0.0.1:1036).

On the first page load, use **Start a session** to choose a **Temporary shell**, **Local tmux**,
or **Remote tmux** over SSH. **Resume a session** lists running local sessions from ghostty-tab's
isolated tmux socket; selecting one attaches immediately. Use the `[ × ]` control beside a
running session to close it after a confirmation; closing a tmux session stops the programs
inside it. Persistent sessions get bookmarkable URLs:

```text
http://127.0.0.1:1036/#tmux=my-project
http://127.0.0.1:1036/#ssh=alice%40server.example.com&tmux=my-project
```

The launcher remembers your selected session type and SSH destination in this browser,
including across tabs and restarts. New sessions still start with a blank session name;
values in a session URL take precedence. These preferences are specific to the site's
address (including its port) and browser profile. Clearing site data removes them.

Use the trackpad or mouse wheel to scroll persistent-session output history. Scrolling up
enters tmux's history view; scroll back to the bottom or press `q` to return to the live
prompt. On each attachment, ghostty-tab enables mouse scrolling and configures one line per
wheel event for all sessions on its dedicated tmux server, locally or over SSH. This applies
to both tmux key modes (Emacs and vi), including existing sessions on that server.

Closing that page detaches from tmux without stopping the programs inside it. Opening the
same URL attaches to the same session again. These sessions use a dedicated tmux socket named
`ghostty-tab`, so they do not attach to or modify sessions on your normal tmux server.

The launcher and terminal follow your browser's light or dark preference. The launcher
updates immediately when that preference changes; reopen the tab to apply a new terminal
palette, since ghostty-web applies its theme when the terminal opens.

The bottom bar shows your session and SSH destination when applicable.
Select **[ new tab ]** to open the launcher in a separate browser tab with your remembered
session type and SSH destination. The session name starts blank, and the current session
and custom tab title are not carried over.
Select **[ rename tab ]** to give the browser tab a custom title. The title takes priority
over shell and tmux title changes. For named tmux sessions, it is saved in this browser,
separately for each session name and SSH destination, so reopening a bookmark restores it.
Titles are specific to the site's address (including its port) and browser profile; clearing
site data removes them. Temporary shell titles only survive reloads in the same tab.
Renaming the browser tab does not rename the tmux session or change its bookmark URL. Choose
**[ use automatic title ]** (or save an empty title) to follow terminal titles again.

## Development

```bash
bun install
bun run dev
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The development command starts both
Vite and the PTY server.

Run every project check with:

```bash
bun run check
```

This checks formatting, lint, types, tests, and the production builds. When tmux is installed
on macOS or Linux, the tests also exercise real PTY detach/reattach, server restart, and shell
exit under Node. This test uses its own temporary tmux socket directory and ignores your tmux
configuration; CI installs tmux so it always runs.

## Configuration

```text
ghostty-tab [--host <host>] [--port <1-65535>]

Options:
    --host <host>       Bind host (default: 127.0.0.1)
-p, --port <port>       HTTP port (default: 1036, or 8000 in development)
-h, --help              Show help

Environment:
GHOSTTY_ALLOWED_HOSTS   Comma-separated browser-visible hostnames
```

For example:

```bash
bun run start --host 127.0.0.1 --port 9000
```

Host and port are configured through CLI flags; `HOST` and `PORT` environment variables
are ignored.

## Remote tmux over SSH

Remote sessions use your local OpenSSH client and its normal configuration. The remote
machine only needs an SSH server and tmux; `ghostty-tab` does not need to be installed there.

First verify that the SSH target works in your regular terminal:

```bash
ssh alice@server.example.com
```

In `ghostty-tab`, select **Remote tmux**, enter `alice@server.example.com`, and open the tmux
session. The URL formatter encodes the `@` as `%40`. SSH aliases from `~/.ssh/config` also
work, but are not required. Closing the browser tab ends the SSH connection but leaves tmux
and its programs running remotely. Reopening the same URL starts a new SSH connection and
reattaches.

Binding `ghostty-tab` directly to a non-loopback address exposes a shell-capable service to
the network. The server validates hosts and origins and uses a per-run WebSocket token, but it
does not provide user accounts or TLS. Use an SSH tunnel or an authenticated, encrypted
reverse proxy for remote access.

## Project boundaries

- `ghostty-web` owns terminal parsing, WASM integration, rendering, keyboard input, selection,
  and the xterm-compatible browser API.
- `ghostty-tab` owns HTTP/WebSocket authentication, local shell and SSH PTY processes, tmux
  persistence, session URLs, and the browser UI.
- The WebSocket accepts only typed terminal input and resize messages; it does not expose a
  browser-side command or automation API.

`ghostty-web` is pinned to an exact stable version in `package.json`. See
[`docs/updating-ghostty-web.md`](updating-ghostty-web.md) for the update checklist.

## License

MIT. See [LICENSE](../LICENSE).
