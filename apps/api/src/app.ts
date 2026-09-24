import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { OmniError, SendMessageInput, capabilities, parseAddress } from "@omni/shared";
import { authorize, filterLines, route as routeOf, type Principal } from "@omni/core";
import { apiKeyTable, chatTable, lineTable, messageTable, webhookDeliveryTable, webhookEndpointTable } from "@omni/db";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Container } from "./container.js";
import { authenticateApiKey, checkCidr } from "./middleware/auth.js";
import { problem } from "./http.js";

type Env = { Variables: { principal: Principal; container: Container } };

const ProblemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number(), detail: z.string(),
}).openapi("Problem");

const errors = {
  400: { description: "petición inválida", content: { "application/problem+json": { schema: ProblemSchema } } },
  401: { description: "sin autenticar", content: { "application/problem+json": { schema: ProblemSchema } } },
  403: { description: "prohibido", content: { "application/problem+json": { schema: ProblemSchema } } },
  404: { description: "no encontrado", content: { "application/problem+json": { schema: ProblemSchema } } },
  409: { description: "conflicto de estado", content: { "application/problem+json": { schema: ProblemSchema } } },
  422: { description: "no soportado por el transporte", content: { "application/problem+json": { schema: ProblemSchema } } },
};

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } }, description,
});

const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});

