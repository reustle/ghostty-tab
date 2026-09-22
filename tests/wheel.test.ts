import { describe, expect, test } from "bun:test";

import { createMouseWheelHandler } from "../src/client/wheel.js";

function setup() {
  const sent: string[] = [];
  const terminal = {
    cols: 80,
    rows: 24,
    mouse: true,
    sgr: true,
    hasMouseTracking() {
      return this.mouse;
    },
    getMode(mode: number) {
      return mode === 1006 && this.sgr;
    },
    input(data: string, userInput?: boolean) {
      expect(userInput).toBe(true);
      sent.push(data);
    },
  };
  const canvas = {
    getBoundingClientRect: () =>
      ({ left: 100, top: 50, width: 800, height: 480 }) as DOMRect,
  };
  const handle = createMouseWheelHandler(terminal, canvas);
  const wheel = (deltaY: number, options: WheelEventInit = {}) =>
    handle({
      deltaY,
      deltaX: 0,
      deltaMode: 0,
      clientX: 195,
      clientY: 245,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      ...options,
    } as WheelEvent);
  return { terminal, sent, wheel };
}

describe("mouse wheel compatibility", () => {
  test("reports wheel direction and cell coordinates instead of arrow keys", () => {
    const { sent, wheel } = setup();
    expect(wheel(-20)).toBe(true);
    expect(wheel(20)).toBe(true);
    expect(sent).toEqual(["\x1b[<64;10;10M", "\x1b[<65;10;10M"]);
  });

  test("accumulates small trackpad deltas and responds to direction changes", () => {
    const { sent, wheel } = setup();
    for (let i = 0; i < 3; i++) wheel(-5);
    expect(sent).toEqual([]);
    wheel(-5);
    expect(sent).toHaveLength(1);
    wheel(-15);
    wheel(20);
    expect(sent.at(-1)).toBe("\x1b[<65;10;10M");
  });

  test("supports line and page deltas with a bounded burst", () => {
    const { sent, wheel } = setup();
    wheel(-2, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(sent).toHaveLength(2);
    wheel(1, { deltaMode: WheelEvent.DOM_DELTA_PAGE });
    expect(sent).toHaveLength(7);
    expect(sent.slice(2).every((value) => value === "\x1b[<65;10;10M")).toBe(
      true,
    );
  });

  test("leaves normal scrollback and non-SGR application behavior to the library", () => {
    const { terminal, sent, wheel } = setup();
    terminal.mouse = false;
    expect(wheel(-100)).toBe(false);
    terminal.mouse = true;
    terminal.sgr = false;
    expect(wheel(-100)).toBe(false);
    expect(sent).toEqual([]);
  });

  test("leaves horizontal scrolling to native mouse reporting", () => {
    const { sent, wheel } = setup();
    expect(wheel(0, { deltaX: -100 })).toBe(false);
    expect(wheel(20, { deltaX: -100 })).toBe(false);
    expect(sent).toEqual([]);
  });

  test("clamps coordinates to the grid and preserves modifiers", () => {
    const { sent, wheel } = setup();
    wheel(-20, { clientX: 0, clientY: 1000, ctrlKey: true, altKey: true });
    expect(sent).toEqual(["\x1b[<88;1;24M"]);
  });

  test("Shift bypasses application mouse capture and clears trackpad remainder", () => {
    const { sent, wheel } = setup();
    wheel(-15);
    expect(wheel(-100, { shiftKey: true })).toBe(false);
    wheel(-5);
    expect(sent).toEqual([]);
  });
});
