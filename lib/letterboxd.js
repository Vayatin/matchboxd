// Lecture des données publiques Letterboxd.
// Seules certaines pages passent la protection Cloudflare depuis un serveur :
//   /{user}/films/  (1re page, ~72 films avec notes)
//   /{user}/rss/    (~100 dernières entrées du journal)
//   /film/{slug}/   (fiche film : genres, réal, casting, films similaires…)
const fs = require("fs");
const path = require("path");

const BASE = "https://letterboxd.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// Dossier du cache (modifiable via CACHE_DIR, par ex. un disque persistant chez l'hébergeur)
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "..", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "films.json");
const FILM_TTL = 1000 * 60 * 60 * 24 * 14; // 14 jours
const PARSER_VERSION = 3; // à incrémenter si parseFilm change, pour invalider le cache

const LINKS_FILE = path.join(CACHE_DIR, "links.json");

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};
let filmCache = readJson(CACHE_FILE);
let linkCache = readJson(LINKS_FILE); // lien court boxd.it -> slug

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(filmCache));
    fs.writeFileSync(LINKS_FILE, JSON.stringify(linkCache));
  }, 1000);
}

class LetterboxdError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Caches en mémoire bornés : au-delà de `max` entrées, on oublie les plus anciennes
function capMap(map, max) {
  while (map.size >= max) map.delete(map.keys().next().value);
}

// Plafond global de requêtes simultanées vers Letterboxd, partagé entre tous les visiteurs :
// le site ne doit jamais mitrailler Letterboxd, même si plusieurs analyses tournent en même temps.
const MAX_OUTGOING = +(process.env.MAX_OUTGOING || 8);
let outgoing = 0;
const waiting = [];
async function withSlot(fn) {
  if (outgoing >= MAX_OUTGOING) await new Promise((r) => waiting.push(r));
  outgoing++;
  try {
    return await fn();
  } finally {
    outgoing--;
    waiting.shift()?.();
  }
}

// Coupe-circuit : si Letterboxd refuse beaucoup de requêtes d'affilée, on arrête de l'interroger
// pendant 2 minutes. Les analyses échouent alors tout de suite avec un message clair, au lieu
// d'insister pendant des minutes (et d'aggraver le blocage).
const BLOCK_THRESHOLD = 10;
const BLOCK_COOLDOWN = 2 * 60 * 1000;
let consecutiveBlocks = 0;
let blockedUntil = 0;
const blockedError = () => Object.assign(new LetterboxdError("Letterboxd limite temporairement l'accès", 429), { blocked: true });
const isBlocked = () => Date.now() < blockedUntil;

async function get(url, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (isBlocked()) throw blockedError();
    const { res, text } = await withSlot(async () => {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xml" }, signal: AbortSignal.timeout(20000) });
      return { res: r, text: await r.text() };
    });
    const challenged = res.status === 403 || /<title>Just a moment/.test(text);
    if (res.ok && !challenged) {
      consecutiveBlocks = 0;
      return text;
    }
    if (res.status === 404) throw new LetterboxdError("introuvable", 404);
    if (challenged && ++consecutiveBlocks >= BLOCK_THRESHOLD) {
      blockedUntil = Date.now() + BLOCK_COOLDOWN;
      consecutiveBlocks = 0;
      console.warn(`[letterboxd] ${BLOCK_THRESHOLD} refus d'affilée : pause de ${BLOCK_COOLDOWN / 1000} s`);
      throw blockedError();
    }
    if (attempt >= retries) throw new LetterboxdError(challenged ? "bloqué par Letterboxd" : `HTTP ${res.status}`, res.status);
    await sleep(800 * (attempt + 1));
  }
}

const decode = (s = "") =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

const unique = (arr) => [...new Set(arr)];

function splitNameYear(full) {
  const m = decode(full).match(/^(.*?)\s*\((\d{4})\)$/);
  return m ? { title: m[1], year: +m[2] } : { title: decode(full), year: null };
}

// ---------- Profil ----------

