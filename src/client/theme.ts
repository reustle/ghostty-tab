import type { ITheme } from "ghostty-web";

export function getTerminalTheme(): ITheme {
  // ghostty-web 0.4.0 only applies the terminal theme when open() runs.
  // Read the current preference on each load without interrupting live shells.
  if (!window.matchMedia("(prefers-color-scheme: light)").matches) {
    return { background: "#1e1e1e", foreground: "#d4d4d4" };
  }

  return {
    // macOS Terminal's Basic palette (Ghostty's bundled "Terminal Basic" theme).
    background: "#ffffff",
    // 0.4.0's WASM config treats RGB zero as "use default" (pale gray).
    // Near-black keeps the Basic appearance without triggering that sentinel.
    foreground: "#010101",
    cursor: "#7f7f7f",
    cursorAccent: "#000000",
    selectionBackground: "#a4c9ff",
    selectionForeground: "#000000",
    black: "#010101",
    red: "#990000",
    green: "#00a600",
    yellow: "#999900",
    blue: "#0000b2",
    magenta: "#b200b2",
    cyan: "#00a6b2",
    white: "#bfbfbf",
    brightBlack: "#666666",
    brightRed: "#e50000",
    brightGreen: "#00d900",
    brightYellow: "#bfbf00",
    brightBlue: "#0000ff",
    brightMagenta: "#e500e5",
    brightCyan: "#00d8d8",
    brightWhite: "#e5e5e5",
  };
}
