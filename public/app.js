const $ = (s, el = document) => el.querySelector(s);

const form = $("#form");
const input = $("#user");
const btn = form.querySelector("button");
const errorEl = $("#error");
const loader = $("#loader");
const loaderFill = $("#loader-fill");
const loaderLabel = $("#loader-label");
const results = $("#results");
const backdrop = $("#backdrop");
const modal = $("#modal");
const modalCard = $("#modal-card");

let current = null; // dernière analyse
let source = null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const img = (src) => `/img?src=${encodeURIComponent(src)}`;

function stars(r) {
  if (r == null) return "";
  return "★".repeat(Math.floor(r)) + (r % 1 ? "½" : "");
}
const fmt = (n) => String(n).replace(".", ",");
const listFr = (arr) => (arr.length < 2 ? arr.join("") : arr.slice(0, -1).join(", ") + " et " + arr[arr.length - 1]);

const fmtCount = (n) =>
  n >= 1e6 ? `${fmt((n / 1e6).toFixed(1))} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n || 0);
const seeOthers = (n) => (n === 1 ? "Voir l'autre film" : `Voir les ${n} autres`);
const fmtRuntime = (m) => (m ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : "");

// ---------- Films masqués : « Déjà vu » et « Pas pour moi » (mémorisés dans le navigateur) ----------
const hiddenKey = (kind, u) => `nextreel:${kind}:${u}`;
function getHidden(kind, u) {
  try {
    return new Set(JSON.parse(localStorage.getItem(hiddenKey(kind, u)) || "[]"));
  } catch {
    return new Set();
  }
}
function addHidden(kind, u, slug) {
  const s = getHidden(kind, u);
  s.add(slug);
  try {
    localStorage.setItem(hiddenKey(kind, u), JSON.stringify([...s]));
  } catch {}
}
function removeHidden(kind, u, slug) {
  const s = getHidden(kind, u);
  s.delete(slug);
  try {
    localStorage.setItem(hiddenKey(kind, u), JSON.stringify([...s]));
  } catch {}
}
const isHidden = (slug) => current && (getHidden("seen", current.user).has(slug) || getHidden("nope", current.user).has(slug));

// ---------- Analyse ----------
function start(user) {
  user = user.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, "").split("/")[0].toLowerCase();
  if (!user) return;
  input.value = user;
  history.replaceState(null, "", `?u=${encodeURIComponent(user)}`);
  begin("Connexion à Letterboxd…");
  if (hasExtension()) return startWithExtension(user);
  listen(`/api/analyse?user=${encodeURIComponent(user)}`);
}

// ---------- Extension Chrome Matchboxd ----------
// Si elle est installée, c'est ton navigateur qui lit toutes les pages de ton profil.
const hasExtension = () => Boolean(document.documentElement.dataset.nextreelExtension);

function readWithExtension(user, onProgress) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const onMessage = (e) => {
      const msg = e.data;
      if (e.source !== window || !msg || msg.source !== "nextreel-ext" || msg.id !== id) return;
      if (msg.type === "progress") return onProgress(msg);
      removeEventListener("message", onMessage);
      if (msg.type === "result") resolve(msg);
      else reject(Object.assign(new Error(msg.message || "L'extension n'a pas pu lire ton profil."), { notFound: msg.notFound }));
    };
    addEventListener("message", onMessage);
    postMessage({ source: "nextreel-page", type: "read", id, user }, location.origin);
  });
}

async function startWithExtension(user) {
  const READ_SHARE = 35; // part de la barre pour la lecture de Letterboxd
  try {
    const { films, watchlist } = await readWithExtension(user, (p) => setProgress((p.pct * READ_SHARE) / 100, p.label));
    setProgress(READ_SHARE, `${films.length} films lus sur ton profil, analyse…`);
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: user,
        films: films.map(([slug, rating10, liked]) => ({ slug, rating: rating10 ? rating10 / 2 : null, liked: liked === 1 })),
        watchlist: (watchlist || []).map((slug) => ({ slug })),
        via: "extension",
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Le serveur a refusé l'analyse.");
    listen(`/api/analyse?job=${encodeURIComponent(body.job)}`, { offset: READ_SHARE });
  } catch (err) {
    if (err.notFound) {
      finish();
      return showError(`Aucun compte Letterboxd « ${user} ». Vérifie l'orthographe.`);
    }
    // L'extension n'a pas pu lire : on retombe sur la lecture partielle par le serveur
    setProgress(3, `${err.message} Lecture partielle à la place…`);
    listen(`/api/analyse?user=${encodeURIComponent(user)}`);
  }
}

async function startImport(files) {
  if (!files.length) return;
  begin("Lecture de ton export…");
  history.replaceState(null, "", "/");
  try {
    const payload = await readLetterboxdExport(files);
    setProgress(2, `${payload.films.length} films trouvés dans ton export, envoi…`);
    await sendImport({ ...payload, via: "export" });
  } catch (err) {
    finish();
    showError(err.message);
  }
}

async function sendImport(payload) {
  const res = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Le serveur a refusé l'import.");
  listen(`/api/analyse?job=${encodeURIComponent(body.job)}`);
}

// Arrivée depuis le favori Matchboxd : la liste complète est dans l'adresse (#import=…, gzip + base64url)
async function receiveFromLetterboxd(encoded) {
  history.replaceState(null, "", "/");
  begin("Lecture de la liste envoyée par Letterboxd…");
  try {
    const bin = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const { u, f, w } = JSON.parse(await new Response(stream).text());
    if (u) input.value = u;
    const films = (f || []).map(([slug, rating10, liked]) => ({ slug, rating: rating10 ? rating10 / 2 : null, liked: liked === 1 }));
    setProgress(3, `${films.length} films lus sur ton profil, analyse…`);
    await sendImport({ username: u, films, watchlist: (w || []).map((slug) => ({ slug })), via: "letterboxd" });
  } catch (err) {
    finish();
    showError(err instanceof SyntaxError || err.name === "InvalidCharacterError" ? "La liste reçue de Letterboxd est illisible. Relance le favori depuis ta page Letterboxd." : err.message);
  }
}

function begin(label) {
  source?.close();
  errorEl.hidden = true;
  loader.hidden = false;
  btn.disabled = true;
  reelReset();
  setProgress(1, label, "read");
}

