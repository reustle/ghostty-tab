import {
  type PersistentSession,
  formatSessionHash,
  isValidSessionName,
  isValidSshTarget,
  normalizeSessionName,
  parseSessionHash,
  suggestSessionNameFromHash,
  suggestSshTargetFromHash,
} from "../shared/session.js";
import { closeExistingSession, fetchExistingSessions } from "./api.js";

const LAUNCHER_PREFERENCES_KEY = "ghostty-tab:launcher";

interface LauncherPreferences {
  mode: "temporary" | "local" | "ssh";
  sshTarget: string;
}

function readLauncherPreferences(): LauncherPreferences {
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(LAUNCHER_PREFERENCES_KEY) ?? "null",
    );
    if (saved && typeof saved === "object") {
      const { mode, sshTarget } = saved as Record<string, unknown>;
      return {
        mode: mode === "temporary" || mode === "ssh" ? mode : "local",
        sshTarget: isValidSshTarget(sshTarget) ? sshTarget : "",
      };
    }
  } catch {
    // Missing or unavailable browser storage leaves the default choices intact.
  }
  return { mode: "local", sshTarget: "" };
}

export async function resolveSession(): Promise<PersistentSession | null> {
  const parsed = parseSessionHash(window.location.hash);
  if (parsed.ok) return parsed.session;
  const session = await showSessionLauncher(
    parsed.reason === "missing"
      ? "Choose a session"
      : "The URL has an invalid session",
    suggestSessionNameFromHash(window.location.hash),
    parsed.reason === "missing"
      ? undefined
      : suggestSshTargetFromHash(window.location.hash),
  );
  if (session)
    window.history.replaceState(null, "", formatSessionHash(session));
  return session;
}

