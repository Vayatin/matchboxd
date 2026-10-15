// Effets visuels de Matchboxd : mur d'affiches, bobine pendant l'analyse, inclinaison 3D,
// ambiance de couleur, carte d'identité ciné à partager.
// Chargé avant app.js : les fonctions ici n'utilisent les variables d'app.js qu'au moment où on les appelle.

const fxReduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fxCanHover = matchMedia("(hover: hover) and (pointer: fine)").matches;
const fxImg = (src) => `/img?src=${encodeURIComponent(src)}`;
// "#9ab" -> "#99aabb" (pour pouvoir ajouter une transparence en hexadécimal)
const hex6 = (c) => (c.length === 4 ? "#" + [...c.slice(1)].map((x) => x + x).join("") : c);

// ---------- 1. Mur d'affiches de l'accueil (3 rangées qui défilent en sens alterné) ----------
fetch("/api/wall")
  .then((r) => r.json())
  .then((posters) => {
    const wall = document.getElementById("poster-wall");
    if (!wall || posters.length < 18) return; // cache encore vide : pas de mur
    const rows = [0, 1, 2].map((r) => posters.filter((_, i) => i % 3 === r));
    wall.innerHTML = rows
      .map((row, r) => {
        // Contenu doublé pour une boucle sans à-coup
        const imgs = [...row, ...row].map((p) => `<img src="${fxImg(p.poster)}" alt="" loading="lazy" onload="this.classList.add('loaded')">`).join("");
        return `<div class="wall-row ${r % 2 ? "rev" : ""}" style="--d:${80 + r * 25}s">${imgs}</div>`;
      })
      .join("");
    requestAnimationFrame(() => wall.classList.add("on"));
  })
  .catch(() => {});

// ---------- 2. Bobine : les affiches des films lus défilent pendant l'analyse ----------
const reel = { queue: [], timer: null, count: 0 };
function reelReset() {
  reel.queue = [];
  reel.count = 0;
  clearTimeout(reel.timer);
  reel.timer = null;
  const el = document.getElementById("reel");
  if (el) el.innerHTML = "";
  const t = document.getElementById("reel-title");
  if (t) t.textContent = "";
  document.getElementById("loader")?.classList.remove("has-reel");
}
function reelAdd(poster, title) {
  if (fxReduce || !poster) return;
  reel.queue.push({ poster, title });
  if (reel.queue.length > 8) reel.queue.splice(0, reel.queue.length - 8); // on garde les plus récents
  if (!reel.timer) reelNext();
}
function reelNext() {
  const item = reel.queue.shift();
  if (!item) {
    reel.timer = null;
    return;
  }
  const el = document.getElementById("reel");
  document.getElementById("loader")?.classList.add("has-reel");
  const card = document.createElement("div");
  card.className = "reel-card";
  card.innerHTML = `<img src="${fxImg(item.poster)}" alt="">`;
  el.appendChild(card);
  // Les cartes précédentes glissent vers la gauche et s'estompent
  const cards = [...el.children];
  cards.forEach((c, i) => c.style.setProperty("--k", cards.length - 1 - i));
  if (cards.length > 5) cards[0].remove();
  const t = document.getElementById("reel-title");
  if (t) {
    t.textContent = item.title || "";
    t.classList.remove("swap");
    void t.offsetWidth;
    t.classList.add("swap");
  }
  reel.timer = setTimeout(reelNext, 260);
}

// ---------- 3. Inclinaison 3D + reflet qui suit la souris ----------
let tiltCard = null;
function resetTilt(card) {
  const p = card?.querySelector(".poster");
  if (!p) return;
  ["--rx", "--ry", "--mx", "--my"].forEach((v) => p.style.removeProperty(v));
}
if (fxCanHover && !fxReduce) {
  document.addEventListener("pointermove", (e) => {
    const card = e.target.closest?.(".film");
    if (card !== tiltCard) {
      resetTilt(tiltCard);
      tiltCard = card;
    }
    if (!card) return;
    const p = card.querySelector(".poster");
    if (!p) return;
    const r = p.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width; // 0 → 1
    const y = (e.clientY - r.top) / r.height;
    p.style.setProperty("--ry", `${(x - 0.5) * 14}deg`);
    p.style.setProperty("--rx", `${(0.5 - y) * 14}deg`);
    p.style.setProperty("--mx", `${x * 100}%`);
    p.style.setProperty("--my", `${y * 100}%`);
  });
  document.addEventListener("pointerleave", () => resetTilt(tiltCard));
}