function listen(url, { offset = 0 } = {}) {
  source = new EventSource(url);
  source.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    setProgress(offset + (p.pct * (100 - offset)) / 100, p.label, p.step);
    if (p.poster) reelAdd(p.poster, p.title); // l'affiche du film qu'on vient de lire défile
  });
  source.addEventListener("result", (e) => {
    finish();
    current = JSON.parse(e.data);
    render(current);
  });
  source.addEventListener("fail", (e) => {
    finish();
    showError(JSON.parse(e.data).message);
  });
  source.onerror = () => {
    if (!source) return;
    finish();
    showError("Connexion perdue avec le serveur.");
  };
}

function finish() {
  source?.close();
  source = null;
  btn.disabled = false;
  setProgress(100, "Terminé", "done");
  loader.classList.add("finished");
  setTimeout(() => {
    loader.hidden = true;
    loader.classList.remove("finished");
  }, reduceMotion ? 0 : 450);
}
// Étapes affichées sous les trois points pendant l'analyse
const STEP_OF = { profile: "read", links: "read", films: "films", taste: "films", people: "explore", explore: "explore", candidates: "explore", rank: "rank", watchlist: "rank" };
const STEP_ORDER = ["read", "films", "explore", "rank"];
function setStep(step) {
  const idx = step === "done" ? STEP_ORDER.length : STEP_ORDER.indexOf(step);
  document.querySelectorAll("#steps li").forEach((li, i) => {
    li.classList.toggle("done", i < idx);
    li.classList.toggle("active", i === idx);
  });
}

function setProgress(pct, label, step) {
  loaderFill.style.width = pct + "%";
  if (loaderLabel.textContent !== label) {
    loaderLabel.textContent = label;
    loaderLabel.classList.remove("swap");
    void loaderLabel.offsetWidth;
    loaderLabel.classList.add("swap");
  }
  if (step) setStep(STEP_OF[step] || step);
}
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  start(input.value);
});

// Import : clic ou glisser-déposer
const fileInput = $("#file");
const dropzone = $("#dropzone");
fileInput.addEventListener("change", () => {
  startImport([...fileInput.files]);
  fileInput.value = "";
});
["dragenter", "dragover"].forEach((t) =>
  dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    dropzone.classList.add("over");
  })
);
["dragleave", "drop"].forEach((t) => dropzone.addEventListener(t, () => dropzone.classList.remove("over")));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  startImport([...e.dataTransfer.files]);
});

// ---------- Couleurs ----------
// Une couleur par genre, pour se repérer d'un coup d'œil (étiquettes, rangées, fiche film)
const GENRE_COLORS = {
  Action: "#ff8000",
  Aventure: "#f2b134",
  Animation: "#ff7eb6",
  Comédie: "#ffd84d",
  Policier: "#9aa7bd",
  Documentaire: "#6fcf97",
  Drame: "#40bcf4",
  Famille: "#7fe0b0",
  Fantastique: "#b48cff",
  Histoire: "#c9a57d",
  Horreur: "#ff4d5e",
  Musique: "#ff6fd8",
  Mystère: "#8b93ff",
  Romance: "#ff8fa6",
  "Science-fiction": "#00e0c6",
  Thriller: "#e4e9ef",
  Guerre: "#a3ad74",
  Western: "#d99a5b",
  Téléfilm: "#778899",
};
const genreColor = (g) => GENRE_COLORS[g] || "#9ab";
const genreDot = (g) => `<i class="gdot" style="--g:${genreColor(g)}"></i>`;

// Couleur dominante d'une affiche (via notre proxy d'images : même origine, donc lisible par un canvas)
const colorCache = new Map();
function filmColor(f) {
  if (!f.poster) return Promise.resolve(null);
  if (colorCache.has(f.slug)) return colorCache.get(f.slug);
  const p = new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 12;
        c.height = 18;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(im, 0, 0, 12, 18);
        const d = ctx.getImageData(0, 0, 12, 18).data;
        // Moyenne pondérée par la saturation : on veut la couleur "vivante" de l'affiche
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]);
          const min = Math.min(d[i], d[i + 1], d[i + 2]);
          const weight = (max - min) / 255 + 0.05;
          r += d[i] * weight;
          g += d[i + 1] * weight;
          b += d[i + 2] * weight;
          w += weight;
        }
        const [h, s] = rgbToHsl(r / w, g / w, b / w);
        // Toujours lisible sur fond sombre : saturation et luminosité recadrées
        resolve(`hsl(${Math.round(h)} ${Math.round(Math.min(75, Math.max(s, 45)))}% 60%)`);
      } catch {
        resolve(null);
      }
    };
    im.onerror = () => resolve(null);
    im.src = img(f.poster);
  });
  colorCache.set(f.slug, p);
  return p;
}
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

// Au survol d'une affiche, une lueur de sa propre couleur
results.addEventListener("pointerover", (e) => {
  const card = e.target.closest(".film[data-slug]");
  if (!card || card.style.getPropertyValue("--glow") || !current) return;
  const f = findFilm(card.dataset.slug, card.dataset.kind);
  if (f) filmColor(f).then((c) => c && card.style.setProperty("--glow", c));
});

// ---------- Notifications ----------
let toastTimer = null;
function toast(text, { action, onAction } = {}) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  if (action) el.querySelector("button").onclick = () => (onAction(), hideToast());
  el.classList.remove("out");
  el.classList.add("in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() {
  const el = $("#toast");
  if (!el) return;
  el.classList.remove("in");
  el.classList.add("out");
}

// ---------- Rendu ----------
function poster(f, { badge = "", info = false } = {}) {
  const tag = f.poster
    ? `<img src="${esc(img(f.poster))}" alt="" loading="lazy" onload="this.classList.add('loaded')" onerror="this.remove()">`
    : "";
  // Infos rapides qui glissent au survol (note Letterboxd, durée)
  const overlay = info
    ? `<div class="poster-info">${f.avgRating ? `<span class="pi-rating">★ ${fmt(f.avgRating.toFixed(1))}</span>` : ""}${f.runtime ? `<span>${fmtRuntime(f.runtime)}</span>` : ""}</div>`
    : "";
  return `<div class="poster">${badge}<div class="poster-fallback">${esc(f.title)}</div>${tag}${overlay}</div>`;
}

function whyShort(f) {
  if (f.byDirector?.length) return `Réalisé par ${esc(f.byDirector[0])}`;
  if (f.because?.length) return `Parce que t'as aimé ${esc(f.because[0])}`;
  if (f.withActor?.length) return `Avec ${esc(f.withActor[0])}`;
  return esc((f.matches || []).join(" · "));
}

const matchClass = (m) => (m >= 80 ? "hi" : m >= 60 ? "mid" : "lo");

