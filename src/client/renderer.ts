import type { CanvasRenderer, GhosttyCell } from "ghostty-web";

// Private renderer surface in the pinned Anomaly commit.
interface RendererInternals {
  getCellBackground(
    cell: GhosttyCell,
    x: number,
    y: number,
  ): string | undefined;
}

/** Remove once ghostty-web paints explicitly requested black backgrounds. */
export function fixBlackBackgrounds(renderer: CanvasRenderer): void {
  const target = renderer as unknown as RendererInternals;
  const original = target.getCellBackground;
  target.getCellBackground = function (cell, x, y) {
    // Only resolved RGB black is skipped. Preserve selection/inverse handling
    // and let the native renderer batch backgrounds on its physical pixel grid.
    return original.call(this, cell, x, y) ?? "rgb(0, 0, 0)";
  };
}