// ---------- 4. Ambiance de couleur de la page (genre choisi, film ouvert) ----------
// Deux calques qui se relaient en fondu (plus fiable que d'animer la couleur elle-même)
let ambientBase = null;
let ambientNow = null;
let ambientLayer = 0;
function setAmbient(color, { base = false } = {}) {
  if (base) ambientBase = color;
  color = color || null;
  if (color === ambientNow) return;
  ambientNow = color;
  const layers = document.querySelectorAll("#ambient .amb");
  if (layers.length < 2) return;
  const next = layers[1 - ambientLayer];
  if (color) next.style.setProperty("--c", color);
  next.style.opacity = color ? "1" : "0";
  layers[ambientLayer].style.opacity = "0";
  ambientLayer = 1 - ambientLayer;
}
const restoreAmbient = () => setAmbient(ambientBase);

// ---------- 5. Carte d'identité ciné (image à télécharger / partager) ----------
function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const im = new Image();
    const t = setTimeout(() => resolve(null), 6000);
    im.onload = () => (clearTimeout(t), resolve(im));
    im.onerror = () => (clearTimeout(t), resolve(null));
    im.src = fxImg(src);
  });
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  const words = text.split(" ");
  let line = "";
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(lines === maxLines - 1 ? line + "…" : line, x, y);
      if (++lines >= maxLines) return y + lineHeight;
      line = words[i];
      y += lineHeight;
    } else line = test;
  }
  ctx.fillText(line, x, y);
  return y + lineHeight;
}

