module.exports = {
  eleventyComputed: {
    // Strip /content prefix from all output paths so
    // content/core-.../index.md => /core-.../index.html => URL: /core-.../
    permalink: data => {
      const stem = data.page.filePathStem; // e.g. /content/core-.../index
      return stem.replace(/^\/content/, '') + '.html';
    }
  }
};

