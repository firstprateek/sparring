// The login form: one `token` field and `log in`. Shown when `GET /api/me` answers 401, and again whenever a
// later call does. The token goes in the POST body only; the daemon answers with the `sparring` cookie.
import { ApiError, api, onUnauthorized } from "./api.ts";

let showing: Promise<void> | null = null;

function build(onDone: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "login-page";
  const form = document.createElement("form");
  form.className = "login mono";
  const label = document.createElement("label");
  label.htmlFor = "login-token";
  label.className = "muted";
  label.textContent = "token";
  const input = document.createElement("input");
  input.id = "login-token";
  input.type = "password";
  input.autocomplete = "current-password";
  input.spellcheck = false;
  input.required = true;
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "t text";
  button.textContent = "log in";
  const status = document.createElement("span");
  status.className = "muted status";
  status.setAttribute("role", "status");
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
 * Resolves once the daemon knows this browser: at once when the cookie is good, after the form when it is
 * not. A daemon that cannot be reached is not a login problem, so that resolves too; the page says it is down.
 * `again` runs after every later login, for whatever was refused while logged out.
 */
export async function ensureLogin(again?: () => void): Promise<void> {
  onUnauthorized(() => {
    void showLogin().then(() => again?.());
  });
  try {
    await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) await (showing ?? showLogin());
  }
}
