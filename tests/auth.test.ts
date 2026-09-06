import { describe, expect, test } from "bun:test";

import {
  createAuthConfig,
  isLoopbackHost,
  isWildcardBindHost,
  parseHostHeader,
  validateTokenRequest,
  validateWebSocketRequest,
} from "../src/server/auth.js";

describe("same-origin authentication", () => {
  const config = createAuthConfig({
    bindHost: "127.0.0.1",
    token: "known-token",
    allowedHosts: ["terminal.example.test"],
    env: {},
  });

  test("parses strict host headers", () => {
    expect(parseHostHeader("localhost:8080")).toEqual({
      hostname: "localhost",
      port: "8080",
    });
    expect(parseHostHeader("[::1]:8080")).toEqual({
      hostname: "::1",
      port: "8080",
    });
    expect(parseHostHeader("bad host:8080")).toBeNull();
    expect(parseHostHeader("example.test:99999")).toBeNull();
    expect(parseHostHeader("user@example.test")).toBeNull();
  });

  test("allows token delivery only to configured hosts and matching origins", () => {
    expect(validateTokenRequest(config, { host: "127.0.0.1:8080" })).toEqual({
      ok: true,
    });
    expect(
      validateTokenRequest(config, {
        host: "terminal.example.test:8080",
        origin: "http://terminal.example.test:8080",
      }),
    ).toEqual({ ok: true });
    expect(
      validateTokenRequest(config, { host: "evil.example:8080" }),
    ).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      validateTokenRequest(config, {
        host: "127.0.0.1:8080",
        origin: "http://evil.example:8080",
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  test("requires a matching origin and timing-safe token for WebSockets", () => {
    expect(
      validateWebSocketRequest(config, {
        host: "127.0.0.1:8080",
        origin: "http://127.0.0.1:8080",
        token: "known-token",
      }),
    ).toEqual({ ok: true });
    expect(
      validateWebSocketRequest(config, {
        host: "127.0.0.1:8080",
        token: "known-token",
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      validateWebSocketRequest(config, {
        host: "127.0.0.1:8080",
        origin: "http://127.0.0.1:8080",
        token: "wrong-token",
      }),
    ).toMatchObject({ ok: false, status: 401 });
  });

  test("classifies bind hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isWildcardBindHost("0.0.0.0")).toBe(true);
    expect(isWildcardBindHost("127.0.0.1")).toBe(false);
  });
});
