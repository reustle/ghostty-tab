import { parseArgs } from "node:util";

import {
  createAuthConfig,
  isLoopbackHost,
  isWildcardBindHost,
} from "./auth.js";
import { createGhosttyTabServer } from "./server.js";

export interface CliOptions {
  dev: boolean;
  help: boolean;
  port: number;
}

export function parseCliOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      dev: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      port: { type: "string", short: "p" },
    },
  });

  const defaultPort = values.dev ? "8000" : "1036";
  const port = parsePort(values.port ?? env.PORT ?? defaultPort);
  return { dev: values.dev, help: values.help, port };
}

export function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new TypeError(`Port must be an integer from 1 to 65535: ${value}`);
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65_535) {
    throw new TypeError(`Port must be an integer from 1 to 65535: ${value}`);
  }
  return port;
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseCliOptions(argv, env);
  if (options.help) {
    printHelp();
    return;
  }

  const authConfig = createAuthConfig({ env });
  const server = await createGhosttyTabServer({
    port: options.port,
    dev: options.dev,
    authConfig,
    env,
  });
  printBanner(server.url, authConfig.bindHost, options.dev);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nShutting down ghostty-tab...");
    await server.shutdown();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

function printHelp(): void {
  console.log(`ghostty-tab

Usage:
  ghostty-tab [--port <1-65535>]

Options:
  -p, --port <port>  HTTP port (default: 1036)
  -h, --help         Show this help

Environment:
  PORT                    Alternative HTTP port
  HOST                    Bind host (default: 127.0.0.1)
  GHOSTTY_ALLOWED_HOSTS   Comma-separated browser-visible hostnames
`);
}

function printBanner(url: string, host: string, dev: boolean): void {
  console.log(`
ghostty-tab${dev ? " (development)" : ""}
Open: ${url}
Sessions: single shell or local/SSH tmux on the isolated "ghostty-tab" socket
Security: per-run same-origin token; shell access is bound to ${host}
`);
  if (isWildcardBindHost(host) || !isLoopbackHost(host)) {
    console.warn(
      "Warning: non-loopback access can expose your shell. Configure exact GHOSTTY_ALLOWED_HOSTS values.",
    );
  }
}
