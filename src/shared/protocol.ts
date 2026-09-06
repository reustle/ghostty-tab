export interface InputMessage {
  type: "input";
  data: string;
}

export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

export type ClientMessage = InputMessage | ResizeMessage;

export const MAX_INPUT_LENGTH = 64 * 1024;
export const MAX_TERMINAL_DIMENSION = 1000;
export const MAX_WEBSOCKET_PAYLOAD = 1024 * 1024;

export function encodeInputMessage(data: string): string {
  return JSON.stringify({ type: "input", data } satisfies InputMessage);
}

/** Chunk terminal input without splitting a UTF-16 surrogate pair. */
export function* encodeInputMessages(data: string): Iterable<string> {
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + MAX_INPUT_LENGTH, data.length);
    const last = data.charCodeAt(end - 1);
    const next = data.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end--;
    }
    yield encodeInputMessage(data.slice(start, end));
    start = end;
  }
}

export function encodeResizeMessage(cols: number, rows: number): string {
  return JSON.stringify({ type: "resize", cols, rows } satisfies ResizeMessage);
}

export function parseClientMessage(value: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const message = parsed as Record<string, unknown>;
  if (
    message.type === "input" &&
    typeof message.data === "string" &&
    message.data.length <= MAX_INPUT_LENGTH &&
    Object.keys(message).every((key) => key === "type" || key === "data")
  ) {
    return { type: "input", data: message.data };
  }

  if (
    message.type === "resize" &&
    Number.isInteger(message.cols) &&
    Number.isInteger(message.rows) &&
    (message.cols as number) > 0 &&
    (message.rows as number) > 0 &&
    (message.cols as number) <= MAX_TERMINAL_DIMENSION &&
    (message.rows as number) <= MAX_TERMINAL_DIMENSION &&
    Object.keys(message).every(
      (key) => key === "type" || key === "cols" || key === "rows",
    )
  ) {
    return {
      type: "resize",
      cols: message.cols as number,
      rows: message.rows as number,
    };
  }

  return null;
}
