// Prépare un dossier propre à glisser sur GitHub (sans le cache ni les fichiers inutiles).
// Usage : npm run preparer-github  ->  crée ../matchboxd-github/
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "..", "matchboxd-github");
const IGNORE = new Set(["cache", "node_modules", ".git"]);

fs.rmSync(OUT, { recursive: true, force: true });

function copy(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(OUT, rel);
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) if (!IGNORE.has(name)) copy(path.join(rel, name));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

let count = 0;
for (const name of fs.readdirSync(ROOT)) {
  if (IGNORE.has(name)) continue;
  copy(name);
}
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else count++;
  }
})(OUT);
console.log(`Dossier prêt : ${OUT} (${count} fichiers)`);
