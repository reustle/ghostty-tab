# Updating ghostty-web

## Integration decision

`ghostty-tab` consumes `ghostty-web` as a dependency and owns the PTY/WebSocket transport,
SSH/tmux policy, launcher, footer, and authentication. It does not vendor the library.

The dependency is pinned to Anomaly's commit
[`6e24d040458ddd7aae81572fe2901deec32f9fe7`](https://github.com/anomalyco/ghostty-web/commit/6e24d040458ddd7aae81572fe2901deec32f9fe7).
This replaces Coder's npm 0.4.0 release with newer Ghostty core/viewport fixes, physical-pixel
rendering, block/Powerline sprites, live themes, and application mouse reporting. OpenCode
also uses the Anomaly fork, but currently pins the earlier `83c0a07` commit. We intentionally
include the subsequent mouse-routing fix. The fork is not a complete superset of Coder's
main; in particular, it does not include Coder's newer input echo latency optimization.

Use the full commit hash, never a moving branch. The fork checks in its JS, declarations,
and WASM, so installation needs neither Zig nor a Ghostty build. Its package version field
still says 0.3.0; the Git SHA identifies the actual code. Review source and artifacts together.

## Upgrade checklist

1. Compare the intended commit with our pin, including source, declarations, and WASM.
2. Update the exact dependency and lockfile together:

   ```bash
   bun add 'ghostty-web@github:anomalyco/ghostty-web#<full-commit-sha>'
   ```

3. Review the private adapter surfaces below. Remove adapters when their fixes land rather
   than leaving duplicate implementations installed.
4. Run `bun run check`, then verify light/dark output, live theme changes, resize under heavy
   output, selection, and local/SSH tmux scrolling in the browser.
5. Verify `ghostty-web/ghostty-vt.wasm` resolves and `/ghostty-vt.wasm` is served. Pack and
   install the app in a clean temporary project; check `ghostty-tab --help` and a shell session.
6. Keep upstream library PRs separate from application changes. Pin a reviewed commit after
   fixes merge, then remove the corresponding compatibility code and keep regression tests.

## Color-query compatibility adapter

Anomaly's `Terminal.processColorQueries` uses a regex observer that can answer with stale
render-state colors, misses combined OSC 10/11 queries, and matches query-looking text
inside unrelated terminal control strings. Adding another responder would duplicate replies.

`src/client/color-queries.ts` replaces that private hook. Its bounded parser carries state
across string and byte writes, supports combined queries and BEL/ST terminators, ignores
other control-string payloads, and resets on terminal reset. It calls `wasmTerm.update()`
before reading `getColors()` and sends replies through the existing input/WebSocket/PTY path.
It observes 7-bit control sequences in UTF-8; it does not treat raw C1 bytes as controls.
The newer WASM supports OSC default-color changes, which replies now reflect.

Tests cover split queries, reset isolation, actual rendered colors, no duplicate replies,
and real querying programs under temporary shells and tmux. Remove the adapter and its
registration once [Anomaly PR #9](https://github.com/anomalyco/ghostty-web/pull/9)
or equivalent fixes are included in the pin, retaining these tests.

## Trackpad scrolling policy

Anomaly now supplies native mouse reporting. `src/client/wheel.ts` remains as an application
policy for vertical SGR scrolling: accumulate fractional trackpad movement, normalize pixel,
line, and page deltas, and cap bursts at five rows. Horizontal gestures and Shift bypass stay
with the library. tmux's copy-mode wheel bindings use `-N 1` so they do not multiply those rows.
Normal shell scrollback, non-SGR modes, clicks, and motion also remain with the library.

## Black background compatibility adapter

Anomaly still skips a resolved RGB black background, although WASM has already resolved
default backgrounds to their actual theme colors. `src/client/renderer.ts` wraps the private
`getCellBackground` method and fills its skipped-black result. Selection and inverse video
remain in the native method; batching and physical-pixel painting remain in the renderer.
The old 0.4.0 `renderCellBackground` method no longer exists.

Tests exercise the actual WASM and `renderCellBackgrounds` painter for RGB/indexed black,
ANSI palette colors, resets, inverse video, selection, and wide characters. Remove this
adapter after [Anomaly PR #8](https://github.com/anomalyco/ghostty-web/pull/8)
or an equivalent renderer fix is included in the pin.

## Reset compatibility adapter

`src/client/reset.ts` keeps selection and native mouse-mode checks bound to the current
WASM terminal after `reset()` replaces and frees the original object. It also clears selection
before replacement. Our session controller resets on every connection, so this is required
for both initial attachment and reconnects. The adapter uses the pinned private
`inputHandler.mouseConfig` and `selectionManager.wasmTerm` surfaces. Remove it after
[Anomaly PR #7](https://github.com/anomalyco/ghostty-web/pull/7) or an equivalent fix lands.

## Theme integration

`src/client/theme.ts` follows system preference changes through the fork's public `options`
API. It updates both `theme` and `colorScheme`, so terminal query replies agree with the
visible palette. Real RGB black is supported by the new WASM configuration; the light
Terminal Basic palette no longer needs the near-black workaround.

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