export function showSessionLauncher(
  heading = "Choose a session",
  initialName = "",
  initialSshTarget?: string,
): Promise<PersistentSession | null> {
  return new Promise((resolve) => {
    const preferences = readLauncherPreferences();
    const mode =
      initialSshTarget === undefined
        ? preferences.mode
        : initialSshTarget
          ? "ssh"
          : "local";
    const dialog = document.createElement("dialog");
    dialog.className = "session-dialog";
    dialog.setAttribute("aria-labelledby", "session-heading");
    // Only static markup here; session names and other dynamic values use textContent.
    dialog.innerHTML = `
      <header class="tui-titlebar">
        <span class="tui-brand"><span aria-hidden="true">&gt;_</span> ghostty-tab</span>
        <span>SESSION LAUNCHER</span>
      </header>
      <div class="launcher-intro">
        <h1 id="session-heading"></h1>
        <p>Start a new shell or pick up where you left off.</p>
      </div>
      <div class="launcher-panels">
        <form class="session-create" aria-labelledby="new-session-heading">
          <h2 class="panel-heading" id="new-session-heading"><span aria-hidden="true">01</span> Start a session</h2>
          <fieldset class="session-modes">
            <legend class="sr-only">Session type</legend>
            <label class="mode-choice">
              <input type="radio" name="sessionTarget" value="temporary">
              <span class="radio-glyph" aria-hidden="true"></span>
              <span><strong>Temporary shell</strong><small>On this machine. Ends when the tab closes.</small></span>
            </label>
            <label class="mode-choice">
              <input type="radio" name="sessionTarget" value="local">
              <span class="radio-glyph" aria-hidden="true"></span>
              <span><strong>Local tmux</strong><small>On this machine. Keeps running without the tab.</small></span>
            </label>
            <label class="mode-choice">
              <input type="radio" name="sessionTarget" value="ssh">
              <span class="radio-glyph" aria-hidden="true"></span>
              <span><strong>Remote tmux</strong><small>On another machine, connected over SSH.</small></span>
            </label>
          </fieldset>
          <div class="session-fields">
            <div class="persistent-fields">
              <label class="field-label" for="session-name-input">Session name</label>
              <div class="tui-input"><span aria-hidden="true">&gt;</span><input id="session-name-input" name="sessionName" autocomplete="off" spellcheck="false" placeholder="my-project" aria-describedby="session-name-hint" required></div>
              <p class="hint" id="session-name-hint">Give it a name so you can come back to it.</p>
            </div>
            <div class="ssh-target-fields" hidden>
              <label class="field-label" for="ssh-target-input">SSH destination</label>
              <div class="tui-input"><span aria-hidden="true">@</span><input id="ssh-target-input" name="sshTarget" autocomplete="off" spellcheck="false" placeholder="alice@server" aria-describedby="ssh-target-hint"></div>
              <p class="hint" id="ssh-target-hint">Use user@hostname or an alias from your SSH config.</p>
            </div>
            <p class="temporary-note" hidden>No name needed. Your shell and its programs end when you close this tab.</p>
          </div>
          <p class="error" role="alert"></p>
          <div class="actions"><button class="primary-action" type="submit">[ Open local session ]</button></div>
          <p class="session-outcome hint">Keeps running. Bookmark the URL to return.</p>
        </form>
        <section class="existing-sessions" aria-labelledby="existing-sessions-heading">
          <h2 class="panel-heading" id="existing-sessions-heading"><span aria-hidden="true">02</span> Resume a session</h2>
          <p class="panel-description">Running tmux sessions on this machine.</p>
          <div class="session-list-heading"><span>SESSION <span class="session-count">[..]</span></span><button class="refresh-sessions" type="button" aria-label="Refresh running sessions">[ refresh ]</button></div>
          <div class="session-list" aria-label="Running local sessions" aria-busy="true"></div>
          <p class="session-picker-status hint" role="status" aria-live="polite">Loading sessions...</p>
          <p class="resume-note hint">Select a name to attach.<br>Bookmark local or remote tmux sessions to reopen them later.</p>
        </section>
      </div>
      <footer class="tui-footer"><span><kbd>Tab</kbd> move <span aria-hidden="true">/</span> <kbd>↑ ↓</kbd> choose <span aria-hidden="true">/</span> <kbd>Enter</kbd> open</span><span class="footer-ready"><span aria-hidden="true">■</span> ready</span></footer>
    `;
    function element<T extends HTMLElement>(selector: string): T {
      const result = dialog.querySelector<T>(selector);
      if (!result) throw new Error(`Launcher is missing ${selector}`);
      return result;
    }
    const form = element<HTMLFormElement>("form");
    const input = element<HTMLInputElement>("#session-name-input");
    const sshInput = element<HTMLInputElement>("#ssh-target-input");
    const local = element<HTMLInputElement>('input[value="local"]');
    const remote = element<HTMLInputElement>('input[value="ssh"]');
    const temporary = element<HTMLInputElement>('input[value="temporary"]');
    const error = element(".error");
    const submit = element<HTMLButtonElement>('[type="submit"]');
    const list = element(".session-list");
    const status = element(".session-picker-status");
    const refresh = element<HTMLButtonElement>(".refresh-sessions");
    element("#session-heading").textContent = heading;
    input.value = initialName;
    sshInput.value = initialSshTarget ?? preferences.sshTarget;
    local.checked = mode === "local";
    remote.checked = mode === "ssh";
    temporary.checked = mode === "temporary";

    let sessions: string[] = [];
    let confirming: string | null = null;
    let closing: string | null = null;
    let finished = false;
    function finish(session: PersistentSession | null) {
      if (finished) return;
      finished = true;
      dialog.close();
      dialog.remove();
      resolve(session);
    }
    function savePreferences() {
      preferences.mode = temporary.checked
        ? "temporary"
        : remote.checked
          ? "ssh"
          : "local";
      const sshTarget = sshInput.value.trim();
      if (!sshTarget || isValidSshTarget(sshTarget))
        preferences.sshTarget = sshTarget;
      try {
        window.localStorage.setItem(
          LAUNCHER_PREFERENCES_KEY,
          JSON.stringify(preferences),
        );
      } catch {
        // Choosing a session still works when browser storage is unavailable.
      }
    }
    function updateMode() {
      element(".persistent-fields").hidden = temporary.checked;
      input.disabled = temporary.checked;
      input.required = !temporary.checked;
      element(".ssh-target-fields").hidden = !remote.checked;
      sshInput.disabled = !remote.checked;
      sshInput.required = remote.checked;
      element(".temporary-note").hidden = !temporary.checked;
      submit.textContent = temporary.checked
        ? "[ Open temporary shell ]"
        : remote.checked
          ? "[ Connect over SSH ]"
          : "[ Open local session ]";
      element(".session-outcome").textContent = temporary.checked
        ? "Temporary. Nothing to bookmark."
        : "Keeps running. Bookmark the URL to return.";
      error.textContent = "";
    }
    for (const radio of [temporary, local, remote])
      radio.addEventListener("change", () => {
        updateMode();
        savePreferences();
      });
    sshInput.addEventListener("input", savePreferences);
    updateMode();

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (temporary.checked) {
        savePreferences();
        finish(null);
        return;
      }
      const name = normalizeSessionName(input.value);
      input.value = name;
      if (!isValidSessionName(name)) {
        error.textContent = "Enter a session name.";
        input.focus();
        return;
      }
      const sshTarget = sshInput.value.trim();
      if (remote.checked && !isValidSshTarget(sshTarget)) {
        error.textContent =
          "Use user@hostname or an SSH alias, without spaces.";
        sshInput.focus();
        return;
      }
      savePreferences();
      finish({
        name,
        target: remote.checked ? { kind: "ssh", sshTarget } : { kind: "local" },
      });
    });

    function focusAction(selector: string, name?: string) {
      const buttons = Array.from(
        list.querySelectorAll<HTMLButtonElement>(selector),
      );
      const button = name
        ? buttons.find((button) => button.dataset.session === name)
        : buttons[0];
      (button ?? refresh).focus();
    }
    function renderSessions() {
      list.replaceChildren();
      element(".session-count").textContent =
        `[${String(sessions.length).padStart(2, "0")}]`;
      if (sessions.length === 0) {
        const empty = document.createElement("p");
        empty.className = "session-empty";
        empty.textContent =
          "No running sessions.\nOpen a local tmux session to start one.";
        list.append(empty);
      }
      for (const name of sessions) {
        const row = document.createElement("div");
        row.className = "session-row";
        if (confirming === name) {
          row.classList.add("is-confirming");
          const message = document.createElement("p");
          message.className = "session-close-confirmation";
          message.textContent = `Stop ${name}? All programs inside it will end.`;
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "session-close-cancel";
          cancel.dataset.session = name;
          cancel.textContent = "[ cancel ]";
          cancel.setAttribute(
            "aria-label",
            `Keep tmux session ${name} running`,
          );
          cancel.disabled = closing !== null;
          cancel.addEventListener("click", () => {
            confirming = null;
            renderSessions();
            focusAction(".session-close", name);
          });
          const stop = document.createElement("button");
          stop.type = "button";
          stop.className = "session-close-confirm";
          stop.textContent = closing === name ? "[ stopping ]" : "[ stop ]";
          stop.setAttribute(
            "aria-label",
            `Confirm closing tmux session ${name}`,
          );
          stop.disabled = closing !== null;
          stop.addEventListener("click", () => {
            closing = name;
            refresh.disabled = true;
            renderSessions();
            void closeExistingSession(name)
              .then(() => {
                if (finished) return;
                sessions = sessions.filter((session) => session !== name);
                status.textContent = `Closed ${name}.`;
              })
              .catch(() => {
                if (!finished)
                  status.textContent = `Could not close ${name}. Try again.`;
              })
              .finally(() => {
                if (finished) return;
                closing = null;
                confirming = null;
                refresh.disabled = false;
                renderSessions();
                focusAction(".session-connect");
              });
          });
          row.append(message, cancel, stop);
        } else {
          const connect = document.createElement("button");
          connect.type = "button";
          connect.className = "session-connect";
          connect.dataset.session = name;
          connect.textContent = name;
          connect.title = name;
          connect.setAttribute("aria-label", `Connect to tmux session ${name}`);
          connect.disabled = closing !== null;
          connect.addEventListener("click", () =>
            finish({ name, target: { kind: "local" } }),
          );
          const close = document.createElement("button");
          close.type = "button";
          close.className = "session-close";
          close.dataset.session = name;
          close.textContent = "[ × ]";
          close.setAttribute("aria-label", `Close tmux session ${name}`);
          close.disabled = closing !== null;
          close.addEventListener("click", () => {
            confirming = name;
            renderSessions();
            focusAction(".session-close-cancel", name);
          });
          row.append(connect, close);
        }
        list.append(row);
      }
    }
    async function refreshSessions() {
      refresh.disabled = true;
      list.setAttribute("aria-busy", "true");
      list.inert = true;
      status.textContent = "Loading sessions...";
      try {
        const result = await fetchExistingSessions();
        if (finished) return;
        sessions = [...new Set(result)];
        confirming = null;
        renderSessions();
        status.textContent = sessions.length
          ? "Your work keeps running when you leave."
          : "No local tmux sessions found.";
      } catch {
        if (!finished) {
          status.textContent = "Could not load sessions. Refresh to retry.";
          if (!sessions.length)
            list.textContent = "You can still start a session on the left.";
          element(".session-count").textContent = "[?]";
        }
      } finally {
        if (!finished) {
          refresh.disabled = false;
          list.setAttribute("aria-busy", "false");
          list.inert = false;
        }
      }
    }
    refresh.addEventListener("click", () => void refreshSessions());
    list.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = Array.from(
        list.querySelectorAll<HTMLButtonElement>(
          ".session-connect:not(:disabled)",
        ),
      );
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      buttons[
        (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length
      ]?.focus();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (confirming && !closing) {
        const name = confirming;
        confirming = null;
        renderSessions();
        focusAction(".session-close", name);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    if (temporary.checked) submit.focus();
    else {
      input.focus();
      input.select();
    }
    void refreshSessions();
  });
}
