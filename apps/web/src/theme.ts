// The theme button: auto, light, dark, kept in localStorage as sparring-theme.
const ORDER = ["auto", "light", "dark"] as const;
type Theme = (typeof ORDER)[number];

function current(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "auto";
}

export function wireTheme(button: HTMLButtonElement): void {
  const show = () => {
    button.textContent = `theme · ${current()}`;
  };
  show();
  button.addEventListener("click", () => {
    const next = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length] as Theme;
    if (next === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === "auto") localStorage.removeItem("sparring-theme");
      else localStorage.setItem("sparring-theme", next);
    } catch {}
    show();
  });
}
