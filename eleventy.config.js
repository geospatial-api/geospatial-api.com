const syntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const markdownIt = require("markdown-it");
const markdownItAnchor = require("markdown-it-anchor");
const markdownItAttrs = require("markdown-it-attrs");
const markdownItTaskLists = require("markdown-it-task-lists");
const pluginSitemap = require("@quasibit/eleventy-plugin-sitemap");
const { minify } = require("html-minifier-terser");

module.exports = function (eleventyConfig) {
  // ── Plugins ──────────────────────────────────────────────────────────────
  eleventyConfig.addPlugin(syntaxHighlight);
  eleventyConfig.addPlugin(pluginSitemap, {
    sitemap: { hostname: "https://www.geospatial-api.com" },
  });

  // ── Markdown-it ──────────────────────────────────────────────────────────
  const md = markdownIt({
    html: true,
    linkify: true,
    typographer: true,
  })
    .use(markdownItAnchor, {
      // ariaHidden adds a standalone # link BESIDE the heading text
      // (not wrapping it), so opacity:0 on the anchor won't hide the heading
      permalink: markdownItAnchor.permalink.ariaHidden({
        placement: "before",
        class: "header-anchor",
        symbol: "#",
        ariaHidden: true,
        renderAttrs: () => ({ "tabindex": "-1" }),
      }),
      level: [2, 3, 4],
      // Custom slugify: produces clean, unencoded slugs so that the
      // links_check gate (which unquotes href fragments before comparing
      // against id attribute values) can match them correctly.
      slugify: (s) =>
        String(s)
          .trim()
          .toLowerCase()
          .replace(/&/g, "and")          // & → and
          .replace(/—/g, "-")        // em-dash → -
          .replace(/[‘’']/g, "") // curly/straight apostrophes → remove
          .replace(/[:()\[\]{},\.~]/g, "") // : ( ) [ ] { } , . ~ → remove
          .replace(/\s+/g, "-")           // whitespace → -
          .replace(/-{2,}/g, "-")         // collapse multiple dashes
          .replace(/^-|-$/g, ""),         // trim leading/trailing dashes
    })
    .use(markdownItAttrs)
    .use(markdownItTaskLists, { enabled: true, label: true, labelAfter: false });

  // Wrap <table> for horizontal scroll
  const defaultTableOpen = md.renderer.rules.table_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
    return '<div class="table-scroll">' + defaultTableOpen(tokens, idx, options, env, self);
  };
  const defaultTableClose = md.renderer.rules.table_close || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => {
    return defaultTableClose(tokens, idx, options, env, self) + '</div>';
  };

  eleventyConfig.setLibrary("md", md);

  // ── Exclude non-page markdown files from build ───────────────────────────
  eleventyConfig.ignores.add("AGENTS.md");
  eleventyConfig.ignores.add("CLAUDE.md");
  eleventyConfig.ignores.add("SITE_BUILD_CHECKLIST.md");
  eleventyConfig.ignores.add("site_description_and_requirements.md");
  eleventyConfig.ignores.add("_plan/**");

  // ── Passthrough copies ────────────────────────────────────────────────────
  eleventyConfig.addPassthroughCopy("assets");
  eleventyConfig.addPassthroughCopy("manifest.json");
  eleventyConfig.addPassthroughCopy("sw.js");
  eleventyConfig.addPassthroughCopy("robots.txt");
  eleventyConfig.addPassthroughCopy("og-image.png");
  eleventyConfig.addPassthroughCopy("8b9016718168d5d7b266d08d251b60a6.txt");
  eleventyConfig.addPassthroughCopy({ "assets/img/favicon.ico": "favicon.ico" });

  // ── Filters ───────────────────────────────────────────────────────────────

  // Build breadcrumb data from page.url
  eleventyConfig.addFilter("breadcrumbs", function (url) {
    const sectionLabels = {
      "core-geospatial-api-architecture-with-fastapi-postgis": "Core Architecture",
      "advanced-spatial-endpoint-implementation-data-contracts": "Advanced Endpoints",
      "high-performance-caching-query-optimization": "Caching & Optimization",
      "securing-geospatial-apis-authentication-authorization": "Security & Auth",
      "deploying-and-operating-geospatial-apis": "Deployment & Operations",
    };
    const parts = url.replace(/^\/|\/$/g, "").split("/").filter(Boolean);
    const crumbs = [{ label: "Home", url: "/" }];
    let cumulative = "";
    for (const part of parts) {
      cumulative += "/" + part;
      const label = sectionLabels[part] || part.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      crumbs.push({ label, url: cumulative + "/" });
    }
    return crumbs;
  });

  // Absolute URL filter
  eleventyConfig.addFilter("absoluteUrl", function (url) {
    return "https://www.geospatial-api.com" + url;
  });

  // Current year
  eleventyConfig.addFilter("currentYear", function () {
    return new Date().getFullYear();
  });

  // ── Transforms ───────────────────────────────────────────────────────────
  // Add tabindex="0" to all pre elements so scrollable code blocks are keyboard-accessible (WCAG 2.1 SC 2.1.1).
  eleventyConfig.addTransform("preTabindex", (content, outputPath) => {
    if (!outputPath || !outputPath.endsWith(".html")) return content;
    // Add tabindex="0" to every <pre> that does not already have a tabindex
    return content.replace(/<pre(?![^>]*tabindex)([^>]*)>/g, '<pre tabindex="0"$1>');
  });

  // Wrap task-list label text in a <span> so inline <code> elements inside a
  // flex label don't become direct flex items (which breaks them out of text flow).
  // Before: <label><input type="checkbox"> text with <code>…</code></label>
  // After:  <label><input type="checkbox"><span> text with <code>…</code></span></label>
  eleventyConfig.addTransform("taskListLabelSpan", (content, outputPath) => {
    if (!outputPath || !outputPath.endsWith(".html")) return content;
    return content.replace(
      /(<label>)(<input[^>]+type="checkbox"[^>]*>)([\s\S]*?)(<\/label>)/g,
      (_, open, input, text, close) => `${open}${input}<span>${text}</span>${close}`
    );
  });

  // Strip the first <h1> from INSIDE content-body — the layout's page-hero
  // already renders the title, so the Markdown `# Title` heading is a duplicate.
  eleventyConfig.addTransform("stripFirstH1", (content, outputPath) => {
    if (!outputPath || !outputPath.endsWith(".html")) return content;
    if (!content.includes('class="page-hero"')) return content;
    // Target only the first <h1> that sits inside the content-body article
    return content.replace(
      /(<article class="content-body">[\s\S]*?)<h1[^>]*>[\s\S]*?<\/h1>\s*/,
      "$1"
    );
  });

  // HTML minify in production
  if (process.env.NODE_ENV === "production") {
    eleventyConfig.addTransform("htmlmin", async (content, outputPath) => {
      if (outputPath && outputPath.endsWith(".html")) {
        return await minify(content, {
          collapseWhitespace: true,
          removeComments: true,
          minifyCSS: false,
          minifyJS: false,
        });
      }
      return content;
    });
  }

  // ── Directory config ──────────────────────────────────────────────────────
  return {
    dir: {
      input: ".",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
  };
};

