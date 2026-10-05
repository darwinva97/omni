import type { MetadataRoute } from "next";

/**
 * El manifiesto que hace instalable el panel.
 *
 * `display: standalone` y no `fullscreen`: esto es una herramienta de trabajo
 * que se consulta a ratos, y quitarle la barra del sistema deja al usuario sin
 * la hora y sin la batería justo cuando está pendiente de un mensaje.
 *
 * `start_url` apunta a la raíz y no a una conversación: la aplicación instalada
 * se abre muchas veces al día y siempre al mismo sitio conocido.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Omni — mensajería multicanal",
    short_name: "Omni",
    description: "Panel de mensajería multicanal: WhatsApp, Telegram y correo.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    // Los dos del tema claro: es lo que ve el sistema al instalar, antes de
    // que la página pueda decir nada.
    background_color: "#f3f5f7",
    theme_color: "#0f766e",
    categories: ["productivity", "business"],
    icons: [
      { src: "/icono-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icono-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // `maskable` es el que Android recorta a su forma: sin uno, el icono sale
      // metido dentro de un cuadrado blanco.
      { src: "/icono-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
