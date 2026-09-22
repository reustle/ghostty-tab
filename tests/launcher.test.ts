import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resolveSession, showSessionLauncher } from "../src/client/launcher.js";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  window.localStorage.clear();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ sessions: [] })),
    )) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
});

describe("session launcher", () => {
  test("prefills a new launcher from saved preferences while leaving the session name blank", async () => {
    const saved = JSON.stringify({ mode: "ssh", sshTarget: "dev@prod" });
    window.localStorage.setItem("ghostty-tab:launcher", saved);
    window.history.replaceState(null, "", "/");
    const choice = resolveSession();
    expect(window.location.hash).toBe("");
    expect(element("#session-heading").textContent).toBe("Choose a session");
    expect(element<HTMLInputElement>('input[value="ssh"]').checked).toBe(true);
    expect(element<HTMLInputElement>("#session-name-input").value).toBe("");
    expect(element<HTMLInputElement>("#ssh-target-input").value).toBe(
      "dev@prod",
    );
    expect(window.localStorage.getItem("ghostty-tab:launcher")).toBe(saved);

    element<HTMLInputElement>("#session-name-input").value = "work";
    element<HTMLFormElement>("form").requestSubmit();
    expect(await choice).toEqual({
      name: "work",
      target: { kind: "ssh", sshTarget: "dev@prod" },
    });
    expect(window.location.hash).toBe("#ssh=dev%40prod&tmux=work");
  });

  test("connects to an existing local session from the visible list", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ sessions: ["kai-dev", "work"] })),
      )) as unknown as typeof fetch;

    const choice = showSessionLauncher("Open a terminal");

    await waitForSessions();
    const sessionButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".session-connect"),
    );
    expect(sessionButtons.map((button) => button.textContent)).toEqual([
      "kai-dev",
      "work",
    ]);
    sessionButtons[0]?.click();

    expect(await choice).toEqual({
      name: "kai-dev",
      target: { kind: "local" },
    });
    expect(document.querySelector(".session-dialog")).toBeNull();
  });

  test("requires confirmation before closing one existing session", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method });
      if (url === "/api/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ sessions: ["kai-dev", "work"] })),
        );
      }
      if (url === "/api/token") {
        return Promise.resolve(
          new Response(JSON.stringify({ token: "close-token" })),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    const choice = showSessionLauncher("Open a terminal");
    await waitForSessions();

    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".session-close"),
    ).find((button) => button.dataset.session === "kai-dev");
    close?.click();
    expect(requests).toHaveLength(1);

    const confirm = document.querySelector<HTMLButtonElement>(
      ".session-close-confirm",
    );
    confirm?.click();
    await waitFor(
      () =>
        requests.length === 3 &&
        document.querySelector(".session-picker-status")?.textContent ===
          "Closed kai-dev.",
    );

    expect(requests).toEqual([
      { url: "/api/sessions", method: undefined },
      { url: "/api/token", method: undefined },
      { url: "/api/sessions/kai-dev", method: "DELETE" },
    ]);
    expect(document.querySelector(".session-picker-status")?.textContent).toBe(
      "Closed kai-dev.",
    );
    openTemporaryShell();
    await choice;
  });

  test("opens a temporary shell without requiring persistent fields", async () => {
    const choice = showSessionLauncher();
    openTemporaryShell();
    expect(await choice).toBeNull();
    expect(document.querySelector("dialog")).toBeNull();
  });

  test("retries a failed list request without blocking new sessions", async () => {
    let attempts = 0;
    globalThis.fetch = (() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("Offline"))
        : Promise.resolve(
            new Response(JSON.stringify({ sessions: ["work", "work"] })),
          );
    }) as unknown as typeof fetch;
    const choice = showSessionLauncher();
    await waitForSessions();
    expect(
      document.querySelector(".session-picker-status")?.textContent,
    ).toContain("Refresh to retry");
    document.querySelector<HTMLButtonElement>(".refresh-sessions")?.click();
    await waitForSessions();
    expect(document.querySelectorAll(".session-connect")).toHaveLength(1);
    document.querySelector<HTMLButtonElement>(".session-connect")?.click();
    expect(await choice).toEqual({ name: "work", target: { kind: "local" } });
  });

  test("supports arrow navigation and Escape cancels a pending deletion", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ sessions: ["first", "second"] })),
      )) as unknown as typeof fetch;
    const choice = showSessionLauncher();
    await waitForSessions();
    const first = document.querySelector<HTMLButtonElement>(".session-connect");
    first?.focus();
    first?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect((document.activeElement as HTMLElement).dataset.session).toBe(
      "second",
    );
    document.querySelector<HTMLButtonElement>(".session-close")?.click();
    expect(document.activeElement?.className).toBe("session-close-cancel");
    const cancel = new Event("cancel", { cancelable: true });
    document.querySelector("dialog")?.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(document.querySelector(".session-close-confirm")).toBeNull();
    expect(document.activeElement?.className).toBe("session-close");
    expect(document.querySelector("dialog")?.open).toBe(true);
    openTemporaryShell();
    await choice;
  });

  test("normalizes persistent names and resolves the dialog", async () => {
    const choice = showSessionLauncher("Open a terminal");
    const input = document.querySelector<HTMLInputElement>(
      "#session-name-input",
    );
    const form = document.querySelector<HTMLFormElement>("form");
    expect(document.activeElement).toBe(input);

    if (!input || !form) throw new Error("Dialog was not rendered");
    input.value = " ../unsafe work! ";
    form.requestSubmit();
    expect(await choice).toEqual({
      name: "unsafe-work",
      target: { kind: "local" },
    });
    expect(document.querySelector(".session-dialog")).toBeNull();
  });

  test("validates and resolves a remote tmux choice", async () => {
    const choice = showSessionLauncher("Open a terminal");
    const sessionInput = document.querySelector<HTMLInputElement>(
      "#session-name-input",
    );
    const sshInput =
      document.querySelector<HTMLInputElement>("#ssh-target-input");
    const remoteRadio = document.querySelector<HTMLInputElement>(
      'input[name="sessionTarget"][value="ssh"]',
    );
    const form = document.querySelector<HTMLFormElement>("form");
    if (!sessionInput || !sshInput || !remoteRadio || !form) {
      throw new Error("Remote session controls were not rendered");
    }

    sessionInput.value = "deploy";
    remoteRadio.checked = true;
    remoteRadio.dispatchEvent(new Event("change"));
    sshInput.value = "-oProxyCommand=bad";
    form.requestSubmit();
    expect(document.querySelector(".error")?.textContent).toContain(
      "user@hostname",
    );

    sshInput.value = "  dev@prod  ";
    form.requestSubmit();
    expect(await choice).toEqual({
      name: "deploy",
      target: { kind: "ssh", sshTarget: "dev@prod" },
    });

    const reopened = showSessionLauncher();
    expect(element<HTMLInputElement>('input[value="ssh"]').checked).toBe(true);
    expect(element<HTMLInputElement>("#ssh-target-input").value).toBe(
      "dev@prod",
    );
    expect(element<HTMLInputElement>("#ssh-target-input").disabled).toBe(false);
    expect(element<HTMLInputElement>("#session-name-input").value).toBe("");
    expect(element<HTMLButtonElement>('[type="submit"]').textContent).toContain(
      "Connect over SSH",
    );
    openTemporaryShell();
    await reopened;
  });

  test.each(["local", "temporary", "ssh"])(
    "remembers the %s selection and SSH destination before submitting",
    async (mode) => {
      void showSessionLauncher();
      selectMode("ssh");
      const sshInput = element<HTMLInputElement>("#ssh-target-input");
      sshInput.value = "  dev@prod  ";
      sshInput.dispatchEvent(new Event("input"));
      selectMode(mode);
      document.body.replaceChildren(); // Leave the launcher without submitting.
      window.sessionStorage.clear(); // A new tab has fresh session storage.

      const reopened = resolveSession();
      expect(element<HTMLInputElement>(`input[value="${mode}"]`).checked).toBe(
        true,
      );
      expect(element<HTMLInputElement>("#ssh-target-input").value).toBe(
        "dev@prod",
      );
      if (mode === "temporary") {
        expect(document.activeElement).toBe(element('[type="submit"]'));
      }
      selectMode("ssh");
      expect(element<HTMLInputElement>("#ssh-target-input").value).toBe(
        "dev@prod",
      );
      openTemporaryShell();
      await reopened;
    },
  );

  test("keeps the last valid SSH destination unless the user clears it", async () => {
    void showSessionLauncher();
    selectMode("ssh");
    const sshInput = element<HTMLInputElement>("#ssh-target-input");
    for (const value of ["dev@prod", "-oProxyCommand=bad"]) {
      sshInput.value = value;
      sshInput.dispatchEvent(new Event("input"));
    }
    document.body.replaceChildren();

    void showSessionLauncher();
    const restoredInput = element<HTMLInputElement>("#ssh-target-input");
    expect(restoredInput.value).toBe("dev@prod");
    restoredInput.value = "";
    restoredInput.dispatchEvent(new Event("input"));
    document.body.replaceChildren();

    const reopened = showSessionLauncher();
    expect(element<HTMLInputElement>("#ssh-target-input").value).toBe("");
    openTemporaryShell();
    await reopened;
  });

  test.each([
    { hash: "#tmux=bad/name", mode: "local", sshTarget: "" },
    {
      hash: "#tmux=bad/name&ssh=other%40host",
      mode: "ssh",
      sshTarget: "other@host",
    },
  ])(
    "prefers explicit URL values over saved preferences: $hash",
    async ({ hash, mode, sshTarget }) => {
      window.localStorage.setItem(
        "ghostty-tab:launcher",
        JSON.stringify({ mode: "ssh", sshTarget: "dev@prod" }),
      );
      window.history.replaceState(null, "", hash);
      const choice = resolveSession();
      expect(element<HTMLInputElement>(`input[value="${mode}"]`).checked).toBe(
        true,
      );
      expect(element<HTMLInputElement>("#session-name-input").value).toBe(
        "bad-name",
      );
      expect(element<HTMLInputElement>("#ssh-target-input").value).toBe(
        sshTarget,
      );
      element<HTMLFormElement>("form").requestSubmit();
      expect(await choice).toEqual({
        name: "bad-name",
        target: mode === "ssh" ? { kind: "ssh", sshTarget } : { kind: "local" },
      });
    },
  );

  test.each([
    "not json",
    "null",
    JSON.stringify({ mode: "unknown", sshTarget: 123 }),
    JSON.stringify({ mode: "local", sshTarget: "-oProxyCommand=bad" }),
  ])("falls back safely for invalid saved preferences: %s", async (saved) => {
    window.localStorage.setItem("ghostty-tab:launcher", saved);
    const choice = showSessionLauncher();
    expect(element<HTMLInputElement>('input[value="local"]').checked).toBe(
      true,
    );
    expect(element<HTMLInputElement>("#ssh-target-input").value).toBe("");
    openTemporaryShell();
    await choice;
  });

  test("still opens sessions when browser storage cannot be read or written", async () => {
    const read = spyOn(window.localStorage, "getItem").mockImplementation(
      () => {
        throw new Error("Storage unavailable");
      },
    );
    const write = spyOn(window.localStorage, "setItem").mockImplementation(
      () => {
        throw new Error("Storage unavailable");
      },
    );
    try {
      const choice = showSessionLauncher();
      selectMode("ssh");
      element<HTMLInputElement>("#session-name-input").value = "deploy";
      element<HTMLInputElement>("#ssh-target-input").value = "dev@prod";
      element<HTMLFormElement>("form").requestSubmit();
      expect(await choice).toEqual({
        name: "deploy",
        target: { kind: "ssh", sshTarget: "dev@prod" },
      });
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing launcher element: ${selector}`);
  return result;
}

function selectMode(mode: string): void {
  const radio = element<HTMLInputElement>(`input[value="${mode}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for launcher");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForSessions(): Promise<void> {
  await waitFor(
    () =>
      document.querySelector(".session-list")?.getAttribute("aria-busy") ===
      "false",
  );
}

function openTemporaryShell(): void {
  const radio = document.querySelector<HTMLInputElement>(
    'input[value="temporary"]',
  );
  if (!radio) throw new Error("Temporary shell choice is missing");
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
  expect(
    document.querySelector<HTMLInputElement>("#session-name-input")?.disabled,
  ).toBe(true);
  expect(
    document.querySelector<HTMLInputElement>("#ssh-target-input")?.disabled,
  ).toBe(true);
  document.querySelector<HTMLFormElement>("form")?.requestSubmit();
}
