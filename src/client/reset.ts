import type { Terminal } from "ghostty-web";

/** Remove after anomalyco/ghostty-web#7 is included in our dependency pin. */
export function fixResetBindings(terminal: Terminal): void {
  const target = terminal as unknown as {
    inputHandler: {
      mouseConfig: {
        hasMouseTracking(): boolean;
        hasSgrMouseMode(): boolean;
      };
    };
    selectionManager: { wasmTerm: Terminal["wasmTerm"] };
  };
  // open() captured the original WASM object; reset() frees and replaces it.
  const mouse = target.inputHandler.mouseConfig;
  mouse.hasMouseTracking = () => terminal.wasmTerm?.hasMouseTracking() ?? false;
  mouse.hasSgrMouseMode = () => terminal.wasmTerm?.getMode(1006, false) ?? true;
  Object.defineProperty(target.selectionManager, "wasmTerm", {
    configurable: true,
    get: () => terminal.wasmTerm,
  });
  const originalReset = terminal.reset;
  terminal.reset = function () {
    this.clearSelection();
    originalReset.call(this);
  };
}
