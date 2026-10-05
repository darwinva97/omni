/*
 * Service worker del panel.
 *
 * Hace UNA cosa a propósito: que el armazón de la aplicación abra sin red, con
 * una pantalla que explica que no hay conexión. NO cachea conversaciones ni
 * mensajes.
 *
 * Esa decisión es deliberada y va contra la tentación obvia. Un panel de
 * mensajería que enseña mensajes viejos de una caché es peor que uno que dice
 * «sin conexión»: quien lo mire creerá que esa es la conversación actual, y
 * puede responder a algo que ya tiene respuesta. Y los medios llevan URL
 * firmada que caduca: cachearlos sería guardar enlaces rotos.
 */

const CACHE = "omni-armazon-v1";
const ESENCIALES = ["/sin-conexion", "/icono-192.png", "/icono-512.png"];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ESENCIALES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(
        claves.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (evento) => {
  const peticion = evento.request;
  if (peticion.method !== "GET") return;

  const url = new URL(peticion.url);
  // Nada de la API ni de los medios se toca: son datos vivos y credenciales
  // que caducan.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return;

  // Solo las navegaciones: si la red falla, la pantalla de sin conexión.
  if (peticion.mode !== "navigate") return;

  evento.respondWith(
    fetch(peticion).catch(() => caches.match("/sin-conexion")),
  );
});
