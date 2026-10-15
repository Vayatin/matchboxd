// Profil de goûts + score des recommandations (v2).
//
//  1. Chaque film vu reçoit un poids : positif si tu l'as noté au-dessus de ta moyenne
//     (ou liké), négatif en dessous. Les poids sont centrés : tout est relatif à TOI.
//  2. On en déduit une affinité pour chaque caractéristique : genre, réalisateur, acteur,
//     pays, langue, décennie et niveau de popularité (grand public ↔ pépite).
//  3. Candidats, de trois sources :
//       - les "Similar Films" Letterboxd de tes films (+ si aimé, − si détesté) ;
//       - la filmographie de tes réalisateurs préférés ;
//       - la filmographie de tes acteurs préférés.
//  4. Score = votes des sources + ressemblance avec ton profil + qualité (note Letterboxd
//     corrigée par le nombre de notes) + petit bonus watchlist. Puis on diversifie
//     (pas trois films de la même saga ou du même réalisateur d'affilée).

const GENRES_FR = {
  Action: "Action",
  Adventure: "Aventure",
  Animation: "Animation",
  Comedy: "Comédie",
  Crime: "Policier",
  Documentary: "Documentaire",
  Drama: "Drame",
  Family: "Famille",
  Fantasy: "Fantastique",
  History: "Histoire",
  Horror: "Horreur",
  Music: "Musique",
  Mystery: "Mystère",
  Romance: "Romance",
  "Science Fiction": "Science-fiction",
  Thriller: "Thriller",
  "TV Movie": "Téléfilm",
  War: "Guerre",
  Western: "Western",
};
const genreFr = (g) => GENRES_FR[g] || g;

// Part approximative de chaque genre parmi les films vus sur Letterboxd (référence pour l'"habitude")
const GENRE_BASE = {
  Drame: 0.45,
  Comédie: 0.3,
  Thriller: 0.22,
  Action: 0.2,
  Aventure: 0.15,
  Policier: 0.15,
  Romance: 0.13,
  Horreur: 0.12,
  "Science-fiction": 0.11,
  Fantastique: 0.1,
  Mystère: 0.08,
  Animation: 0.07,
  Famille: 0.07,
  Histoire: 0.05,
  Documentaire: 0.05,
  Musique: 0.04,
  Guerre: 0.04,
  Western: 0.02,
  Téléfilm: 0.02,
};

// Niveau de popularité d'après le nombre de notes Letterboxd
const POP_TIERS = [
  [15000, "Pépite"],
  [150000, "Connu"],
  [800000, "Populaire"],
  [Infinity, "Blockbuster"],
];
const popTier = (count) => POP_TIERS.find(([max]) => (count || 0) < max)[1];

// Importance de chaque type de caractéristique
const FEATURE_WEIGHT = { g: 1.0, d: 1.4, a: 0.45, c: 0.5, l: 0.35, y: 0.3, p: 0.4 };

