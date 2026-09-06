import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listTmuxSessions } from "../src/server/tmux.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function hangingTmuxEnvironment() {
  const directory = await mkdtemp(path.join(tmpdir(), "ghostty-tmux-command-"));
  directories.push(directory);
  await copyFile(
    new URL("./fixtures/hanging-tmux.js", import.meta.url),
    path.join(directory, "tmux"),
  );
  return {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
  };
}

describe.skipIf(process.platform === "win32")("tmux command execution", () => {
  test("times out a hung executable without blocking the event loop", async () => {
    const env = await hangingTmuxEnvironment();
    let timerRan = false;
    const timer = setTimeout(() => {
      timerRan = true;
    }, 10);
    try {
      await expect(
        listTmuxSessions({ env, timeoutMs: 100 }),
      ).rejects.toMatchObject({ killed: true });
      expect(timerRan).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  test("cancels a running executable", async () => {
    const env = await hangingTmuxEnvironment();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(
        listTmuxSessions({ env, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
  });

  test("does not disguise a launch failure as an empty session list", async () => {
    await expect(
      listTmuxSessions({ env: { PATH: "/nonexistent-ghostty-test-bin" } }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
