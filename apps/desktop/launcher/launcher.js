// The launcher: find the daemon, then hand the window to it. The address is kept in localStorage. On the Mac
// mini the Rust side offers the local daemon and its token, which rides in the URL fragment so the login form
// never shows; the web client logs in with it and drops it from the address at once.
const KEY = "sparring-daemon";
const DEFAULT = "http://127.0.0.1:7421";

const form = document.getElementById("connect");
const input = document.getElementById("addr");
const statusLine = document.getElementById("status");
const waiting = document.getElementById("waiting");

function saved() {
  try {
    return localStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}

function save(origin) {
  try {
    localStorage.setItem(KEY, origin);
  } catch {
    // Not remembering the address only means asking again next time.
  }
}

async function command(name) {
  try {
    return (await window.__TAURI__?.core.invoke(name)) ?? undefined;
  } catch {
    return undefined;
  }
}

function origin(raw) {
  const text = raw.trim();
  return new URL(text.includes("://") ? text : `http://${text}`).origin;
}

/** True when something answers at the address. The answer itself is opaque; reaching it is enough. */
async function reachable(base) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 4000);
  try {
    await fetch(`${base}/api/me`, { mode: "no-cors", cache: "no-store", signal: stop.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function ask(message) {
  waiting.hidden = true;
  form.hidden = false;
  statusLine.textContent = message ?? "";
  input.focus();
  input.select();
}

async function connect(raw, local) {
  let base;
  try {
    base = origin(raw);
  } catch {
    ask("that is not an address");
    return;
  }
  statusLine.textContent = "connecting…";
  if (!(await reachable(base))) {
    ask(`can't reach ${base}. Is the daemon running?`);
    return;
  }
  save(base);
  const handoff = local && local.url === base ? `#token=${encodeURIComponent(local.token)}` : "";
  location.replace(`${base}/${handoff}`);
}

async function start() {
  const local = await command("local_daemon");
  const address = saved() ?? local?.url ?? (await command("default_daemon")) ?? DEFAULT;
  input.value = address;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void connect(input.value, local);
  });
  if (new URLSearchParams(location.search).has("change")) ask();
  else await connect(address, local);
}

void start();
