import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Ghostty, Terminal } from "ghostty-web";

import { followSystemTheme, getTerminalTheme } from "../src/client/theme.js";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("terminal color scheme", () => {
  test("uses a light terminal palette when the browser prefers light mode", () => {
    const matchMedia = spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);

    const theme = getTerminalTheme();
    expect(matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: light)");
    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#000000");
    expect(theme.cursor).toBe("#7f7f7f");
    expect(theme.selectionForeground).not.toBe(theme.selectionBackground);
  });

  test("WASM resolves light text and ANSI resets without falling back to gray", async () => {
    spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);
    const theme = getTerminalTheme();
    const rgb = (color: string | undefined) => {
      if (!color) throw new Error("Missing theme color");
      return Number.parseInt(color.slice(1), 16);
    };
    const ghostty = await Ghostty.load(
      import.meta.resolve("ghostty-web/ghostty-vt.wasm").replace("file://", ""),
    );
    const terminal = ghostty.createTerminal(10, 2, {
      fgColor: rgb(theme.foreground),
      bgColor: rgb(theme.background),
      palette: [rgb(theme.black), rgb(theme.red)],
    });
    try {
      terminal.write(
        "A\x1b[31mB\x1b[39mC\x1b[30mD\x1b[0mE\x1b[38;2;212;212;212mF",
      );
      const cells = terminal.getLine(0);
      if (!cells?.[0]) throw new Error("Missing terminal cells");
      expect(
        cells.slice(0, 6).map((cell) => [cell.fg_r, cell.fg_g, cell.fg_b]),
      ).toEqual([
        [0, 0, 0],
        [153, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [212, 212, 212],
      ]);
      expect([cells[0].bg_r, cells[0].bg_g, cells[0].bg_b]).toEqual([
        255, 255, 255,
      ]);
    } finally {
      terminal.free();
    }
  });

  test("preserves the current dark theme when light mode is not requested", () => {
    spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);

    expect(getTerminalTheme()).toEqual({
      background: "#1e1e1e",
      foreground: "#d4d4d4",
    });
  });

  test("reads the current preference for each new terminal", () => {
    const matchMedia = spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);
    expect(getTerminalTheme().background).toBe("#1e1e1e");

    matchMedia.mockReturnValue({ matches: true } as MediaQueryList);
    expect(getTerminalTheme().background).toBe("#ffffff");
  });

  test("updates the live WASM theme and reported color scheme, then unsubscribes", async () => {
    const preference = Object.assign(new EventTarget(), { matches: true });
    spyOn(window, "matchMedia").mockReturnValue(preference as MediaQueryList);
    const ghostty = await Ghostty.load(
      import.meta.resolve("ghostty-web/ghostty-vt.wasm").replace("file://", ""),
    );
    const terminal = new Terminal({ ghostty });
    const stop = followSystemTheme(terminal);
    const internals = terminal as unknown as {
      isOpen: boolean;
      buildWasmConfig(): Parameters<Ghostty["createTerminal"]>[2];
    };
    terminal.wasmTerm = ghostty.createTerminal(
      80,
      24,
      internals.buildWasmConfig(),
    );
    terminal.wasmTerm.setColorScheme(terminal.options.colorScheme);
    terminal.renderer = { setTheme() {}, render() {}, dispose() {} } as never;
    internals.isOpen = true;
    const replies: string[] = [];
    terminal.onData((data) => replies.push(data));
    try {
      terminal.write("\x1b[?996n");
      expect(replies.join("")).toBe("\x1b[?997;2n");
      preference.matches = false;
      preference.dispatchEvent(new Event("change"));
      terminal.wasmTerm.update();
      expect(terminal.wasmTerm.getColors().background).toEqual({
        r: 30,
        g: 30,
        b: 30,
      });
      replies.length = 0;
      terminal.write("\x1b[?996n");
      expect(replies.join("")).toBe("\x1b[?997;1n");
      stop();
      preference.matches = true;
      preference.dispatchEvent(new Event("change"));
      expect(terminal.options.colorScheme).toBe("dark");
    } finally {
      stop();
      terminal.dispose();
    }
  });
});
