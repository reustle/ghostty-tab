import type { ITheme, Terminal } from "ghostty-web";

export function getTerminalTheme(
  light = window.matchMedia("(prefers-color-scheme: light)").matches,
): ITheme {
  if (!light) {
    return { background: "#1e1e1e", foreground: "#d4d4d4" };
  }

  return {
    // macOS Terminal's Basic palette (Ghostty's bundled "Terminal Basic" theme).
    background: "#ffffff",
    foreground: "#000000",
    cursor: "#7f7f7f",
    cursorAccent: "#000000",
    selectionBackground: "#a4c9ff",
    selectionForeground: "#000000",
    black: "#000000",
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

export function followSystemTheme(
  terminal: Pick<Terminal, "options">,
): () => void {
  const preference = window.matchMedia("(prefers-color-scheme: light)");
  const apply = () => {
    terminal.options.theme = getTerminalTheme(preference.matches);
    terminal.options.colorScheme = preference.matches ? "light" : "dark";
  };
  apply();
  preference.addEventListener("change", apply);
  return () => preference.removeEventListener("change", apply);
}
