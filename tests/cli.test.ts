import { describe, expect, test } from "bun:test";

import { parseCliOptions, parsePort } from "../src/server/cli.js";

describe("CLI parsing", () => {
  test("uses production and development defaults", () => {
    expect(parseCliOptions([], {})).toEqual({
      dev: false,
      help: false,
      port: 1036,
    });
    expect(parseCliOptions(["--dev"], {})).toEqual({
      dev: true,
      help: false,
      port: 8000,
    });
    expect(parseCliOptions([], { PORT: "9000" }).port).toBe(9000);
  });

  test("accepts explicit ports and help", () => {
    expect(parseCliOptions(["-p", "4321", "--help"], {})).toEqual({
      dev: false,
      help: true,
      port: 4321,
    });
  });

  test("rejects bad ports and unknown options", () => {
    for (const value of ["0", "65536", "80.5", "-1", "not-a-port"]) {
      expect(() => parsePort(value)).toThrow("Port must be an integer");
    }
    expect(() => parseCliOptions(["--unknown"], {})).toThrow();
  });
});
