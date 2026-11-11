// Service worker minimal : coquille d'app en cache (network-first avec timeout),
// pour l'installabilité PWA et un démarrage hors-ligne / origine éteinte.
// Aucune requête cloud mise en cache (les données volets/lumières sont toujours
// rafraîchies en ligne).
//
// La coquille comprend aussi les bundles JS/CSS hashés de /assets/ : leurs noms
// changent à chaque build, on les découvre donc à l'install en lisant
// /index.html (précache). Sans cela, au 1er chargement ces fichiers sont
// téléchargés AVANT que le SW contrôle la page et ne seraient jamais mis en
// cache -> écran blanc hors-ligne tant qu'on n'a pas rechargé une 2e fois.
// Remplacé au build (vite.config.ts, plugin sw-build-id) par un hash de
// index.html : chaque build a ainsi un sw.js différent (le navigateur détecte la
// mise à jour -> toast « Recharger ») et son propre cache (les anciens bundles
// hashés sont purgés à l'activation).
const BUILD = "f5fe3bfc87";
// Préfixe propre à l'app : sur GitHub Pages l'origine (xxx.github.io) est partagée avec
// d'autres sites, on ne touche jamais aux caches qui ne sont pas les nôtres.
const CACHE_PREFIX = "flexom-shell-";
const CACHE = CACHE_PREFIX + BUILD;
// L'app peut être servie sous un sous-chemin (GitHub Pages : /naco/). Le scope du
// worker donne ce chemin de base ; tout est dérivé de lui, rien n'est codé en dur à « / ».
const SCOPE =
  (self.registration && self.registration.scope) || self.location.origin + "/";
const BASE_PATH = new URL(SCOPE).pathname;
const INDEX = BASE_PATH + "index.html";
const SHELL = [
  BASE_PATH,
  INDEX,
  BASE_PATH + "manifest.webmanifest",
  BASE_PATH + "icon.svg",
  BASE_PATH + "icon-192.png",
  BASE_PATH + "icon-512.png",
];
// Origine injoignable (ex. Mac en veille sur le LAN) : sans timeout, fetch peut
// pendre longtemps avant d'échouer. Au-delà, on sert le cache.
const NETWORK_TIMEOUT_MS = 4000;

/** URLs same-origin …/assets/… référencées par un index.html (script/link), base comprise. */
function assetUrls(html) {
  const out = new Set();
  const re = /(?:src|href)=["']([^"'?#]*\/assets\/[^"'?#]+)["']/g;
  let m;
  while ((m = re.exec(html)) !== null) out.add(new URL(m[1], SCOPE).pathname);
  return [...out];
}

async function precache() {
  const cache = await caches.open(CACHE);
  // cache: "reload" : ne pas lire un index.html périmé du cache HTTP du navigateur.
  const res = await fetch(INDEX, { cache: "reload" });
  if (!res.ok) throw new Error("index.html HTTP " + res.status);
  const html = await res.clone().text();
  await cache.put(INDEX, res);
  const urls = SHELL.filter((u) => u !== INDEX).concat(assetUrls(html));
  await cache.addAll(urls);
}

self.addEventListener("install", (e) => {
  // Pas de skipWaiting automatique : le nouveau worker attend que l'app
  // propose « Recharger » (message SKIP_WAITING) pour ne pas recharger sous
  // les pieds de l'utilisateur en pleine manipulation d'un volet.
  e.waitUntil(precache());
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function networkWithTimeout(req) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    fetch(req).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Seule la coquille same-origin est servie par le cache.
  if (url.origin !== self.location.origin) return;
  // /version.json sert à détecter une version plus récente que celle qui tourne :
  // jamais servi ni conservé par le worker (sinon un cache périmé masquerait la mise à jour).
  if (url.pathname === BASE_PATH + "version.json") return;
  e.respondWith(
    networkWithTimeout(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req, { ignoreSearch: true })
          .then((r) => r || (req.mode === "navigate" ? caches.match(INDEX) : undefined))
          .then((r) => r || Response.error()),
      ),
  );
});
