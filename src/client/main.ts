import { FitAddon, Terminal, init } from "ghostty-web";

import "./style.css";
import { createTerminalFooter } from "./footer.js";
import { fixBlackBackgrounds } from "./renderer.js";
import { startTerminalSession } from "./session.js";
import { getTerminalTheme } from "./theme.js";
import { createMouseWheelHandler } from "./wheel.js";

void main().catch((error) => {
  console.error("Could not start ghostty-tab:", error);
  document.body.textContent =
    "Could not start ghostty-tab. Check the browser console for details.";
});

async function main(): Promise<void> {
  await init();

  const container = document.querySelector<HTMLElement>("#terminal-container");
  if (!container) {
    throw new Error("Terminal page is missing required elements");
  }

  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, "Courier New", monospace',
    fontSize: 14,
    scrollback: 10_000,
    theme: getTerminalTheme(),
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
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
      terminal.dispose();
    },
    { once: true },
  );
}
