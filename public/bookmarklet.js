// Favori « Matchboxd » : à cliquer depuis ta page de profil sur letterboxd.com.
// Il lit toutes les pages de ta liste de films (et de ta watchlist) depuis TON navigateur,
// comme si tu les parcourais, puis ouvre Matchboxd avec la liste compressée dans l'adresse
// (après le #, donc jamais envoyée à un serveur par le navigateur).
// __NEXTREEL_ORIGIN__ est remplacé par l'adresse de Matchboxd au moment de générer le favori.
(async () => {
  const ORIGIN = "__NEXTREEL_ORIGIN__";
  const reserved = /^(film|films|lists|list|members|journal|search|settings|activity|sign-in|create-account|pro|about|tags|crew|actor|director|studio)$/;
  if (!/(^|\.)letterboxd\.com$/.test(location.hostname)) {
    alert("Matchboxd : ouvre d'abord ta page de profil sur letterboxd.com, puis clique à nouveau sur ce favori.");
    return;
  }
  const user = document.body.dataset.owner || location.pathname.split("/")[1];
  if (!user || reserved.test(user)) {
    alert("Matchboxd : va sur ta page de profil (letterboxd.com/ton-pseudo/), puis clique à nouveau sur ce favori.");
    return;
  }
  if (document.getElementById("nextreel-box")) return; // déjà en cours

  // Petit encadré de progression sur la page Letterboxd
  const box = document.createElement("div");
  box.id = "nextreel-box";
  box.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:2147483647;width:300px;padding:16px;border-radius:6px;" +
    "background:#1c2228;color:#9ab;font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.6)";
  box.innerHTML =
    '<b style="color:#fff">Matchboxd</b><div id="nextreel-label" style="margin:6px 0 10px">Lecture de tes films…</div>' +
    '<div style="height:4px;background:#2c3440;border-radius:2px;overflow:hidden"><div id="nextreel-bar" style="height:100%;width:2%;background:#00e054;transition:width .3s"></div></div>';
  document.body.appendChild(box);
  const show = (label, pct) => {
    box.querySelector("#nextreel-label").textContent = label;
    box.querySelector("#nextreel-bar").style.width = pct + "%";
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function page(path) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(path, { credentials: "include" });
      const text = await res.text();
      if (res.ok && !/<title>Just a moment/.test(text)) return new DOMParser().parseFromString(text, "text/html");
      if (res.status === 404) return null;
      await sleep(1500 * (attempt + 1)); // Letterboxd refuse parfois une page : on attend et on réessaie
    }
    throw new Error(`Letterboxd a refusé la lecture de ${path}. Recharge la page et réessaie.`);
  }

  // [slug, note sur 10 (0 = pas de note), liké 1/0]
  function grid(doc) {
    return [...doc.querySelectorAll("li.griditem")]
      .map((li) => {
        const el = li.querySelector("[data-item-slug]");
        if (!el) return null;
        const rated = li.innerHTML.match(/rated-(\d+)/);
        return [el.dataset.itemSlug, rated ? +rated[1] : 0, /icon-liked|liked-micro/.test(li.innerHTML) ? 1 : 0];
      })
      .filter(Boolean);
  }

  const pageCount = (doc) => Math.max(1, ...[...doc.querySelectorAll(".paginate-page a")].map((a) => +a.textContent || 1));

  async function readAll(section, label, from, span, maxPages = Infinity) {
    const first = await page(`/${user}/${section}/`);
    if (!first) return [];
    const total = Math.min(pageCount(first), maxPages);
    const films = grid(first);
    show(`${label} : page 1/${total}`, from + span / total);
    for (let i = 2; i <= total; i++) {
      await sleep(350);
      const doc = await page(`/${user}/${section}/page/${i}/`);
      if (doc) films.push(...grid(doc));
      show(`${label} : page ${i}/${total} (${films.length} films)`, from + (span * i) / total);
    }
    return films;
  }

  try {
    const films = await readAll("films", "Tes films", 0, 85);
    let watchlist = [];
    try {
      // La watchlist ne sert qu'à un badge : les 8 premières pages suffisent
      watchlist = (await readAll("watchlist", "Ta watchlist", 85, 12, 8)).map((f) => f[0]);
    } catch {}
    show(`${films.length} films lus, ouverture de Matchboxd…`, 100);

    // Compression gzip + base64url pour tenir dans l'adresse
    const json = JSON.stringify({ u: user, f: films, w: watchlist });
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const data = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    location.href = `${ORIGIN}/#import=${data}`;
  } catch (err) {
    show(err.message, 100);
    box.querySelector("#nextreel-bar").style.background = "#ff8000";
    setTimeout(() => box.remove(), 8000);
  }
})();
