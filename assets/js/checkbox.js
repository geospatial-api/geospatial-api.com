// Interactive checkboxes for markdown-it-task-lists output
// Removes disabled attribute, enables toggling, persists state in localStorage
(function () {
  const STORAGE_KEY = 'geo-api-checkboxes';

  function getState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
  }
  function setState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }

  function itemKey(cb) {
    const label = cb.closest('label') || cb.parentElement;
    const text = label ? label.textContent.trim().slice(0, 60) : '';
    return window.location.pathname + '|' + text;
  }

  function applyStrike(cb) {
    const label = cb.closest('label');
    if (!label) return;
    if (cb.checked) {
      label.style.textDecoration = 'line-through';
      label.style.color = 'var(--text-muted)';
    } else {
      label.style.textDecoration = '';
      label.style.color = '';
    }
  }

  function init() {
    const state = getState();
    document.querySelectorAll('.content-body .task-list-item input[type="checkbox"]').forEach(cb => {
      // Remove disabled so the checkbox can be toggled
      cb.removeAttribute('disabled');
      const key = itemKey(cb);
      if (state[key]) cb.checked = true;
      applyStrike(cb);
      cb.addEventListener('change', () => {
        const s = getState();
        if (cb.checked) s[key] = true;
        else delete s[key];
        setState(s);
        applyStrike(cb);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
