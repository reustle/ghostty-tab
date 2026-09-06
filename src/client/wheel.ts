import type { Terminal } from "ghostty-web";

/** Bridge ghostty-web 0.4's missing SGR wheel reporting using its public API. */
export function createMouseWheelHandler(
  terminal: Pick<
    Terminal,
    "cols" | "rows" | "hasMouseTracking" | "getMode" | "input"
  >,
  canvas: Pick<HTMLCanvasElement, "getBoundingClientRect">,
): (event: WheelEvent) => boolean {
  let remainder = 0;
  return (event) => {
    if (!terminal.hasMouseTracking() || !terminal.getMode(1006)) {
      remainder = 0;
      return false; // Keep native scrollback and non-mouse application behavior.
    }

    // Consume horizontal-only gestures instead of letting the library send Up.
    if (event.deltaY === 0) return true;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return true;
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * terminal.rows
          : event.deltaY / (rect.height / terminal.rows);
    if (Math.sign(delta) !== Math.sign(remainder)) remainder = 0;
    remainder += delta;
    const steps = Math.min(Math.floor(Math.abs(remainder)), 5);
    remainder %= 1;
    const col = Math.max(
      1,
      Math.min(
        terminal.cols,
        Math.floor(((event.clientX - rect.left) / rect.width) * terminal.cols) +
          1,
      ),
    );
    const row = Math.max(
      1,
      Math.min(
        terminal.rows,
        Math.floor(((event.clientY - rect.top) / rect.height) * terminal.rows) +
          1,
      ),
    );
    const button =
      (delta < 0 ? 64 : 65) +
      (event.shiftKey ? 4 : 0) +
      (event.altKey ? 8 : 0) +
      (event.ctrlKey ? 16 : 0);
    for (let step = 0; step < steps; step++) {
      terminal.input(`\x1b[<${button};${col};${row}M`, true);
    }
    return true;
  };
}
