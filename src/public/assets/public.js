(() => {
  const year = String(new Date().getFullYear());
  const yearEl = document.getElementById("currentYear") || document.getElementById("current-year");
  if (yearEl) {
    yearEl.textContent = year;
    if ("dateTime" in yearEl) yearEl.dateTime = year;
  }
})();
