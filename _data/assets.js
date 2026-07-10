const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

// Local CSS/JS referenced by the base template. Root-relative paths.
const FILES = [
  "/assets/css/global.css",
  "/assets/js/copy-code.js",
  "/assets/js/checkbox.js",
  "/assets/js/accordion.js",
];

function computeVersion() {
  const hash = crypto.createHash("sha1");
  for (const rel of FILES) {
    const abs = path.join(__dirname, "..", rel);
    hash.update(fs.readFileSync(abs));
  }
  return hash.digest("hex").slice(0, 10);
}

let v;
try {
  v = computeVersion();
} catch (err) {
  v = "dev";
}

module.exports = { v };
