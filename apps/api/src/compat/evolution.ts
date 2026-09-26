import { Hono, type Context } from "hono";
import { OmniError, parseAddress, SendMessageInput } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import { chatTable, lineTable } from "@omni/db";
import { and, desc, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { problem } from "../http.js";

/**
 * Capa de compatibilidad con Evolution API.
 *
 * Su convención es distinta a la de WasenderAPI: la línea va en la RUTA
 * (`/message/sendText/{instance}`) y la credencial en la cabecera `apikey`, no
 * en `Authorization`. Se aceptan las dos formas para no obligar a tocar nada.
 *
 * Aquí se identifica la línea por su `slug`, que es lo que Evolution llama
 * "instance": un identificador legible que el usuario eligió.
 */
export function evolutionCompat(container: Container): Hono {
  const app = new Hono();
  app.onError((err, c) => problem(c, err));

  const contexto = async (
    c: { req: { header: (h: string) => string | undefined } },
    instancia: string,
  ) => {
    // Evolution manda la clave en `apikey`; se acepta también `Authorization`
    // para quien ya venga acostumbrado a la nuestra.
    const cabecera = c.req.header("apikey")
      ? `Bearer ${c.req.header("apikey")}`
      : c.req.header("authorization");
    const principal = await authenticateApiKey(container.dbh.db, cabecera);

    const filas = await container.dbh.db
      .select({ id: lineTable.id })
      .from(lineTable)
      .where(and(eq(lineTable.orgId, principal.orgId), eq(lineTable.slug, instancia)))
      .limit(1);
    if (!filas[0]) throw new OmniError("not_found", `no hay ninguna línea con el identificador "${instancia}"`);
    return { principal, lineId: filas[0].id };
  };

  const enviar = async (
    c: Context,
    instancia: string,
    construir: (cuerpo: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const { principal, lineId } = await contexto(c, instancia);
    const cuerpo = await c.req.json<Record<string, unknown>>();
    const numero = String(cuerpo["number"] ?? "");
    if (!numero) throw new OmniError("validation_failed", "falta `number`");

    const entrada = SendMessageInput.parse({ to: numero, ...construir(cuerpo) });
    await authorize(principal, routeOf("message.send"), { lineId, chat: parseAddress(numero) });
    const aceptado = await container.runtime.send(lineId, entrada, {
      ...(principal.kind === "api-key" ? { connectorId: principal.apiKeyId } : { userId: principal.userId }),
    });

    // El sobre de Evolution: `key.id` y `status`.
    return c.json({
      key: { remoteJid: parseAddress(numero).value, fromMe: true, id: aceptado.messageId },
      status: "PENDING",
      messageTimestamp: Math.floor(Date.now() / 1000),
    }, 201);
  };

  app.post("/message/sendText/:instance", async (c) =>
    enviar(c, c.req.param("instance"), (b) => ({
      text: String(b["text"] ?? b["textMessage"] ?? ""),
      ...(b["quoted"] ? { replyTo: String((b["quoted"] as { key?: { id?: string } }).key?.id ?? "") } : {}),
    })),
  );

  app.post("/message/sendMedia/:instance", async (c) =>
    enviar(c, c.req.param("instance"), (b) => {
      const tipo = String(b["mediatype"] ?? "image");
      const url = String(b["media"] ?? "");
      const campo = tipo === "video" ? "video" : tipo === "audio" ? "audio" : tipo === "document" ? "document" : "image";
      return {
        [campo]: { url },
        ...(b["caption"] ? { caption: String(b["caption"]) } : {}),
        ...(b["fileName"] ? { fileName: String(b["fileName"]) } : {}),
      };
    }),
  );

  app.post("/message/sendLocation/:instance", async (c) =>
    enviar(c, c.req.param("instance"), (b) => ({
      location: {
        latitude: Number(b["latitude"]), longitude: Number(b["longitude"]),
        ...(b["name"] ? { name: String(b["name"]) } : {}),
        ...(b["address"] ? { address: String(b["address"]) } : {}),
      },
    })),
  );

  /** `GET /instance/connectionState/{instance}` con el vocabulario de Evolution. */
  app.get("/instance/connectionState/:instance", async (c) => {
    const instancia = c.req.param("instance");
    const { lineId } = await contexto(c, instancia);
    const estado = await container.runtime.status(lineId);
    const equivalencia: Record<string, string> = {
      connected: "open", connecting: "connecting",
      "awaiting-link": "connecting", disconnected: "close", "logged-out": "close",
    };
    return c.json({
      instance: { instanceName: instancia, state: equivalencia[estado.state] ?? "close" },
    });
  });

  app.get("/chat/findChats/:instance", async (c) => {
    const instancia = c.req.param("instance");
    const { principal, lineId } = await contexto(c, instancia);
    await authorize(principal, routeOf("chat.list"), { lineId });
    const filas = await container.dbh.db.select().from(chatTable)
      .where(eq(chatTable.lineId, lineId))
      .orderBy(desc(chatTable.lastMessageAt)).limit(200);
    return c.json(filas.map((f) => ({
      id: f.address, name: f.title, unreadCount: f.unreadCount,
      updatedAt: f.lastMessageAt?.toISOString() ?? null,
    })));
  });

  return app;
}
