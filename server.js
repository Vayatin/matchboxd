const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { createZip } = require("./lib/zip");
const { getUserFilms, getMember, getUserFilmEntries, getUserWatchlistPage, getFilms, getPersonFilms, getPosterWall, resolveShortLinks, LetterboxdError } = require("./lib/letterboxd");
const { buildProfile, peopleToExplore, collectCandidates, rankCandidates, rankWatchlist, FilmSet } = require("./lib/taste");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const results = new Map(); // cache des analyses récentes (pseudo -> { at, data })
const RESULT_TTL = 1000 * 60 * 30;
const imports = new Map(); // exports CSV reçus, en attente d'analyse (id -> { at, data })
const IMPORT_TTL = 1000 * 60 * 10;
const MAX_IMPORT_ANALYSED = 400; // nb max de films analysés en détail depuis un export

// `film` (optionnel) : la fiche qu'on vient de lire, pour faire défiler son affiche pendant l'attente
const progress = (send, step, label, pct, film) =>
  send("progress", { step, label, pct: Math.round(pct), ...(film?.poster && !film.isTv ? { poster: film.poster, title: film.title } : {}) });

const MAX_CANDIDATES = 240; // fiches de candidats récupérées par analyse (vivier + réserve pour "par genre")
const WATCHLIST_MAX = 100; // films de watchlist classés au maximum

// Filmographies de tes réalisateurs / acteurs préférés
async function explorePeople(profile) {
  const people = peopleToExplore(profile);
  const lists = await Promise.all(
    people.map(async (p) => {
      try {
        return { ...p, films: await getPersonFilms(p.kind, p.slug) };
      } catch {
        return null;
      }
    })
  );
  return lists.filter(Boolean);
}

async function rankUserWatchlist(profile, slugs, meta, seen, send, from, to) {
  const list = slugs.filter((s) => !seen.has({ slug: s })).slice(0, WATCHLIST_MAX);
  if (!list.length) return [];
  const wlMeta = await getFilms(list, {
    onProgress: (d, t, film) => progress(send, "watchlist", `On classe ta watchlist (${d}/${t})`, from + (d / t) * (to - from), film),
  });
  for (const [k, v] of wlMeta) meta.set(k, v);
  return rankWatchlist(profile, list, meta, { isSeen: (m) => seen.has(m) });
}

// ---------- Mode 1 : pseudo seul ----------
// Letterboxd ne laisse lire que ~100 films de la liste. Chaque candidat est donc vérifié
// sur le compte (/{user}/film/{slug}/) :
//  - déjà vu  -> il rejoint ton profil, avec ta note
//  - pas vu   -> il devient recommandable
// Seuls les films vérifiés "pas vus" peuvent être recommandés.
const VERIFY_ROUNDS = 2;
const VERIFY_PER_ROUND = 120;