export function createApp(container: Container): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problem(c, new OmniError("validation_failed", "la petición no valida contra el esquema", {
          issues: result.error.issues,
        }));
      }
      return undefined;
    },
  });

  app.onError((err, c) => problem(c, err));
  app.use("*", async (c, next) => { c.set("container", container); await next(); });

  // ─────────────────────────────────────────────── sin autenticación
  app.openapi(
    createRoute({
      method: "get", path: "/health", tags: ["sistema"],
      summary: "Estado del servicio y sus dependencias",
      responses: { 200: json(z.object({ data: z.object({ status: z.string(), checks: z.record(z.string(), z.boolean()) }) }), "ok") },
    }),
    async (c) => {
      const checks: Record<string, boolean> = { database: false, queue: false };
      try { await container.dbh.sql`SELECT 1`; checks["database"] = true; } catch { /* abajo */ }
      try { await container.queue.depth("health"); checks["queue"] = true; } catch { /* abajo */ }
      const healthy = Object.values(checks).every(Boolean);
      return c.json({ data: { status: healthy ? "ok" : "degraded", checks } }, healthy ? 200 : 503);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/capabilities", tags: ["sistema"],
      summary: "Qué sabe hacer cada transporte disponible",
      description:
        "La API rechaza con 422 lo que el transporte de una línea no soporta. " +
        "Cloud API no ve grupos, whatsapp-web.js no rechaza llamadas y Baileys no " +
        "expone etiquetas de forma estable: aquí se consulta antes de intentarlo.",
      responses: { 200: json(z.object({ data: z.array(z.object({
        kind: z.string(), network: z.string(), risk: z.string(),
        linkMethod: z.string(), approxMemoryMbPerLine: z.number(),
        capabilities: z.array(z.string()),
      })) }), "ok") },
    }),
    async (c) => {
      const kinds = container.sandbox ? [container.sandbox] : [];
      return c.json({
        data: kinds.map((d) => ({
          kind: d.descriptor.kind, network: d.descriptor.network, risk: d.descriptor.risk,
          linkMethod: d.descriptor.linkMethod,
          approxMemoryMbPerLine: d.descriptor.approxMemoryMbPerLine,
          capabilities: [...d.descriptor.capabilities].sort(),
        })),
      });
    },
  );

  // ─────────────────────────────────────────────── autenticación
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/capabilities") return next();
    const principal = await authenticateApiKey(container.dbh.db, c.req.header("authorization"));

    if (principal.kind === "api-key") {
      const rows = await container.dbh.db
        .select({ cidrs: apiKeyTable.allowedCidrs })
        .from(apiKeyTable)
        .where(eq(apiKeyTable.id, principal.apiKeyId))
        .limit(1);
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      checkCidr(rows[0]?.cidrs ?? [], ip);
      // Marcar el uso ayuda a detectar claves olvidadas que siguen vivas.
      await container.dbh.db.update(apiKeyTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeyTable.id, principal.apiKeyId));
    }

    c.set("principal", principal);
    await next();
  });

  const LineSchema = z.object({
    id: z.string(), name: z.string(), slug: z.string(), channelKind: z.string(),
    address: z.string().nullable(), status: z.string(), enabled: z.boolean(),
    sendRatePerMinute: z.number(),
  }).openapi("Line");

  // ─────────────────────────────────────────────── líneas
  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines", tags: ["líneas"],
      summary: "Listar líneas al alcance de la credencial",
      responses: { 200: json(z.object({ data: z.array(LineSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("line.list"));
      const rows = await container.dbh.db.select().from(lineTable)
        .where(eq(lineTable.orgId, principal.orgId));
      // Una clave limitada ve SUS líneas, no un error: los listados se filtran.
      const visible = filterLines(principal, rows, (l) => l.id);
      return c.json({ data: visible.map(toLine) });
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/connect", tags: ["líneas"],
      summary: "Iniciar el enlace de una línea",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ state: z.string(), qr: z.string().optional() }) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      await authorize(principal, routeOf("line.connect"), { lineId });
      const status = await container.runtime.connect(lineId);
      return c.json({ data: status as never });
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/status", tags: ["líneas"],
      summary: "Estado de conexión de una línea",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ state: z.string() }) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      // Marcada segura para claves limitadas a chats: una integración necesita
      // saber si su línea está viva aunque no pueda ver ninguna conversación.
      await authorize(principal, routeOf("line.status"), { lineId });
      return c.json({ data: (await container.runtime.status(lineId)) as never });
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/disconnect", tags: ["líneas"],
      summary: "Cerrar la conexión sin desvincular el dispositivo",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      await authorize(principal, routeOf("line.connect"), { lineId });
      await container.runtime.disconnect(lineId);
      return c.json({ data: { ok: true } });
    },
  );

  // ─────────────────────────────────────────────── mensajes
  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/messages", tags: ["mensajes"],
      summary: "Enviar un mensaje de cualquier tipo",
      description:
        "UN endpoint para todos los tipos. El campo que rellenas decide qué sale: " +
        "`text`, `image`, `video`, `audio`, `document`, `sticker`, `contact`, " +
        "`location`, `poll`, `buttons` o `list`. Exactamente uno. " +
        "Repetir `clientMessageId` NO duplica el mensaje.",
      request: { params: z.object({ lineId: z.string() }), ...body(SendMessageInput) },
      responses: {
        202: json(z.object({ data: z.object({
          clientMessageId: z.string(), messageId: z.string(), state: z.string(),
        }) }), "aceptado y encolado"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      const input = c.req.valid("json");
      await authorize(principal, routeOf("message.send"), { lineId, chat: parseAddress(input.to) });
      const accepted = await container.runtime.send(lineId, input, {
        ...(principal.kind === "api-key" ? { connectorId: principal.apiKeyId } : { userId: principal.userId }),
      });
      // 202 y no 200: se aceptó, todavía no se envió. Mentir aquí haría que un
      // cliente creyera entregado algo que aún está en la cola.
      return c.json({ data: accepted }, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/chats", tags: ["mensajes"],
      summary: "Listar conversaciones",
      request: { params: z.object({ lineId: z.string() }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      responses: { 200: json(z.object({ data: z.array(z.object({
        address: z.string(), kind: z.string(), title: z.string().nullable(),
        lastMessageAt: z.string().nullable(), unreadCount: z.number(),
      })) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      await authorize(principal, routeOf("chat.list"), { lineId });
      const rows = await container.dbh.db.select().from(chatTable)
        .where(eq(chatTable.lineId, lineId))
        .orderBy(desc(chatTable.lastMessageAt)).limit(limit);
      const visible = principal.kind === "api-key" && principal.allowedChats.length > 0
        ? rows.filter((r) => principal.allowedChats.includes(r.address))
        : rows;
      return c.json({ data: visible.map((r) => ({
        address: r.address, kind: r.kind, title: r.title,
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null, unreadCount: r.unreadCount,
      })) });
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/chats/{chatId}/messages", tags: ["mensajes"],
      summary: "Historial de una conversación, paginado por cursor",
      request: {
        params: z.object({ lineId: z.string(), chatId: z.string() }),
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().optional().describe("ISO-8601: devuelve lo anterior a esa marca"),
        }),
      },
      responses: { 200: json(z.object({
        data: z.array(z.object({
          id: z.string(), providerMessageId: z.string().nullable(), fromMe: z.boolean(),
          kind: z.string(), body: z.string().nullable(), state: z.string(), timestamp: z.string(),
        })),
        meta: z.object({ nextBefore: z.string().nullable() }),
      }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId, chatId } = c.req.valid("param");
      const { limit, before } = c.req.valid("query");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(principal, routeOf("message.list"), { lineId, chat });

      const conds = [eq(messageTable.lineId, lineId), eq(messageTable.chatId, chat.value)];
      if (before) conds.push(lt(messageTable.timestamp, new Date(before)));
      const rows = await container.dbh.db.select().from(messageTable)
        .where(and(...conds))
        .orderBy(desc(messageTable.timestamp), desc(messageTable.id))
        .limit(limit);

      return c.json({
        data: rows.map((r) => ({
          id: r.id, providerMessageId: r.providerMessageId, fromMe: r.fromMe,
          kind: r.kind, body: r.body, state: r.state, timestamp: r.timestamp.toISOString(),
        })),
        meta: { nextBefore: rows.length === limit ? rows.at(-1)!.timestamp.toISOString() : null },
      });
    },
  );

  registerWebhookRoutes(app, container);
  registerSandboxRoutes(app, container);
  registerDocs(app, container);
  return app;
}

function toLine(l: typeof lineTable.$inferSelect) {
  return {
    id: l.id, name: l.name, slug: l.slug, channelKind: l.channelKind,
    address: l.address, status: l.status, enabled: l.enabled,
    sendRatePerMinute: l.sendRatePerMinute,
  };
}



// ─────────────────────────────────────────────── webhooks
function registerWebhookRoutes(app: OpenAPIHono<Env>, container: Container): void {
  const EndpointSchema = z.object({
    id: z.string(), url: z.string(), events: z.array(z.string()),
    lineId: z.string().nullable(), enabled: z.boolean(), hmacEnabled: z.boolean(),
  }).openapi("WebhookEndpoint");

  app.openapi(
    createRoute({
      method: "post", path: "/v1/webhooks", tags: ["webhooks"],
      summary: "Registrar un receptor de eventos",
      description:
        "La firma va en `X-Omni-Signature` como `t=<epoch>,v1=<hmac-sha256>` sobre " +
        "el CUERPO CRUDO. Verifícala antes de parsear el JSON: cualquier middleware " +
        "que consuma el flujo te deja sin nada que hashear. " +
        "Una lista de `events` vacía significa TODOS los eventos.",
      request: { ...body(z.object({
        url: z.string().url(),
        events: z.array(z.string()).default([]),
        lineId: z.string().nullable().default(null),
        secret: z.string().min(16).optional(),
        hmacEnabled: z.boolean().default(true),
        maxAttempts: z.number().int().min(1).max(10).default(5),
        timeoutMs: z.number().int().min(1000).max(60000).default(10000),
        filter: z.record(z.string(), z.unknown()).nullable().default(null),
      })) },
      responses: { 201: json(z.object({ data: EndpointSchema.extend({ secret: z.string() }) }), "creado"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      await authorize(principal, routeOf("webhook.manage"), { ...(input.lineId ? { lineId: input.lineId } : {}) });
      const secret = input.secret ?? crypto.randomUUID().replaceAll("-", "");
      const id = crypto.randomUUID();
      await container.dbh.db.insert(webhookEndpointTable).values({
        id, orgId: principal.orgId, lineId: input.lineId, url: input.url,
        events: input.events, secret, hmacEnabled: input.hmacEnabled,
        maxAttempts: input.maxAttempts, timeoutMs: input.timeoutMs,
        filter: input.filter as never,
      });
      // El secreto se devuelve AQUÍ y no vuelve a mostrarse.
      return c.json({ data: { id, url: input.url, events: input.events, lineId: input.lineId,
        enabled: true, hmacEnabled: input.hmacEnabled, secret } }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/webhooks", tags: ["webhooks"],
      summary: "Listar receptores",
      responses: { 200: json(z.object({ data: z.array(EndpointSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("webhook.manage"));
      const rows = await container.dbh.db.select().from(webhookEndpointTable)
        .where(eq(webhookEndpointTable.orgId, principal.orgId));
      return c.json({ data: rows.map((r) => ({
        id: r.id, url: r.url, events: r.events, lineId: r.lineId,
        enabled: r.enabled, hmacEnabled: r.hmacEnabled,
      })) });
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/dispatches", tags: ["webhooks"],
      summary: "Intentos de entrega, con su estado y su error",
      description:
        "Un webhook que falla tiene que ser VISIBLE. Aquí queda cada intento, " +
        "con el código que respondió el receptor y cuánto tardó.",
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      responses: { 200: json(z.object({ data: z.array(z.object({
        id: z.string(), event: z.string(), status: z.string(), attempt: z.number(),
        responseStatus: z.number().nullable(), error: z.string().nullable(),
        durationMs: z.number().nullable(), createdAt: z.string(),
      })) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { limit } = c.req.valid("query");
      await authorize(principal, routeOf("webhook.manage"));
      const rows = await container.dbh.db.select().from(webhookDeliveryTable)
        .where(eq(webhookDeliveryTable.orgId, principal.orgId))
        .orderBy(desc(webhookDeliveryTable.createdAt)).limit(limit);
      return c.json({ data: rows.map((r) => ({
        id: r.id, event: r.event, status: r.status, attempt: r.attempt,
        responseStatus: r.responseStatus, error: r.error, durationMs: r.durationMs,
        createdAt: r.createdAt.toISOString(),
      })) });
    },
  );
}

// ─────────────────────────────────────────────── sandbox
function registerSandboxRoutes(app: OpenAPIHono<Env>, container: Container): void {
  const guard = (c: { get: (k: "principal") => Principal }) => {
    if (!container.sandbox) {
      throw new OmniError("not_found", "el sandbox está deshabilitado (SANDBOX_ENABLED=false)");
    }
    return c.get("principal");
  };

  app.openapi(
    createRoute({
      method: "post", path: "/v1/sandbox/lines/{lineId}/scan", tags: ["sandbox"],
      summary: "Completar el enlace sin escanear nada",
      description:
        "El equivalente a escanear el QR con el teléfono, pero por API. Es lo que " +
        "permite que una prueba de integración de WhatsApp corra desatendida en CI.",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({ phone: z.string().min(5) })),
      },
      responses: { 200: json(z.object({ data: z.object({ state: z.string() }) }), "enlazada"), ...errors },
    }),
    async (c) => {
      const principal = guard(c);
      const { lineId } = c.req.valid("param");
      const { phone } = c.req.valid("json");
      await authorize(principal, routeOf("line.connect"), { lineId });
      const status = await container.sandbox!.scan(lineId as never, phone);
      return c.json({ data: status as never });
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/sandbox/lines/{lineId}/inbound", tags: ["sandbox"],
      summary: "Fabricar un mensaje entrante de un contacto que no existe",
      description:
        "El evento que sale de aquí es idéntico al de una línea real, así que tu " +
        "manejador de webhooks recibe una entrega firmada de verdad contra la que probarse.",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({
          from: z.string().min(5), text: z.string(),
          chat: z.string().optional().describe("Para simular un grupo"),
          pushName: z.string().optional(),
        })),
      },
      responses: { 201: json(z.object({ data: z.object({ id: z.string(), chat: z.string() }) }), "creado"), ...errors },
    }),
    async (c) => {
      const principal = guard(c);
      const { lineId } = c.req.valid("param");
      const input = c.req.valid("json");
      await authorize(principal, routeOf("line.connect"), { lineId });
      const msg = await container.sandbox!.inbound(lineId as never, input.from, input.text, {
        ...(input.chat ? { chat: input.chat } : {}),
        ...(input.pushName ? { pushName: input.pushName } : {}),
      });
      return c.json({ data: { id: msg.id, chat: msg.chat } }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/sandbox/lines/{lineId}/thread", tags: ["sandbox"],
      summary: "La conversación simulada, en ambos sentidos",
      request: { params: z.object({ lineId: z.string() }), query: z.object({ chat: z.string().optional() }) },
      responses: { 200: json(z.object({ data: z.array(z.object({
        id: z.string(), chat: z.string(), fromMe: z.boolean(),
        text: z.string().nullable(), state: z.string(),
      })) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = guard(c);
      const { lineId } = c.req.valid("param");
      const { chat } = c.req.valid("query");
      await authorize(principal, routeOf("line.status"), { lineId });
      const thread = container.sandbox!.thread(lineId as never, chat);
      return c.json({ data: thread.map((m) => ({
        id: m.id, chat: m.chat, fromMe: m.fromMe, text: m.text, state: m.state,
      })) });
    },
  );
}

// ─────────────────────────────────────────────── documentación
function registerDocs(app: OpenAPIHono<Env>, container: Container): void {
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Omni",
      version: "0.1.0",
      description:
        "Plataforma multicanal de mensajería.\n\n" +
        "**Antes de enlazar un número de WhatsApp:** los transportes " +
        "`whatsapp.baileys` y `whatsapp.web` conducen clientes NO oficiales. " +
        "WhatsApp puede restringir o banear la cuenta y ninguna calidad de código " +
        "hace ese riesgo cero. Usa un número que puedas permitirte perder. Para " +
        "entornos regulados usa `whatsapp.cloud`, la API oficial de Meta.\n\n" +
        "Consulta `GET /v1/capabilities` para saber qué soporta cada transporte: " +
        "lo que uno no sabe hacer se rechaza con 422, nunca en silencio.",
    },
    servers: [{ url: container.config.PUBLIC_URL }],
  });

  app.get("/docs", (c) =>
    c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Omni — API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/@stoplight/elements/styles.min.css"></head>
<body style="margin:0"><elements-api apiDescriptionUrl="/openapi.json" router="hash" layout="sidebar"></elements-api>
<script src="https://unpkg.com/@stoplight/elements/web-components.min.js"></script></body></html>`));
}
