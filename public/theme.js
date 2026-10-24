// Applies the theme picked on this device before the page is drawn, so the other one never flashes.
// No choice saved: the page follows the device setting.
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