async function analyseUser(user, send) {
  progress(send, "profile", "Lecture de ton profil Letterboxd…", 3);
  const [{ films: initial, partial, estimatedTotal, member }, watchlistSlugs] = await Promise.all([getUserFilms(user), getUserWatchlistPage(user)]);
  if (!initial.length) throw new LetterboxdError("Aucun film visible sur ce profil.", 422);

  progress(send, "films", `${initial.length} films trouvés, analyse de chaque fiche…`, 5);
  const meta = await getFilms(
    initial.map((f) => f.slug),
    { onProgress: (d, t, film) => progress(send, "films", `Analyse de tes films (${d}/${t})`, 5 + (d / t) * 25, film) }
  );

  const userFilms = [...initial];
  const seen = new FilmSet();
  userFilms.forEach((f) => seen.add(f));
  const verified = new Set();
  const unseen = new Set();
  let profile = buildProfile(userFilms, meta);
  let discovered = 0;

  for (let round = 0; round < VERIFY_ROUNDS; round++) {
    const from = 30 + round * 30;
    progress(send, "people", "On explore les filmographies de tes réalisateurs et acteurs préférés…", from);
    const people = await explorePeople(profile);
    const toCheck = collectCandidates(profile, seen, people)
      .filter((c) => !verified.has(c.slug))
      .slice(0, VERIFY_PER_ROUND);
    if (!toCheck.length) break;

    const [entries, candMeta] = await Promise.all([
      getUserFilmEntries(user, toCheck.map((c) => c.slug), {
        onProgress: (d, t) => progress(send, "explore", `On vérifie ce que tu as déjà vu (${d}/${t})`, from + (d / t) * 28),
      }),
      getFilms(toCheck.map((c) => c.slug), { concurrency: 4 }),
    ]);
    for (const [k, v] of candMeta) meta.set(k, v);

    let found = 0;
    for (const c of toCheck) {
      const entry = entries.get(c.slug);
      if (!entry) continue; // vérification impossible : ni dans le profil, ni recommandé
      verified.add(c.slug);
      if (!entry.seen) {
        unseen.add(c.slug);
        continue;
      }
      const m = meta.get(c.slug);
      const film = { slug: c.slug, title: m?.title || c.title, year: m?.year ?? null, rating: entry.rating, liked: entry.liked };
      userFilms.push(film);
      seen.add(film);
      found++;
    }
    discovered += found;
    profile = buildProfile(userFilms, meta);
    if (found < 8) break; // plus grand-chose à découvrir : inutile de refaire un tour
  }

  progress(send, "rank", "Classement des recommandations…", 90);
  const people = await explorePeople(profile);
  const candidates = collectCandidates(profile, seen, people);
  const { pool, avoided, extras } = rankCandidates(profile, candidates, meta, { isSeen: (m) => seen.has(m), allowed: unseen });
  const watchlistRanked = await rankUserWatchlist(profile, watchlistSlugs, meta, seen, send, 92, 98);

  Object.assign(profile.summary, { estimatedTotal: Math.max(estimatedTotal, userFilms.length), discovered });
  return { user, member, source: "profile", partial, profile: profile.summary, pool, extras, avoided, watchlistRanked, watchlistCount: watchlistSlugs.length, watchlistPartial: true };
}

// ---------- Mode 2 : export CSV ----------
function cleanImport(body) {
  const str = (v, max = 300) => (typeof v === "string" ? v.slice(0, max) : null);
  const year = (v) => (Number.isInteger(+v) && +v > 1870 && +v < 2100 ? +v : null);
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

  const slug = (v) => (typeof v === "string" && /^[a-z0-9-]{1,200}$/.test(v) ? v : null);
  const uri = (v) => (typeof v === "string" && /^https:\/\/boxd\.it\/[A-Za-z0-9]+$/.test(v) ? v : null);

  // Un film est identifié soit par son slug (favori Matchboxd), soit par son lien court (export CSV)
  const films = list(body.films, 20000)
    .map((f) => ({
      slug: slug(f.slug),
      uri: uri(f.uri),
      title: str(f.title),
      year: year(f.year),
      rating: typeof f.rating === "number" && f.rating >= 0.5 && f.rating <= 5 ? Math.round(f.rating * 2) / 2 : null,
      liked: f.liked === true,
      date: str(f.date, 10),
    }))
    .filter((f) => f.slug || (f.uri && f.title));
  const pairs = (arr) =>
    list(arr, 30000)
      .map((f) => ({ slug: slug(f.slug), title: str(f.title), year: year(f.year) }))
      .filter((f) => f.slug || f.title);

  return {
    via: ["letterboxd", "extension"].includes(body.via) ? body.via : "export",
    username: (str(body.username, 40) || "").replace(/[^A-Za-z0-9_]/g, "") || null,
    films,
    watched: pairs(body.watched),
    watchlist: pairs(body.watchlist),
  };
}

