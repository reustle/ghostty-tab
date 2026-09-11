import assert from "node:assert";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_BIND_HOSTS = Object.freeze(["0.0.0.0", "::", "*"]);

export interface AuthConfig {
  readonly token: string;
  readonly bindHost: string;
  readonly allowedHosts: readonly string[];
}

export interface RequestHeaders {
  host?: string;
  origin?: string;
}

export type AuthDecision =
  | { ok: true }
  | { ok: false; status: number; reason: string; host?: ParsedHost | null };

export interface ParsedHost {
  hostname: string;
  port: string;
}

function decision(status: number, reason: string): AuthDecision {
  return { ok: false, status, reason };
}

function parseAllowedHosts(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean)
    : [];
}

function normalizeHostname(hostname: unknown): string | null {
  if (typeof hostname !== "string") {
    return null;
  }

  let value = hostname.trim().toLowerCase();
  if (value.length === 0 || /\s/.test(value)) {
    return null;
  }
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]")) {
      return null;
    }
    value = value.slice(1, -1);
  }
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("@")
  ) {
    return null;
  }
  if (isIP(value) !== 0) {
    return value;
  }
  if (value.includes(":") || !/^[a-z0-9.-]+$/.test(value)) {
    return null;
  }

  const labels = value.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  return value;
}

function addAllowedHost(allowedHosts: Set<string>, host: string): void {
  const normalized = normalizeHostname(host);
  assert(normalized, `Allowed host must be a hostname or IP address: ${host}`);
  allowedHosts.add(normalized);
}

function parseHeaderPort(port: string | undefined): string | null {
  if (port === undefined || port === "") {
    return "";
  }
  if (!/^[0-9]+$/.test(port)) {
    return null;
  }
  const value = Number.parseInt(port, 10);
  return value >= 1 && value <= 65_535 ? String(value) : null;
}

export function parseHostHeader(hostHeader: unknown): ParsedHost | null {
  if (
    typeof hostHeader !== "string" ||
    hostHeader.length === 0 ||
    hostHeader.trim() !== hostHeader
  ) {
    return null;
  }

  let hostname: string;
  let port = "";
  if (hostHeader.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(hostHeader);
    if (!match) {
      return null;
    }
    hostname = match[1];
    const parsedPort = parseHeaderPort(match[2]);
    if (parsedPort === null) {
      return null;
    }
    port = parsedPort;
  } else {
    const colonCount = (hostHeader.match(/:/g) ?? []).length;
    if (colonCount === 0) {
      hostname = hostHeader;
    } else if (colonCount === 1) {
      const parts = hostHeader.split(":");
      hostname = parts[0];
      const parsedPort = parseHeaderPort(parts[1]);
      if (parsedPort === null) {
        return null;
      }
      port = parsedPort;
    } else {
      hostname = hostHeader;
    }
  }

  const normalizedHostname = normalizeHostname(hostname);
  return normalizedHostname ? { hostname: normalizedHostname, port } : null;
}

function parseOriginHeader(
  originHeader: unknown,
): (ParsedHost & { protocol: string }) | null {
  if (
    typeof originHeader !== "string" ||
    originHeader.length === 0 ||
    originHeader.trim() !== originHeader
  ) {
    return null;
  }

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return null;
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    return null;
  }

  const host = parseHostHeader(origin.host);
  return host ? { protocol: origin.protocol, ...host } : null;
}

function originMatchesHost(
  origin: ParsedHost & { protocol: string },
  host: ParsedHost,
): boolean {
  const fallbackPort = origin.protocol === "https:" ? "443" : "80";
  return (
    origin.hostname === host.hostname &&
    (origin.port || fallbackPort) === (host.port || fallbackPort)
  );
}

function validateAllowedHost(
  config: AuthConfig,
  hostHeader: unknown,
): AuthDecision & { host?: ParsedHost | null } {
  const host = parseHostHeader(hostHeader);
  if (!host) {
    return { ok: false, status: 400, reason: "Bad Request", host: null };
  }
  if (!config.allowedHosts.includes(host.hostname)) {
    return { ok: false, status: 403, reason: "Forbidden", host };
  }
  return { ok: true, host };
}

function validateOrigin(
  originHeader: unknown,
  host: ParsedHost,
  required: boolean,
): AuthDecision {
  if (originHeader === undefined && !required) {
    return { ok: true };
  }
  if (originHeader === undefined) {
    return decision(403, "Forbidden");
  }
  const origin = parseOriginHeader(originHeader);
  if (!origin) {
    return decision(400, "Bad Request");
  }
  return originMatchesHost(origin, host)
    ? { ok: true }
    : decision(403, "Forbidden");
}

function tokenEquals(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length === 0) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isWildcardBindHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  return (
    WILDCARD_BIND_HOSTS.includes(host) ||
    (normalized !== null && WILDCARD_BIND_HOSTS.includes(normalized))
  );
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized !== null && LOOPBACK_HOSTS.includes(normalized);
}

export function createAuthConfig(
  options: {
    env?: NodeJS.ProcessEnv;
    bindHost?: string;
    token?: string;
    allowedHosts?: string[];
  } = {},
): AuthConfig {
  const env = options.env ?? process.env;
  const bindHost = options.bindHost ?? "127.0.0.1";
  const token = options.token ?? generateSessionToken();
  assert(bindHost.length > 0, "Bind host must be non-empty");
  assert(token.length > 0, "Auth token must be non-empty");

  const allowedHosts = new Set(LOOPBACK_HOSTS);
  for (const host of options.allowedHosts ??
    parseAllowedHosts(env.GHOSTTY_ALLOWED_HOSTS)) {
    addAllowedHost(allowedHosts, host);
  }
  if (!isWildcardBindHost(bindHost)) {
    addAllowedHost(allowedHosts, bindHost);
  }

  return Object.freeze({
    token,
    bindHost,
    allowedHosts: Object.freeze([...allowedHosts]),
  });
}

export function validateTokenRequest(
  config: AuthConfig,
  request: RequestHeaders,
): AuthDecision {
  const hostDecision = validateAllowedHost(config, request.host);
  if (!hostDecision.ok) {
    return hostDecision;
  }
  return validateOrigin(request.origin, hostDecision.host as ParsedHost, false);
}

export function validateWebSocketRequest(
  config: AuthConfig,
  request: RequestHeaders & { token?: string | null },
): AuthDecision {
  const hostDecision = validateAllowedHost(config, request.host);
  if (!hostDecision.ok) {
    return hostDecision;
  }
  const originDecision = validateOrigin(
    request.origin,
    hostDecision.host as ParsedHost,
    true,
  );
  if (!originDecision.ok) {
    return originDecision;
  }
  return tokenEquals(config.token, request.token)
    ? { ok: true }
    : decision(401, "Unauthorized");
}