function featuresOf(meta) {
  const f = [];
  for (const g of meta.genres) f.push("g:" + genreFr(g));
  for (const d of meta.directors) f.push("d:" + d);
  for (const a of meta.actors.slice(0, 5)) f.push("a:" + a);
  for (const c of meta.countries.slice(0, 2)) f.push("c:" + c);
  if (meta.language) f.push("l:" + meta.language);
  if (meta.year) f.push("y:" + Math.floor(meta.year / 10) * 10 + "s");
  if (meta.ratingCount != null) f.push("p:" + popTier(meta.ratingCount));
  return f;
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round1 = (x) => Math.round(x * 10) / 10;
const CURRENT_YEAR = new Date().getFullYear();

// Poids d'un film = ta note comparée à ce qu'on attendrait de toi pour CE film.
// On tient compte de sa note Letterboxd : mettre 2,5★ à un navet que tout le monde note 2,6★
// ne veut pas dire que tu n'aimes pas le genre, juste que le film est faible.
function filmWeight(film, mean, lbMean) {
  if (film.rating != null) {
    const lb = film.meta?.avgRating;
    const expected = lb ? mean + 0.6 * (lb - lbMean) : mean;
    return clamp((film.rating - expected) / 1.25, -2, 2) + (film.liked ? 0.6 : 0);
  }
  return film.liked ? 0.8 : 0.15; // vu sans note : léger signal positif (tu as choisi de le regarder)
}

// `allRatings` : toutes tes notes (si on n'analyse qu'une partie des films, la moyenne
// et l'histogramme restent calculés sur l'historique complet)
function buildProfile(userFilms, metaBySlug, { allRatings } = {}) {
  const rated = allRatings ? allRatings.map((rating) => ({ rating })) : userFilms.filter((f) => f.rating != null);
  const mean = rated.length ? rated.reduce((s, f) => s + f.rating, 0) / rated.length : 3.5;

  const films = userFilms.map((f) => ({ ...f, meta: metaBySlug.get(f.slug) })).filter((f) => f.meta);
  const withLb = films.filter((f) => f.meta.avgRating);
  const lbMean = withLb.length ? withLb.reduce((s, f) => s + f.meta.avgRating, 0) / withLb.length : 3.5;
  for (const f of films) f.w = filmWeight(f, mean, lbMean);
  const avgW = films.length ? films.reduce((s, f) => s + f.w, 0) / films.length : 0;
  for (const f of films) f.w -= avgW;

  // Affinités + correspondance nom -> slug pour les réalisateurs / acteurs
  const acc = new Map(); // feature -> { sum, n, ratings: [] }
  const slugOf = new Map(); // "d:Nom" -> slug Letterboxd
  for (const f of films) {
    f.meta.directors.forEach((d, i) => f.meta.directorSlugs?.[i] && slugOf.set("d:" + d, f.meta.directorSlugs[i]));
    f.meta.actors.forEach((a, i) => f.meta.actorSlugs?.[i] && slugOf.set("a:" + a, f.meta.actorSlugs[i]));
    for (const feat of featuresOf(f.meta)) {
      const a = acc.get(feat) || { sum: 0, n: 0, ratings: [] };
      a.sum += f.w;
      a.n++;
      if (f.rating != null) a.ratings.push(f.rating);
      acc.set(feat, a);
    }
  }
  const affinity = new Map();
  for (const [feat, a] of acc) affinity.set(feat, a.sum / (a.n + 2)); // +2 : on se méfie des petits échantillons

  // Habitude : un genre que tu regardes bien plus souvent que la moyenne des films est un goût
  // en soi, même si tu le notes durement (ex. : beaucoup d'horreur, dont pas mal de navets).
  // On compare ta part de chaque genre à sa fréquence habituelle (sinon le drame, présent
  // partout, passerait pour une passion).
  const ratingAffinity = new Map(affinity);
  const habit = new Map();
  for (const [feat, a] of acc) {
    if (!feat.startsWith("g:")) continue;
    const share = a.n / Math.max(1, films.length);
    const base = GENRE_BASE[feat.slice(2)] ?? 0.08;
    const h = 0.3 * clamp(Math.log2(share / base), -0.5, 2) * (a.n / (a.n + 3));
    habit.set(feat, h);
    affinity.set(feat, affinity.get(feat) + h);
  }

  const statsFor = (prefix, minCount = 1) =>
    [...acc.entries()]
      .filter(([k, a]) => k.startsWith(prefix) && a.n >= minCount)
      .map(([k, a]) => ({
        name: k.slice(2),
        slug: slugOf.get(k) || null,
        count: a.n,
        avg: a.ratings.length ? round1(a.ratings.reduce((s, r) => s + r, 0) / a.ratings.length) : null,
        affinity: Math.round(affinity.get(k) * 100) / 100,
        ratingAffinity: Math.round(ratingAffinity.get(k) * 100) / 100,
        habit: Math.round((habit.get(k) || 0) * 100) / 100,
      }));

  const allGenres = statsFor("g:").sort((a, b) => b.count - a.count);
  const genres = allGenres;
  const minG = films.length > 40 ? 3 : 2;
  // Tu en regardes beaucoup mais tu les notes sous ta moyenne : ni "ton truc", ni "pas ton truc"
  const toughGenres = genres
    .filter((g) => g.count >= minG && g.ratingAffinity < -0.05 && g.affinity >= -0.05 && g.habit > 0.05)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
  const tough = new Set(toughGenres.map((g) => g.name));
  const lovedGenres = genres.filter((g) => g.count >= minG && g.affinity > 0.05 && !tough.has(g.name)).sort((a, b) => b.affinity - a.affinity).slice(0, 5);
  const dislikedGenres = genres.filter((g) => g.count >= minG && g.affinity < -0.05).sort((a, b) => a.affinity - b.affinity).slice(0, 4);

  const directors = statsFor("d:", 2).sort((a, b) => b.affinity - a.affinity || b.count - a.count);
  const actors = statsFor("a:", 2).sort((a, b) => b.affinity - a.affinity || b.count - a.count);
  const decades = statsFor("y:").sort((a, b) => a.name.localeCompare(b.name));
  const countries = statsFor("c:").sort((a, b) => b.count - a.count);
  const popularity = POP_TIERS.map(([, name]) => statsFor("p:").find((p) => p.name === name) || { name, count: 0, avg: null, affinity: 0 });

  const histogram = Array.from({ length: 10 }, (_, i) => rated.filter((f) => f.rating === (i + 1) / 2).length);
  const minutes = films.reduce((s, f) => s + (f.meta.runtime || 0), 0);

  // Films préférés : tes meilleures notes (+ like), départagées par la note Letterboxd
  const favScore = (f) => (f.rating ?? (f.liked ? 4 : 0)) + (f.liked ? 0.3 : 0) + (f.meta.avgRating || 0) * 0.05;
  const favourites = films
    .filter((f) => (f.rating ?? 0) >= mean || f.liked)
    .filter((f) => !f.meta.isTv && (f.meta.runtime || 90) >= 45)
    .sort((a, b) => favScore(b) - favScore(a))
    .slice(0, 4)
    .map((f) => card(f.meta, { rating: f.rating, liked: f.liked }));

  // Tes films les moins aimés : tes plus basses notes (hors likes), les plus connus d'abord à note égale
  const leastLiked = films
    .filter((f) => f.rating != null && f.rating < mean && !f.liked)
    .filter((f) => !f.meta.isTv && (f.meta.runtime || 90) >= 45)
    .sort((a, b) => a.rating - b.rating || (b.meta.ratingCount || 0) - (a.meta.ratingCount || 0))
    .slice(0, 4)
    .map((f) => card(f.meta, { rating: f.rating, liked: false }));

  // Avis à contre-courant : écart entre ta note et la moyenne Letterboxd
  const withDiff = films
    .filter((f) => f.rating != null && !f.meta.isTv && (f.meta.runtime || 90) >= 45 && f.meta.avgRating && f.meta.ratingCount > 500)
    .map((f) => ({ f, diff: f.rating - f.meta.avgRating }));
  const contraCard = ({ f, diff }) => card(f.meta, { rating: f.rating, liked: f.liked, diff: round1(diff) });
  const contrarian = {
    lovedMore: withDiff.filter((x) => x.diff >= 0.75).sort((a, b) => b.diff - a.diff).slice(0, 36).map(contraCard),
    lovedLess: withDiff.filter((x) => x.diff <= -0.75).sort((a, b) => a.diff - b.diff).slice(0, 36).map(contraCard),
    // Tes notes les plus proches du consensus, pour comparaison
    agreeRate: withDiff.length ? Math.round((withDiff.filter((x) => Math.abs(x.diff) <= 0.5).length / withDiff.length) * 100) : null,
  };

  // Grand public ou pépites ?
  const counts = films.map((f) => f.meta.ratingCount || 0).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const mainstream =
    median < 40000
      ? { label: "Chercheur de pépites", text: "Tu regardes beaucoup de films peu connus." }
      : median < 300000
      ? { label: "Entre classiques et découvertes", text: "Tu alternes grands films et œuvres plus confidentielles." }
      : { label: "Plutôt grand public", text: "Tu regardes surtout des films très vus." };

  const severity =
    mean < 2.9 ? "Tu notes sévèrement" : mean > 3.7 ? "Tu notes plutôt généreusement" : "Tu notes de façon assez équilibrée";

  return {
    films,
    mean,
    affinity,
    summary: {
      filmCount: userFilms.length,
      analysedCount: films.length,
      ratedCount: rated.length,
      likedCount: userFilms.filter((f) => f.liked).length,
      avgRating: round1(mean),
      hours: Math.round(minutes / 60),
      histogram,
      severity,
      topGenres: genres.slice(0, 8),
      allGenres: genres,
      lovedGenres,
      dislikedGenres,
      toughGenres,
      directors: directors.slice(0, 8),
      actors: actors.slice(0, 8),
      decades,
      countries: countries.slice(0, 6),
      popularity,
      mainstream: { ...mainstream, median },
      contrarian,
      favourites,
      leastLiked,
      backdrop: films.filter((f) => f.meta.backdrop && !f.meta.isTv).sort((a, b) => favScore(b) - favScore(a))[0]?.meta.backdrop || null,
    },
  };
}

// Réalisateurs et acteurs dont on va explorer la filmographie
function peopleToExplore(profile, { directors = 8, actors = 4 } = {}) {
  const s = profile.summary;
  const pick = (list, kind, n, min) =>
    list
      .filter((p) => p.slug && p.affinity >= min)
      .slice(0, n)
      .map((p) => ({ kind, slug: p.slug, name: p.name, affinity: p.affinity }));
  return [...pick(s.directors, "director", directors, 0.1), ...pick(s.actors, "actor", actors, 0.2)];
}

function card(meta, extra = {}) {
  return {
    slug: meta.slug,
    title: meta.title,
    year: meta.year,
    poster: meta.poster,
    backdrop: meta.backdrop,
    avgRating: meta.avgRating,
    ratingCount: meta.ratingCount || 0,
    runtime: meta.runtime,
    genres: meta.genres.map(genreFr),
    directors: meta.directors,
    countries: meta.countries,
    language: meta.language,
    url: `https://letterboxd.com/film/${meta.slug}/`,
    ...extra,
  };
}

// Ensemble de films reconnus par slug OU par titre + année
// (l'export CSV donne le titre/année de tous les films vus, sans le slug)
const normTitle = (t) =>
  String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
const filmKey = (title, year) => `${normTitle(title)}|${year || ""}`;

class FilmSet {
  constructor() {
    this.slugs = new Set();
    this.keys = new Set();
  }
  add({ slug, title, year }) {
    if (slug) this.slugs.add(slug);
    if (title) this.keys.add(filmKey(title, year));
    return this;
  }
  has({ slug, title, year }) {
    return (slug && this.slugs.has(slug)) || (title != null && this.keys.has(filmKey(title, year)));
  }
  get size() {
    return Math.max(this.slugs.size, this.keys.size);
  }
}

// Étape 1 : candidats. `people` = [{ kind, name, affinity, films: [{slug,title,year}] }]
function collectCandidates(profile, seen, people = []) {
  const votes = new Map();
  const vote = (s) => {
    if (!votes.has(s.slug))
      votes.set(s.slug, { slug: s.slug, title: s.title, year: s.year, score: 0, pos: 0, neg: 0, because: [], against: [], people: [], sources: new Set() });
    return votes.get(s.slug);
  };

  // a) Films similaires
  for (const f of profile.films) {
    if (Math.abs(f.w) < 0.1) continue;
    f.meta.similar.forEach((s, i) => {
      if (seen.has(s)) return;
      const v = vote(s);
      const contrib = f.w * (1 - i * 0.07);
      v.score += contrib;
      if (contrib > 0) {
        v.pos += contrib;
        v.because.push({ title: f.meta.title, w: contrib });
        v.sources.add("similar");
      } else {
        v.neg -= contrib;
        v.against.push({ title: f.meta.title, w: contrib });
      }
    });
  }

  // b) Filmographies de tes réalisateurs / acteurs préférés (triées par popularité)
  for (const p of people) {
    const max = p.kind === "director" ? 12 : 8;
    const strength = p.kind === "director" ? 1.6 : 0.8;
    p.films.slice(0, max).forEach((s, i) => {
      if (seen.has(s)) return;
      const v = vote(s);
      const contrib = p.affinity * strength * (1 - i * 0.04);
      v.score += contrib;
      v.pos += contrib;
      v.people.push({ kind: p.kind, name: p.name });
      v.sources.add(p.kind);
    });
  }

  return [...votes.values()].filter((v) => v.pos > 0).sort((a, b) => b.score - a.score);
}

// Note Letterboxd "corrigée" : peu de notes => on la rapproche d'une note moyenne
function bayesQuality(meta) {
  if (!meta.avgRating) return -0.2;
  const n = meta.ratingCount || 0;
  const C = 1500;
  return (meta.avgRating * n + 3.2 * C) / (n + C) - 3.4;
}

const gemThreshold = (profile) => clamp((profile.summary.mainstream.median || 0) / 5, 15000, 100000);

// Clé de saga : "The Lord of the Rings: The Two Towers" -> "thelordoftherings"
const franchiseKey = (title) => normTitle(String(title).split(/:| – | - /)[0].replace(/\s+(part\s+)?(\d+|ii|iii|iv)$/i, ""));

function scoreOne(profile, meta, c, maxVote, { watchlist } = {}) {
  const inWatchlist = watchlist ? watchlist.has(meta) : false;
  let num = 0;
  let den = 0;
  const matches = [];
  const clashes = [];
  for (const feat of featuresOf(meta)) {
    const fw = FEATURE_WEIGHT[feat[0]];
    const aff = profile.affinity.get(feat) ?? 0;
    num += fw * aff;
    den += fw;
    if (feat[0] !== "p" && aff * fw > 0.12) matches.push({ feat, v: aff * fw });
    if (feat[0] !== "p" && aff * fw < -0.12) clashes.push({ feat, v: aff * fw });
  }
  const content = den ? num / den : 0;
  const quality = bayesQuality(meta);
  const vote = maxVote ? c.score / maxVote : 0;
  const score = 0.5 * vote + 1.4 * content + 0.4 * quality + (inWatchlist ? 0.12 : 0);
  const label = (f) => f.feat.slice(2);
  const people = c.people || [];

  return {
    ...card(meta),
    score,
    content,
    inWatchlist,
    match: clamp(Math.round(100 / (1 + Math.exp(-3.2 * (score - 0.15)))), 30, 99),
    because: (c.because || [])
      .sort((a, b) => b.w - a.w)
      .map((b) => b.title)
      .filter((t, i, arr) => arr.indexOf(t) === i)
      .slice(0, 3),
    against: (c.against || []).sort((a, b) => a.w - b.w).map((b) => b.title).slice(0, 2),
    againstRatio: c.pos ? c.neg / c.pos : 0,
    byDirector: people.filter((p) => p.kind === "director").map((p) => p.name).filter((n, i, a) => a.indexOf(n) === i),
    withActor: people.filter((p) => p.kind === "actor").map((p) => p.name).filter((n, i, a) => a.indexOf(n) === i).slice(0, 2),
    sources: [...(c.sources || [])],
    // Pépite : bien noté et nettement moins vu que ce que tu regardes d'habitude
    gem: (meta.ratingCount || 0) < gemThreshold(profile) && (meta.avgRating || 0) >= 3.5,
    franchise: franchiseKey(meta.title),
    matches: matches.sort((a, b) => b.v - a.v).slice(0, 3).map(label),
    clashes: clashes.sort((a, b) => a.v - b.v).slice(0, 2).map(label),
    description: meta.description,
  };
}

// Un film "regardable" : sorti, pas une série, pas un court-métrage
function isEligible(meta) {
  if (!meta || meta.isTv) return false;
  if (meta.runtime != null && meta.runtime < 45) return false;
  if (meta.year && meta.year > CURRENT_YEAR) return false;
  return (meta.ratingCount || 0) >= 30;
}

// Diversification : on pénalise les films d'un réalisateur / d'une saga déjà proposés
function diversify(list) {
  const out = [];
  const rest = [...list];
  const dirCount = new Map();
  const sagaCount = new Map();
  while (rest.length) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const r = rest[i];
      const dirPenalty = r.directors.reduce((s, d) => s + (dirCount.get(d) || 0) * 0.12, 0);
      const sagaPenalty = (sagaCount.get(r.franchise) || 0) * 0.3;
      const adjusted = r.score - dirPenalty - sagaPenalty;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        best = i;
      }
    }
    const [pick] = rest.splice(best, 1);
    pick.directors.forEach((d) => dirCount.set(d, (dirCount.get(d) || 0) + 1));
    sagaCount.set(pick.franchise, (sagaCount.get(pick.franchise) || 0) + 1);
    out.push(pick);
  }
  return out;
}

