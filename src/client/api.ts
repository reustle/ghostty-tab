import { isValidSessionName } from "../shared/session.js";

export async function fetchAuthToken(): Promise<string> {
  const response = await fetch("/api/token", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("Token response did not include a token");
  }
  return body.token;
}

export async function fetchExistingSessions(): Promise<string[]> {
  const response = await fetch("/api/sessions", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Session list request failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as { sessions?: unknown };
  if (!Array.isArray(body.sessions)) {
    throw new Error("Session list response did not include sessions");
  }
  return body.sessions.filter(isValidSessionName);
}

export async function closeExistingSession(sessionName: string): Promise<void> {
  const token = await fetchAuthToken();
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionName)}`,
    {
      method: "DELETE",
      headers: { "X-Ghostty-Token": token },
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not close session: HTTP ${response.status}`);
  }
}
