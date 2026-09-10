import { afterEach, describe, expect, test } from "bun:test";

import { createTerminalFooter } from "../src/client/footer.js";
import { parseSessionHash } from "../src/shared/session.js";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.replaceChildren();
  document.title = "";
});

describe("browser tab titles", () => {
  test.each(["#tmux=work", "#tmux=work&ssh=dev%40prod"])(
    "restores a custom title when reopening bookmark %s in a new tab",
    (hash) => {
      const first = openFooter(hash);
      renameTab("  Project work  ");
      expect(document.title).toBe("Project work");
      first.dispose();
      window.sessionStorage.clear(); // A new tab has fresh session storage.

      const reopened = openFooter(hash);
      expect(document.title).toBe("Project work");
      reopened.emitTitle("shell title");
      expect(document.title).toBe("Project work");
      reopened.dispose();
    },
  );

  test("keeps titles separate for session names and SSH destinations", () => {
    const bookmarks = [
      "#tmux=work",
      "#tmux=other",
      "#tmux=work&ssh=dev%40prod",
      "#tmux=work&ssh=dev%40staging",
    ];
    for (const [index, hash] of bookmarks.entries()) {
      const footer = openFooter(hash);
      renameTab(`Project ${index}`);
      footer.dispose();
    }
    window.sessionStorage.clear();
    for (const [index, hash] of bookmarks.entries()) {
      const footer = openFooter(hash);
      expect(document.title).toBe(`Project ${index}`);
      footer.dispose();
    }
  });

  test.each(["automatic", "empty"])(
    "clears the saved title after choosing %s",
    (choice) => {
      const footer = openFooter("#tmux=work");
      renameTab("Project work");
      footer.emitTitle("shell title");
      if (choice === "automatic") {
        element<HTMLButtonElement>(".rename-tab").click();
        element<HTMLButtonElement>(".automatic-title").click();
      } else {
        renameTab("   ");
      }
      expect(document.title).toBe("shell title");
      footer.dispose();
      window.sessionStorage.clear();

      const reopened = openFooter("#tmux=work");
      expect(document.title).toBe("work");
      reopened.emitTitle("new shell title");
      expect(document.title).toBe("new shell title");
      reopened.dispose();
    },
  );

  test("keeps temporary shell titles only for the current browser tab", () => {
    const first = openFooter();
    renameTab("Scratch shell");
    first.dispose();

    const reloaded = openFooter();
    expect(document.title).toBe("Scratch shell");
    reloaded.dispose();
    window.sessionStorage.clear();

    const reopened = openFooter();
    expect(document.title).toBe("ghostty-tab");
    reopened.dispose();
  });
});

function openFooter(hash = "") {
  let emitTitle = (_title: string) => {};
  const footer = createTerminalFooter({
    cols: 80,
    rows: 24,
    focus() {},
    onTitleChange(listener) {
      emitTitle = listener;
      return { dispose() {} };
    },
    onResize() {
      return { dispose() {} };
    },
  });
  const parsed = parseSessionHash(hash);
  if (hash && !parsed.ok) throw new Error(`Invalid bookmark: ${hash}`);
  footer.setSession(parsed.ok ? parsed.session : null);
  return { ...footer, emitTitle };
}

function renameTab(title: string): void {
  element<HTMLButtonElement>(".rename-tab").click();
  element<HTMLInputElement>("#tab-title-input").value = title;
  element<HTMLFormElement>(".rename-form").requestSubmit();
}

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing footer element: ${selector}`);
  return result;
}
