import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

/**
 * Que un socket roto durante el apretón de manos del WebSocket no tumbe la API.
 *
 * En el `upgrade`, Node le pasa el socket CRUDO a quien escucha y le quita sus
 * propias defensas: desde ahí, un `error` sin nadie escuchando es una excepción
 * no capturada y el proceso entero se cae. `@hono/node-ws` no le pone ninguna:
 * espera a que la app canjee el billete y, si no vale, escribe la respuesta
 * —un 401— en ese socket. Si el panel ya se fue —pestaña cerrada, red que
 * cambia, reconexión con un billete caducado— esa escritura da `EPIPE` o
 * `ECONNRESET` y se lleva por delante la API, todas las líneas de WhatsApp y
 * el panel con ella. Pasó en bucle, una vez por minuto, al reintentar el
 * panel.
 *
 * Va con `prependListener` para quedar puesto ANTES de que nadie toque el
 * socket. Cuando `ws` acepta la conexión añade su propio manejador, y este se
 * limita a cerrar lo que ya está roto.
 */
export function protegerUpgrades(
  server: Pick<EventEmitter, "prependListener">,
  alFallar: (error: NodeJS.ErrnoException) => void = () => {},
): void {
  server.prependListener("upgrade", (_req: unknown, socket: Duplex) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      alFallar(error);
      socket.destroy();
    });
  });
}
