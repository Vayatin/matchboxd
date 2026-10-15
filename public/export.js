// Lecture de l'export Letterboxd (Settings → Data → Export your data), entièrement dans le navigateur.
// Accepte le .zip tel quel, ou les fichiers .csv décompressés.
// Seuls titres, années, notes, likes et liens courts sont envoyés au serveur.

// ---------- ZIP minimal (pas de dépendance : DecompressionStream du navigateur) ----------
async function unzip(file, wanted) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let eocd = -1; // "End of central directory", à la fin du fichier
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Ce fichier n'est pas un .zip valide.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder();
  const out = {};

  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;

    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else continue;
    out[name] = utf8.decode(bytes);
  }
  return out;
}

// ---------- CSV (gère les guillemets, virgules et retours à la ligne dans les titres) ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  if (!head) return [];
  const keys = head.map((k) => k.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}

// Quel fichier de l'export est-ce ? (on ignore les dossiers deleted/ et orphaned/)
function kindOf(path, { loose }) {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(deleted|orphaned|lists)\//.test(p)) return null;
  if (/(^|\/)likes\/films\.csv$/.test(p)) return "likes";
  if (p.includes("/") && !/^[^/]+\/[^/]+\.csv$/.test(p)) return null; // fichiers des sous-dossiers (listes…)
  const base = p.split("/").pop();
  const kinds = { "ratings.csv": "ratings", "watched.csv": "watched", "watchlist.csv": "watchlist", "profile.csv": "profile" };
  if (loose && base === "films.csv") return "likes";
  return kinds[base] || null;
}

async function readLetterboxdExport(fileList) {
  const tables = {};
  for (const file of fileList) {
    if (/\.zip$/i.test(file.name)) {
      if (typeof DecompressionStream === "undefined") throw new Error("Ton navigateur ne sait pas ouvrir les .zip : décompresse-le et envoie les fichiers .csv.");
      const entries = await unzip(file, (name) => kindOf(name, { loose: false }));
      for (const [name, text] of Object.entries(entries)) tables[kindOf(name, { loose: false })] = parseCsv(text);
    } else if (/\.csv$/i.test(file.name)) {
      const kind = kindOf(file.webkitRelativePath || file.name, { loose: true });
      if (kind) tables[kind] = parseCsv(await file.text());
    }
  }
  if (!tables.ratings && !tables.watched) {
    throw new Error("Je ne trouve ni ratings.csv ni watched.csv : vérifie que c'est bien l'export Letterboxd.");
  }

  // Fusion par lien court (même lien pour un film dans watched / ratings / likes)
  const films = new Map();
  const film = (r) => {
    const uri = (r["Letterboxd URI"] || "").trim();
    if (!uri || !r.Name) return null;
    if (!films.has(uri)) films.set(uri, { uri, title: r.Name, year: +r.Year || null, rating: null, liked: false, date: r.Date || null });
    return films.get(uri);
  };
  for (const r of tables.watched || []) film(r);
  for (const r of tables.ratings || []) {
    const f = film(r);
    const rating = parseFloat(r.Rating);
    if (f && rating) {
      f.rating = rating;
      f.date = r.Date || f.date;
    }
  }
  for (const r of tables.likes || []) {
    const f = film(r);
    if (f) f.liked = true;
  }

  return {
    username: tables.profile?.[0]?.Username || null,
    films: [...films.values()],
    watched: [],
    watchlist: (tables.watchlist || []).map((r) => ({ title: r.Name, year: +r.Year || null })),
  };
}
