// Articles, step 1: open a recent article or start a new one by slug. The real list comes from the AHP root
// session list in step 2; until then the browser remembers what it opened.
import "@fontsource/source-serif-4/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "./base.css";
import "./index.css";
import { slugProblem } from "@sparring/protocol/slug";
import { ApiError, api } from "./api.ts";
import { wireTheme } from "./theme.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
wireTheme($<HTMLButtonElement>("theme"));

const roomUrl = (slug: string) => `/room.html?slug=${encodeURIComponent(slug)}`;

let recent: string[] = [];
try {
  recent = JSON.parse(localStorage.getItem("sparring-recent") ?? "[]") as string[];
} catch {}
$("articles").replaceChildren(
  ...recent.map((slug) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = roomUrl(slug);
    a.textContent = slug;
    li.append(a);
    return li;
  }),
);

const input = $<HTMLInputElement>("new-slug");
const error = $("new-error");
$<HTMLFormElement>("new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const slug = input.value.trim();
  const problem = slugProblem(slug);
  if (problem) {
    error.textContent = problem;
    return;
  }
  try {
    await api.createArticle(slug);
    location.href = roomUrl(slug);
  } catch (err) {
    error.textContent = err instanceof ApiError ? err.message : "could not reach the daemon";
  }
});