function recCard(f, kind = "rec", i = 0, rank = null) {
  const badges =
    (kind !== "avoided" ? `<span class="match ${matchClass(f.match)}${f.match >= 90 ? " top" : ""}">${f.match}%</span>` : "") +
    (rank != null ? `<span class="rank">#${rank}</span>` : "") +
    (f.inWatchlist && kind !== "watchlist" ? '<span class="badge-wl">Watchlist</span>' : f.gem && kind !== "gems" ? '<span class="badge-gem">Pépite</span>' : "");
  return `<button class="film" style="--i:${Math.min(i, 30)}" data-slug="${esc(f.slug)}" data-kind="${kind}" aria-label="${esc(f.title)}">
    ${poster(f, { badge: badges, info: kind !== "avoided" })}
    <div class="rec-meta">
      <div class="rec-title">${esc(f.title)} <span class="rec-year">${f.year ?? ""}</span></div>
      ${kind === "avoided" ? "" : `<div class="rec-why">${whyShort(f)}</div>`}
    </div>
  </button>`;
}

// Une colonne « préférés » ou « moins aimés » du profil
function tasteCol(kind, title, films, delay) {
  return `<div class="taste-col ${kind}">
    <h3 class="section-heading">${title}</h3>
    ${
      films.length
        ? `<div class="favs">${films
            .map(
              (f, i) => `<a class="film" style="--i:${i + delay}" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.title)}">${poster(f)}
              <div class="stars">${stars(f.rating)}${f.liked ? '<span class="like">♥</span>' : ""}</div></a>`
            )
            .join("")}</div>`
        : `<p class="empty small">Pas assez de films notés sous ta moyenne pour l'instant.</p>`
    }
  </div>`;
}

function bars(items, { max, valueOf, classOf, dot = false }) {
  return `<ul class="bars">${items
    .map(
      (g) => `<li>
        <span class="name" title="${esc(g.name)}">${dot ? genreDot(g.name) : ""}${esc(g.name)}</span>
        <span class="track"><span class="fill ${classOf(g)}" style="width:${Math.max(4, (g.count / max) * 100)}%"></span></span>
        <span class="val">${valueOf(g)}</span>
      </li>`
    )
    .join("")}</ul>`;
}

// ---------- Onglets de recommandations ----------
const GENRE_PAGE = 18; // films affichés d'emblée pour un genre (3 rangées)
const ui = { tab: "foryou", genre: "", decade: "", duration: "", shown: 24, genrePick: "", genreShown: GENRE_PAGE, gDecade: "", gDuration: "" };

const visible = (list) => list.filter((f) => !isHidden(f.slug));
const decadeOf = (f) => (f.year ? `${Math.floor(f.year / 10) * 10}s` : "");

function forYouList() {
  return visible(current.pool).filter((f) => (!ui.genre || f.genres.includes(ui.genre)) && matchesFilters(f, "decade", "duration"));
}

function row(title, sub, films, kind = "rec", color = null) {
  if (!films.length) return "";
  return `<section class="row${color ? " genre-row" : ""}"${color ? ` style="--g:${color}"` : ""}>
    <h4 class="row-title">${title}${sub ? ` <small>${sub}</small>` : ""}</h4>
    <div class="row-scroll">${films.map((f, i) => recCard(f, kind, i)).join("")}</div>
  </section>`;
}

function empty(text) {
  return `<p class="empty">${text}</p>`;
}

// ---------- Filtres communs (époque / durée) ----------
const opt = (v, label, sel) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(label)}</option>`;
const decadeSelect = (key, decades) =>
  `<label>Époque <select data-filter="${key}">${opt("", "Toutes", ui[key])}${decades.map((d) => opt(d, `Années ${d.slice(0, 4)}`, ui[key])).join("")}</select></label>`;
const durationSelect = (key) =>
  `<label>Durée <select data-filter="${key}">${opt("", "Peu importe", ui[key])}${opt("105", "Moins de 1h45", ui[key])}${opt("135", "Moins de 2h15", ui[key])}</select></label>`;
const decadesOf = (films) => [...new Set(films.map(decadeOf).filter(Boolean))].sort().reverse();
const matchesFilters = (f, decadeKey, durationKey) =>
  (!ui[decadeKey] || decadeOf(f) === ui[decadeKey]) && (!ui[durationKey] || (f.runtime && f.runtime <= +ui[durationKey]));
const filmCount = (n) => `${n} film${n > 1 ? "s" : ""}`;

