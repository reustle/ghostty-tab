import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { getTerminalTheme } from "../src/client/theme.js";

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
    expect(theme.background).toBe("#f5f3eb");
    expect(theme.foreground).toBe("#30372c");
    expect(theme.cursor).toBe(theme.foreground);
    expect(theme.selectionForeground).not.toBe(theme.selectionBackground);
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
    expect(getTerminalTheme().background).toBe("#f5f3eb");
  });
});
