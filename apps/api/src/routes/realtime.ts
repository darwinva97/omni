import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { UpgradeWebSocket } from "hono/ws";
import { OmniError } from "@omni/shared";
import type { Container } from "../container.js";
import { issueTicket, redeemTicket } from "../realtime/tickets.js";
import { parseMensajeCliente, RealtimeGateway } from "../realtime/gateway.js";
import type { ApiEnv } from "./shared.js";
import { errors, json } from "./shared.js";

/**
 * Tiempo real.
 *
 * Dos rutas: una normal y autenticada que entrega un billete, y el propio
 * WebSocket, que lo canjea. El rodeo existe porque un navegador no puede poner
 * cabeceras en el apretón de manos, y meter una clave permanente en la URL la
 * deja escrita en registros de acceso e historiales.
 */
export function registerRealtimeRoutes(
  app: OpenAPIHono<ApiEnv>,
  container: Container,
): void {
  app.openapi(
    createRoute({
      method: "post", path: "/v1/realtime/ticket", tags: ["tiempo real"],
      summary: "Obtener un billete para abrir el WebSocket",
      description:
        "Dura sesenta segundos y sirve UNA vez. Se pasa como `?ticket=` al abrir " +
        "`/v1/realtime/ws`. No metas aquí tu clave de API: acabaría en los " +
        "registros de acceso y en el historial del navegador.",
      responses: {
        201: json(z.object({ data: z.object({
          ticket: z.string(),
          expiresIn: z.number(),
          url: z.string().describe("URL ABSOLUTA del socket, con el billete ya puesto"),
        }) }), "emitido"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { ticket, expiresIn } = await issueTicket(container.kv, principal);

      /*
       * Se devuelve la URL ABSOLUTA y con el billete puesto.
       *
       * El panel no puede reenviar un WebSocket —un manejador de ruta HTTP
       * habla en peticiones, no en sockets—, así que el navegador se conecta
       * directamente aquí. Que sea el servidor quien diga dónde evita que cada
       * cliente tenga que componer la URL y acertar con el esquema.
       */
      const ws = container.config.PUBLIC_URL.replace(/^http/, "ws").replace(/\/+$/, "");
      return c.json({
        data: { ticket, expiresIn, url: `${ws}/v1/realtime/ws?ticket=${ticket}` },
      }, 201);
    },
  );

}

/**
 * Monta el WebSocket.
 *
 * Va aparte de las demás rutas porque el adaptador de Node necesita la MISMA
 * instancia de la app a la que luego engancha el `upgrade`. Crearlo con una app
 * distinta —aunque sea para romper la dependencia circular— deja el adaptador
 * escuchando en el sitio equivocado y el apretón de manos falla sin explicación.
 */
export function registerWebSocketRoute(
  app: OpenAPIHono<ApiEnv>,
  container: Container,
  gateway: RealtimeGateway,
  upgradeWebSocket: UpgradeWebSocket,
): void {
  app.get("/v1/realtime/ws", upgradeWebSocket(async (c) => {
    const ticket = c.req.query("ticket");
    if (!ticket) throw new OmniError("unauthenticated", "falta el parámetro `ticket`");
    // Se canjea ANTES de aceptar el socket: si el billete no vale, no se abre.
    const payload = await redeemTicket(container.kv, ticket);
    const id = crypto.randomUUID();

    return {
      onOpen: (_evt, ws) => {
        void gateway.añadir(id, payload, (texto) => ws.send(texto));
        ws.send(JSON.stringify({ type: "ready", orgId: payload.orgId }));
      },
      onMessage: (evt, ws) => {
        const mensaje = parseMensajeCliente(String(evt.data));
        if (!mensaje) {
          ws.send(JSON.stringify({ type: "error", detail: "mensaje no reconocido" }));
          return;
        }
        if (mensaje.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        gateway.suscribir(id, { events: mensaje.events ?? [], lines: mensaje.lines ?? [] });
        ws.send(JSON.stringify({
          type: "subscribed",
          events: mensaje.events ?? [], lines: mensaje.lines ?? [],
        }));
      },
      onClose: () => { void gateway.quitar(id); },
      onError: () => { void gateway.quitar(id); },
    };
  }));
}