const TABS = {
  foryou: {
    label: "Pour toi",
    render() {
      const pool = visible(current.pool);
      const genres = [...new Set(pool.flatMap((f) => f.genres))]
        .map((g) => ({ g, aff: current.profile.topGenres.find((t) => t.name === g)?.affinity ?? -1 }))
        .sort((a, b) => b.aff - a.aff)
        .map((x) => x.g);
      const list = forYouList();
      return `
        <div class="filters">
          <label>Genre <select data-filter="genre">${opt("", "Tous", ui.genre)}${genres.map((g) => opt(g, g, ui.genre)).join("")}</select></label>
          ${decadeSelect("decade", decadesOf(pool))}
          ${durationSelect("duration")}
          <span class="filters-count">${filmCount(list.length)}</span>
          ${ui.genre || ui.decade || ui.duration ? '<button type="button" class="link-btn" data-reset>Réinitialiser</button>' : ""}
        </div>
        ${
          list.length
            ? `<div class="grid">${list.slice(0, ui.shown).map((f, i) => recCard(f, "rec", i)).join("")}</div>
               ${list.length > ui.shown ? '<div class="more"><button type="button" class="btn btn-ghost btn-sm" data-more>Voir plus</button></div>' : ""}`
            : empty("Aucun film ne correspond à ces filtres. Essaie d'en enlever un.")
        }`;
    },
  },
  genres: {
    label: "Par genre",
    // Un sélecteur de genres (du plus apprécié au moins apprécié) + les films du genre choisi
    render() {
      const p = current.profile;
      const stats = p.allGenres || p.topGenres;
      const tough = new Set((p.toughGenres || []).map((g) => g.name));
      const all = [...visible(current.pool), ...visible(current.extras || [])];
      const affinityOf = (name) => stats.find((g) => g.name === name)?.affinity ?? -0.2;
      const genres = [...new Set(all.flatMap((f) => f.genres))]
        .filter((g) => g !== "Téléfilm")
        .map((name) => {
          const pool = visible(current.pool).filter((f) => f.genres.includes(name)).sort((a, b) => b.score - a.score);
          const extras = visible(current.extras || []).filter((f) => f.genres.includes(name)).sort((a, b) => b.score - a.score);
          const films = [...pool, ...extras];
          // `shown` : les films du genre qui passent les filtres époque / durée
          return { name, films, shown: films.filter((f) => matchesFilters(f, "gDecade", "gDuration")), stat: stats.find((g) => g.name === name) };
        })
        .filter((g) => g.films.length >= 3)
        .sort((a, b) => affinityOf(b.name) - affinityOf(a.name));
      if (!genres.length) return empty("Pas encore assez de films par genre.");

      if (!genres.some((g) => g.name === ui.genrePick)) ui.genrePick = genres[0].name;
      const sel = genres.find((g) => g.name === ui.genrePick);
      const kindOf = (g) => (tough.has(g.name) ? "tough" : g.stat && g.stat.affinity < -0.05 ? "neg" : g.stat && g.stat.affinity > 0.05 ? "pos" : "");
      const TAGS = { pos: "ton truc", neg: "moins ton truc", tough: "tu en regardes beaucoup, tu es dur avec" };
      const filtered = Boolean(ui.gDecade || ui.gDuration);

      const picker = genres
        .map(
          (g) => `<button type="button" class="gpick ${kindOf(g)}${g.shown.length ? "" : " none"}" data-pick-genre="${esc(g.name)}" aria-pressed="${g.name === sel.name}" style="--g:${genreColor(g.name)}">
            <i class="gdot"></i>${esc(g.name)}<small>${g.shown.length}</small>
          </button>`
        )
        .join("");
      const s = sel.stat;
      const kind = kindOf(sel);
      const sub = s ? `${s.avg != null ? `ta moyenne : ${fmt(s.avg)}★ · ` : ""}${s.count} film${s.count > 1 ? "s" : ""} vus` : "genre peu exploré";
      const list = sel.shown;

      return `
        <div class="genre-picker" role="tablist" aria-label="Choisis un genre">${picker}</div>
        <div class="filters">
          ${decadeSelect("gDecade", decadesOf(genres.flatMap((g) => g.films)))}
          ${durationSelect("gDuration")}
          <span class="filters-count">${filmCount(list.length)}${filtered ? ` sur ${sel.films.length}` : ""}</span>
          ${filtered ? '<button type="button" class="link-btn" data-reset-genre-filters>Réinitialiser</button>' : ""}
        </div>
        <section class="genre-view" style="--g:${genreColor(sel.name)}">
          <h4 class="genre-view-title">${genreDot(sel.name)}${esc(sel.name)}
            ${kind ? `<span class="row-tag ${kind}">${TAGS[kind]}</span>` : ""}
            <small>${sub} · ${filmCount(list.length)} à découvrir</small>
          </h4>
          ${
            list.length
              ? `<div class="grid">${list.slice(0, ui.genreShown).map((f, i) => recCard(f, "rec", i)).join("")}</div>
                 ${
                   list.length > ui.genreShown
                     ? `<div class="more"><button type="button" class="btn btn-ghost btn-sm" data-genre-more>${seeOthers(list.length - ui.genreShown)}</button></div>`
                     : ""
                 }`
              : empty("Aucun film de ce genre ne correspond à ces filtres. Essaie une autre époque ou une autre durée.")
          }
        </section>`;
    },
  },
  directors: {
    label: "Tes réalisateurs",
    render() {
      const rows = current.profile.directors
        .filter((d) => d.affinity > 0)
        .map((d) => {
          const films = visible(current.pool).filter((f) => f.directors.includes(d.name)).sort((a, b) => b.score - a.score);
          return row(esc(d.name), `${d.avg != null ? `${fmt(d.avg)}★ en moyenne · ` : ""}${d.count} films vus`, films);
        });
      return (
        rows.join("") ||
        empty("Aucun film à te proposer de tes réalisateurs préférés : soit tu les as tous vus, soit il faut noter un peu plus de leurs films.")
      );
    },
  },
  gems: {
    label: "Pépites",
    render() {
      const gems = visible(current.pool).filter((f) => f.gem);
      return `<p class="tab-intro">Des films bien notés mais beaucoup moins vus que ce que tu regardes d'habitude. Les découvertes à faire tourner.</p>
        ${gems.length ? `<div class="grid">${gems.map((f, i) => recCard(f, "gems", i)).join("")}</div>` : empty("Pas de pépite repérée cette fois-ci.")}`;
    },
  },
  watchlist: {
    label: "Ta watchlist",
    render() {
      const list = visible(current.watchlistRanked || []);
      if (!list.length) {
        return empty(
          current.source === "import" && current.via === "export"
            ? "L'export ne permet pas de classer ta watchlist. Utilise l'extension ou le favori pour en profiter."
            : "Ta watchlist est vide ou n'a pas pu être lue."
        );
      }
      const note = current.watchlistPartial
        ? current.source === "profile"
          ? " (première page seulement : installe l'extension pour la classer en entier)"
          : ` (les ${list.length} premiers films)`
        : "";
      return `<p class="tab-intro">Ta watchlist classée selon tes goûts : commence par le haut${note}.</p>
        <div class="grid">${list.map((f, i) => recCard(f, "watchlist", i, i + 1)).join("")}</div>`;
    },
  },
};

function renderRecs({ animate = true, dir = 0 } = {}) {
  const panel = $("#recs-panel");
  if (!panel) return;
  $("#recs-tabs")
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === ui.tab)));
  panel.innerHTML = TABS[ui.tab].render();
  // Entrée du panneau : glisse depuis la droite ou la gauche selon l'onglet choisi
  panel.classList.remove("enter", "from-left", "from-right", "still");
  void panel.offsetWidth;
  panel.classList.add(animate ? "enter" : "still");
  if (dir) panel.classList.add(dir > 0 ? "from-right" : "from-left");
  moveTabInk();
  // Ambiance : la page prend la couleur du genre choisi dans « Par genre »
  setAmbient(ui.tab === "genres" && ui.genrePick ? genreColor(ui.genrePick) : null, { base: true });
}

