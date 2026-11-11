// Applies the saved theme and accent before first paint. A plain script because the CSP allows no inline one.
(function () {
  try {
    var t = localStorage.getItem("sparring-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    var a = localStorage.getItem("sparring-accent");
    if (a && a !== "#35697c") document.documentElement.style.setProperty("--accent", a);
  } catch (e) {}
})();
