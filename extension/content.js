// Pont entre la page Matchboxd (localhost) et l'extension.
// La page envoie { source: "nextreel-page", type: "read", id, user } via window.postMessage ;
// on relaie au service worker et on renvoie sa progression / son résultat à la page.
const version = chrome.runtime.getManifest().version;
document.documentElement.dataset.nextreelExtension = version;

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.source !== "nextreel-page" || e.data.type !== "read") return;
  const { id, user } = e.data;
  const reply = (msg) => window.postMessage({ source: "nextreel-ext", id, ...msg }, location.origin);

  const port = chrome.runtime.connect({ name: "nextreel" });
  let finished = false;
  port.onMessage.addListener((msg) => {
    if (msg.type === "result" || msg.type === "error") finished = true;
    reply(msg);
  });
  port.onDisconnect.addListener(() => {
    if (!finished) reply({ type: "error", message: "L'extension Matchboxd s'est arrêtée pendant la lecture. Réessaie." });
  });
  port.postMessage({ type: "read", user });
});