function render(data, { scroll = true } = {}) {
  const p = data.profile;
  const isImport = data.source === "import";
  document.body.classList.add("has-results");
  if (scroll) Object.assign(ui, { tab: "foryou", genre: "", decade: "", duration: "", shown: 24, genrePick: "", genreShown: GENRE_PAGE, gDecade: "", gDuration: "" }); // nouvelle analyse

  if (p.backdrop) {
    backdrop.style.backgroundImage = `url("${img(p.backdrop)}")`;
    backdrop.classList.add("on");
  }

  const maxHisto = Math.max(...p.histogram, 1);
  const maxGenre = Math.max(...p.topGenres.map((g) => g.count), 1);
  const maxDecade = Math.max(...p.decades.map((d) => d.count), 1);
  const maxPop = Math.max(...p.popularity.map((d) => d.count), 1);
  const tasteClass = (g) => (g.affinity > 0.05 ? "pos" : g.affinity < -0.05 ? "neg" : "");

  const loved = p.lovedGenres.map((g) => g.name);
  const headline = loved.length
    ? `Ton truc : ${listFr(loved.slice(0, 3).map((g) => g.toLowerCase()))}${p.directors[0] && p.directors[0].affinity > 0 ? `, et ${p.directors[0].name}` : ""}. ${p.severity} (${fmt(p.avgRating)}★ de moyenne).`
    : `${p.severity} (${fmt(p.avgRating)}★ de moyenne).`;

  const wlCount = (data.watchlistRanked || []).length;
  const contrarianCard = (f, i) => `<a class="film" style="--i:${i % 6}" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.title)}">${poster(f, {
    badge: `<span class="diff ${f.diff > 0 ? "up" : "down"}">${f.diff > 0 ? "+" : "−"}${fmt(Math.abs(f.diff).toFixed(1))}</span>`,
  })}
    <div class="contra-note"><span class="stars">${stars(f.rating)}</span><span class="vs">LB ${fmt(f.avgRating.toFixed(1))}</span></div></a>`;
  const CONTRA_FIRST = 6;
  const contraList = (list, key, title) =>
    list.length
      ? `<p class="label">${title}</p>
        <div class="contra">${list.slice(0, CONTRA_FIRST).map(contrarianCard).join("")}</div>
        ${
          list.length > CONTRA_FIRST
            ? `<div class="contra contra-more" id="contra-${key}" hidden>${list.slice(CONTRA_FIRST).map((f, i) => contrarianCard(f, i)).join("")}</div>
               <button type="button" class="link-btn expand" data-expand="contra-${key}" data-count="${list.length - CONTRA_FIRST}">${seeOthers(list.length - CONTRA_FIRST)}</button>`
            : ""
        }`
      : "";

  const member = data.member || {};
  const name = member.displayName || data.user;

  results.innerHTML = `
    <div class="profile">
      <div class="avatar" aria-hidden="true">${
        member.avatar ? `<img src="${esc(img(member.avatar))}" alt="" onload="this.classList.add('loaded')" onerror="this.remove()">` : ""
      }<span>${esc(name[0].toUpperCase())}</span></div>
      <div class="profile-id">
        ${isImport ? '<span class="source-pill">Historique complet</span>' : ""}
        <h2 class="profile-name">${esc(name)}${name.toLowerCase() !== data.user.toLowerCase() ? ` <small>@${esc(data.user)}</small>` : ""}</h2>
        <p class="profile-tag" id="profile-tag">${esc(headline)}</p>
        <button type="button" class="share-btn" data-share><span aria-hidden="true">✦</span> Ma carte ciné</button>
      </div>
      <div class="profile-stats">
        <div class="stat"><b data-count="${isImport ? p.filmCount : p.analysedCount}">0</b><span>${isImport ? "Films vus" : "Films lus"}</span></div>
        <div class="stat"><b data-count="${p.avgRating}" data-decimals="1">0</b><span>Note moy.</span></div>
        <div class="stat"><b data-count="${p.hours}">0</b><span>Heures</span></div>
        <div class="stat"><b data-count="${p.likedCount}">0</b><span>Likes</span></div>
      </div>
    </div>

    ${
      !isImport && p.estimatedTotal > p.analysedCount * 1.3
        ? `<div class="callout">
      <div>
        <strong>Profil partiel : ${p.analysedCount} films lus sur environ ${p.estimatedTotal}.</strong>
        <span>Avec juste le pseudo, Letterboxd ne laisse lire que ta première page de films. Tes recos restent sûres (chacune est vérifiée : pas encore vue), mais tes goûts sont calculés sur une partie de tes films. ${
          hasExtension()
            ? "L'extension Matchboxd n'a pas réussi à lire toutes tes pages cette fois : relance l'analyse dans un instant."
            : "Installe l'extension Matchboxd pour qu'ils le soient sur tous tes films, avec juste ton pseudo."
        }</span>
      </div>
      ${hasExtension() ? "" : '<button class="btn btn-ghost btn-sm" type="button" data-import>Installer l\'extension</button>'}
    </div>`
        : ""
    }

    ${
      p.favourites.length || (p.leastLiked || []).length
        ? `<div class="block taste-ends">
      ${tasteCol("love", isImport ? "Tes films préférés" : "Tes coups de cœur récents", p.favourites, 0)}
      ${tasteCol("hate", isImport ? "Tes films les moins aimés" : "Tes déceptions récentes", p.leastLiked || [], 4)}
      <p class="taste-note">Matchboxd s'appuie sur les deux : on cherche ce qui ressemble à tes coups de cœur, et on écarte ce qui ressemble à tes déceptions.</p>
    </div>`
        : ""
    }

    <div class="block recs">
      <div class="recs-head">
        <div class="tabs" id="recs-tabs" role="tablist">
          ${Object.entries(TABS)
            .map(
              ([key, t]) =>
                `<button type="button" role="tab" class="tab" data-tab="${key}">${t.label}${key === "watchlist" && wlCount ? ` <small>${wlCount}</small>` : ""}</button>`
            )
            .join("")}
          <span class="tab-ink" id="tab-ink" aria-hidden="true"></span>
        </div>
        <button type="button" class="btn btn-green btn-sm surprise" data-surprise><span class="dice" aria-hidden="true"></span>Surprends-moi</button>
      </div>
      <div id="recs-panel" role="tabpanel"></div>
    </div>

    <div class="cols">
      <div>
        <div class="block">
          <h3 class="section-heading">Tes goûts</h3>
          ${loved.length ? `<p class="label">Tu notes ces genres au-dessus de ta moyenne</p><div class="chips">${p.lovedGenres.map((g) => `<span class="chip pos">${genreDot(g.name)}${esc(g.name)}<small>${g.avg != null ? fmt(g.avg) + "★" : ""}</small></span>`).join("")}</div>` : ""}
          ${(p.toughGenres || []).length ? `<p class="label">Tu en regardes beaucoup, mais tu les notes durement</p><div class="chips">${p.toughGenres.map((g) => `<span class="chip tough">${genreDot(g.name)}${esc(g.name)}<small>${g.count} films · ${g.avg != null ? fmt(g.avg) + "★" : ""}</small></span>`).join("")}</div>` : ""}
          ${p.dislikedGenres.length ? `<p class="label">Pas trop ton truc</p><div class="chips">${p.dislikedGenres.map((g) => `<span class="chip neg">${genreDot(g.name)}${esc(g.name)}<small>${g.avg != null ? fmt(g.avg) + "★" : ""}</small></span>`).join("")}</div>` : ""}
        </div>
        <div class="block">
          <h3 class="section-heading">Genres que tu regardes le plus <small>barre = nb de films · note moyenne</small></h3>
          ${bars(p.topGenres, { max: maxGenre, classOf: tasteClass, dot: true, valueOf: (g) => (g.avg != null ? fmt(g.avg) + "★" : g.count) })}
        </div>
        ${
          p.contrarian.lovedMore.length || p.contrarian.lovedLess.length
            ? `<div class="block">
          <h3 class="section-heading">Tes avis à contre-courant <small>ta note vs la moyenne Letterboxd</small></h3>
          ${p.contrarian.agreeRate != null ? `<p class="agree">Tu es d'accord avec Letterboxd (à une demi-étoile près) sur <b>${p.contrarian.agreeRate} %</b> de tes films.</p>` : ""}
          ${contraList(p.contrarian.lovedMore, "more", `Tu as adoré, Letterboxd beaucoup moins <small>${p.contrarian.lovedMore.length}</small>`)}
          ${contraList(p.contrarian.lovedLess, "less", `Letterboxd adore, toi pas trop <small>${p.contrarian.lovedLess.length}</small>`)}
        </div>`
            : ""
        }
        ${
          data.avoided.length
            ? `<div class="block avoided">
          <h3 class="section-heading">On t'a évité ça <small>proche de tes films, mais ça ressemble à ce que tu n'aimes pas</small></h3>
          <div class="grid">${data.avoided.map((f, i) => recCard(f, "avoided", i)).join("")}</div>
        </div>`
            : ""
        }
      </div>

      <aside>
        <div class="block">
          <h3 class="section-heading">Tes notes <small>${p.ratedCount} films notés</small></h3>
          <div class="histo">${p.histogram.map((n, i) => `<span style="height:${(n / maxHisto) * 100}%" title="${stars((i + 1) / 2)} : ${n} film${n > 1 ? "s" : ""}"></span>`).join("")}</div>
          <div class="histo-axis"><span>★</span><span>★★★★★</span></div>
        </div>
        <div class="block">
          <h3 class="section-heading">Grand public ou pépites ?</h3>
          <p class="mainstream"><b>${esc(p.mainstream.label)}</b>${esc(p.mainstream.text)}</p>
          ${bars(p.popularity, { max: maxPop, classOf: tasteClass, valueOf: (d) => (d.avg != null ? fmt(d.avg) + "★" : d.count) })}
        </div>
        ${
          p.directors.length
            ? `<div class="block">
          <h3 class="section-heading">Réalisateurs</h3>
          <ul class="list-plain">${p.directors.map((d) => `<li><span>${esc(d.name)}</span><span>${d.avg != null ? fmt(d.avg) + "★ · " : ""}${d.count} films</span></li>`).join("")}</ul>
        </div>`
            : ""
        }
        <div class="block">
          <h3 class="section-heading">Décennies</h3>
          ${bars(p.decades, { max: maxDecade, classOf: tasteClass, valueOf: (d) => d.count })}
        </div>
        <div class="block">
          <h3 class="section-heading">Pays</h3>
          <ul class="list-plain">${p.countries.map((c) => `<li><span>${esc(c.name)}</span><span>${c.count} films</span></li>`).join("")}</ul>
        </div>
      </aside>
    </div>

    <p class="notice">${
      isImport
        ? `Analyse basée sur tous tes films${data.via === "export" ? ", d'après ton export" : ", lus directement sur ton profil"} : ${p.filmCount} films vus et ${p.ratedCount} notes. Les ${p.analysedCount} films qui en disent le plus sur toi (notes les plus marquées, likes) ont été analysés en détail. Aucun film déjà vu n'est recommandé.`
        : `Chaque film recommandé a été vérifié sur ton compte : tu ne l'as pas encore vu. Profil calculé sur ${p.analysedCount} de tes films : ta première page de films et ton journal récent${p.discovered ? `, plus ${p.discovered} retrouvés en vérifiant des films proches de tes goûts` : ""}.`
    } Recos tirées des films similaires à ceux que tu as aimés et des filmographies de tes réalisateurs et acteurs préférés.</p>
  `;
  results.hidden = false;
  renderRecs();
  results.querySelectorAll("[data-count]").forEach(countUp);
  if (scroll) typeText($("#profile-tag"), headline); // ce que le site a compris de toi, écrit sous tes yeux
  revealOnScroll();
  if (scroll) results.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Petites animations ----------
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Les chiffres du profil défilent jusqu'à leur valeur
function countUp(el) {
  const target = +el.dataset.count;
  const decimals = +(el.dataset.decimals || 0);
  const suffix = el.dataset.suffix || "";
  const show = (v) => (el.textContent = fmt(v.toFixed(decimals)) + suffix);
  if (reduceMotion || !target) return show(target || 0);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 900);
    show(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Effet machine à écrire (≈ 1,4 s quelle que soit la longueur du texte)
function typeText(el, text) {
  if (!el || reduceMotion) return;
  el.textContent = "";
  el.classList.add("typing");
  const step = Math.max(1, Math.ceil(text.length / 70));
  let i = 0;
  const tick = () => {
    i = Math.min(text.length, i + step);
    el.textContent = text.slice(0, i);
    if (i < text.length) setTimeout(tick, 20);
    else el.classList.remove("typing");
  };
  setTimeout(tick, 350);
}

// Les blocs de stats (barres, histogramme) s'animent quand ils arrivent à l'écran
function revealOnScroll() {
  const blocks = results.querySelectorAll(".cols .block, .profile, .callout");
  if (reduceMotion || !("IntersectionObserver" in window)) return blocks.forEach((b) => b.classList.add("in"));
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }),
    { threshold: 0.15 }
  );
  blocks.forEach((b) => io.observe(b));
}

// Le soulignement vert glisse sous l'onglet actif
function moveTabInk() {
  const ink = $("#tab-ink");
  const active = $("#recs-tabs [aria-selected='true']");
  if (!ink || !active) return;
  ink.style.width = active.offsetWidth + "px";
  ink.style.transform = `translateX(${active.offsetLeft}px)`;
}
addEventListener("resize", moveTabInk);

// ---------- Fiche détaillée ----------
function findFilm(slug, kind) {
  const lists =
    kind === "avoided"
      ? [current.avoided]
      : kind === "watchlist"
      ? [current.watchlistRanked || [], current.pool]
      : [current.pool, current.extras || [], current.watchlistRanked || []];
  for (const list of lists) {
    const f = list.find((x) => x.slug === slug);
    if (f) return f;
  }
  return null;
}

function openFilm(slug, kind, { surprise = false } = {}) {
  const f = findFilm(slug, kind);
  if (!f) return;

  const why = [];
  if (f.inWatchlist) why.push(`<p>Il est déjà dans ta <em>watchlist</em> : c'est le moment.</p>`);
  if (f.byDirector?.length) why.push(`<p>Réalisé par <em>${f.byDirector.map(esc).join("</em>, <em>")}</em>, l'un de tes réalisateurs préférés.</p>`);
  if (f.because?.length) why.push(`<p>Parce que t'as aimé <em>${f.because.map(esc).join("</em>, <em>")}</em>.</p>`);
  if (f.withActor?.length) why.push(`<p>Avec <em>${f.withActor.map(esc).join("</em>, <em>")}</em>, que tu suis de près.</p>`);
  const matches = (f.matches || []).filter((m) => !(f.byDirector || []).includes(m) && !(f.withActor || []).includes(m));
  if (matches.length) why.push(`<p>Ce qui colle avec tes goûts : <em>${matches.map(esc).join("</em>, <em>")}</em>.</p>`);
  if (f.gem) why.push(`<p>Une <em>pépite</em> : bien notée, mais peu vue.</p>`);
  if (f.clashes?.length) why.push(`<p class="bad">Ce qui coince : <em>${f.clashes.map(esc).join("</em>, <em>")}</em>.</p>`);
  if (f.against?.length) why.push(`<p class="bad">Proche de <em>${f.against.map(esc).join("</em>, <em>")}</em>, que t'as pas aimé.</p>`);

  const facts = [f.year, fmtRuntime(f.runtime), f.countries?.[0], f.language].filter(Boolean).map(esc).join(" · ");
  const canHide = kind !== "avoided";

  modalCard.innerHTML = `
    <div class="modal-hero ${f.backdrop ? "" : "empty"}" ${f.backdrop ? `style="background-image:url('${esc(img(f.backdrop))}')"` : ""}></div>
    <button class="modal-close" data-close aria-label="Fermer">×</button>
    <div class="modal-body">
    ${poster(f)}
    <div class="modal-info">
      ${surprise ? '<p class="surprise-label">Ce soir, pourquoi pas…</p>' : ""}
      <h3 class="modal-title" id="modal-title">${esc(f.title)}</h3>
      <p class="modal-sub">${facts}</p>
      ${f.directors.length ? `<p class="modal-sub">Réalisé par <b>${f.directors.map(esc).join(", ")}</b></p>` : ""}
      <div class="genre-chips">${f.genres.map((g) => `<span class="gchip" style="--g:${genreColor(g)}">${esc(g)}</span>`).join("")}</div>
      <div class="modal-score">
        ${
          kind !== "avoided"
            ? `<div class="gauge ${matchClass(f.match)}" style="--p:${f.match}">
                <svg viewBox="0 0 40 40" aria-hidden="true"><circle class="g-bg" cx="20" cy="20" r="16" pathLength="100"/><circle class="g-fg" cx="20" cy="20" r="16" pathLength="100"/></svg>
                <b data-count="${f.match}" data-suffix="%">${f.match}%</b>
                <span>Compatibilité</span>
              </div>`
            : ""
        }
        ${f.avgRating ? `<div><b>${fmt(f.avgRating.toFixed(1))}</b><span>Moy. Letterboxd</span></div>` : ""}
        ${f.ratingCount ? `<div><b>${fmtCount(f.ratingCount)}</b><span>Notes</span></div>` : ""}
      </div>
      ${why.length ? `<div class="modal-why">${why.join("")}</div>` : ""}
      <p class="modal-desc">${esc(f.description)}</p>
      <div class="modal-actions">
        <a class="btn btn-green btn-sm" href="${esc(f.url)}" target="_blank" rel="noopener">Voir sur Letterboxd</a>
        ${canHide ? `<button class="btn btn-ghost btn-sm" data-hide="seen" data-slug="${esc(f.slug)}">Déjà vu</button>` : ""}
        ${canHide ? `<button class="btn btn-ghost btn-sm" data-hide="nope" data-slug="${esc(f.slug)}">Pas pour moi</button>` : ""}
        ${surprise ? '<button class="btn btn-ghost btn-sm" data-surprise>Un autre</button>' : ""}
      </div>
    </div>
    </div>`;
  // Teinte de la fiche : la couleur dominante de l'affiche
  modalCard.style.removeProperty("--film");
  filmColor(f).then((c) => {
    if (!c) return;
    modalCard.style.setProperty("--film", c);
    setAmbient(c); // toute la page se teinte de la couleur du film ouvert
  });
  modalCard.querySelectorAll("[data-count]").forEach(countUp);
  showModal();
  modalCard.querySelector(".modal-close").focus();
}

