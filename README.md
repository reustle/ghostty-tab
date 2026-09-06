# ghostty-tab

```text
$ ghostty-tab
> your shell. a browser tab. make yourself at /home.
```

A real terminal in your browser, powered by
[ghostty-web](https://github.com/coder/ghostty-web).
Open a temporary shell, or bookmark a local or remote tmux session and pick up where you left off.

<img width="1201" height="783" alt="image" src="https://github.com/user-attachments/assets/09e367d3-d207-413d-8a57-daa6cc60cb18" />

## Boot up

Requires **Node.js 20+** and **Bun 1.3.13**. Add **tmux** for persistent sessions and
**SSH** for remote sessions (the remote machine needs tmux too).

```sh
git clone https://github.com/reustle/ghostty-tab.git
cd ghostty-tab
bun install
bun run build
bun run start
```

Open [127.0.0.1:1036](http://127.0.0.1:1036) and choose a session.

- **Temporary shell** — gone when you disconnect.
- **Local tmux** — close the tab, keep the session.
- **Remote tmux** — the same, over SSH. Your SSH config works here too.

Persistent sessions have bookmarkable URLs and scrollable history. They use a separate
`ghostty-tab` tmux socket. Light and dark themes follow your system preference.

The server binds to `127.0.0.1` by default. It has no user accounts or TLS; use an SSH tunnel
or an authenticated, encrypted reverse proxy for remote access.

## Hack on it

```sh
bun run dev    # http://127.0.0.1:8000
bun run check  # formatting, lint, types, tests, build
```

[Usage & configuration](docs/usage.md) ·
[Updating ghostty-web](docs/updating-ghostty-web.md) ·
[MIT license](LICENSE)
