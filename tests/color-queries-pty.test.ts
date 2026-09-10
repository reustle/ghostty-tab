import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const hasTmux = process.platform !== "win32" && Boolean(Bun.which("tmux"));

test.skipIf(!hasTmux)(
  "applications receive light and dark colors through real PTY and tmux sessions",
  async () => {
    const result = await exec(
      "node",
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/color-queries-pty.ts", import.meta.url),
        ),
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        timeout: 25_000,
      },
    );
    expect(result.stdout).toContain("PTY and tmux color queries passed");
  },
  30_000,
);
