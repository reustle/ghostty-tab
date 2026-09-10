# Updating ghostty-web

## Integration decision

`ghostty-tab` is intentionally a separate application with `ghostty-web` as a normal npm
dependency. It does not carry a copy of the base library, a Git submodule, or a long-lived fork.

This is the cleanest update boundary because the application needs only documented public
exports (`init`, `Terminal`, `FitAddon`, and terminal event/mode APIs) plus the published
`ghostty-vt.wasm` asset, with the temporary renderer exception documented below.
The color-query adapter also uses the exposed `Terminal.wasmTerm` render-state API.
Its PTY transport, session UX, tmux policy, and security model are
application concerns and do not require changes to the terminal emulator.

The dependency is pinned to an exact stable release rather than a range. Upgrades therefore
happen only in an explicit review and cannot silently replace the WASM/TypeScript ABI during a
fresh install.

## Upgrade checklist

1. Read the upstream release notes and compare the package contents and public API with the
   currently pinned version.
2. Install the intended stable version exactly:

   ```bash
   bun add --exact ghostty-web@<version>
   ```

3. Confirm `ghostty-web/ghostty-vt.wasm` still resolves from Node and that the browser build
   serves it at `/ghostty-vt.wasm`.
4. Run the complete gate:

   ```bash
   bun run check
   ```

5. Run `npm pack` in a temporary destination, install the tarball in a clean temporary project,
   and verify `ghostty-tab --help` and a local shell session.
6. Review the lockfile and package diff. Commit the dependency and lockfile changes together.

Do not develop ghostty-tab features on a ghostty-web branch. If the base library truly needs a
fix, prepare that change upstream, test this app against the candidate release, and update the
exact dependency after a stable package contains it. Until then, keep any explicitly approved
compatibility adapter isolated and document its removal conditions here.

## Audit of the original ghostty-web feature branch

The source branch reviewed while extracting this application was `demo-fullscreen-title` in
the local `ghostty-web` checkout. At the time of extraction it was six commits ahead of, and
based directly on, the then-current `origin/main` (`1858a59`). Its existing library checks
passed: formatting, lint, type checking, 400 tests, and the library build.

The branch mixed two different categories of work:

- broadly reusable terminal behavior, such as terminal title reporting; and
- application behavior, including the fullscreen demo, PTY server, tmux session URLs,
  authentication, and browser automation commands.

Keeping the second category on a base-library branch would create regular merge pressure and
would make application security changes part of every upstream rebase. The implementation in
this repository instead uses the released title event and moves all product code behind the
dependency boundary. It deliberately does not copy the branch's browser-side command tool.

## Color-query compatibility adapter

`src/client/color-queries.ts` supplies the OSC 10/11 foreground/background replies missing
from ghostty-web 0.4.0. The installed WASM logs `OSC 10/11 requires an allocator, but none was
provided` and returns no color response, although ordinary cursor-position queries work.
Codex CLI consequently falls back to dark diff backgrounds and dark syntax highlighting on
a light terminal. `TERM` and `COLORTERM` only advertise color capabilities, not background
lightness.

The adapter is installed after `open()` and before the session connects. It observes writes
without rewriting output and sends replies through `Terminal.input(..., true)` and the normal
`onData`/WebSocket/PTY transport. It supports foreground, background, and combined queries,
BEL and ST termination, and sequences split across string or `Uint8Array` writes. Its bounded
state persists across writes, ignores other control-string payloads, and resets when the
terminal resets on reconnection. It only observes 7-bit control sequences in the UTF-8 stream;
it does not add OSC color-setting or raw 8-bit C1 support.

Replies come from `wasmTerm.update()` and `getColors()`, so they describe the actual default
colors rather than SGR text colors or an independently parsed CSS theme. In particular,
0.4.0's unsupported CSS names and zero-color sentinel still follow the library's rendering
fallbacks. The app's themes already use explicit nonzero hex colors. The unsupported queries
still reach the original parser, so its diagnostic warnings remain until the upstream fix.

`tests/color-queries.test.ts` exercises the released Terminal and WASM with the Codex startup
probe, both themes, every query split point, byte arrays, RGB/shorthand/named colors, resets,
and unrelated output. `tests/color-queries-pty.test.ts` also runs a real querying application
under Node through temporary-shell and isolated tmux sessions in both themes. The adapter
replaces the rejected original branch approach, which matched each string write independently
and parsed CSS names incorrectly.

The durable upstream fix belongs in Ghostty's parser/response callback: provide the OSC
allocator and implement color replies through the WASM bridge's
`ResponseHandler.colorOperation` seam after verifying the current Ghostty source and ABI.
When a stable release supports these queries, remove this adapter and its registration in
`src/client/main.ts` to avoid duplicate responses. Keep the regression tests and verify local
and SSH tmux paths before updating the pinned dependency. Reload the browser tab and restart
applications such as Codex after the fix; already-running applications may cache the old
startup detection result.

## Wheel compatibility adapter

`src/client/wheel.ts` works around ghostty-web 0.4's alternate-screen wheel handler sending
arrow keys even when tmux requests mouse events ([upstream issue #145](https://github.com/coder/ghostty-web/issues/145)).
It uses the public `attachCustomWheelEventHandler`, `hasMouseTracking`, `getMode`, and
`input` APIs to report SGR wheel events through the normal input transport. It only takes
over while SGR mouse tracking is enabled; normal shell scrollback stays with ghostty-web.
Local and SSH tmux sessions enable `mouse on` so these events scroll tmux's own history.
Their shared copy-mode and copy-mode-vi wheel bindings use `-N 1` because the adapter already
converts wheel movement to rows; tmux's default `-N 5` would multiply the scroll distance.

When upgrading to a release that handles mouse wheel reporting, verify scrolling up and down
with a trackpad in local and SSH tmux sessions, then remove this adapter and its registration
in `src/client/main.ts`. Keep the tmux mouse setting, one-line wheel bindings, and the real
scrolling regression test.

## Black background compatibility adapter

`src/client/renderer.ts` works around ghostty-web 0.4.0 treating every resolved RGB black
background as the terminal default and skipping its paint. This makes btop's default dark
theme show pale text over a light terminal background even with btop's background enabled.

The adapter is installed on the terminal's renderer immediately after `open()`. It paints
resolved black backgrounds, including inverse video, before delegating to the original method
so selection highlighting retains priority. Default backgrounds and ANSI palette colors are
already resolved by WASM; no application output or palette is rewritten.

This adapter uses private `renderCellBackground`, `ctx`, and `metrics` members in the pinned
release. `tests/renderer.test.ts` exercises the installed WASM and renderer in light and dark
themes, covering RGB/indexed black, configured ANSI colors, resets, inverse video, selection,
and wide characters. Review these private members on every dependency upgrade.

The corresponding upstream source fix is to remove the black-color skip in
`lib/renderer.ts`, painting every resolved background after handling selection and inverse
video. Once a stable release includes that fix, remove this adapter and its registration in
`src/client/main.ts`, and retain the regression tests without adapter installation.
