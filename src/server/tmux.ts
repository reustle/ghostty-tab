import { execFile } from "node:child_process";

import { isValidSessionName, isValidSshTarget } from "../shared/session.js";

export const TMUX_SOCKET_NAME = "ghostty-tab";
export const LOCAL_TMUX_TITLE_FORMAT = "#{pane_current_command} - tmux";
export const REMOTE_TMUX_TITLE_FORMAT =
  "#{pane_current_command} - #{user}@#{host_short}";
const TMUX_EXECUTABLE = "tmux";
const TMUX_SESSION_OPTIONS = [
  ["destroy-unattached", "off"],
  ["mouse", "on"],
  ["set-titles", "on"],
  ["set-titles-string", LOCAL_TMUX_TITLE_FORMAT],
] as const;
// Key tables are shared by every session on our dedicated tmux server.
// The browser already converts wheel movement to rows, so do not multiply by 5.
const TMUX_COPY_MODE_TABLES = ["copy-mode", "copy-mode-vi"] as const;
const TMUX_WHEEL_BINDINGS = [
  ["WheelUpPane", "select-pane; send-keys -X -N 1 scroll-up"],
  ["WheelDownPane", "select-pane; send-keys -X -N 1 scroll-down"],
] as const;

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

type Run = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal },
) => Promise<CommandResult>;

interface TmuxOptions {
  env?: NodeJS.ProcessEnv;
  run?: Run;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function createTmuxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== "TMUX" && key !== "TMUX_PANE",
    ),
  );
}

export function exactTmuxTarget(sessionName: string): string {
  assertSessionName(sessionName);
  return `=${sessionName}`;
}

function withSocket(args: string[]): string[] {
  return ["-L", TMUX_SOCKET_NAME, ...args];
}

export function buildTmuxCreateArgs(
  sessionName: string,
  cols: number,
  rows: number,
  cwd: string,
): string[] {
  assertSessionName(sessionName);
  assertDimension(cols, "cols");
  assertDimension(rows, "rows");
  if (!cwd) {
    throw new TypeError("cwd must be a non-empty string");
  }
  return withSocket([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    cwd,
    "-x",
    String(cols),
    "-y",
    String(rows),
  ]);
}

export function buildTmuxAttachArgs(sessionName: string): string[] {
  return withSocket(["attach-session", "-t", exactTmuxTarget(sessionName)]);
}

export function buildRemoteTmuxCommand(
  sessionName: string,
  cols: number,
  rows: number,
): string {
  assertSessionName(sessionName);
  assertDimension(cols, "cols");
  assertDimension(rows, "rows");

  const exactTarget = exactTmuxTarget(sessionName);
  const create = `tmux -L ${TMUX_SOCKET_NAME} new-session -d -s ${sessionName} -x ${cols} -y ${rows} 2>/dev/null || true`;
  const configure = [
    `tmux -L ${TMUX_SOCKET_NAME} set-option -t ${exactTarget}: destroy-unattached off`,
    `tmux -L ${TMUX_SOCKET_NAME} set-option -t ${exactTarget}: mouse on`,
    `tmux -L ${TMUX_SOCKET_NAME} set-option -t ${exactTarget}: set-titles on`,
    `tmux -L ${TMUX_SOCKET_NAME} set-option -t ${exactTarget}: set-titles-string '${REMOTE_TMUX_TITLE_FORMAT}'`,
    ...TMUX_COPY_MODE_TABLES.flatMap((table) =>
      TMUX_WHEEL_BINDINGS.map(
        ([key, command]) =>
          `tmux -L ${TMUX_SOCKET_NAME} bind-key -T ${table} ${key} '${command}'`,
      ),
    ),
  ].join(" && ");
  const attach = `exec tmux -L ${TMUX_SOCKET_NAME} attach-session -t ${exactTarget}`;
  return `${create}; ${configure} && ${attach}`;
}

