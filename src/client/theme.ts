import type { ITheme } from "ghostty-web";

export function getTerminalTheme(): ITheme {
  // ghostty-web 0.4.0 only applies the terminal theme when open() runs.
  // Read the current preference on each load without interrupting live shells.
  if (!window.matchMedia("(prefers-color-scheme: light)").matches) {
    return { background: "#1e1e1e", foreground: "#d4d4d4" };
  }

  return {
    background: "#f5f3eb",
    foreground: "#30372c",
    cursor: "#30372c",
    cursorAccent: "#f5f3eb",
    selectionBackground: "#cbd4bf",
    selectionForeground: "#242a21",
    black: "#242a21",
    red: "#a12727",
    green: "#376b20",
    yellow: "#86600b",
    blue: "#245e9c",
    magenta: "#854488",
    cyan: "#246b6b",
    white: "#c6c7bf",
    brightBlack: "#60675b",
    brightRed: "#bd3030",
    brightGreen: "#417a26",
    brightYellow: "#986c0b",
    brightBlue: "#306faf",
    brightMagenta: "#99549a",
    brightCyan: "#287d7d",
    brightWhite: "#e7e5db",
  };
}
