export const getTheme = () => document.documentElement.dataset.themePreference || 'auto';
export function setTheme(value) {
  if (!['auto','light','dark'].includes(value)) return;
  document.documentElement.dataset.themePreference = value;
  try { localStorage.setItem('filemaster-theme',value); } catch {}
  window.dispatchEvent(new Event('filemaster-theme'));
}