let modalTimer = null;
function showModal() {
  clearTimeout(modalTimer);
  modal.classList.remove("closing");
  modal.hidden = false;
  modalCard.scrollTop = 0;
}

function closeModal() {
  if (modal.hidden) return;
  rollToken++; // stoppe un tirage en cours
  restoreAmbient();
  modal.classList.add("closing");
  modalTimer = setTimeout(() => {
    modal.hidden = true;
    modal.classList.remove("closing");
  }, reduceMotion ? 0 : 180);
}

// Un film au hasard parmi les meilleures recos (en tenant compte des filtres de « Pour toi »),
// avec un petit tirage animé façon machine à sous
let rollToken = 0;
function surprise() {
  const top = forYouList().slice(0, 20);
  const list = top.length ? top : visible(current.pool).slice(0, 20);
  if (!list.length) return;
  const pick = list[Math.floor(Math.random() * list.length)];
  if (reduceMotion) return openFilm(pick.slug, "rec", { surprise: true });

  const token = ++rollToken;
  const reel = [...list].sort(() => Math.random() - 0.5).filter((f) => f.poster && f.slug !== pick.slug).slice(0, 12);
  reel.push(pick);
  modalCard.innerHTML = `
    <div class="roulette">
      <div class="roulette-frame"><img id="roulette-img" alt=""></div>
      <p class="roulette-label">On tire au sort ton film…</p>
    </div>`;
  showModal();
  const frame = $("#roulette-img");
  let i = 0;
  const step = () => {
    if (token !== rollToken) return; // fenêtre fermée ou nouveau tirage
    frame.src = img(reel[i].poster);
    frame.parentElement.classList.remove("tick");
    void frame.offsetWidth;
    frame.parentElement.classList.add("tick");
    if (++i < reel.length) setTimeout(step, 55 + i * i * 2.2); // ralentit petit à petit
    else setTimeout(() => token === rollToken && openFilm(pick.slug, "rec", { surprise: true }), 450);
  };
  step();
}

