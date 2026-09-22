export const LEGACY_SESSION_HASH_PREFIX = "#tmux-";
export const SESSION_HASH_PREFIX = "#tmux=";

export const SESSION_CLOSE_CODES = Object.freeze({
  SERVER_SHUTDOWN: 4000,
  SESSION_ENDED: 4001,
  SESSION_SETUP_FAILED: 4002,
  SESSION_DETACHED: 4003,
});

const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SSH_TARGET_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const NON_RETRYABLE_CLOSE_CODES = new Set<number>([
  SESSION_CLOSE_CODES.SESSION_ENDED,
  SESSION_CLOSE_CODES.SESSION_SETUP_FAILED,
  SESSION_CLOSE_CODES.SESSION_DETACHED,
]);

export type TmuxTarget = { kind: "local" } | { kind: "ssh"; sshTarget: string };

export interface PersistentSession {
  name: string;
  target: TmuxTarget;
}

export type ParsedSessionHash =
  | { ok: true; session: PersistentSession }
  | { ok: false; reason: "missing" | "invalid" };

export function isValidSessionName(value: unknown): value is string {
  return typeof value === "string" && SESSION_NAME_PATTERN.test(value);
}

export function normalizeSessionName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
}

export function isValidSshTarget(value: unknown): value is string {
  return typeof value === "string" && SSH_TARGET_PATTERN.test(value);
}

export function parseSessionHash(hash: string): ParsedSessionHash {
  if (hash.length === 0 || hash === "#") {
    return { ok: false, reason: "missing" };
  }

  if (hash.startsWith(LEGACY_SESSION_HASH_PREFIX)) {
    const name = hash.slice(LEGACY_SESSION_HASH_PREFIX.length);
    return isValidSessionName(name)
      ? { ok: true, session: { name, target: { kind: "local" } } }
      : { ok: false, reason: "invalid" };
  }

  if (!hash.startsWith("#")) {
    return { ok: false, reason: "invalid" };
  }

  const params = new URLSearchParams(hash.slice(1));
  if (
    params.getAll("tmux").length !== 1 ||
    params.getAll("ssh").length > 1 ||
    [...params.keys()].some((key) => key !== "tmux" && key !== "ssh")
  ) {
    return { ok: false, reason: "invalid" };
  }

  const name = params.get("tmux");
  const sshTarget = params.get("ssh");
  if (!isValidSessionName(name)) {
    return { ok: false, reason: "invalid" };
  }
  if (sshTarget !== null && !isValidSshTarget(sshTarget)) {
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    session: {
      name,
      target:
        sshTarget === null ? { kind: "local" } : { kind: "ssh", sshTarget },
    },
  };
}

export function formatSessionHash(session: PersistentSession): string {
  if (!isValidSessionName(session.name)) {
    throw new TypeError("Invalid tmux session name");
  }
  if (
    session.target.kind === "ssh" &&
    !isValidSshTarget(session.target.sshTarget)
  ) {
    throw new TypeError("Invalid SSH target");
  }

  const params = new URLSearchParams();
  if (session.target.kind === "ssh") {
    params.set("ssh", session.target.sshTarget);
  }
  params.set("tmux", session.name);
  return `#${params}`;
}

export function suggestSessionNameFromHash(hash: string): string {
  let name: string;
  if (hash.startsWith(LEGACY_SESSION_HASH_PREFIX)) {
    name = hash.slice(LEGACY_SESSION_HASH_PREFIX.length);
  } else if (hash.startsWith("#")) {
    name = new URLSearchParams(hash.slice(1)).get("tmux") ?? "";
  } else {
    return "";
  }

  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw suffix when the hash contains malformed percent encoding.
  }

  return normalizeSessionName(name);
}

export function suggestSshTargetFromHash(hash: string): string {
  if (!hash.startsWith("#") || hash.startsWith(LEGACY_SESSION_HASH_PREFIX)) {
    return "";
  }
  return new URLSearchParams(hash.slice(1)).get("ssh") ?? "";
}

export function sessionsEqual(
  left: PersistentSession,
  right: PersistentSession,
): boolean {
  return (
    left.name === right.name &&
    left.target.kind === right.target.kind &&
    (left.target.kind === "local" ||
      (right.target.kind === "ssh" &&
        left.target.sshTarget === right.target.sshTarget))
  );
}

export function shouldReconnect(code: number): boolean {
  return !NON_RETRYABLE_CLOSE_CODES.has(code);
}