async function analyseImport(data, send) {
  const rated = data.films.filter((f) => f.rating != null);
  const allRatings = rated.map((f) => f.rating);
  if (rated.length + data.films.filter((f) => f.liked).length < 5)
    throw new LetterboxdError("Ton export contient trop peu de films notés ou likés.", 422);
  const mean = allRatings.reduce((s, r) => s + r, 0) / (allRatings.length || 1);

  // On garde en priorité les films qui en disent le plus sur toi : notes extrêmes et likes
  const selected = data.films
    .filter((f) => f.rating != null || f.liked)
    .map((f) => ({ ...f, priority: (f.rating != null ? Math.abs(f.rating - mean) : 0.5) + (f.liked ? 0.75 : 0) }))
    .sort((a, b) => b.priority - a.priority || (b.date || "").localeCompare(a.date || ""))
    .slice(0, MAX_IMPORT_ANALYSED);

  const toResolve = selected.filter((f) => !f.slug).map((f) => f.uri);
  let slugs = new Map();
  if (toResolve.length) {
    progress(send, "links", `${data.films.length} films dans ton export, on retrouve chaque fiche…`, 3);
    slugs = await resolveShortLinks(toResolve, {
      onProgress: (d, t) => progress(send, "links", `On retrouve tes films sur Letterboxd (${d}/${t})`, 3 + (d / t) * 22),
    });
  }
  const userFilms = selected
    .map((f) => ({ ...f, slug: f.slug || slugs.get(f.uri) }))
    .filter((f) => f.slug);
  if (!userFilms.length) throw new LetterboxdError("Impossible de retrouver tes films sur Letterboxd.", 502);

  const from = toResolve.length ? 25 : 3;
  const meta = await getFilms(
    userFilms.map((f) => f.slug),
    { onProgress: (d, t, film) => progress(send, "films", `Analyse de tes films (${d}/${t})`, from + (d / t) * (55 - from), film) }
  );

  progress(send, "taste", "Calcul de ton profil de goûts…", 56);
  const profile = buildProfile(userFilms, meta, { allRatings });

  // Tout ce que tu as vu est exclu, même les films qu'on n'a pas analysés en détail
  const seen = new FilmSet();
  data.watched.forEach((f) => seen.add(f));
  data.films.forEach((f) => seen.add(f));
  userFilms.forEach((f) => seen.add(f));
  const watchlist = new FilmSet();
  data.watchlist.forEach((f) => watchlist.add(f));

  progress(send, "people", "On explore les filmographies de tes réalisateurs et acteurs préférés…", 58);
  const people = await explorePeople(profile);
  const candidates = collectCandidates(profile, seen, people).slice(0, MAX_CANDIDATES);
  const candMeta = await getFilms(
    candidates.map((c) => c.slug),
    { onProgress: (d, t, film) => progress(send, "candidates", `Exploration des films qui pourraient te plaire (${d}/${t})`, 60 + (d / t) * 28, film) }
  );
  for (const [k, v] of candMeta) meta.set(k, v);
  const { pool, avoided, extras } = rankCandidates(profile, candidates, meta, { isSeen: (m) => seen.has(m), watchlist });

  // L'export ne donne que les titres de la watchlist ; le favori et l'extension donnent les slugs
  const watchlistSlugs = data.watchlist.map((f) => f.slug).filter(Boolean);
  const [watchlistRanked, member] = await Promise.all([
    rankUserWatchlist(profile, watchlistSlugs, meta, seen, send, 88, 98),
    data.username ? getMember(data.username) : { avatar: null, displayName: null },
  ]);

  Object.assign(profile.summary, {
    filmCount: seen.size,
    likedCount: data.films.filter((f) => f.liked).length,
    histogram: Array.from({ length: 10 }, (_, i) => allRatings.filter((r) => r === (i + 1) / 2).length),
  });
  return {
    user: data.username || "ton export",
    member,
    source: "import",
    via: data.via,
    partial: false,
    profile: profile.summary,
    pool,
    extras,
    avoided,
    watchlistRanked,
    watchlistCount: data.watchlist.length,
    watchlistPartial: watchlistSlugs.length > WATCHLIST_MAX,
  };
}

// ---------- HTTP ----------
function errorMessage(err, user) {
  if (err.status === 404 && user) return `Aucun compte Letterboxd « ${user} ». Vérifie l'orthographe.`;
  if (err.status === 422) return err.message;
  if (err.blocked) return "Letterboxd limite en ce moment l'accès de Matchboxd. Réessaie dans quelques minutes.";
  if (err instanceof LetterboxdError) return `Letterboxd n'a pas répondu (${err.message}). Réessaie dans un instant.`;
  console.error(err);
  return "Une erreur est survenue pendant l'analyse.";
}

// Adresse IP du visiteur. Derrière le proxy de l'hébergeur, on prend l'en-tête posé par le proxy
// (True-Client-IP / CF-Connecting-IP), sinon la DERNIÈRE valeur de X-Forwarded-For : c'est celle
// ajoutée par le proxy, les premières peuvent être inventées par le visiteur.
const clientIp = (req) =>
  req.headers["true-client-ip"] ||
  req.headers["cf-connecting-ip"] ||
  (req.headers["x-forwarded-for"] || "").split(",").pop().trim() ||
  req.socket.remoteAddress ||
  "?";