results.addEventListener("click", (e) => {
  if (e.target.closest("[data-import]")) {
    $("#ext-off").open = true;
    return $("#ext-status").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    const keys = Object.keys(TABS);
    const dir = Math.sign(keys.indexOf(tab.dataset.tab) - keys.indexOf(ui.tab));
    ui.tab = tab.dataset.tab;
    return renderRecs({ dir });
  }
  if (e.target.closest("[data-surprise]")) return surprise();
  if (e.target.closest("[data-share]")) return openShareCard();
  const pick = e.target.closest("[data-pick-genre]");
  if (pick) {
    if (pick.dataset.pickGenre === ui.genrePick) return;
    ui.genrePick = pick.dataset.pickGenre;
    ui.genreShown = GENRE_PAGE;
    return refreshGenreView();
  }
  if (e.target.closest("[data-genre-more]")) {
    // Tout le reste du genre, ajouté à la suite (seuls les nouveaux films apparaissent en cascade)
    const grid = $("#recs-panel .genre-view .grid");
    const already = grid.children.length;
    ui.genreShown = Infinity;
    const tmp = document.createElement("div");
    tmp.innerHTML = TABS.genres.render();
    const films = [...tmp.querySelectorAll(".genre-view .grid .film")].slice(already);
    films.forEach((el, i) => {
      el.style.setProperty("--i", Math.min(i, 30));
      el.classList.add("appear");
      grid.appendChild(el);
    });
    $("#recs-panel .genre-view .more")?.remove();
    return;
  }
  const expand = e.target.closest("[data-expand]");
  if (expand) {
    const box = $("#" + expand.dataset.expand);
    box.hidden = !box.hidden;
    expand.textContent = box.hidden ? seeOthers(+expand.dataset.count) : "Réduire";
    return;
  }
  if (e.target.closest("[data-more]")) {
    // On ajoute les films suivants à la suite (seuls les nouveaux apparaissent en cascade)
    const list = forYouList();
    const from = ui.shown;
    ui.shown += 24;
    $("#recs-panel .grid").insertAdjacentHTML("beforeend", list.slice(from, ui.shown).map((f, i) => recCard(f, "rec", i)).join(""));
    if (list.length <= ui.shown) $("#recs-panel .more")?.remove();
    return;
  }
  if (e.target.closest("[data-reset]")) {
    Object.assign(ui, { genre: "", decade: "", duration: "", shown: 24 });
    return renderRecs();
  }
  if (e.target.closest("[data-reset-genre-filters]")) {
    Object.assign(ui, { gDecade: "", gDuration: "", genreShown: GENRE_PAGE });
    return refreshGenreView();
  }
  const film = e.target.closest("button.film");
  if (film) openFilm(film.dataset.slug, film.dataset.kind);
});
results.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-filter]");
  if (!sel) return;
  ui[sel.dataset.filter] = sel.value;
  if (ui.tab === "genres") {
    ui.genreShown = GENRE_PAGE;
    return refreshGenreView();
  }
  ui.shown = 24;
  renderRecs();
});

