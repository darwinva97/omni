import { z } from "zod";
import { OmniError, parseAddress, SendMessageInput } from "@omni/shared";
import { authorize, filterLines, route as routeOf, type Principal } from "@omni/core";
import { chatTable, lineTable, messageTable } from "@omni/db";
import { and, desc, eq } from "drizzle-orm";
import type { Container } from "../container.js";

/**
 * Herramientas MCP.
 *
 * Cada una vuelve a pasar por el MISMO guardián que la ruta REST equivalente.
 * No basta con comprobar en la puerta: el montaje MCP autentica fuera del
 * middleware REST, así que heredar los permisos "por estar dentro" dejaría un
 * agente con más alcance del que le corresponde. La comprobación es POR
 * LLAMADA, no por conexión.
 */

export interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: z.ZodRawShape;
  /** Solo lectura: disponible aunque el servidor arranque en modo restringido. */
  readonly readOnly: boolean;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolContext {
  readonly container: Container;
  readonly principal: Principal;
}

const textOf = (v: unknown): string => JSON.stringify(v, null, 2);

export const TOOLS: readonly ToolDef[] = [
  {
    name: "listar_lineas",
    title: "Listar líneas",
    description:
      "Las líneas que esta credencial alcanza, con su canal y su estado de conexión. " +
      "Una credencial acotada ve solo las suyas.",
    schema: {},
    readOnly: true,
    async run({ container, principal }) {
      await authorize(principal, routeOf("line.list"));
      const rows = await container.dbh.db.select().from(lineTable)
        .where(eq(lineTable.orgId, principal.orgId));
      return filterLines(principal, rows, (l) => l.id).map((l) => ({
        id: l.id, nombre: l.name, canal: l.channelKind,
        direccion: l.address, estado: l.status,
      }));
    },
  },
  {
    name: "capacidades",
    title: "Capacidades de los transportes",
    description:
      "Qué sabe hacer cada transporte. Consúltalo ANTES de intentar algo poco " +
      "común: Cloud API no ve grupos, whatsapp-web.js no rechaza llamadas.",
    schema: {},
    readOnly: true,
    async run({ container }) {
      return container.drivers.map((d) => ({
        transporte: d.descriptor.kind,
        riesgo: d.descriptor.risk,
        capacidades: [...d.descriptor.capabilities].sort(),
      }));
    },
  },
  {
    name: "listar_chats",
    title: "Listar conversaciones",
    description: "Conversaciones de una línea, de la más reciente a la más antigua.",
    schema: {
      lineId: z.string().describe("Identificador de la línea"),
      limit: z.number().int().min(1).max(100).default(30),
    },
    readOnly: true,
    async run({ container, principal }, args) {
      const lineId = String(args["lineId"]);
      await authorize(principal, routeOf("chat.list"), { lineId });
      const rows = await container.dbh.db.select().from(chatTable)
        .where(eq(chatTable.lineId, lineId))
        .orderBy(desc(chatTable.lastMessageAt))
        .limit(Number(args["limit"] ?? 30));
      const visible = principal.kind === "api-key" && principal.allowedChats.length > 0
        ? rows.filter((r) => principal.allowedChats.includes(r.address))
        : rows;
      return visible.map((r) => ({
        chat: r.address, tipo: r.kind, titulo: r.title,
        sinLeer: r.unreadCount, ultimo: r.lastMessageAt?.toISOString() ?? null,
      }));
    },
  },
  {
    name: "leer_conversacion",
    title: "Leer una conversación",
    description: "Mensajes de un chat, del más reciente al más antiguo.",
    schema: {
      lineId: z.string(),
      chat: z.string().describe("Dirección del chat, por ejemplo 51999888777@s.whatsapp.net"),
      limit: z.number().int().min(1).max(100).default(30),
    },
    readOnly: true,
    async run({ container, principal }, args) {
      const lineId = String(args["lineId"]);
      const chat = parseAddress(String(args["chat"]));
      await authorize(principal, routeOf("message.list"), { lineId, chat });
      const rows = await container.dbh.db.select().from(messageTable)
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.chatId, chat.value)))
        .orderBy(desc(messageTable.timestamp))
        .limit(Number(args["limit"] ?? 30));
      return rows.map((m) => ({
        mio: m.fromMe, tipo: m.kind, texto: m.body,
        estado: m.state, cuando: m.timestamp.toISOString(),
      }));
    },
  },
  {
    name: "enviar_mensaje",
    title: "Enviar un mensaje",
    description:
      "Envía por una línea. Devuelve enseguida: el mensaje queda ENCOLADO, no " +
      "entregado. Usa `clientMessageId` para que un reintento no duplique.",
    schema: {
      lineId: z.string(),
      to: z.string().describe("Destinatario: teléfono o dirección completa"),
      text: z.string().min(1),
      replyTo: z.string().optional(),
      clientMessageId: z.string().optional(),
    },
    readOnly: false,
    async run({ container, principal }, args) {
      const lineId = String(args["lineId"]);
      const input = SendMessageInput.parse({
        to: String(args["to"]),
        text: String(args["text"]),
        ...(args["replyTo"] ? { replyTo: String(args["replyTo"]) } : {}),
        ...(args["clientMessageId"] ? { clientMessageId: String(args["clientMessageId"]) } : {}),
      });
      await authorize(principal, routeOf("message.send"), { lineId, chat: parseAddress(input.to) });
      const accepted = await container.runtime.send(lineId, input, {
        ...(principal.kind === "api-key" ? { connectorId: principal.apiKeyId } : { userId: principal.userId }),
      });
      return { ...accepted, nota: "encolado; consulta el estado con leer_conversacion" };
    },
  },
  {
    name: "sandbox_mensaje_entrante",
    title: "Fabricar un mensaje entrante (sandbox)",
    description:
      "Solo en líneas de sandbox. Simula que alguien te escribe, para probar un " +
      "flujo completo sin un teléfono real y sin arriesgar ninguna cuenta.",
    schema: { lineId: z.string(), from: z.string(), text: z.string() },
    readOnly: false,
    async run({ container, principal }, args) {
      if (!container.sandbox) throw new OmniError("not_found", "el sandbox está deshabilitado");
      const lineId = String(args["lineId"]);
      await authorize(principal, routeOf("line.connect"), { lineId });
      const msg = await container.sandbox.inbound(
        lineId as never, String(args["from"]), String(args["text"]),
      );
      return { id: msg.id, chat: msg.chat };
    },
  },
];

export const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: textOf(value) }],
});

export const toolError = (err: unknown) => {
  const e = err instanceof OmniError
    ? err
    : new OmniError("internal", err instanceof Error ? err.message : String(err));
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${e.code}: ${e.message}` }],
  };
};
