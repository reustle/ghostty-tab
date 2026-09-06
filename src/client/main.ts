import { FitAddon, Terminal, init } from "ghostty-web";

import "./style.css";
import { fixBlackBackgrounds } from "./renderer.js";
import { startTerminalSession } from "./session.js";
import { getTerminalTheme } from "./theme.js";
import { createMouseWheelHandler } from "./wheel.js";

const DEFAULT_TITLE = "ghostty-tab";

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
  fitAddon.fit();
  fitAddon.observeResize();

  let latestTerminalTitle = "";
  let sessionLabel = "";

  function fallbackTitle(): string {
    return sessionLabel || DEFAULT_TITLE;
  }

  function refreshDocumentTitle(): void {
    document.title = latestTerminalTitle || fallbackTitle();
  }

  const titleSubscription = terminal.onTitleChange((title) => {
    latestTerminalTitle = title.trim();
    refreshDocumentTitle();
  });

  const session = await startTerminalSession(terminal);
  if (session.session) {
    sessionLabel =
      session.session.target.kind === "ssh"
        ? `${session.session.name}@${session.session.target.sshTarget}`
        : session.session.name;
  }
  refreshDocumentTitle();
  terminal.focus();

  window.addEventListener(
    "pagehide",
    () => {
      session.dispose();
      titleSubscription.dispose();
      terminal.dispose();
    },
    { once: true },
  );
}