// Onglet « Par genre » : on redessine en gardant la position du sélecteur de genres,
// et seules les affiches entrent en cascade
function refreshGenreView() {
  const scroller = $("#recs-panel .genre-picker");
  const scrollLeft = scroller ? scroller.scrollLeft : 0;
  renderRecs({ animate: false });
  const next = $("#recs-panel .genre-picker");
  if (next) next.scrollLeft = scrollLeft;
  $("#recs-panel .genre-view")?.classList.add("swap");
}
modal.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) return closeModal();
  if (e.target.closest("[data-surprise]")) return surprise();
  const hideBtn = e.target.closest("[data-hide]");
  if (hideBtn) hideFilm(hideBtn.dataset.hide, hideBtn.dataset.slug);
});

// « Déjà vu » / « Pas pour moi » : l'affiche s'efface en glissant, avec possibilité d'annuler
function hideFilm(kind, slug) {
  const f = findFilm(slug, "rec");
  addHidden(kind, current.user, slug);
  closeModal();
  const cards = results.querySelectorAll(`#recs-panel .film[data-slug="${CSS.escape(slug)}"]`);
  cards.forEach((c) => c.classList.add("leaving"));
  setTimeout(() => renderRecs({ animate: false }), reduceMotion || !cards.length ? 0 : 380);
  toast(`« ${f ? f.title : "Film"} » ${kind === "seen" ? "marqué comme déjà vu" : "ne te sera plus proposé"}`, {
    action: "Annuler",
    onAction: () => {
      removeHidden(kind, current.user, slug);
      renderRecs({ animate: false });
    },
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});

// ---------- Favori « Lire tout mon profil » ----------
// Le code lisible est dans bookmarklet.js ; on en fait un lien javascript: à glisser dans les favoris
const bookmarklet = $("#bookmarklet");
fetch("/bookmarklet.js")
  .then((r) => r.text())
  .then((code) => {
    const compact = code
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n")
      .replace("__NEXTREEL_ORIGIN__", location.origin);
    bookmarklet.href = "javascript:" + encodeURIComponent(compact);
  });
bookmarklet.addEventListener("click", (e) => {
  e.preventDefault();
  bookmarklet.classList.add("shake");
  setTimeout(() => bookmarklet.classList.remove("shake"), 500);
});

// ---------- État de l'extension + instructions d'installation ----------
if (hasExtension()) {
  document.body.classList.add("has-ext");
  $("#ext-on").hidden = false;
  $("#ext-off").hidden = true;
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const text = btn.dataset.copy || $("#" + btn.dataset.copyFrom).textContent;
  navigator.clipboard?.writeText(text).then(() => {
    btn.textContent = "Copié";
    setTimeout(() => (btn.textContent = "Copier"), 1500);
  });
});

// Lien partageable : ?u=pseudo ; #import=… : arrivée depuis le favori
const params = new URLSearchParams(location.search);
const hashImport = location.hash.match(/^#import=([A-Za-z0-9_-]+)$/);
if (hashImport) receiveFromLetterboxd(hashImport[1]);
else if (params.get("u")) start(params.get("u"));
