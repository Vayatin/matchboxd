// Service worker de l'extension Matchboxd.
// Lit toutes les pages de /{pseudo}/films/ (+ début de la watchlist) avec le navigateur de l'utilisateur.
//  1. d'abord directement depuis l'extension ;
//  2. si Letterboxd refuse, dans un onglet Letterboxd ouvert en arrière-plan (comme si tu parcourais tes pages).

const WATCHLIST_MAX_PAGES = 8;

// Fonction autonome : elle est aussi injectée telle quelle dans l'onglet Letterboxd (chrome.scripting),
// donc rien en dehors d'elle ne doit être utilisé. Sans `report`, la progression part via chrome.runtime.
async function readProfile(user, watchlistMaxPages, report) {
  report = report || ((msg) => chrome.runtime.sendMessage({ ...msg, fromTab: true }).catch(() => {}));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function page(path) {
    let challenged = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`https://letterboxd.com${path}`, { credentials: "include" });
      const text = await res.text();
      challenged = res.status === 403 || /<title>Just a moment/.test(text);
      if (res.ok && !challenged) return text;
      if (res.status === 404) return null;
      await sleep(1200 * (attempt + 1)); // Letterboxd refuse parfois une page : on attend et on réessaie
    }
    const err = new Error(`Letterboxd a refusé la lecture de ${path}.`);
    err.challenged = challenged;
    throw err;
  }

  // [slug, note sur 10 (0 = pas de note), liké 1/0]
  function grid(html) {
    const films = [];
    for (const [, block] of html.matchAll(/<li class="griditem">([\s\S]*?)<\/li>/g)) {
      const slug = (block.match(/data-item-slug="([^"]+)"/) || [])[1];
      if (!slug) continue;
      const rated = block.match(/rated-(\d+)/);
      films.push([slug, rated ? +rated[1] : 0, /icon-liked|liked-micro/.test(block) ? 1 : 0]);
    }
    return films;
  }

  async function readAll(section, label, from, span, maxPages) {
    const first = await page(`/${user}/${section}/`);
    if (first === null) {
      if (section === "films") throw Object.assign(new Error(`Aucun compte Letterboxd « ${user} ».`), { notFound: true });
      return [];
    }
    const pageRe = new RegExp(`/${section}/page/(\\d+)/`, "g");
    const total = Math.min(Math.max(1, ...[...first.matchAll(pageRe)].map((m) => +m[1])), maxPages);
    const films = grid(first);
    report({ type: "progress", label: `${label} : page 1/${total}`, pct: from + span / total });
    for (let i = 2; i <= total; i++) {
      await sleep(300);
      const html = await page(`/${user}/${section}/page/${i}/`);
      if (html) films.push(...grid(html));
      report({ type: "progress", label: `${label} : page ${i}/${total} (${films.length} films)`, pct: from + (span * i) / total });
    }
    return films;
  }

  try {
    const films = await readAll("films", "Lecture de tes films", 0, 88, Infinity);
    let watchlist = [];
    try {
      watchlist = (await readAll("watchlist", "Lecture de ta watchlist", 88, 12, watchlistMaxPages)).map((f) => f[0]);
    } catch {}
    return { ok: true, films, watchlist };
  } catch (err) {
    return { ok: false, message: err.message, challenged: !!err.challenged, notFound: !!err.notFound };
  }
}

// Plan B : lecture dans un onglet Letterboxd en arrière-plan
async function readProfileInTab(user, report) {
  const tab = await chrome.tabs.create({ url: `https://letterboxd.com/${encodeURIComponent(user)}/`, active: false });
  const relay = (msg, sender) => {
    if (msg && msg.fromTab && sender.tab && sender.tab.id === tab.id) report(msg);
  };
  chrome.runtime.onMessage.addListener(relay);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Letterboxd met trop de temps à répondre.")), 30000);
      const onUpdated = (id, info) => {
        if (id === tab.id && info.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      // Si l'onglet a fini de charger avant qu'on écoute
      chrome.tabs.get(tab.id).then((t) => t.status === "complete" && onUpdated(tab.id, { status: "complete" }));
    });
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readProfile, args: [user, WATCHLIST_MAX_PAGES] });
    return injection && injection.result ? injection.result : { ok: false, message: "La lecture dans l'onglet Letterboxd a échoué." };
  } finally {
    chrome.runtime.onMessage.removeListener(relay);
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "nextreel") return;
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "read") return;
    const user = String(msg.user || "").toLowerCase();
    const post = (m) => {
      try {
        port.postMessage(m);
      } catch {}
    };
    if (!/^[a-z0-9_]{2,30}$/.test(user)) return post({ type: "error", message: "Ce pseudo n'a pas l'air valide." });

    let result = await readProfile(user, WATCHLIST_MAX_PAGES, post);
    if (!result.ok && result.challenged) {
      post({ type: "progress", label: "Letterboxd demande une vraie page : ouverture d'un onglet en arrière-plan…", pct: 2 });
      try {
        result = await readProfileInTab(user, post);
      } catch (err) {
        result = { ok: false, message: err.message };
      }
    }
    if (result.ok) post({ type: "result", films: result.films, watchlist: result.watchlist });
    else post({ type: "error", message: result.message, notFound: result.notFound });
  });
});
