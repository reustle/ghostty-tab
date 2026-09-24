import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Ghostty, Terminal } from "ghostty-web";

import { fixResetBindings } from "../src/client/reset.js";
import { enableDragToCopy } from "../src/client/selection.js";
import { createMouseWheelHandler } from "../src/client/wheel.js";

let terminal: Terminal | undefined;
let restoreCanvas: (() => void) | undefined;
afterEach(() => {
  terminal?.dispose();
  terminal = undefined;
  restoreCanvas?.();
  document.body.replaceChildren();
});

async function openTerminal() {
  // Keep real terminal, selection, input, and WASM behavior; canvas paints are
  // verified in the browser. The no-op context supplies only the drawing surface.
  const canvas = spyOn(
    HTMLCanvasElement.prototype,
    "getContext",
  ).mockImplementation(function (this: HTMLCanvasElement) {
    return new Proxy(
      {
        canvas: this,
        measureText: (text: string) => ({
          width: text.length * 10,
          actualBoundingBoxAscent: 10,
          actualBoundingBoxDescent: 3,
          fontBoundingBoxAscent: 10,
          fontBoundingBoxDescent: 3,
        }),
      },
      {
        get(target, key) {
          return Reflect.get(target, key) ?? (() => {});
        },
      },
    ) as never;
  });
  restoreCanvas = () => canvas.mockRestore();
  const ghostty = await Ghostty.load(
    import.meta.resolve("ghostty-web/ghostty-vt.wasm").replace("file://", ""),
  );
  terminal = new Terminal({ ghostty, cols: 80, rows: 24 });
  const container = document.createElement("div");
  document.body.append(container);
  terminal.open(container);
  fixResetBindings(terminal);
  return terminal;
}

describe("terminal reset bindings", () => {
  test("drag copies without Shift under mouse capture, including after reconnect", async () => {
    const term = await openTerminal();
    const canvas = term.element?.querySelector("canvas");
    if (!canvas) throw new Error("Terminal canvas missing");
    spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 480,
      width: 800,
      height: 480,
    } as DOMRect);
    const stop = enableDragToCopy(canvas);
    term.attachCustomWheelEventHandler(createMouseWheelHandler(term, canvas));
    const replies: string[] = [];
    term.onData((data) => replies.push(data));
    const pointer = (type: string, x: number, buttons: number) => {
      const event = new MouseEvent(type, {
        button: 0,
        buttons,
        clientX: x,
        clientY: 5,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(event, {
        offsetX: { value: x },
        offsetY: { value: 5 },
      });
      canvas.dispatchEvent(event);
    };
    try {
      for (const mode of [1000, 1002, 1003]) {
        term.reset();
        term.write(`\x1b[?${mode}h\x1b[?1006hHello world`);
        replies.length = 0;
        await navigator.clipboard.writeText("");
        pointer("mousedown", 1, 1);
        pointer("mousemove", 41, 1);
        pointer("mouseup", 41, 0);
        expect(term.getSelection()).toBe("Hello");
        expect(await navigator.clipboard.readText()).toBe("Hello");
        expect(replies).toEqual([]);

        const wheel = new WheelEvent("wheel", {
          deltaY: 20,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperties(wheel, {
          clientX: { value: 20 },
          clientY: { value: 20 },
        });
        canvas.dispatchEvent(wheel);
        expect(replies).toEqual(["\x1b[<65;3;2M"]);
        expect(wheel.shiftKey).toBeFalsy();
      }
      stop();
      term.clearSelection();
      replies.length = 0;
      pointer("mousedown", 1, 1);
      pointer("mousemove", 41, 1);
      pointer("mouseup", 41, 0);
      expect(term.hasSelection()).toBe(false);
      expect(replies.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("clears selection and can select below the original row count after reconnect", async () => {
    const term = await openTerminal();
    term.write("Before reset");
    term.select(0, 0, 6);
    expect(term.getSelection()).toBe("Before");
    term.reset();
    expect(term.hasSelection()).toBe(false);
    term.resize(80, 48);
    term.write("\x1b[31;1HLower half");
    term.select(0, 30, 5);
    expect(term.getSelection()).toBe("Lower");
  });

  test("native mouse events follow replacement WASM modes after repeated resets", async () => {
    const term = await openTerminal();
    const element = term.element;
    const canvas = element?.querySelector("canvas");
    if (!element || !canvas) throw new Error("Terminal canvas missing");
    spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 480,
    } as DOMRect);
    const replies: string[] = [];
    term.onData((data) => replies.push(data));
    for (let i = 0; i < 2; i++) {
      const old = term.wasmTerm;
      if (!old) throw new Error("Terminal WASM missing");
      term.reset();
      // Make an accidental call through the freed object's JS wrapper fail.
      old.hasMouseTracking = () => {
        throw new Error("Read freed mouse state");
      };
      old.getMode = () => {
        throw new Error("Read freed mode");
      };
      term.write("\x1b[?1000h\x1b[?1006h");
      replies.length = 0;
      const event = new WheelEvent("wheel", {
        deltaX: 100,
        deltaY: 0,
        bubbles: true,
        cancelable: true,
      });
      // Happy DOM's WheelEvent omits inherited MouseEvent coordinates.
      Object.defineProperties(event, {
        clientX: { value: 20 },
        clientY: { value: 20 },
      });
      element.dispatchEvent(event);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.startsWith("\x1b[<67;")).toBe(true);
      expect(replies[0]?.slice(6)).toMatch(/^\d+;\d+M$/);
    }
  });
});