async function buildShareCard(data) {
  const p = data.profile;
  const W = 1080;
  const H = 1350;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  await document.fonts.ready;
  const serif = '"Source Serif 4", Georgia, serif';
  const sans = "Inter, Segoe UI, Arial, sans-serif";
  const loved = p.lovedGenres.slice(0, 4);

  // Fond sombre + halos aux couleurs de tes genres préférés
  ctx.fillStyle = "#14181c";
  ctx.fillRect(0, 0, W, H);
  [[0, 0], [W, 380], [0, H], [W, H]].forEach(([x, y], i) => {
    const color = hex6(genreColor(loved[i % Math.max(1, loved.length)]?.name || "Drame"));
    const g = ctx.createRadialGradient(x, y, 0, x, y, 620);
    g.addColorStop(0, color + "40");
    g.addColorStop(1, color + "00");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });

  // Logo
  [["#ff8000", 0], ["#00e054", 22], ["#40bcf4", 44]].forEach(([col, dx]) => {
    ctx.beginPath();
    ctx.fillStyle = col;
    ctx.arc(92 + dx, 92, 14, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#fff";
  ctx.font = `700 38px ${sans}`;
  ctx.fillText("Matchboxd", 160, 106);
  ctx.fillStyle = "#678";
  ctx.font = `600 22px ${sans}`;
  ctx.textAlign = "right";
  ctx.fillText("MA CARTE CINÉ", W - 80, 104);
  ctx.textAlign = "left";

  // Avatar + nom
  const name = data.member?.displayName || data.user;
  const avatar = await loadImage(data.member?.avatar);
  ctx.save();
  ctx.beginPath();
  ctx.arc(160, 250, 80, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) ctx.drawImage(avatar, 80, 170, 160, 160);
  else {
    const g = ctx.createLinearGradient(80, 170, 240, 330);
    g.addColorStop(0, "#ff8000");
    g.addColorStop(0.5, "#00e054");
    g.addColorStop(1, "#40bcf4");
    ctx.fillStyle = g;
    ctx.fillRect(80, 170, 160, 160);
    ctx.fillStyle = "#fff";
    ctx.font = `700 72px ${sans}`;
    ctx.textAlign = "center";
    ctx.fillText(name[0].toUpperCase(), 160, 276);
    ctx.textAlign = "left";
  }
  ctx.restore();
  ctx.fillStyle = "#fff";
  ctx.font = `700 64px ${serif}`;
  ctx.fillText(name, 280, 248);
  ctx.fillStyle = "#9ab";
  ctx.font = `400 28px ${sans}`;
  ctx.fillText(`@${data.user} sur Letterboxd`, 282, 294);

  // Phrase de profil
  ctx.fillStyle = "#cde";
  ctx.font = `400 30px ${sans}`;
  const headline = loved.length
    ? `Son truc : ${loved.slice(0, 3).map((g) => g.name.toLowerCase()).join(", ")}${p.directors[0]?.affinity > 0 ? `, et ${p.directors[0].name}` : ""}.`
    : p.severity + ".";
  let y = wrapText(ctx, headline, 80, 400, W - 160, 42, 2);

  // Chiffres
  y += 30;
  const nums = [
    [data.source === "import" ? p.filmCount : p.analysedCount, "FILMS"],
    [String(p.avgRating).replace(".", ","), "NOTE MOY."],
    [p.hours, "HEURES"],
    [p.likedCount, "LIKES"],
  ];
  nums.forEach(([v, l], i) => {
    const x = 80 + i * 235;
    ctx.fillStyle = "#fff";
    ctx.font = `700 56px ${sans}`;
    ctx.fillText(String(v), x, y + 40);
    ctx.fillStyle = "#678";
    ctx.font = `600 20px ${sans}`;
    ctx.fillText(l, x, y + 74);
  });
  y += 130;

  // Genres
  ctx.fillStyle = "#9ab";
  ctx.font = `600 20px ${sans}`;
  ctx.fillText("SES GENRES", 80, y);
  y += 22;
  let x = 80;
  ctx.font = `500 26px ${sans}`;
  (loved.length ? loved : p.topGenres.slice(0, 4)).forEach((g) => {
    const col = hex6(genreColor(g.name));
    const w = ctx.measureText(g.name).width + 44;
    roundRect(ctx, x, y, w, 50, 25);
    ctx.fillStyle = col + "26";
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(g.name, x + 22, y + 34);
    x += w + 14;
  });
  y += 100;

  // Films préférés
  ctx.fillStyle = "#9ab";
  ctx.font = `600 20px ${sans}`;
  ctx.fillText("SES FILMS PRÉFÉRÉS", 80, y);
  y += 24;
  const favs = p.favourites.slice(0, 4);
  const posters = await Promise.all(favs.map((f) => loadImage(f.poster)));
  favs.forEach((f, i) => {
    const px = 80 + i * 236;
    ctx.save();
    roundRect(ctx, px, y, 212, 318, 10);
    ctx.clip();
    if (posters[i]) ctx.drawImage(posters[i], px, y, 212, 318);
    else {
      ctx.fillStyle = "#2c3440";
      ctx.fillRect(px, y, 212, 318);
    }
    ctx.restore();
    ctx.fillStyle = "#00e054";
    ctx.font = `400 26px ${sans}`;
    ctx.fillText(stars(f.rating), px, y + 352);
  });
  y += 410;

  // Réalisateur fétiche + avis à contre-courant
  ctx.font = `400 28px ${sans}`;
  const director = p.directors.find((d) => d.affinity > 0);
  if (director) {
    ctx.fillStyle = "#9ab";
    ctx.fillText("Réalisateur fétiche : ", 80, y);
    ctx.fillStyle = "#fff";
    ctx.fillText(director.name, 80 + ctx.measureText("Réalisateur fétiche : ").width, y);
    y += 46;
  }
  const contra = p.contrarian.lovedMore[0];
  if (contra) {
    ctx.fillStyle = "#9ab";
    const label = "Avis à contre-courant : ";
    ctx.fillText(label, 80, y);
    ctx.fillStyle = "#fff";
    ctx.fillText(`${contra.title} (${stars(contra.rating)} vs ${String(contra.avgRating.toFixed(1)).replace(".", ",")} sur LB)`, 80 + ctx.measureText(label).width, y);
  }

  // Pied
  ctx.fillStyle = "#567";
  ctx.font = `500 22px ${sans}`;
  ctx.fillText("Fait avec Matchboxd · d'après son profil Letterboxd", 80, H - 60);
  return c;
}

async function openShareCard() {
  if (!current) return;
  modalCard.innerHTML = `
    <button class="modal-close" data-close aria-label="Fermer">×</button>
    <div class="share">
      <h3 class="share-title">Ta carte ciné</h3>
      <div class="share-preview"><div class="share-loading"><i class="o"></i><i class="g"></i><i class="b"></i></div></div>
      <div class="share-actions"></div>
    </div>`;
  showModal();
  const canvas = await buildShareCard(current);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  const url = URL.createObjectURL(blob);
  const file = new File([blob], `matchboxd-${current.user}.png`, { type: "image/png" });
  const preview = modalCard.querySelector(".share-preview");
  if (!preview) return; // fenêtre fermée entre-temps
  preview.innerHTML = `<img src="${url}" alt="Ta carte ciné Matchboxd">`;
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  modalCard.querySelector(".share-actions").innerHTML = `
    <a class="btn btn-green btn-sm" href="${url}" download="matchboxd-${esc(current.user)}.png">Télécharger l'image</a>
    ${canShare ? '<button type="button" class="btn btn-ghost btn-sm" data-share-native>Partager</button>' : ""}`;
  modalCard.querySelector("[data-share-native]")?.addEventListener("click", () =>
    navigator.share({ files: [file], title: "Ma carte ciné Matchboxd" }).catch(() => {})
  );
}
