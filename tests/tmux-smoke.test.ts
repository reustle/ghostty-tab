import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const hasTmux = process.platform !== "win32" && Boolean(Bun.which("tmux"));

test.skipIf(!hasTmux)(
  "real tmux survives detach and server restart under Node",
  async () => {
    const result = await exec(
      "node",
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/tmux-smoke.ts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        timeout: 25_000,
      },
    );
    expect(result.stdout).toContain(
      "tmux detach, reattach, server restart and shell exit passed",
    );
  },
  30_000,
);
