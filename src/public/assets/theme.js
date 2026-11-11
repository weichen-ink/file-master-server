(() => {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    let preference = root.dataset.themePreference;
    if (!preference) { try { preference = localStorage.getItem('filemaster-theme'); } catch {} }
    if (!['light','dark','auto'].includes(preference)) preference = 'auto';
    root.dataset.themePreference = preference;
    root.dataset.theme = preference === 'auto' ? (media.matches ? 'dark' : 'light') : preference;
  };
  media.addEventListener('change', apply);
  window.addEventListener('filemaster-theme', apply);
  window.addEventListener('storage', event => {
    if (event.key === 'filemaster-theme') { delete root.dataset.themePreference; apply(); }
  });
  apply();
})();
