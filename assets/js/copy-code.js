// Copy-to-clipboard button for code blocks
(function () {
  const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`;
  const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;

  function wrapAndAddButton(pre) {
    if (pre.querySelector('.copy-btn')) return; // already done

    // Detect language from class
    const code = pre.querySelector('code');
    const langClass = code ? [...code.classList].find(c => c.startsWith('language-')) : null;
    const lang = langClass ? langClass.replace('language-', '') : null;

    // Wrap
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    // Language badge
    if (lang && lang !== 'text') {
      const badge = document.createElement('span');
      badge.className = 'code-lang-badge';
      badge.textContent = lang;
      wrapper.appendChild(badge);
    }

    // Copy button
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.innerHTML = COPY_ICON + '<span>Copy</span>';
    btn.addEventListener('click', async () => {
      const text = (code || pre).innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        btn.innerHTML = CHECK_ICON + '<span>Copied!</span>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = COPY_ICON + '<span>Copy</span>';
        }, 2000);
      } catch {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.innerHTML = CHECK_ICON + '<span>Copied!</span>';
        setTimeout(() => { btn.innerHTML = COPY_ICON + '<span>Copy</span>'; }, 2000);
      }
    });
    wrapper.appendChild(btn);
  }

  function init() {
    document.querySelectorAll('pre[class*="language-"], pre:has(code)').forEach(wrapAndAddButton);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

