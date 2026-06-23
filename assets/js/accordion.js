// FAQ accordion: wrap sections following ## FAQ / ## Frequently Asked Questions
(function () {
  // Normalise heading text: strip whitespace and anchor glyphs introduced by
  // permalink plugins (e.g. the "#" inserted by eleventy-plugin-toc / markdown-it-anchor).
  function headingText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.header-anchor, a[aria-hidden]').forEach(a => a.remove());
    return clone.textContent.trim().toLowerCase();
  }

  function isFaqHeading(text) {
    return text === 'faq' || text === 'faqs' || text.includes('frequently asked question');
  }

  function buildAccordion(heading) {
    const section = document.createElement('div');
    section.className = 'faq-section';

    let node = heading.nextElementSibling;
    // Collect h3 + following p/ul siblings as FAQ pairs
    while (node && node.tagName !== 'H2') {
      if (node.tagName === 'H3') {
        const q = node;

        const details = document.createElement('details');
        details.className = 'faq-item';

        const summary = document.createElement('summary');
        // Clone the h3, strip anchor links, then wrap all content in a span
        // so inline <code> or <em> elements don't become separate flex items.
        const qClone = q.cloneNode(true);
        qClone.querySelectorAll('.header-anchor, a[aria-hidden]').forEach(a => a.remove());
        const span = document.createElement('span');
        span.innerHTML = qClone.innerHTML;
        summary.appendChild(span);

        details.appendChild(summary);

        // Collect body content until next h3 or h2
        let next = q.nextElementSibling;
        while (next && next.tagName !== 'H3' && next.tagName !== 'H2') {
          details.appendChild(next.cloneNode(true));
          next = next.nextElementSibling;
        }

        section.appendChild(details);
      }
      node = node.nextElementSibling;
    }
    return section;
  }

  function removeOriginalFaqNodes(heading) {
    // Remove original h3+answer nodes that were wrapped into the accordion
    let node = heading.nextElementSibling;
    const toRemove = [];
    while (node && node.tagName !== 'H2') {
      toRemove.push(node);
      node = node.nextElementSibling;
    }
    toRemove.forEach(n => n.remove());
  }

  function init() {
    document.querySelectorAll('.content-body h2').forEach(h2 => {
      const text = headingText(h2);
      if (isFaqHeading(text)) {
        const accordion = buildAccordion(h2);
        if (accordion.children.length) {
          removeOriginalFaqNodes(h2);
          h2.insertAdjacentElement('afterend', accordion);
        }
      }
    });
  }

  // Mobile nav toggle
  function initNav() {
    const toggle = document.querySelector('.nav-toggle');
    const nav = document.querySelector('.site-nav');
    if (toggle && nav) {
      toggle.addEventListener('click', () => {
        nav.classList.toggle('is-open');
        const expanded = nav.classList.contains('is-open');
        toggle.setAttribute('aria-expanded', String(expanded));
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); initNav(); });
  } else {
    init();
    initNav();
  }
})();
