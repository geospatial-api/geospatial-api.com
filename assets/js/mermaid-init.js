// Mermaid initialisation with site colour theme
(function () {
  function initMermaid() {
    if (typeof mermaid === 'undefined') return;
    mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      themeVariables: {
        primaryColor:       '#c4b3e8',
        primaryTextColor:   '#2a1f3d',
        primaryBorderColor: '#b39ddc',
        lineColor:          '#6b52b0',
        secondaryColor:     '#ede8f8',
        tertiaryColor:      '#f0e9df',
        background:         '#faf8f5',
        mainBkg:            '#ede8f8',
        nodeBorder:         '#b39ddc',
        clusterBkg:         '#f5f0ff',
        titleColor:         '#4b3a7c',
        edgeLabelBackground:'#faf8f5',
        fontFamily:         'Inter, system-ui, sans-serif',
        fontSize:           '14px',
      },
    });

    // Wrap mermaid blocks for styling
    document.querySelectorAll('pre.mermaid, .mermaid').forEach(el => {
      if (!el.closest('.mermaid-wrapper')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-wrapper';
        el.parentNode.insertBefore(wrapper, el);
        wrapper.appendChild(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMermaid);
  } else {
    initMermaid();
  }
})();

