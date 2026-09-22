import { describe, expect, test } from "bun:test";

import {
  SESSION_CLOSE_CODES,
  formatSessionHash,
  isValidSessionName,
  isValidSshTarget,
  normalizeSessionName,
  parseSessionHash,
  sessionsEqual,
  shouldReconnect,
  suggestSessionNameFromHash,
  suggestSshTargetFromHash,
} from "../src/shared/session.js";

describe("session identifiers", () => {
  test("round-trips valid bookmark hashes", () => {
    for (const name of ["work", "project-2", "UPPER_case", "a".repeat(64)]) {
      expect(isValidSessionName(name)).toBe(true);
      const session = { name, target: { kind: "local" as const } };
      expect(parseSessionHash(formatSessionHash(session))).toEqual({
        ok: true,
        session,
      });
    }
    expect(formatSessionHash({ name: "work", target: { kind: "local" } })).toBe(
      "#tmux=work",
    );
  });

  test("formats and parses remote SSH session variables", () => {
    const session = {
      name: "deploy",
      target: { kind: "ssh" as const, sshTarget: "dev@prod.example.com" },
    };
    expect(formatSessionHash(session)).toBe(
      "#ssh=dev%40prod.example.com&tmux=deploy",
    );
    expect(parseSessionHash(formatSessionHash(session))).toEqual({
      ok: true,
      session,
    });
    expect(parseSessionHash("#tmux=deploy&ssh=dev%40prod.example.com")).toEqual(
      {
        ok: true,
        session,
      },
    );
    expect(parseSessionHash("#tmux-legacy")).toEqual({
      ok: true,
      session: { name: "legacy", target: { kind: "local" } },
    });
  });

  test("rejects ambiguous or unsafe names", () => {
    for (const name of [
      "",
      "-leading",
      "_leading",
      "spaces here",
      "slash/name",
      "a".repeat(65),
    ]) {
      expect(isValidSessionName(name)).toBe(false);
    }
    expect(parseSessionHash("")).toEqual({ ok: false, reason: "missing" });
    expect(parseSessionHash("#work")).toEqual({ ok: false, reason: "invalid" });
    expect(parseSessionHash("#tmux=work&ssh=-oProxyCommand=bad")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(parseSessionHash("#tmux=work&tmux=other")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(() =>
      formatSessionHash({ name: "../work", target: { kind: "local" } }),
    ).toThrow("Invalid tmux session name");
    expect(() =>
      formatSessionHash({
        name: "work",
        target: { kind: "ssh", sshTarget: "-oProxyCommand=bad" },
      }),
    ).toThrow("Invalid SSH target");
  });

  test("normalizes user-entered session names", () => {
    expect(normalizeSessionName("  my project!  ")).toBe("my-project");
    expect(normalizeSessionName("../unsafe/name")).toBe("unsafe-name");
    expect(normalizeSessionName("__work__")).toBe("work");
    expect(normalizeSessionName("a".repeat(80))).toBe("a".repeat(64));
    expect(normalizeSessionName(" !!! ")).toBe("");
  });

  test("validates SSH config aliases and user@host targets", () => {
    for (const target of ["prod", "prod.example.com", "dev@prod", "host_1"]) {
      expect(isValidSshTarget(target)).toBe(true);
    }
    for (const target of ["", "-option", "user@", "two words", "host;id"]) {
      expect(isValidSshTarget(target)).toBe(false);
    }
  });

  test("sanitizes a partially typed hash into a useful suggestion", () => {
    expect(suggestSessionNameFromHash("#tmux-my%20project!")).toBe(
      "my-project",
    );
    expect(suggestSessionNameFromHash("#tmux=my%20project!&ssh=prod")).toBe(
      "my-project",
    );
    expect(suggestSshTargetFromHash("#tmux=work&ssh=prod")).toBe("prod");
    expect(suggestSessionNameFromHash("#unrelated")).toBe("");
  });

  test("compares the complete session target", () => {
    const local = { name: "work", target: { kind: "local" as const } };
    const remote = {
      name: "work",
      target: { kind: "ssh" as const, sshTarget: "prod" },
    };
    expect(sessionsEqual(local, { ...local })).toBe(true);
    expect(sessionsEqual(remote, { ...remote })).toBe(true);
    expect(sessionsEqual(local, remote)).toBe(false);
  });

  test("does not reconnect when a terminal session reached a final state", () => {
    expect(shouldReconnect(1006)).toBe(true);
    expect(shouldReconnect(SESSION_CLOSE_CODES.SESSION_ENDED)).toBe(false);
    expect(shouldReconnect(SESSION_CLOSE_CODES.SESSION_SETUP_FAILED)).toBe(
      false,
    );
    expect(shouldReconnect(SESSION_CLOSE_CODES.SESSION_DETACHED)).toBe(false);
  });
});
