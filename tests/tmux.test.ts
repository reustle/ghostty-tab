import { describe, expect, test } from "bun:test";

import {
  LOCAL_TMUX_TITLE_FORMAT,
  REMOTE_TMUX_TITLE_FORMAT,
  TMUX_SOCKET_NAME,
  buildRemoteTmuxCommand,
  buildSshTmuxArgs,
  buildTmuxAttachArgs,
  buildTmuxCreateArgs,
  createTmuxEnvironment,
  ensureTmuxSession,
  exactTmuxTarget,
  killTmuxSession,
  listTmuxSessions,
} from "../src/server/tmux.js";

interface SpawnCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

describe("isolated tmux sessions", () => {
  test("uses an exact target on the dedicated socket", () => {
    expect(exactTmuxTarget("work")).toBe("=work");
    expect(buildTmuxAttachArgs("work")).toEqual([
      "-L",
      TMUX_SOCKET_NAME,
      "-u",
      "attach-session",
      "-t",
      "=work",
    ]);
    expect(buildTmuxCreateArgs("work", 80, 24, "/tmp")).toEqual([
      "-L",
      TMUX_SOCKET_NAME,
      "new-session",
      "-d",
      "-s",
      "work",
      "-c",
      "/tmp",
      "-x",
      "80",
      "-y",
      "24",
    ]);
  });

  test("creates and configures a missing persistent session", async () => {
    const calls: SpawnCall[] = [];
    const statuses = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const run = async (
      command: string,
      args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      calls.push({ command, args, env: options.env });
      return { status: statuses.shift() ?? 1, stdout: "", stderr: "" };
    };

    await ensureTmuxSession(
      { sessionName: "work", cols: 100, rows: 30, cwd: "/tmp" },
      {
        env: { PATH: "/bin", TMUX: "parent", TMUX_PANE: "%1" },
        run,
      },
    );

    expect(calls).toHaveLength(11);
    expect(calls.every((call) => call.command === "tmux")).toBe(true);
    expect(
      calls.every(
        (call) => call.args[0] === "-L" && call.args[1] === TMUX_SOCKET_NAME,
      ),
    ).toBe(true);
    expect(calls.slice(2, 7).map((call) => call.args)).toEqual([
      [
        "-L",
        TMUX_SOCKET_NAME,
        "set-option",
        "-t",
        "=work:",
        "destroy-unattached",
        "off",
      ],
      [
        "-L",
        TMUX_SOCKET_NAME,
        "set-option",
        "-t",
        "=work:",
        "detach-on-destroy",
        "on",
      ],
      ["-L", TMUX_SOCKET_NAME, "set-option", "-t", "=work:", "mouse", "on"],
      [
        "-L",
        TMUX_SOCKET_NAME,
        "set-option",
        "-t",
        "=work:",
        "set-titles",
        "on",
      ],
      [
        "-L",
        TMUX_SOCKET_NAME,
        "set-option",
        "-t",
        "=work:",
        "set-titles-string",
        LOCAL_TMUX_TITLE_FORMAT,
      ],
    ]);
    expect(calls.every((call) => call.env.TMUX === undefined)).toBe(true);
    expect(calls.every((call) => call.env.TMUX_PANE === undefined)).toBe(true);
  });

  test("attaches when another connection wins the session creation race", async () => {
    const statuses = [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    await ensureTmuxSession(
      { sessionName: "work", cols: 80, rows: 24, cwd: "/tmp" },
      {
        run: async () => ({
          status: statuses.shift() ?? 1,
          stdout: "",
          stderr: "duplicate session",
        }),
      },
    );
    expect(statuses).toHaveLength(0);
  });

  test("stops setup when session configuration fails", async () => {
    const statuses = [0, 1, 0, 0];
    await expect(
      ensureTmuxSession(
        { sessionName: "work", cols: 80, rows: 24, cwd: "/tmp" },
        {
          run: async () => ({
            status: statuses.shift() ?? 1,
            stdout: "",
            stderr: "configuration failed",
          }),
        },
      ),
    ).rejects.toThrow("configuration failed");
    expect(statuses).toHaveLength(2);
  });

  test("builds a fixed SSH command that creates and attaches remotely", () => {
    const command = buildRemoteTmuxCommand("work", 100, 30);
    expect(command).toBe(
      [
        "tmux -L ghostty-tab new-session -d -s work -x 100 -y 30 2>/dev/null || true; ",
        "tmux -L ghostty-tab set-option -t =work: destroy-unattached off && ",
        "tmux -L ghostty-tab set-option -t =work: detach-on-destroy on && ",
        "tmux -L ghostty-tab set-option -t =work: mouse on && ",
        "tmux -L ghostty-tab set-option -t =work: set-titles on && ",
        `tmux -L ghostty-tab set-option -t =work: set-titles-string '${REMOTE_TMUX_TITLE_FORMAT}' && `,
        "tmux -L ghostty-tab bind-key -T copy-mode WheelUpPane 'select-pane; send-keys -X -N 1 scroll-up' && ",
        "tmux -L ghostty-tab bind-key -T copy-mode WheelDownPane 'select-pane; send-keys -X -N 1 scroll-down' && ",
        "tmux -L ghostty-tab bind-key -T copy-mode-vi WheelUpPane 'select-pane; send-keys -X -N 1 scroll-up' && ",
        "tmux -L ghostty-tab bind-key -T copy-mode-vi WheelDownPane 'select-pane; send-keys -X -N 1 scroll-down' && ",
        "exec tmux -L ghostty-tab -u attach-session -t =work",
      ].join(""),
    );
    expect(buildSshTmuxArgs("dev@prod", "work", 100, 30)).toEqual([
      "-tt",
      "dev@prod",
      command,
    ]);
  });

  test("rejects unsafe remote tmux command values", () => {
    expect(() =>
      buildSshTmuxArgs("-oProxyCommand=bad", "work", 80, 24),
    ).toThrow("Invalid SSH target");
    expect(() => buildSshTmuxArgs("prod", "work;id", 80, 24)).toThrow(
      "Invalid tmux session name",
    );
  });

  test("removes parent tmux routing variables", () => {
    expect(
      createTmuxEnvironment({ PATH: "/bin", TMUX: "socket", TMUX_PANE: "%2" }),
    ).toEqual({
      PATH: "/bin",
    });
    expect(() => buildTmuxAttachArgs("../other")).toThrow(
      "Invalid tmux session name",
    );
  });

  test("lists valid session names from the isolated socket", async () => {
    const calls: SpawnCall[] = [];
    const run = async (
      command: string,
      args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      calls.push({ command, args, env: options.env });
      return {
        status: 0,
        stdout: "zeta\nalpha\n../unsafe\nalpha\n",
        stderr: "",
      };
    };

    expect(await listTmuxSessions({ env: { PATH: "/bin" }, run })).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(calls[0]?.args).toEqual([
      "-L",
      TMUX_SOCKET_NAME,
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
  });

  test("closes one exact session on the isolated socket", async () => {
    const calls: SpawnCall[] = [];
    const run = async (
      command: string,
      args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      calls.push({ command, args, env: options.env });
      return { status: 0, stdout: "", stderr: "" };
    };

    expect(await killTmuxSession("work", { env: { PATH: "/bin" }, run })).toBe(
      true,
    );
    expect(calls[0]?.args).toEqual([
      "-L",
      TMUX_SOCKET_NAME,
      "kill-session",
      "-t",
      "=work",
    ]);
    await expect(killTmuxSession("../unsafe", { run })).rejects.toThrow(
      "Invalid tmux session name",
    );
  });
});
