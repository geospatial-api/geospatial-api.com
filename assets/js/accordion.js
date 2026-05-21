// FAQ accordion: wrap sections following ## FAQ / ## Frequently Asked Questions
(function () {
  const CHEVRON = `<svg class="faq-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>`;

  function buildAccordion(heading) {
    const section = document.createElement('div');
    section.className = 'faq-section';

    let node = heading.nextElementSibling;
    // Collect h3 + following p/ul siblings as FAQ pairs
    while (node && !(node.tagName === 'H2')) {
      if (node.tagName === 'H3') {
        const q = node;
        const item = document.createElement('div');
        item.className = 'faq-item';

        const trigger = document.createElement('button');
        trigger.className = 'faq-trigger';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = q.innerHTML + CHEVRON;

        const body = document.createElement('div');
        body.className = 'faq-body';

        // Collect body content until next h3 or h2
        let next = q.nextElementSibling;
        while (next && next.tagName !== 'H3' && next.tagName !== 'H2') {
          const clone = next.cloneNode(true);
          body.appendChild(clone);
          next = next.nextElementSibling;
        }

        trigger.addEventListener('click', () => {
          const isOpen = trigger.getAttribute('aria-expanded') === 'true';
          trigger.setAttribute('aria-expanded', String(!isOpen));
          body.classList.toggle('is-open', !isOpen);
        });

        item.appendChild(trigger);
        item.appendChild(body);
        section.appendChild(item);
      }
      node = node.nextElementSibling;
    }
    return section;
  }

  function init() {
    document.querySelectorAll('.content-body h2').forEach(h2 => {
      const text = h2.textContent.trim().toLowerCase();
      if (text === 'faq' || text.includes('frequently asked question')) {
        const accordion = buildAccordion(h2);
        if (accordion.children.length) {
          h2.insertAdjacentElement('afterend', accordion);
          // Remove original h3+p elements that were wrapped
          accordion.querySelectorAll('.faq-body').forEach(body => {
            // original nodes will become orphaned; clean up duplicate h3s
          });
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