// Étape 2 : score final une fois les fiches des candidats récupérées
function rankCandidates(profile, candidates, metaBySlug, { limit = 160, isSeen = () => false, watchlist = null, allowed = null } = {}) {
  const maxVote = Math.max(...candidates.map((c) => c.score), 0.01);
  const scored = [];
  for (const c of candidates) {
    const meta = metaBySlug.get(c.slug);
    if (!isEligible(meta) || isSeen(meta) || (allowed && !allowed.has(c.slug))) continue;
    scored.push(scoreOne(profile, meta, c, maxVote, { watchlist }));
  }

  scored.sort((a, b) => b.score - a.score);
  const avoided = scored
    .filter((s) => s.content < -0.06 || s.againstRatio > 0.6)
    .sort((a, b) => a.content - a.againstRatio * 0.2 - (b.content - b.againstRatio * 0.2))
    .slice(0, 6);
  const avoidedSet = new Set(avoided.map((a) => a.slug));
  const pool = diversify(scored.filter((s) => !avoidedSet.has(s.slug) && s.content > -0.05)).slice(0, limit);
  // Films restants (moins dans tes goûts) : servent seulement à remplir les rangées "par genre"
  const inPool = new Set(pool.map((p) => p.slug));
  const extras = scored.filter((s) => !inPool.has(s.slug) && !avoidedSet.has(s.slug)).slice(0, 120);
  return { pool, avoided, extras };
}

// Classe ta watchlist : quoi regarder en premier ?
function rankWatchlist(profile, slugs, metaBySlug, { isSeen = () => false } = {}) {
  return slugs
    .map((slug) => metaBySlug.get(slug))
    .filter((m) => isEligible(m) && !isSeen(m))
    // vote "moyen" (0,5) : tu l'as mis de côté toi-même, sans qu'on ait d'autre signal
    .map((m) => scoreOne(profile, m, { score: 0.5 }, 1, {}))
    .map((r) => ({ ...r, inWatchlist: true }))
    .sort((a, b) => b.score - a.score);
}

module.exports = { buildProfile, peopleToExplore, collectCandidates, rankCandidates, rankWatchlist, FilmSet };
