import type { IDisposable } from "ghostty-web";

import {
  type PersistentSession,
  formatSessionHash,
} from "../shared/session.js";

interface FooterTerminal {
  cols: number;
  rows: number;
  focus(): void;
  onTitleChange(listener: (title: string) => void): IDisposable;
  onResize(
    listener: (size: { cols: number; rows: number }) => void,
  ): IDisposable;
}

export function createTerminalFooter(terminal: FooterTerminal): {
  setSession(session: PersistentSession | null): void;
  dispose(): void;
} {
  const footer = document.createElement("footer");
  footer.className = "terminal-footer";
  footer.setAttribute("aria-label", "Terminal session controls");
  footer.innerHTML = `
    <span class="terminal-footer-brand">ghostty-tab</span>
    <span class="terminal-footer-session">Choose a session</span>
    <span class="terminal-footer-size" aria-label="Terminal dimensions"></span>
    <button type="button" class="rename-tab">[ rename tab ]</button>
  `;
  const dialog = document.createElement("dialog");
  dialog.className = "session-dialog rename-dialog";
  dialog.setAttribute("aria-labelledby", "rename-heading");
  dialog.innerHTML = `
    <header class="tui-titlebar">
      <span class="tui-brand"><span aria-hidden="true">&gt;_</span> ghostty-tab</span>
      <span> BROWSER TAB </span>
    </header>
    <form class="rename-form">
      <label class="field-label" id="rename-heading" for="tab-title-input">Rename browser tab</label>
      <div class="tui-input"><span aria-hidden="true">&gt;</span><input id="tab-title-input" name="title" autocomplete="off" spellcheck="false" maxlength="200" aria-describedby="tab-title-hint"></div>
      <p class="hint" id="tab-title-hint">Your title stays until you switch back to automatic.</p>
      <div class="rename-actions">
        <button type="button" class="automatic-title">[ use automatic title ]</button>
        <button type="button" class="cancel-rename">[ cancel ]</button>
        <button type="submit" class="primary-action">[ save ]</button>
      </div>
    </form>
    <footer class="tui-footer"><span><kbd>Enter</kbd> save <span aria-hidden="true">/</span> <kbd>Esc</kbd> cancel</span></footer>
  `;
  function element<T extends HTMLElement>(
    root: HTMLElement,
    selector: string,
  ): T {
    const result = root.querySelector<T>(selector);
    if (!result) throw new Error(`Terminal footer is missing ${selector}`);
    return result;
  }
  const label = element(footer, ".terminal-footer-session");
  const size = element(footer, ".terminal-footer-size");
  const rename = element<HTMLButtonElement>(footer, ".rename-tab");
  const input = element<HTMLInputElement>(dialog, "input");
  let latestTerminalTitle = "";
  let sessionLabel = "";
  let customTitle = "";
  let storageKey = "";
  let storageType: "localStorage" | "sessionStorage" = "sessionStorage";
  rename.disabled = true;

  function refreshTitle(): void {
    const automaticTitle = latestTerminalTitle || sessionLabel || "ghostty-tab";
    document.title = customTitle || automaticTitle;
    input.placeholder = automaticTitle;
    rename.title = customTitle
      ? `Browser tab: ${customTitle}`
      : "Rename browser tab";
  }
  function closeDialog(): void {
    dialog.close();
    terminal.focus();
  }
  function saveTitle(title: string): void {
    customTitle = title.trim();
    try {
      const storage = window[storageType];
      if (customTitle) storage.setItem(storageKey, customTitle);
      else storage.removeItem(storageKey);
    } catch {
      // Renaming still works when browser storage is unavailable.
    }
    refreshTitle();
    closeDialog();
  }
  rename.addEventListener("click", () => {
    input.value = customTitle || document.title;
    dialog.showModal();
    input.focus();
    input.select();
  });
  element<HTMLFormElement>(dialog, "form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      saveTitle(input.value);
    },
  );
  element(dialog, ".automatic-title").addEventListener("click", () =>
    saveTitle(""),
  );
  element(dialog, ".cancel-rename").addEventListener("click", closeDialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });

  function updateSize({ cols, rows }: { cols: number; rows: number }): void {
    size.textContent = `${cols}×${rows}`;
  }
  updateSize(terminal);
  const resizeSubscription = terminal.onResize(updateSize);
  const titleSubscription = terminal.onTitleChange((title) => {
    latestTerminalTitle = title.trim();
    refreshTitle();
  });
  document.body.append(footer, dialog);

  return {
    setSession(session) {
      sessionLabel = session
        ? session.target.kind === "ssh"
          ? `${session.name}@${session.target.sshTarget}`
          : session.name
        : "";
      label.textContent = session
        ? session.target.kind === "ssh"
          ? `tmux: ${session.name} · ssh: ${session.target.sshTarget}`
          : `tmux: ${session.name} · local`
        : "temporary shell · local";
      label.title = label.textContent;
      storageKey = `ghostty-tab:title:${session ? formatSessionHash(session) : "temporary"}`;
      storageType = session ? "localStorage" : "sessionStorage";
      element(dialog, "#tab-title-hint").textContent = session
        ? "Your title is saved for this session in this browser until you switch back to automatic."
        : "Your title stays until you switch back to automatic.";
      try {
        customTitle = window[storageType].getItem(storageKey) ?? "";
      } catch {
        customTitle = "";
      }
      rename.disabled = false;
      refreshTitle();
    },
    dispose() {
      resizeSubscription.dispose();
      titleSubscription.dispose();
      dialog.remove();
      footer.remove();
    },
  };
}