// --- Limites d'usage : protègent le serveur… et Letterboxd ---
const MAX_RUNNING = +(process.env.MAX_RUNNING || 3); // analyses en parallèle, tous visiteurs confondus
const RATE_WINDOW = 10 * 60 * 1000;
const RATE_MAX = +(process.env.RATE_MAX || 10); // analyses par visiteur et par tranche de 10 minutes
const hits = new Map(); // ip -> [horodatages]
const activeByIp = new Map(); // ip -> nb d'analyses en cours
let running = 0;
const queue = []; // { start, onQueue }

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  if (list.length >= RATE_MAX) return true;
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return false;
}

// Lance `task` dès qu'une place se libère ; `onWait(position)` tient le visiteur informé
function schedule(task, onWait) {
  return new Promise((resolve, reject) => {
    const entry = {
      start: () => {
        running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            const next = queue.shift();
            queue.forEach((q, i) => q.onWait(i + 1));
            next?.start();
          });
      },
      onWait,
    };
    if (running < MAX_RUNNING) entry.start();
    else {
      queue.push(entry);
      onWait(queue.length);
    }
  });
}

function handleAnalyse(req, res, url) {
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let closed = false;
  const send = (event, data) => !closed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Petit signal toutes les 15 s : évite que la connexion soit coupée pendant une longue analyse
  const heartbeat = setInterval(() => !closed && res.write(": ping\n\n"), 15000);
  const end = () => {
    clearInterval(heartbeat);
    if (!closed) res.end();
    closed = true;
  };
  req.on("close", () => {
    clearInterval(heartbeat);
    closed = true;
  });

  const ip = clientIp(req);
  const run = (makeJob, cacheKey, user) => {
    if ((activeByIp.get(ip) || 0) >= 1) {
      send("fail", { message: "Une analyse est déjà en cours depuis ton appareil. Attends qu'elle se termine." });
      return end();
    }
    if (rateLimited(ip)) {
      send("fail", { message: "Tu as lancé beaucoup d'analyses d'un coup. Patiente quelques minutes avant de recommencer." });
      return end();
    }
    activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
    schedule(makeJob, (pos) => send("progress", { step: "read", label: `Beaucoup de monde en ce moment : tu es n°${pos} dans la file…`, pct: 1 }))
      .then((data) => {
        if (cacheKey) {
          if (results.size > 300) results.delete(results.keys().next().value);
          results.set(cacheKey, { at: Date.now(), data });
        }
        send("result", data);
      })
      .catch((err) => send("fail", { message: errorMessage(err, user) }))
      .finally(() => {
        const n = (activeByIp.get(ip) || 1) - 1;
        if (n > 0) activeByIp.set(ip, n);
        else activeByIp.delete(ip);
        end();
      });
  };

  const jobId = url.searchParams.get("job");
  if (jobId) {
    const job = imports.get(jobId);
    imports.delete(jobId);
    if (!job || Date.now() - job.at > IMPORT_TTL) {
      send("fail", { message: "Import expiré, renvoie ton fichier." });
      return end();
    }
    return run(() => analyseImport(job.data, send));
  }

  const user = (url.searchParams.get("user") || "").trim().toLowerCase().replace(/^@/, "");
  if (!/^[a-z0-9_]{2,30}$/.test(user)) {
    send("fail", { message: "Ce pseudo n'a pas l'air valide." });
    return end();
  }
  const hit = results.get(user);
  if (hit && Date.now() - hit.at < RESULT_TTL) {
    send("result", hit.data);
    return end();
  }
  run(() => analyseUser(user, send), user, user);
}

function handleImport(req, res) {
  const json = (status, body) => res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json" }).end(JSON.stringify(body));
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > 10 * 1024 * 1024) {
      json(413, { error: "Fichier trop gros." });
      req.destroy();
    } else chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    let data;
    try {
      data = cleanImport(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      return json(400, { error: "Données d'import illisibles." });
    }
    if (!data.films.length) return json(400, { error: "Aucun film trouvé dans ton export." });
    for (const [id, job] of imports) if (Date.now() - job.at > IMPORT_TTL) imports.delete(id);
    if (imports.size > 200) return json(503, { error: "Le site est très sollicité, réessaie dans une minute." });
    const id = crypto.randomUUID();
    imports.set(id, { at: Date.now(), data });
    json(200, { job: id });
  });
}

