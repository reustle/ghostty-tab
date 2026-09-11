import { describe, expect, test } from "bun:test";

import { parseCliOptions, parsePort } from "../src/server/cli.js";

describe("CLI parsing", () => {
  test("uses production and development defaults", () => {
    expect(parseCliOptions([])).toEqual({
      dev: false,
      help: false,
      host: "127.0.0.1",
      port: 1036,
    });
    expect(parseCliOptions(["--dev"])).toEqual({
      dev: true,
      help: false,
      host: "127.0.0.1",
      port: 8000,
    });
  });

  test("accepts explicit ports and help", () => {
    expect(parseCliOptions(["-p", "4321", "--help"])).toEqual({
      dev: false,
      help: true,
      host: "127.0.0.1",
      port: 4321,
    });
  });

  test("accepts explicit bind hosts and long port flags", () => {
    expect(parseCliOptions(["--host", "0.0.0.0", "--port", "9000"])).toEqual({
      dev: false,
      help: false,
      host: "0.0.0.0",
      port: 9000,
    });
    expect(parseCliOptions(["--host=::1"]).host).toBe("::1");
  });

  test("rejects missing and empty hosts", () => {
    expect(() => parseCliOptions(["--host"])).toThrow();
    expect(() => parseCliOptions(["--host", ""])).toThrow(
      "Host must be non-empty",
    );
    expect(() => parseCliOptions(["--host", "   "])).toThrow(
      "Host must be non-empty",
    );
  });

  test("rejects bad ports and unknown options", () => {
    for (const value of ["0", "65536", "80.5", "-1", "not-a-port"]) {
      expect(() => parsePort(value)).toThrow("Port must be an integer");
    }
    expect(() => parseCliOptions(["--unknown"])).toThrow();
  });
});