export function buildSshTmuxArgs(
  sshTarget: string,
  sessionName: string,
  cols: number,
  rows: number,
): string[] {
  if (!isValidSshTarget(sshTarget)) {
    throw new TypeError("Invalid SSH target");
  }
  return ["-tt", sshTarget, buildRemoteTmuxCommand(sessionName, cols, rows)];
}

export async function tmuxSessionExists(
  sessionName: string,
  options: TmuxOptions = {},
): Promise<boolean> {
  return commandSucceeded(
    await runTmux(
      withSocket(["has-session", "-t", exactTmuxTarget(sessionName)]),
      options,
    ),
  );
}

export async function listTmuxSessions(
  options: TmuxOptions = {},
): Promise<string[]> {
  const result = await runTmux(
    withSocket(["list-sessions", "-F", "#{session_name}"]),
    options,
  );
  if (!commandSucceeded(result)) {
    return [];
  }

  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(isValidSessionName),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export async function killTmuxSession(
  sessionName: string,
  options: TmuxOptions = {},
): Promise<boolean> {
  assertSessionName(sessionName);
  return commandSucceeded(
    await runTmux(
      withSocket(["kill-session", "-t", exactTmuxTarget(sessionName)]),
      options,
    ),
  );
}

export async function ensureTmuxSession(
  {
    sessionName,
    cols,
    rows,
    cwd,
  }: { sessionName: string; cols: number; rows: number; cwd: string },
  options: TmuxOptions = {},
): Promise<void> {
  assertSessionName(sessionName);
  if (!(await tmuxSessionExists(sessionName, options))) {
    const createResult = await runTmux(
      buildTmuxCreateArgs(sessionName, cols, rows, cwd),
      options,
    );
    if (
      !commandSucceeded(createResult) &&
      !(await tmuxSessionExists(sessionName, options))
    ) {
      throw commandError(
        `Could not create tmux session "${sessionName}"`,
        createResult,
      );
    }
  }

  const target = `${exactTmuxTarget(sessionName)}:`;
  for (const [option, value] of TMUX_SESSION_OPTIONS) {
    const optionResult = await runTmux(
      withSocket(["set-option", "-t", target, option, value]),
      options,
    );
    if (!commandSucceeded(optionResult)) {
      throw commandError(
        `Could not configure tmux option "${option}" for session "${sessionName}"`,
        optionResult,
      );
    }
  }
  for (const table of TMUX_COPY_MODE_TABLES) {
    for (const [key, command] of TMUX_WHEEL_BINDINGS) {
      const bindingResult = await runTmux(
        withSocket(["bind-key", "-T", table, key, command]),
        options,
      );
      if (!commandSucceeded(bindingResult)) {
        throw commandError(
          `Could not configure tmux binding "${key}" in "${table}"`,
          bindingResult,
        );
      }
    }
  }
}

function assertSessionName(sessionName: string): void {
  if (!isValidSessionName(sessionName)) {
    throw new TypeError("Invalid tmux session name");
  }
}

function assertDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new TypeError(`${label} must be an integer from 1 to 1000`);
  }
}

function runTmux(args: string[], options: TmuxOptions): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  return (options.run ?? runCommand)(TMUX_EXECUTABLE, args, {
    env: createTmuxEnvironment(options.env),
    timeout: options.timeoutMs ?? 5_000,
    signal: options.signal,
  });
}

const runCommand: Run = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...options,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        // A normal nonzero exit can mean an absent session. Launch failures,
        // cancellation and timeouts must reach the caller as operational errors.
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error);
        } else {
          resolve({
            status: typeof error?.code === "number" ? error.code : 0,
            stdout,
            stderr,
          });
        }
      },
    );
  });

function commandSucceeded(result: CommandResult): boolean {
  return result.status === 0;
}

function commandError(message: string, result: CommandResult): Error {
  const detail = result.stderr.trim();
  return new Error(detail ? `${message}: ${detail}` : message);
}
