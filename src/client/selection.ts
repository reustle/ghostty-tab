/** Reserve left-button selection for the browser, even when tmux owns the mouse. */
export function enableDragToCopy(canvas: HTMLCanvasElement): () => void {
  const events = ["mousedown", "mousemove", "mouseup", "click"] as const;
  const bypassMouseCapture = (event: MouseEvent) => {
    const primary =
      event.type === "mousemove"
        ? (event.buttons & 1) !== 0
        : event.button === 0;
    if (!primary) return;

    // ghostty-web uses Shift for both starting browser selection and suppressing
    // application mouse reports. Apply that bypass to this pointer event only;
    // keyboard modifiers and wheel events retain their normal behavior.
    Object.defineProperty(event, "shiftKey", {
      configurable: true,
      value: true,
    });
  };
  for (const type of events) {
    canvas.addEventListener(type, bypassMouseCapture, { capture: true });
  }
  return () => {
    for (const type of events) {
      canvas.removeEventListener(type, bypassMouseCapture, { capture: true });
    }
  };
}
