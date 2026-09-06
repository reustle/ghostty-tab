import { type CanvasRenderer, CellFlags, type GhosttyCell } from "ghostty-web";

// Private renderer surface in the pinned ghostty-web 0.4.0 release.
interface RendererInternals {
  ctx: CanvasRenderingContext2D;
  metrics: { width: number; height: number };
  renderCellBackground(cell: GhosttyCell, x: number, y: number): void;
}

/** Remove once ghostty-web paints explicitly requested black backgrounds. */
export function fixBlackBackgrounds(renderer: CanvasRenderer): void {
  const target = renderer as unknown as RendererInternals;
  const original = target.renderCellBackground;
  target.renderCellBackground = function (cell, x, y) {
    const inverse = (cell.flags & CellFlags.INVERSE) !== 0;
    const r = inverse ? cell.fg_r : cell.bg_r;
    const g = inverse ? cell.fg_g : cell.bg_g;
    const b = inverse ? cell.fg_b : cell.bg_b;

    // WASM already resolves default backgrounds to the configured theme color.
    // RGB black is a real color, but 0.4.0 incorrectly skips painting it.
    if (r === 0 && g === 0 && b === 0) {
      this.ctx.fillStyle = "rgb(0, 0, 0)";
      this.ctx.fillRect(
        x * this.metrics.width,
        y * this.metrics.height,
        this.metrics.width * cell.width,
        this.metrics.height,
      );
    }

    // Keep the library's selection background on top of the cell background.
    original.call(this, cell, x, y);
  };
}
