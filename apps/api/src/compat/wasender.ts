import { Hono } from "hono";
import { OmniError, parseAddress, SendMessageInput } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import { lineTable } from "@omni/db";
import { and, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import { authenticateApiKey } from "../middleware/auth.js";
import { problem } from "../http.js";

/**
 * Capa de compatibilidad con WasenderAPI.
 *
 * Migrar desde ahí es cambiar la URL base. Nada más.
 *
 * Los sobres de respuesta de esa interfaz son INCONSISTENTES —unos devuelven
 * `{success, data}`, otros el campo suelto arriba— y aquí se reproducen tal
 * cual: el objetivo es que un cliente existente funcione sin tocarlo. Esa
 * inconsistencia vive SOLO aquí; `/v1` tiene una sola forma.
 */
export function wasenderCompat(container: Container): Hono {
  const app = new Hono();

  app.onError((err, c) => problem(c, err));

  /** La clave identifica la línea, así que ninguna ruta lleva su identificador. */
  const contexto = async (c: { req: { header: (h: string) => string | undefined } }) => {
    const principal = await authenticateApiKey(container.dbh.db, c.req.header("authorization"));
    // Una clave acotada a UNA línea la identifica sin ambigüedad; sin acotar,
    // se usa la única que haya. Con varias hay que decir cuál, y esta interfaz
    // no tiene dónde: se dice en vez de elegir al azar.
    const lineas = await container.dbh.db
      .select({ id: lineTable.id, kind: lineTable.channelKind })
      .from(lineTable)
      .where(and(eq(lineTable.orgId, principal.orgId), eq(lineTable.enabled, true)));

    const alcance = principal.kind === "api-key" && principal.allowedLines.length > 0
      ? lineas.filter((l) => principal.allowedLines.includes(l.id))
      : lineas;

    if (alcance.length === 0) throw new OmniError("not_found", "la credencial no alcanza ninguna línea");
    if (alcance.length > 1) {
      throw new OmniError(
        "conflict",
        "esta interfaz no lleva identificador de línea: acota la clave a una sola con `allowedLines`",
        { lineas: alcance.map((l) => l.id) },
      );
    }
    return { principal, lineId: alcance[0]!.id };
  };

  /**
   * `POST /api/send-message` — el endpoint polimórfico de WasenderAPI.
   *
   * Su forma es `imageUrl`, `videoUrl`…; la nuestra es `image: {url}`. La
   * traducción vive aquí para que `/v1` no cargue con dos vocabularios.
   */
  app.post("/api/send-message", async (c) => {
    const { principal, lineId } = await contexto(c);
    const cuerpo = await c.req.json<Record<string, unknown>>();

    const to = String(cuerpo["to"] ?? "");
    if (!to) throw new OmniError("validation_failed", "falta `to`");

    const url = (campo: string): { url: string } | undefined => {
      const v = cuerpo[campo];
      return typeof v === "string" && v.length > 0 ? { url: v } : undefined;
    };

    const entrada = SendMessageInput.parse({
      to,
      ...(cuerpo["text"] ? { text: String(cuerpo["text"]) } : {}),
      ...(url("imageUrl") ? { image: url("imageUrl") } : {}),
      ...(url("videoUrl") ? { video: url("videoUrl") } : {}),
      ...(url("audioUrl") ? { audio: url("audioUrl") } : {}),
      ...(url("documentUrl") ? { document: url("documentUrl") } : {}),
      ...(url("stickerUrl") ? { sticker: url("stickerUrl") } : {}),
      ...(cuerpo["fileName"] ? { fileName: String(cuerpo["fileName"]) } : {}),
      ...(cuerpo["replyTo"] ? { replyTo: String(cuerpo["replyTo"]) } : {}),
      ...(Array.isArray(cuerpo["mentions"]) ? { mentions: cuerpo["mentions"] as string[] } : {}),
      ...(cuerpo["viewOnce"] === true ? { viewOnce: true } : {}),
    });

    await authorize(principal, routeOf("message.send"), { lineId, chat: parseAddress(entrada.to) });
    const aceptado = await container.runtime.send(lineId, entrada, {
      ...(principal.kind === "api-key" ? { connectorId: principal.apiKeyId } : { userId: principal.userId }),
    });

    // El sobre de ELLOS, con su `msgId` y su `in_progress`.
    return c.json({
      success: true,
      data: { msgId: aceptado.messageId, status: "in_progress" },
    });
  });

  /** `GET /api/status` — devuelve `{status}` PELADO, sin sobre. Así es allí. */
  app.get("/api/status", async (c) => {
    const { lineId } = await contexto(c);
    const estado = await container.runtime.status(lineId);
    return c.json({ status: estado.state === "connected" ? "connected" : "disconnected" });
  });

  app.get("/api/contacts", async (c) => {
    const { principal, lineId } = await contexto(c);
    await authorize(principal, routeOf("contact.list"), { lineId });
    const { contactTable } = await import("@omni/db");
    const filas = await container.dbh.db.select().from(contactTable)
      .where(eq(contactTable.lineId, lineId)).limit(500);
    return c.json({
      success: true,
      data: filas.map((f) => ({
        jid: f.address, name: f.savedName ?? f.pushName ?? null, isBlocked: f.blocked,
      })),
    });
  });

  app.get("/api/groups", async (c) => {
    const { principal, lineId } = await contexto(c);
    await authorize(principal, routeOf("chat.list"), { lineId });
    const { groupInfoTable } = await import("@omni/db");
    const filas = await container.dbh.db.select().from(groupInfoTable)
      .where(eq(groupInfoTable.lineId, lineId));
    return c.json({
      success: true,
      data: filas.map((g) => ({ jid: g.address, name: g.subject, size: g.size })),
    });
  });

  return app;
}
