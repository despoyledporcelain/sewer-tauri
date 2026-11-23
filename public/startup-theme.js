(() => {
  const key = 'sewer.startup-theme';
  const style = document.documentElement.style;
  const fields = {
    background: 'background-color',
    image: 'background-image',
    radius: 'border-radius',
    ink: 'color',
    accent: 'color',
  };

  function apply(theme) {
    for (const [field, property] of Object.entries(fields)) {
      const value = theme?.[field];
      if (typeof value === 'string' && CSS.supports(property, value)) {
        style.setProperty(`--startup-${field}`, value);
      }
    }
  }

  let cached;
  try {
    cached = localStorage.getItem(key);
    apply(JSON.parse(cached));
  } catch {}

  window.seWerStartupTheme = theme => {
    const next = JSON.stringify(theme);
    if (next === cached) return;
    apply(theme);
    try {
      localStorage.setItem(key, next);
      cached = next;
    } catch {}
  };
})();
