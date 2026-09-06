import { describe, expect, test } from "bun:test";

import {
  MAX_INPUT_LENGTH,
  MAX_WEBSOCKET_PAYLOAD,
  encodeInputMessage,
  encodeInputMessages,
  encodeResizeMessage,
  parseClientMessage,
} from "../src/shared/protocol.js";

describe("client protocol", () => {
  test("round-trips the two allowed message types", () => {
    expect(parseClientMessage(encodeInputMessage("ls\r"))).toEqual({
      type: "input",
      data: "ls\r",
    });
    expect(parseClientMessage(encodeResizeMessage(132, 44))).toEqual({
      type: "resize",
      cols: 132,
      rows: 44,
    });
  });

  test("chunks large pastes within protocol limits while preserving Unicode and escape sequences", () => {
    const values = [
      "x".repeat(MAX_INPUT_LENGTH),
      "x".repeat(MAX_INPUT_LENGTH + 1),
      "x".repeat(MAX_INPUT_LENGTH - 1) + "😀日本語".repeat(MAX_INPUT_LENGTH),
      `\x1b[200~${"\u0000".repeat(MAX_INPUT_LENGTH * 2)}\x1b[201~`,
    ];
    for (const value of values) {
      const chunks: string[] = [];
      for (const encoded of encodeInputMessages(value)) {
        expect(Buffer.byteLength(encoded)).toBeLessThan(MAX_WEBSOCKET_PAYLOAD);
        const message = parseClientMessage(encoded);
        if (message?.type !== "input") throw new Error("Invalid input chunk");
        // The PTY independently encodes each write as UTF-8.
        chunks.push(Buffer.from(message.data).toString("utf8"));
      }
      expect(chunks.join("")).toBe(value);
    }
  });

  test("rejects commands, extra keys, bad dimensions, and oversized input", () => {
    const invalidMessages = [
      "{",
      JSON.stringify({ type: "command", command: "rm -rf /" }),
      JSON.stringify({ type: "input", data: "x", command: "whoami" }),
      JSON.stringify({ type: "input", data: "x".repeat(MAX_INPUT_LENGTH + 1) }),
      JSON.stringify({ type: "resize", cols: 0, rows: 24 }),
      JSON.stringify({ type: "resize", cols: 80.5, rows: 24 }),
      JSON.stringify({ type: "resize", cols: 80, rows: 1001 }),
    ];

    for (const message of invalidMessages) {
      expect(parseClientMessage(message)).toBeNull();
    }
  });
});