// Proxy d'images : affiches et backdrops Letterboxd (uniquement leur CDN)
async function handleImage(res, url) {
  let src;
  try {
    src = new URL(url.searchParams.get("src"));
  } catch {
    return res.writeHead(400).end();
  }
  if (src.protocol !== "https:" || !/^(a|s)\.ltrbxd\.com$/.test(src.hostname)) return res.writeHead(403).end();
  try {
    const r = await fetch(src, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.writeHead(r.status).end();
    const type = r.headers.get("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return res.writeHead(415).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return res.writeHead(413).end();
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=604800, immutable", "X-Content-Type-Options": "nosniff" });
    res.end(buf);
  } catch {
    res.writeHead(502).end();
  }
}

// --- Diagnostic : comment le serveur voit le visiteur, et Letterboxd répond-il depuis l'hébergeur ? ---
let lbProbe = { at: 0, result: null };
async function probeLetterboxd() {
  if (Date.now() - lbProbe.at < 60000 && lbProbe.result) return lbProbe.result; // 1 test par minute max
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  const check = async (p) => {
    try {
      const r = await fetch("https://letterboxd.com" + p, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      const t = await r.text();
      return `${r.status}${/Just a moment/.test(t) ? " (challenge Cloudflare)" : ""}`;
    } catch (e) {
      return "erreur : " + e.message;
    }
  };
  const result = { "/karsten/films/": await check("/karsten/films/"), "/film/parasite-2019/": await check("/film/parasite-2019/") };
  lbProbe = { at: Date.now(), result };
  return result;
}
async function handleDiag(req, res) {
  const body = {
    ipVue: clientIp(req),
    entetes: {
      "true-client-ip": req.headers["true-client-ip"] || null,
      "cf-connecting-ip": req.headers["cf-connecting-ip"] || null,
      "x-forwarded-for": req.headers["x-forwarded-for"] || null,
      "x-real-ip": req.headers["x-real-ip"] || null,
    },
    analysesEnCours: running,
    fileAttente: queue.length,
    visiteursActifs: activeByIp.size,
    letterboxd: await probeLetterboxd(),
  };
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body, null, 2));
}

// --- Extension Chrome, réglée automatiquement sur l'adresse de ce site ---
const EXTENSION_DIR = path.join(__dirname, "extension");
function siteOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers.host}`;
}
function handleExtensionZip(req, res) {
  const origin = siteOrigin(req);
  const files = fs.readdirSync(EXTENSION_DIR).map((name) => {
    let data = fs.readFileSync(path.join(EXTENSION_DIR, name));
    if (name === "manifest.json") {
      const manifest = JSON.parse(data.toString("utf8"));
      const matches = new Set(manifest.content_scripts[0].matches);
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) matches.add(`${origin}/*`);
      manifest.content_scripts[0].matches = [...matches];
      manifest.description = `Permet à Matchboxd (${origin.replace(/^https?:\/\//, "")}) de lire tous les films de ton profil Letterboxd depuis ton navigateur.`;
      data = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    return { name: `matchboxd-extension/${name}`, data };
  });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="matchboxd-extension.zip"',
    "Cache-Control": "no-cache",
  });
  res.end(createZip(files));
}

// --- Fichiers statiques (compressés si le navigateur le permet) ---
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".svg", ".json", ".txt"]);

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  fs.readFile(file, (err, buf) => {
    if (err) {
      // Page 404 maison
      return fs.readFile(path.join(PUBLIC, "404.html"), (e2, page) =>
        res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" }).end(e2 ? "Page introuvable" : page)
      );
    }
    const ext = path.extname(file);
    const headers = {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[ext] || "application/octet-stream",
      // HTML toujours revalidé ; le reste gardé une heure
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    };
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      return zlib.gzip(buf, (e, gz) => {
        if (e) return res.writeHead(200, headers).end(buf);
        res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" }).end(gz);
      });
    }
    res.writeHead(200, headers).end(buf);
  });
}

http
  .createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      return res.writeHead(400).end();
    }
    if (url.pathname === "/healthz") return res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    if (url.pathname === "/api/diag") return handleDiag(req, res);
    if (url.pathname === "/api/analyse") return handleAnalyse(req, res, url);
    if (url.pathname === "/api/import" && req.method === "POST") return handleImport(req, res);
    if (url.pathname === "/img") return handleImage(res, url);
    if (url.pathname === "/extension.zip") return handleExtensionZip(req, res);
    if (url.pathname === "/api/wall") {
      return res
        .writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-cache" })
        .end(JSON.stringify(getPosterWall()));
    }
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return res.writeHead(400).end();
    }
    serveStatic(req, res, pathname);
  })
  .listen(PORT, () => console.log(`Matchboxd → http://localhost:${PORT}`));
