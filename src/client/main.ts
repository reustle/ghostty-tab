import { FitAddon, Terminal, init } from "ghostty-web";

import "./style.css";
import { fixColorQueries } from "./color-queries.js";
import { createTerminalFooter } from "./footer.js";
import { fixBlackBackgrounds } from "./renderer.js";
import { fixResetBindings } from "./reset.js";
import { startTerminalSession } from "./session.js";
import { followSystemTheme } from "./theme.js";
import { createMouseWheelHandler } from "./wheel.js";

void main().catch((error) => {
  console.error("Could not start ghostty-tab:", error);
  document.body.textContent =
    "Could not start ghostty-tab. Check the browser console for details.";
});

async function main(): Promise<void> {
  // Canvas text is not automatically repainted when a web font finishes loading.
  // Use an icon as the sample so the symbols-only font is actually requested.
  await Promise.all([
    init(),
    document.fonts
      .load('14px "Ghostty Tab Symbols"', "\ue5ff")
      .catch((error) => {
        console.warn(
          "Could not load terminal icons; using system fonts:",
          error,
        );
      }),
  ]);

  const container = document.querySelector<HTMLElement>("#terminal-container");
  if (!container) {
    throw new Error("Terminal page is missing required elements");
  }

  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    cursorBlink: true,
    fontFamily:
      '"JetBrains Mono", Menlo, Monaco, "Courier New", "Ghostty Tab Symbols", monospace',
    fontSize: 14,
    scrollback: 10_000,
  });
  const stopFollowingTheme = followSystemTheme(terminal);

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fixResetBindings(terminal);
  fixColorQueries(terminal);
  if (terminal.renderer) fixBlackBackgrounds(terminal.renderer);
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("Terminal canvas was not created");
  terminal.attachCustomWheelEventHandler(
    createMouseWheelHandler(terminal, canvas),
  );
  const footer = createTerminalFooter(terminal);
  fitAddon.fit();
  fitAddon.observeResize();

  const session = await startTerminalSession(terminal);
  footer.setSession(session.session);
  terminal.focus();

  window.addEventListener(
    "pagehide",
    () => {
      session.dispose();
      footer.dispose();
      stopFollowingTheme();
      terminal.dispose();
    },
    { once: true },
  );
}