async function getUserFilmsPage(user) {
  const html = await get(`${BASE}/${encodeURIComponent(user)}/films/`);
  const films = [];
  const itemRe = /<li class="griditem">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = itemRe.exec(html))) {
    const block = m[1];
    const slug = (block.match(/data-item-slug="([^"]+)"/) || [])[1];
    if (!slug) continue;
    const name = (block.match(/data-item-name="([^"]+)"/) || [])[1] || slug;
    const rated = block.match(/rated-(\d+)/);
    films.push({
      slug,
      ...splitNameYear(name),
      rating: rated ? +rated[1] / 2 : null,
      liked: /icon-liked|liked-micro/.test(block),
    });
  }
  const hasMore = /class="paginate-page/.test(html);
  // Nombre de pages (72 films par page) -> estimation du total de films vus
  const pages = Math.max(1, ...[...html.matchAll(/\/films\/page\/(\d+)\//g)].map((m) => +m[1]));
  return { films, hasMore, estimatedTotal: hasMore ? pages * 72 : films.length, member: parseMember(html) };
}

// Photo de profil + nom affiché, présents dans l'en-tête des pages d'un membre
function parseMember(html) {
  const avatar = (html.match(/https:\/\/a\.ltrbxd\.com\/resized\/avatar\/[^"' )]+/) || [])[0] || null;
  const title = decode((html.match(/<title>([^<]+)<\/title>/) || [])[1] || "");
  const displayName = (title.replace(/&lrm;|‎/g, "").match(/^(.+?)[’']s films/) || [])[1] || null;
  return {
    // L'en-tête donne une miniature 48 px : on demande une version 220 px
    avatar: avatar ? avatar.replace(/-0-\d+-0-\d+-crop/, "-0-220-0-220-crop") : null,
    displayName: displayName ? displayName.trim() : null,
  };
}

async function getMember(user) {
  try {
    return parseMember(await get(`${BASE}/${encodeURIComponent(user)}/films/`));
  } catch {
    return { avatar: null, displayName: null };
  }
}

// Un compte a-t-il vu ce film ? /{user}/film/{slug}/ existe (200) si oui, 404 sinon.
// Cette page n'est pas bloquée par Cloudflare, contrairement à la liste paginée.
const entryCache = new Map(); // "user/slug" -> { at, entry }
const ENTRY_TTL = 1000 * 60 * 30;

async function getUserFilmEntry(user, slug) {
  const key = `${user}/${slug}`;
  const hit = entryCache.get(key);
  if (hit && Date.now() - hit.at < ENTRY_TTL) return hit.entry;
  let entry;
  try {
    const html = await get(`${BASE}/${encodeURIComponent(user)}/film/${slug}/`);
    // La note du compte est dans les données structurées ; les étoiles affichées
    // dans la page peuvent appartenir à d'autres visionnages
    const rating = (html.match(/"reviewRating":\{[^}]*"ratingValue":([\d.]+)/) || [])[1];
    entry = { seen: true, rating: rating ? +rating : null, liked: /inline-liked/.test(html) };
  } catch (err) {
    if (err.status !== 404) throw err;
    entry = { seen: false };
  }
  capMap(entryCache, 20000);
  entryCache.set(key, { at: Date.now(), entry });
  return entry;
}

// Vérifie une liste de films pour un compte -> Map(slug -> entry). Les échecs sont absents de la Map.
async function getUserFilmEntries(user, slugs, { concurrency = 6, onProgress } = {}) {
  const queue = [...slugs];
  const out = new Map();
  let done = 0;
  let blocked = null;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length && !blocked) {
        const slug = queue.shift();
        try {
          out.set(slug, await getUserFilmEntry(user, slug));
        } catch (err) {
          if (err.blocked) blocked = err; // Letterboxd bloque : inutile de continuer
        }
        done++;
        onProgress?.(done, slugs.length);
      }
    })
  );
  if (blocked) throw blocked;
  return out;
}

async function getUserRss(user) {
  let xml;
  try {
    xml = await get(`${BASE}/${encodeURIComponent(user)}/rss/`);
  } catch {
    return [];
  }
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? decode(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : null;
  };
  const items = [];
  for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = tag(block, "letterboxd:filmTitle");
    const link = tag(block, "link") || "";
    const slug = (link.match(/\/film\/([^/]+)\//) || [])[1];
    if (!title || !slug) continue; // entrées de listes, etc.
    const rating = tag(block, "letterboxd:memberRating");
    items.push({
      slug,
      title,
      year: +tag(block, "letterboxd:filmYear") || null,
      rating: rating ? +rating : null,
      liked: tag(block, "letterboxd:memberLike") === "Yes",
      watchedDate: tag(block, "letterboxd:watchedDate"),
      poster: (block.match(/<img src="([^"]+)"/) || [])[1] || null,
    });
  }
  return items;
}

async function getUserFilms(user) {
  const [page, rss] = await Promise.all([getUserFilmsPage(user), getUserRss(user)]);
  const bySlug = new Map();
  for (const f of page.films) bySlug.set(f.slug, { ...f });
  // Le RSS est le plus récent : il complète/écrase la note et le like
  for (const r of rss) {
    const prev = bySlug.get(r.slug) || { slug: r.slug, title: r.title, year: r.year, rating: null, liked: false };
    bySlug.set(r.slug, {
      ...prev,
      rating: prev.rating ?? r.rating,
      liked: prev.liked || r.liked,
      poster: prev.poster || r.poster,
      watchedDate: prev.watchedDate || r.watchedDate,
    });
  }
  return { films: [...bySlug.values()], partial: page.hasMore, estimatedTotal: Math.max(page.estimatedTotal, bySlug.size), member: page.member };
}

// ---------- Fiche film ----------

function parseFilm(slug, html) {
  let ld = {};
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    try {
      ld = JSON.parse(ldMatch[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\//g, ""));
    } catch {}
  }

  const og = (prop) => decode((html.match(new RegExp(`<meta property="og:${prop}" content="([^"]*)"`)) || [])[1] || "");
  const { title, year } = splitNameYear(og("title") || ld.name || slug);

  const genresBlock = (html.match(/<div id="tab-genres"[\s\S]*?<\/div>\s*<\/div>/) || [html])[0];
  const links = (block, kind) =>
    unique([...block.matchAll(new RegExp(`href="/films/${kind}/[^/"]+/"[^>]*>([^<]+)<`, "g"))].map((m) => decode(m[1]).trim()));
  const genres = links(genresBlock, "genre");
  const countries = links(html, "country");
  const languages = links(html, "language");

  const asList = (list) => (Array.isArray(list) ? list : list ? [list] : []).filter((p) => p && p.name);
  const personSlug = (p) => ((p.sameAs || "").match(/\/(?:director|actor)\/([^/]+)\//) || [])[1] || null;
  const directors = asList(ld.director).map((p) => p.name);
  const directorSlugs = asList(ld.director).map(personSlug);
  const actors = asList(ld.actor).slice(0, 6).map((p) => p.name);
  const actorSlugs = asList(ld.actor).slice(0, 6).map(personSlug);
  const ratingCount = ld.aggregateRating && Number.isFinite(+ld.aggregateRating.ratingCount) ? +ld.aggregateRating.ratingCount : 0;

  const avg = (html.match(/<meta name="twitter:data2" content="([\d.]+) out of 5"/) || [])[1];
  const dur = (ld.duration || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  const runtime = dur ? (+dur[1] || 0) * 60 + (+dur[2] || 0) : null;

  const similarBlock = (html.match(/<section class="section related-films[\s\S]*?<\/section>/) || [""])[0];
  const similar = [];
  for (const m of similarBlock.matchAll(/data-item-slug="([^"]+)"[^>]*?data-item-name="([^"]+)"|data-item-name="([^"]+)"[^>]*?data-item-slug="([^"]+)"/g)) {
    const s = m[1] || m[4];
    const name = m[2] || m[3];
    if (s && s !== slug && !similar.some((x) => x.slug === s)) similar.push({ slug: s, ...splitNameYear(name) });
  }

  return {
    slug,
    title,
    year,
    poster: ld.image || null,
    backdrop: og("image") || null,
    description: og("description") || ld.description || "",
    genres,
    countries,
    language: languages[0] || null,
    directors,
    directorSlugs,
    actors,
    actorSlugs,
    ratingCount,
    avgRating: avg ? +avg : null,
    runtime,
    tmdbId: (html.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/) || [])[1] || null,
    isTv: /data-tmdb-type="tv"|themoviedb\.org\/tv\//.test(html),
    similar,
    v: PARSER_VERSION,
    fetchedAt: Date.now(),
  };
}

async function getFilm(slug) {
  const cached = filmCache[slug];
  if (cached && cached.v === PARSER_VERSION && Date.now() - cached.fetchedAt < FILM_TTL) return cached;
  const html = await get(`${BASE}/film/${slug}/`);
  const film = parseFilm(slug, html);
  filmCache[slug] = film;
  scheduleSave();
  return film;
}

// ---------- Filmographies (pages réalisateur / acteur, triées par popularité) ----------
const personCache = new Map(); // "director/slug" -> { at, films }
const PERSON_TTL = 1000 * 60 * 60 * 24;

async function getPersonFilms(kind, slug) {
  const key = `${kind}/${slug}`;
  const hit = personCache.get(key);
  if (hit && Date.now() - hit.at < PERSON_TTL) return hit.films;
  const html = await get(`${BASE}/${kind}/${slug}/`);
  const films = [];
  for (const m of html.matchAll(/data-item-slug="([^"]+)"[^>]*?data-item-name="([^"]+)"|data-item-name="([^"]+)"[^>]*?data-item-slug="([^"]+)"/g)) {
    const s = m[1] || m[4];
    if (!films.some((f) => f.slug === s)) films.push({ slug: s, ...splitNameYear(m[2] || m[3]) });
  }
  capMap(personCache, 2000);
  personCache.set(key, { at: Date.now(), films });
  return films;
}

// 1re page de la watchlist d'un compte (la seule lisible depuis un serveur)
async function getUserWatchlistPage(user) {
  try {
    const html = await get(`${BASE}/${encodeURIComponent(user)}/watchlist/`);
    return unique([...html.matchAll(/data-item-slug="([^"]+)"/g)].map((m) => m[1]));
  } catch {
    return [];
  }
}

// ---------- Liens courts de l'export (https://boxd.it/xxxx) ----------

async function resolveShortLink(uri) {
  if (linkCache[uri]) return linkCache[uri];
  const m = String(uri).match(/^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/);
  if (!m) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await withSlot(() =>
      fetch(`https://boxd.it/${m[1]}`, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(15000) })
    );
    const slug = ((res.headers.get("location") || "").match(/\/film\/([^/]+)\//) || [])[1];
    if (slug) {
      linkCache[uri] = slug;
      scheduleSave();
      return slug;
    }
    if (res.status === 404) return null;
    await sleep(800 * (attempt + 1));
  }
  return null;
}

// Résout une liste de liens courts en parallèle -> Map(uri -> slug)
async function resolveShortLinks(uris, { concurrency = 8, onProgress } = {}) {
  const queue = [...uris];
  const out = new Map();
  let done = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const uri = queue.shift();
        try {
          const slug = await resolveShortLink(uri);
          if (slug) out.set(uri, slug);
        } catch {}
        done++;
        onProgress?.(done, uris.length);
      }
    })
  );
  return out;
}

// Récupère plusieurs fiches en parallèle (avec une limite), sans échouer si une fiche est bloquée.
async function getFilms(slugs, { concurrency = 6, onProgress } = {}) {
  const queue = [...slugs];
  const out = new Map();
  let done = 0;
  let blocked = null;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length && !blocked) {
        const slug = queue.shift();
        try {
          out.set(slug, await getFilm(slug));
        } catch (err) {
          if (err.blocked) blocked = err; // Letterboxd bloque : inutile de continuer
        }
        done++;
        onProgress?.(done, slugs.length, out.get(slug)); // 3e argument : la fiche, pour montrer son affiche
      }
    })
  );
  if (blocked) throw blocked;
  return out;
}

// Affiches de films populaires déjà en cache (mur d'affiches de la page d'accueil)
function getPosterWall(count = 72) {
  const films = Object.values(filmCache).filter((f) => f.poster && !f.isTv && (f.ratingCount || 0) > 150000);
  // Mélange puis tri léger par popularité : des films connus, mais pas toujours les mêmes
  return films
    .map((f) => ({ f, r: Math.random() * (1 + Math.log10(f.ratingCount)) }))
    .sort((a, b) => b.r - a.r)
    .slice(0, count)
    .map(({ f }) => ({ poster: f.poster, title: f.title }));
}

module.exports = { getUserFilms, getMember, getUserFilmEntries, getUserWatchlistPage, getFilms, getPersonFilms, getPosterWall, resolveShortLinks, LetterboxdError };
