// The login form: one `token` field and `log in`. Shown when `GET /api/me` answers 401, and again whenever a
// later call does. The token goes in the POST body only; the daemon answers with the `sparring` cookie.
import { ApiError, api, onUnauthorized } from "./api.ts";
import { wireDesktop } from "./desktop.ts";

// Every page logs in through here, so every page gets the desktop app's title bar.
wireDesktop();

let showing: Promise<void> | null = null;

function build(onDone: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "login-page";
  const form = document.createElement("form");
  form.className = "login mono";
  const label = document.createElement("label");
  label.htmlFor = "login-token";
  label.className = "muted";
  label.textContent = "token or one-time code";
  const input = document.createElement("input");
  input.id = "login-token";
  input.type = "password";
  input.autocomplete = "current-password";
  input.spellcheck = false;
  input.required = true;
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "btn primary";
  button.textContent = "log in";
  const status = document.createElement("span");
  status.className = "err status";
  status.setAttribute("role", "alert");
  form.append(label, input, button, status);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = input.value.trim();
    if (!token) return;
    button.disabled = true;
    status.textContent = "";
    try {
      await api.login(token);
      input.value = "";
      onDone();
    } catch (err) {
      status.textContent = err instanceof ApiError ? err.message : "could not reach the daemon";
      input.select();
    } finally {
      button.disabled = false;
    }
  });
  const head = document.createElement("header");
  head.className = "login-bar mono";
  const name = document.createElement("span");
  name.textContent = "sparring";
  head.append(name);
  wrap.append(head, form);
  return wrap;
}

/** Shows the form over the page until a login works. */
export function showLogin(): Promise<void> {
  showing ??= new Promise<void>((resolve) => {
    const page = document.querySelector<HTMLElement>(".sp");
    const box = build(() => {
      box.remove();
      if (page) page.hidden = false;
      showing = null;
      resolve();
    });
    if (page) page.hidden = true;
    document.body.prepend(box);
    box.querySelector("input")?.focus();
  });
  return showing;
}

/**
 * A token handed over in the fragment, `#token=…`, as the desktop app does on the Mac mini. The fragment never
 * reaches the server; it is dropped from the address before anything else runs.
 */
export function handedToken(): string | undefined {
  const m = /^#token=([^&]+)$/.exec(location.hash);
  if (!m?.[1]) return undefined;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

/**
 * Resolves once the daemon knows this browser: at once when the cookie is good, after the form when it is
 * not. A daemon that cannot be reached is not a login problem, so that resolves too; the page says it is down.
 * `again` runs after every later login, for whatever was refused while logged out.
 */
export async function ensureLogin(again?: () => void): Promise<void> {
  onUnauthorized(() => {
    void showLogin().then(() => again?.());
  });
  const handed = handedToken();
  let refused = "";
  if (handed) {
    try {
      await api.login(handed);
    } catch (e) {
      refused = `the desktop app's saved token was refused (${e instanceof ApiError ? e.message : "no answer"}) · paste the token or a one-time code`;
    }
  }
  try {
    await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      const form = showing ?? showLogin();
      if (refused) {
        const status = document.querySelector<HTMLElement>(".login .status");
        if (status) status.textContent = refused;
      }
      await form;
    }
  }
}
