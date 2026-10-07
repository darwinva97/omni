import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { OmniError, SendMessageInput, capabilities, parseAddress } from "@omni/shared";
import { authorize, filterLines, route as routeOf, type Principal } from "@omni/core";
import { apiKeyTable, chatTable, contactTable, identityMapTable, labelAssignmentTable, lineTable, messageTable, pollTable, pollVoteTable, reactionTable, webhookDeliveryTable, webhookEndpointTable } from "@omni/db";
import { and, desc, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import type { LineStatus } from "@omni/channels";
import type { LineId } from "@omni/shared";
import type { Container } from "./container.js";

/**
 * Una conversación tal y como se enseña.
 *
 * `displayName` es lo que se pinta y `address` el detalle. Con el
 * direccionamiento por LID la dirección es un número opaco de quince cifras
 * que no se parece a un teléfono, así que sin nombre resuelto la lista de
 * conversaciones no se puede leer.
 */
/**
 * La foto de perfil se firma al LEER, como cualquier otro medio.
 *
 * Guardar la URL firmada en la base la dejaría caducada al día siguiente, que
 * es exactamente el fallo que tiene guardar la URL original de WhatsApp.
 * Dura más que la de un mensaje porque un avatar se pinta en cada fila de la
 * lista y se vuelve a pedir en cada navegación.
 */
async function urlDeAvatar(container: Container, key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  return container.storage.signedUrl(key, 24 * 3600).catch(() => null);
}

/** Cuánto vale una URL de medio. Lo justo para abrir la conversación y verla. */
const MEDIA_URL_TTL = 3600;

/** Los tipos de mensaje que llevan fichero; para saber si un hueco es un fallo. */
const MEDIA_KINDS_API = new Set(["image", "video", "audio", "document", "sticker"]);

const MensajeSchema = z.object({
  id: z.string(),
  providerMessageId: z.string().nullable(),
  /** El que puso quien envió. Permite reconocer el mensaje propio al volver. */
  clientMessageId: z.string().nullable(),
  /**
   * Quién lo escribió, en un grupo.
   *
   * En un chat de dos sobra —solo hay dos— pero en un grupo es lo que permite
   * seguir una conversación: sin él, veinte burbujas iguales sin saber de
   * quién es cada una.
   */
  senderAddress: z.string().nullable(),
  senderName: z.string().nullable(),
  fromMe: z.boolean(),
  kind: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  timestamp: z.string(),
  media: z.object({
    url: z.string(),
    mimeType: z.string(),
    fileName: z.string().nullable(),
    size: z.number().nullable(),
  }).nullable(),
  /** Por qué no hay fichero, cuando debería haberlo. */
  mediaError: z.string().nullable(),
  /** Reacciones, agrupadas por emoji. `mia` dice si una es nuestra. */
  reacciones: z.array(z.object({
    emoji: z.string(), cuantas: z.number(), mia: z.boolean(),
  })).default([]),
  /**
   * Retirado por quien lo escribió.
   *
   * El cuerpo sigue viniendo a propósito: la fila no se borra, se marca, y
   * quien audita una conversación necesita saber qué decía lo que se retiró.
   * El panel enseña el aviso, no el texto.
   */
  deleted: z.boolean().default(false),
  /**
   * A qué mensaje responde, ya resuelto.
   *
   * Viene resuelto y no como un identificador suelto a propósito: pintar la
   * cita obliga a saber quién la escribió y qué decía, y dejar eso al cliente
   * significa una petición por burbuja citada.
   */
  replyTo: z.object({
    id: z.string(),
    fromMe: z.boolean(),
    senderName: z.string().nullable(),
    kind: z.string(),
    body: z.string().nullable(),
    /** Miniatura del citado, cuando lo tenemos y lleva fichero. */
    thumbUrl: z.string().nullable(),
    /**
     * `false` cuando el original no está en esta base.
     *
     * La cita se enseña igual —WhatsApp manda una copia dentro del mensaje que
     * responde— pero no se puede saltar a ella, y el panel debe saberlo para
     * no ofrecer un salto que no lleva a ninguna parte.
     */
    disponible: z.boolean(),
  }).nullable().default(null),
  /**
   * La encuesta, cuando el mensaje es una.
   *
   * Con sus votos ya contados: WhatsApp los manda cifrados y uno a uno, y
   * contarlos en el cliente obligaría a repartir la clave de descifrado.
   */
  poll: z.object({
    question: z.string(),
    allowMultiple: z.boolean(),
    totalVotes: z.number(),
    options: z.array(z.object({
      name: z.string(),
      votes: z.number(),
      /** Si esta línea votó esa opción. */
      mine: z.boolean(),
    })),
  }).nullable().default(null),
}).openapi("Mensaje");

const ChatSchema = z.object({
  address: z.string(),
  kind: z.string(),
  displayName: z.string(),
  title: z.string().nullable(),
  /** El que TÚ le pusiste en tu agenda. Manda al enseñarlo. */
  savedName: z.string().nullable(),
  /** El que esa persona se puso a sí misma. Es el recambio. */
  pushName: z.string().nullable(),
  /** Foto de perfil, con URL firmada. `null` si no tiene o no se puede ver. */
  avatarUrl: z.string().nullable(),
  /** El teléfono detrás de un LID, cuando lo sabemos. */
  phone: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  unreadCount: z.number(),
  /** Resumen del último mensaje, para la lista. `null` si aún no hay ninguno. */
  ultimo: z.string().nullable(),
  ultimoPropio: z.boolean(),
  /**
   * Silenciada en WhatsApp hasta este instante.
   *
   * Es el silencio de la cuenta, el mismo que se ve en el teléfono, no un
   * ajuste de este panel: silenciar aquí silencia allí y al revés.
   */
  mutedUntil: z.string().nullable(),
  archived: z.boolean().default(false),
  pinned: z.boolean().default(false),
  /**
   * Las listas de Omni en las que está.
   *
   * Son etiquetas NUESTRAS, no de WhatsApp: agrupan conversaciones en el panel
   * y no se ven en el teléfono. Vienen con el chat para que filtrar por lista
   * no cueste una petición por pestaña.
   */
  labelIds: z.array(z.string()).default([]),
}).openapi("Chat");

/**
 * Lo único que nos interesa del nodo original: la copia de la cita.
 *
 * WhatsApp manda dentro del mensaje que responde una copia del citado, y es lo
 * que permite enseñar la cita de algo que no está en esta base. Se lee de ahí
 * y no se vuelve a pedir a la red, que ya no lo daría.
 */
interface CrudoConCita {
  replyTo?: { id: string; author?: string | null; kind?: string; text?: string | null };
}

interface FilaDeChat {
  address: string; kind: string; title: string | null;
  lastMessageAt: Date | null; unreadCount: number;
  pushName: string | null; savedName: string | null; phone: string | null;
  avatarKey?: string | null; avatarUrl?: string | null;
  ultimo?: string | null; ultimoPropio?: boolean;
  muteUntil?: Date | null; archived?: boolean; pinned?: boolean;
  labelIds?: string[];
}

/**
 * El último mensaje de cada conversación, en UNA consulta.
 *
 * `DISTINCT ON` con el orden adecuado devuelve una fila por chat sin recorrer
 * la tabla una vez por conversación: con sesenta chats, lo segundo son sesenta
 * viajes a la base para pintar una lista.
 */
async function ultimosMensajes(
  container: Container, lineId: string, direcciones: readonly string[],
): Promise<Map<string, { texto: string; propio: boolean }>> {
  if (direcciones.length === 0) return new Map();
  /*
   * El último mensaje CUENTA incluso si lo retiraron.
   *
   * Saltárselo hacía que la conversación pareciera inactiva desde antes de lo
   * que fue: el adelanto enseñaba un mensaje de ayer cuando el de hoy existió
   * y se borró. Se enseña que hubo algo y que ya no está.
   */
  const filas = await container.dbh.sql<
    { chat_id: string; kind: string; body: string | null; from_me: boolean;
      retirado: boolean }[]
  >`
    SELECT DISTINCT ON (chat_id)
      chat_id, kind, body, from_me, deleted_at IS NOT NULL AS retirado
    FROM message
    WHERE line_id = ${lineId} AND chat_id = ANY(${direcciones as string[]})
    ORDER BY chat_id, timestamp DESC`;

  const nombres: Record<string, string> = {
    image: "Foto", video: "Vídeo", audio: "Audio", sticker: "Sticker",
    document: "Documento", location: "Ubicación", contact: "Contacto",
    poll: "Encuesta", template: "Plantilla", buttons: "Mensaje con botones",
    list: "Mensaje con lista", unknown: "Mensaje no compatible",
  };
  return new Map(filas.map((f) => [
    f.chat_id,
    {
      texto: f.retirado
        ? "Se eliminó este mensaje"
        : f.body?.trim() || nombres[f.kind] || "Mensaje",
      propio: f.from_me,
    },
  ]));
}

/** Las listas de Omni de cada conversación, en UNA consulta. */
async function listasDe(
  container: Container, lineId: string, direcciones: readonly string[],
): Promise<Map<string, string[]>> {
  if (direcciones.length === 0) return new Map();
  const filas = await container.dbh.db
    .select({ target: labelAssignmentTable.target, labelId: labelAssignmentTable.labelId })
    .from(labelAssignmentTable)
    .where(and(
      eq(labelAssignmentTable.lineId, lineId),
      inArray(labelAssignmentTable.target, [...direcciones]),
    ));
  const mapa = new Map<string, string[]>();
  for (const f of filas) mapa.set(f.target, [...(mapa.get(f.target) ?? []), f.labelId]);
  return mapa;
}

/**
 * Qué nombre gana, de mejor a peor.
 *
 * 1. El asunto de un GRUPO, que no tiene recambio posible.
 * 2. El nombre que TÚ le pusiste en tu agenda: lo elegiste para reconocerlo.
 * 3. El que esa persona se puso a sí misma, que es lo que hay cuando no la
 *    tienes guardada.
 * 4. El teléfono, que al menos se reconoce.
 * 5. La dirección, que con el direccionamiento por LID no identifica a nadie,
 *    y por eso es el último recurso y no el primero.
 *
 * Los dos nombres se devuelven ADEMÁS del resuelto: la ficha del contacto los
 * enseña por separado, porque saber que alguien se llama «Juan» en tu agenda y
 * «Juan Pérez — Ventas» en WhatsApp es información, no ruido.
 */
/**
 * La cita de un mensaje que responde a otro.
 *
 * Dos orígenes y en este orden: el mensaje original de NUESTRA base, que es el
 * bueno —tiene su estado actual, su fichero y su nombre resuelto—, y si no
 * está, la copia que WhatsApp metió dentro del mensaje que responde.
 *
 * El segundo no es un apaño: es la única forma de enseñar la cita de algo
 * anterior al enlace de la línea, y WhatsApp hace exactamente lo mismo. Lo que
 * cambia es que entonces no se puede saltar al original, y eso se dice con
 * `disponible` en vez de ofrecer un salto que no lleva a ningún sitio.
 */
async function citaDe(
  container: Container,
  replyToId: string | null,
  crudo: CrudoConCita | null,
  originales: Map<string, {
    fromMe: boolean; senderAddress: string; kind: string; body: string | null;
    mediaKey: string | null;
  }>,
  nombres: Map<string, string>,
  chat: string,
): Promise<{
  id: string; fromMe: boolean; senderName: string | null; kind: string;
  body: string | null; thumbUrl: string | null; disponible: boolean;
} | null> {
  if (!replyToId) return null;

  const quien = (direccion: string | null | undefined): string | null => {
    if (!direccion || direccion === chat) return null;
    return nombres.get(direccion) ?? `+${direccion.split("@")[0]}`;
  };

  const original = originales.get(replyToId);
  if (original) {
    return {
      id: replyToId,
      fromMe: original.fromMe,
      senderName: original.fromMe ? null : quien(original.senderAddress),
      kind: original.kind,
      body: original.body,
      thumbUrl: original.mediaKey
        ? await container.storage.signedUrl(original.mediaKey, MEDIA_URL_TTL)
        : null,
      disponible: true,
    };
  }

  const copia = crudo?.replyTo;
  if (!copia) return null;
  return {
    id: replyToId,
    // Sin el original no se sabe de quién era: sin autor, el panel lo dice.
    fromMe: false,
    senderName: quien(copia.author),
    kind: copia.kind ?? "unknown",
    body: copia.text ?? null,
    thumbUrl: null,
    disponible: false,
  };
}

function presentarChat(r: FilaDeChat) {
  const telefono = r.phone ? r.phone.split("@")[0]! : null;
  const displayName =
    // El título solo manda en lo que no es una persona: en un chat
    // individual lo tiene que decidir la agenda, no un nombre heredado.
    (r.kind === "group" || r.kind === "broadcast" || r.kind === "newsletter"
      ? r.title?.trim() : null) ||
    r.savedName?.trim() ||
    r.pushName?.trim() ||
    r.title?.trim() ||
    (telefono ? `+${telefono}` : null) ||
    (r.kind === "group" ? "Grupo sin nombre"
      : r.kind === "newsletter" ? "Canal sin nombre"
      : r.address.split("@")[0]!);

  return {
    address: r.address,
    kind: r.kind,
    displayName,
    title: r.title,
    savedName: r.savedName,
    pushName: r.pushName,
    avatarUrl: r.avatarUrl ?? null,
    phone: r.phone,
    lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
    unreadCount: r.unreadCount,
    ultimo: r.ultimo ?? null,
    ultimoPropio: r.ultimoPropio ?? false,
    mutedUntil: r.muteUntil?.toISOString() ?? null,
    archived: r.archived ?? false,
    pinned: r.pinned ?? false,
    labelIds: r.labelIds ?? [],
  };
}
import { authenticateApiKey, authenticateSession, checkCidr } from "./middleware/auth.js";
import { getCookie } from "hono/cookie";
import { problem } from "./http.js";
import { registerMessagingRoutes } from "./routes/messaging.js";
import { registerLineAdminRoutes } from "./routes/lines.js";
import { registerGroupRoutes, registerGroupChatRoutes } from "./routes/groups.js";
import { registerLabelRoutes } from "./routes/labels.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerNewsletterRoutes } from "./routes/newsletters.js";
import { registerCrmRoutes } from "./routes/crm.js";
import { registerCommerceRoutes } from "./routes/commerce.js";
import { HOST_VERSION } from "./container.js";
import { registerIdentityRoutes, SESSION_COOKIE } from "./routes/identity.js";
import { registerCloudWebhookRoutes } from "./routes/cloud-webhook.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { wasenderCompat } from "./compat/wasender.js";
import { evolutionCompat } from "./compat/evolution.js";

type Env = { Variables: { principal: Principal; container: Container } };

const LinkStateSchema = z.object({
  state: z.string(),
  qr: z.string().optional(),
  pairingCode: z.string().optional(),
  self: z.string().optional(),
}).openapi("LinkState");

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

export interface AppOptions {
  readonly gateway?: import("./realtime/gateway.js").RealtimeGateway;
}

export function createApp(container: Container, opts: AppOptions = {}): OpenAPIHono<Env> {
  void opts;
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
      responses: {
        200: json(z.object({ data: z.object({ status: z.string(), checks: z.record(z.string(), z.boolean()) }) }), "sano"),
        503: json(z.object({ data: z.object({ status: z.string(), checks: z.record(z.string(), z.boolean()) }) }), "degradado"),
      },
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
      return c.json({
        data: container.drivers.map((d) => ({
          kind: d.descriptor.kind, network: d.descriptor.network, risk: d.descriptor.risk,
          linkMethod: d.descriptor.linkMethod,
          approxMemoryMbPerLine: d.descriptor.approxMemoryMbPerLine,
          capabilities: [...d.descriptor.capabilities].sort(),
        })),
      }, 200);
    },
  );

  // ─────────────────────────────────────────────── autenticación
  /**
   * Rutas de `/v1` que NO llevan credencial.
   *
   * `GET /v1/media/...` se sirve por URL firmada y caducada: la firma es la
   * credencial. Exigir además una clave de API haría imposible pegar el enlace
   * en un `<img>` o mandárselo a un tercero, que es justo para lo que existe.
   */
  const sinCredencial = (method: string, path: string): boolean =>
    path === "/v1/capabilities" ||
    // Alta, entrada y aceptación de invitación son, por definición, anteriores
    // a tener credencial.
    path === "/v1/auth/register" ||
    path === "/v1/auth/login" ||
    path === "/v1/auth/logout" ||
    path === "/v1/invitations/accept" ||
    // El billete de un solo uso ES la credencial; se canjea en el manejador.
    path === "/v1/realtime/ws" ||
    // Meta no tiene credencial nuestra: esta ruta se autentica con la firma
    // del cuerpo, comprobada dentro del propio manejador.
    /^\/v1\/channels\/cloud\/[^/]+\/webhook$/.test(path) ||
    (method === "GET" && path.startsWith("/v1/media/"));

  app.use("/v1/*", async (c, next) => {
    if (sinCredencial(c.req.method, c.req.path)) return next();

    /*
     * Dos formas de identificarse, con la misma salida.
     *
     * Una persona trae cookie de sesión; una integración, clave de API. A
     * partir de aquí el resto del sistema ve un `Principal` y no sabe —ni
     * necesita saber— cuál de las dos era.
     */
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      const persona = await authenticateSession(container.dbh.db, cookie);
      if (persona) {
        c.set("principal", persona);
        return next();
      }
    }

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
      /*
       * Las borradas NO salen.
       *
       * El borrado es blando —la bitácora necesita saber qué línea mandó qué—
       * pero eso es cosa de la base, no del usuario: una línea que borraste y
       * sigue en la lista es un borrado que no funciona.
       */
      const rows = await container.dbh.db.select().from(lineTable)
        .where(and(eq(lineTable.orgId, principal.orgId), isNull(lineTable.deletedAt)));
      // Una clave limitada ve SUS líneas, no un error: los listados se filtran.
      const visible = filterLines(principal, rows, (l) => l.id);
      return c.json({ data: visible.map(toLine) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/connect", tags: ["líneas"],
      summary: "Iniciar el enlace de una línea",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: LinkStateSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      await authorize(principal, routeOf("line.connect"), { lineId });
      return c.json({ data: linkState(await container.runtime.connect(lineId)) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/status", tags: ["líneas"],
      summary: "Estado de conexión de una línea",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: LinkStateSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      // Marcada segura para claves limitadas a chats: una integración necesita
      // saber si su línea está viva aunque no pueda ver ninguna conversación.
      await authorize(principal, routeOf("line.status"), { lineId });
      return c.json({ data: linkState(await container.runtime.status(lineId)) }, 200);
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
      return c.json({ data: { ok: true } }, 200);
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
          /** El fichero ya convertido, con su URL firmada, para poder pintarlo. */
          media: z.object({
            url: z.string(), mimeType: z.string(),
            fileName: z.string().nullable(), size: z.number(),
          }).nullable(),
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
      return c.json({
        data: {
          clientMessageId: accepted.clientMessageId,
          messageId: accepted.messageId,
          state: accepted.state,
          media: accepted.media
            ? {
                url: await container.storage.signedUrl(accepted.media.storageKey, MEDIA_URL_TTL),
                mimeType: accepted.media.mimeType,
                fileName: accepted.media.fileName ?? null,
                size: accepted.media.size,
              }
            : null,
        },
      }, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/chats", tags: ["mensajes"],
      summary: "Listar conversaciones",
      request: { params: z.object({ lineId: z.string() }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      responses: { 200: json(z.object({ data: z.array(ChatSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      await authorize(principal, routeOf("chat.list"), { lineId });

      /*
       * Se trae el nombre del contacto y el teléfono del LID en la MISMA
       * consulta. Resolverlos luego, uno por conversación, son cincuenta
       * viajes a la base para pintar una lista de cincuenta filas.
       */
      const rows = await container.dbh.db
        .select({
          address: chatTable.address, kind: chatTable.kind, title: chatTable.title,
          lastMessageAt: chatTable.lastMessageAt, unreadCount: chatTable.unreadCount,
          avatarKey: chatTable.avatarKey,
          muteUntil: chatTable.muteUntil, archived: chatTable.archived,
          pinned: chatTable.pinned,
          pushName: contactTable.pushName, savedName: contactTable.savedName,
          phone: identityMapTable.phone,
        })
        .from(chatTable)
        .leftJoin(contactTable, and(
          eq(contactTable.lineId, chatTable.lineId),
          eq(contactTable.address, chatTable.address),
        ))
        .leftJoin(identityMapTable, and(
          eq(identityMapTable.lineId, chatTable.lineId),
          eq(identityMapTable.lid, chatTable.address),
        ))
        /*
         * `status@broadcast` NO es una conversación: es el muro de estados.
         * Colarlo entre los chats pone «Estados» con el nombre del último que
         * publicó, y ningún cliente de mensajería lo enseña ahí.
         */
        .where(and(eq(chatTable.lineId, lineId), ne(chatTable.address, "status@broadcast")))
        .orderBy(desc(chatTable.lastMessageAt)).limit(limit);

      const visible = principal.kind === "api-key" && principal.allowedChats.length > 0
        ? rows.filter((r) => principal.allowedChats.includes(r.address))
        : rows;

      const ultimos = await ultimosMensajes(container, lineId, visible.map((r) => r.address));
      const listas = await listasDe(container, lineId, visible.map((r) => r.address));
      const data = await Promise.all(visible.map(async (r) => presentarChat({
        ...r,
        avatarUrl: await urlDeAvatar(container, r.avatarKey),
        ultimo: ultimos.get(r.address)?.texto ?? null,
        ultimoPropio: ultimos.get(r.address)?.propio ?? false,
        labelIds: listas.get(r.address) ?? [],
      })));
      return c.json({ data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/stickers", tags: ["mensajes"],
      summary: "Los stickers que han pasado por esta línea",
      description:
        "No existe una «biblioteca de stickers» que WhatsApp deje consultar: los " +
        "paquetes viven en el teléfono y no se exponen. Esto es lo que SÍ se " +
        "puede ofrecer y resulta igual de útil: los que has recibido o enviado, " +
        "listos para reenviar sin volver a subirlos.",
      request: {
        params: z.object({ lineId: z.string() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(60) }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          storageKey: z.string(), url: z.string(), usados: z.number(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      await authorize(principal, routeOf("chat.list"), { lineId });

      /*
       * Se agrupan por fichero, no por mensaje: el mismo sticker llega veinte
       * veces en un grupo activo, y una rejilla con veinte copias del mismo
       * dibujo no es una biblioteca.
       */
      const filas = await container.dbh.sql<{ media_key: string; usados: number }[]>`
        SELECT media_key, count(*)::int AS usados
        FROM message
        WHERE line_id = ${lineId} AND kind = 'sticker' AND media_key IS NOT NULL
        GROUP BY media_key
        ORDER BY max(timestamp) DESC
        LIMIT ${limit}`;

      const data = await Promise.all(filas.map(async (f) => ({
        storageKey: f.media_key,
        url: await container.storage.signedUrl(f.media_key, MEDIA_URL_TTL),
        usados: f.usados,
      })));
      return c.json({ data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/statuses", tags: ["mensajes"],
      summary: "Los estados, agrupados por quién los publicó",
      description:
        "Los estados llegan todos a la misma dirección (`status@broadcast`), así " +
        "que como conversación no significan nada: lo que importa es QUIÉN " +
        "publicó y qué. Aquí vienen agrupados, como en el teléfono.",
      request: {
        params: z.object({ lineId: z.string() }),
        query: z.object({ horas: z.coerce.number().int().min(1).max(168).default(24) }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          address: z.string(),
          displayName: z.string(),
          avatarUrl: z.string().nullable(),
          ultimo: z.string(),
          items: z.array(MensajeSchema),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId } = c.req.valid("param");
      const { horas } = c.req.valid("query");
      await authorize(principal, routeOf("chat.list"), { lineId });

      /*
       * Los estados caducan: WhatsApp los borra a las 24 horas y enseñar los de
       * la semana pasada como si estuvieran vivos sería mentir sobre lo que la
       * otra persona tiene publicado.
       */
      const desde = new Date(Date.now() - horas * 3600 * 1000);
      const filas = await container.dbh.db.select().from(messageTable)
        .where(and(
          eq(messageTable.lineId, lineId),
          eq(messageTable.chatId, "status@broadcast"),
          gte(messageTable.timestamp, desde),
          // Un estado retirado no está publicado: no se enseña.
          isNull(messageTable.deletedAt),
        ))
        .orderBy(desc(messageTable.timestamp))
        .limit(500);

      const autores = [...new Set(filas.map((f) => f.senderAddress).filter(Boolean))] as string[];
      const nombres = new Map<string, { nombre: string; avatarKey: string | null }>();
      if (autores.length > 0) {
        const datos = await container.dbh.db
          .select({
            address: contactTable.address,
            pushName: contactTable.pushName,
            savedName: contactTable.savedName,
          })
          .from(contactTable)
          .where(and(eq(contactTable.lineId, lineId), inArray(contactTable.address, autores)));
        for (const d of datos) {
          nombres.set(d.address, {
            nombre: d.savedName?.trim() || d.pushName?.trim() || `+${d.address.split("@")[0]}`,
            avatarKey: null,
          });
        }
        const avatares = await container.dbh.db
          .select({ address: chatTable.address, avatarKey: chatTable.avatarKey })
          .from(chatTable)
          .where(and(eq(chatTable.lineId, lineId), inArray(chatTable.address, autores)));
        for (const a of avatares) {
          const previo = nombres.get(a.address);
          nombres.set(a.address, {
            nombre: previo?.nombre ?? `+${a.address.split("@")[0]}`,
            avatarKey: a.avatarKey,
          });
        }
      }

      const porAutor = new Map<string, typeof filas>();
      for (const f of filas) {
        const quien = f.senderAddress ?? "desconocido";
        porAutor.set(quien, [...(porAutor.get(quien) ?? []), f]);
      }

      const data = await Promise.all([...porAutor.entries()].map(async ([address, items]) => ({
        address,
        displayName: nombres.get(address)?.nombre ?? `+${address.split("@")[0]}`,
        avatarUrl: await urlDeAvatar(container, nombres.get(address)?.avatarKey),
        ultimo: items[0]!.timestamp.toISOString(),
        items: await Promise.all(items.map(async (r) => ({
          id: r.id, providerMessageId: r.providerMessageId,
          clientMessageId: r.clientMessageId, fromMe: r.fromMe,
          senderAddress: r.senderAddress, senderName: null,
          kind: r.kind, body: r.body, state: r.state,
          timestamp: r.timestamp.toISOString(),
          media: r.mediaKey
            ? {
                url: await container.storage.signedUrl(r.mediaKey, MEDIA_URL_TTL),
                mimeType: r.mediaMime ?? "application/octet-stream",
                fileName: r.mediaFileName, size: r.mediaSize,
              }
            : null,
          mediaError: null,
          reacciones: [],
          deleted: false,
          // Un estado no responde a nada ni es una encuesta: no hay hilo.
          replyTo: null,
          poll: null,
        }))),
      })));

      data.sort((a, b) => b.ultimo.localeCompare(a.ultimo));
      return c.json({ data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/chats/{chatId}", tags: ["mensajes"],
      summary: "Una conversación, con su nombre ya resuelto",
      description:
        "`displayName` es lo que hay que enseñar y `address` el detalle. Con el " +
        "direccionamiento por LID de WhatsApp, la dirección es un número opaco de " +
        "quince cifras que no se parece a un teléfono: enseñarla sola deja la " +
        "conversación sin identificar.",
      request: { params: z.object({ lineId: z.string(), chatId: z.string() }) },
      responses: { 200: json(z.object({ data: ChatSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId, chatId } = c.req.valid("param");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(principal, routeOf("chat.get"), { lineId, chat });

      const rows = await container.dbh.db
        .select({
          address: chatTable.address, kind: chatTable.kind, title: chatTable.title,
          lastMessageAt: chatTable.lastMessageAt, unreadCount: chatTable.unreadCount,
          avatarKey: chatTable.avatarKey,
          muteUntil: chatTable.muteUntil, archived: chatTable.archived,
          pinned: chatTable.pinned,
          pushName: contactTable.pushName, savedName: contactTable.savedName,
          phone: identityMapTable.phone,
        })
        .from(chatTable)
        .leftJoin(contactTable, and(
          eq(contactTable.lineId, chatTable.lineId),
          eq(contactTable.address, chatTable.address),
        ))
        .leftJoin(identityMapTable, and(
          eq(identityMapTable.lineId, chatTable.lineId),
          eq(identityMapTable.lid, chatTable.address),
        ))
        .where(and(eq(chatTable.lineId, lineId), eq(chatTable.address, chat.value)))
        .limit(1);

      if (!rows[0]) throw new OmniError("not_found", "esa conversación no existe en esta línea");
      const ultimo = (await ultimosMensajes(container, lineId, [chat.value])).get(chat.value);
      const listas = await listasDe(container, lineId, [chat.value]);
      return c.json({
        data: presentarChat({
          ...rows[0],
          avatarUrl: await urlDeAvatar(container, rows[0].avatarKey),
          ultimo: ultimo?.texto ?? null,
          ultimoPropio: ultimo?.propio ?? false,
          labelIds: listas.get(chat.value) ?? [],
        }),
      }, 200);
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
        data: z.array(MensajeSchema),
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

      /*
       * Los nombres de quienes escriben, en UNA consulta.
       *
       * Solo hace falta en los grupos, y ahí hay pocas personas distintas
       * aunque haya cien mensajes: se piden los remitentes únicos y se reparten.
       */
      /*
       * Las citas se resuelven ANTES de los nombres.
       *
       * Quien escribió un mensaje citado puede no haber escrito nada en esta
       * página —se cita a alguien de hace un mes— y su nombre hace falta igual:
       * entra en la misma consulta de nombres, no en otra.
       */
      const citados = [...new Set(
        rows.map((r) => r.replyToId).filter((x): x is string => x !== null),
      )];
      const originales = new Map<string, {
        fromMe: boolean; senderAddress: string; kind: string; body: string | null;
        mediaKey: string | null;
      }>();
      if (citados.length > 0) {
        const filas = await container.dbh.db
          .select({
            providerMessageId: messageTable.providerMessageId,
            fromMe: messageTable.fromMe, senderAddress: messageTable.senderAddress,
            kind: messageTable.kind, body: messageTable.body,
            mediaKey: messageTable.mediaKey, deletedAt: messageTable.deletedAt,
          })
          .from(messageTable)
          .where(and(
            eq(messageTable.lineId, lineId),
            inArray(messageTable.providerMessageId, citados),
          ));
        for (const f of filas) {
          if (!f.providerMessageId) continue;
          originales.set(f.providerMessageId, {
            fromMe: f.fromMe, senderAddress: f.senderAddress, kind: f.kind,
            // Un original retirado no vuelve a enseñar su texto por la puerta
            // de atrás de una cita.
            body: f.deletedAt ? null : f.body,
            mediaKey: f.deletedAt ? null : f.mediaKey,
          });
        }
      }

      const remitentes = [...new Set([
        ...rows.filter((r) => !r.fromMe && r.senderAddress && r.senderAddress !== chat.value)
          .map((r) => r.senderAddress!),
        ...[...originales.values()]
          .filter((o) => !o.fromMe && o.senderAddress !== chat.value)
          .map((o) => o.senderAddress),
        ...rows.map((r) => (r.raw as CrudoConCita | null)?.replyTo?.author)
          .filter((x): x is string => typeof x === "string"),
      ])];
      const nombres = new Map<string, string>();
      if (remitentes.length > 0) {
        const contactos = await container.dbh.db
          .select({
            address: contactTable.address,
            pushName: contactTable.pushName,
            savedName: contactTable.savedName,
          })
          .from(contactTable)
          .where(and(
            eq(contactTable.lineId, lineId),
            inArray(contactTable.address, remitentes),
          ));
        for (const c of contactos) {
          const nombre = c.savedName?.trim() || c.pushName?.trim();
          if (nombre) nombres.set(c.address, nombre);
        }
      }

      /*
       * Las URLs se firman aquí, no se guardan: caducan, y una URL caducada
       * guardada en la base es una imagen rota semanas después.
       */
      /*
       * Las reacciones de todos los mensajes, en UNA consulta.
       *
       * Una por mensaje serían cien viajes a la base para pintar cien
       * burbujas, y las reacciones son pocas: casi todas las filas no tienen.
       */
      const ids = rows.map((r) => r.providerMessageId).filter((x): x is string => x !== null);
      const porMensaje = new Map<string, { emoji: string; cuantas: number; mia: boolean }[]>();
      if (ids.length > 0) {
        const filas = await container.dbh.db
          .select()
          .from(reactionTable)
          .where(and(
            eq(reactionTable.lineId, lineId),
            inArray(reactionTable.providerMessageId, ids),
          ));
        for (const f of filas) {
          const lista = porMensaje.get(f.providerMessageId) ?? [];
          const previa = lista.find((x) => x.emoji === f.emoji);
          if (previa) {
            previa.cuantas++;
            previa.mia = previa.mia || f.reactor === "yo";
          } else {
            lista.push({ emoji: f.emoji, cuantas: 1, mia: f.reactor === "yo" });
          }
          porMensaje.set(f.providerMessageId, lista);
        }
      }

      /*
       * Las encuestas de la página, con sus votos, en DOS consultas.
       *
       * Una por encuesta sería un viaje por burbuja, y en un grupo donde se
       * vota mucho eso es lo que convierte una conversación en una espera.
       */
      /*
       * Nuestra propia dirección, para saber qué votamos nosotros.
       *
       * Sale de la línea y no de la sesión: lo que marca una opción como
       * «mía» es el número de WhatsApp que votó, no quién mira el panel.
       */
      const [linea] = await container.dbh.db
        .select({ address: lineTable.address })
        .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
      const propia = linea?.address ?? null;

      const encuestas = new Map<string, {
        question: string; allowMultiple: boolean; totalVotes: number;
        options: { name: string; votes: number; mine: boolean }[];
      }>();
      const idsDeEncuesta = rows.filter((r) => r.kind === "poll")
        .map((r) => r.providerMessageId).filter((x): x is string => x !== null);
      if (idsDeEncuesta.length > 0) {
        const cabeceras = await container.dbh.db
          .select()
          .from(pollTable)
          .where(and(
            eq(pollTable.lineId, lineId),
            inArray(pollTable.providerMessageId, idsDeEncuesta),
          ));
        const votos = cabeceras.length > 0
          ? await container.dbh.db
              .select()
              .from(pollVoteTable)
              .where(inArray(pollVoteTable.pollId, cabeceras.map((c) => c.id)))
          : [];

        for (const cab of cabeceras) {
          const mios = votos.filter((v) => v.pollId === cab.id);
          const cuenta = cab.options.map((name, i) => ({
            name,
            votes: mios.filter((v) => v.selected.includes(i)).length,
            // «Mío» es el voto de ESTA línea, que en un grupo es uno más.
            mine: mios.some((v) => v.voter === propia && v.selected.includes(i)),
          }));
          encuestas.set(cab.providerMessageId, {
            question: cab.question,
            allowMultiple: cab.allowMultiple,
            // Quien ha votado, no la suma de marcas: en una de opción
            // múltiple, una persona que marca tres no son tres votantes.
            totalVotes: mios.filter((v) => v.selected.length > 0).length,
            options: cuenta,
          });
        }
      }

      const data = await Promise.all(rows.map(async (r) => ({
        id: r.id, providerMessageId: r.providerMessageId,
        clientMessageId: r.clientMessageId, fromMe: r.fromMe,
        senderAddress: r.senderAddress,
        senderName: r.senderAddress
          ? nombres.get(r.senderAddress) ?? `+${r.senderAddress.split("@")[0]}`
          : null,
        kind: r.kind, body: r.body, state: r.state, timestamp: r.timestamp.toISOString(),
        media: r.mediaKey
          ? {
              url: await container.storage.signedUrl(r.mediaKey, MEDIA_URL_TTL),
              mimeType: r.mediaMime ?? "application/octet-stream",
              fileName: r.mediaFileName,
              size: r.mediaSize,
            }
          : null,
        /*
         * Un medio que no se pudo traer se dice. Sin esto, una imagen que
         * falló y una que todavía se está descargando se ven igual: un hueco,
         * y nadie sabe si esperar o no.
         */
        mediaError: r.mediaKey ? null : (MEDIA_KINDS_API.has(r.kind) ? r.failureReason : null),
        reacciones: r.providerMessageId ? porMensaje.get(r.providerMessageId) ?? [] : [],
        deleted: r.deletedAt !== null,
        replyTo: await citaDe(container, r.replyToId, r.raw as CrudoConCita | null,
          originales, nombres, chat.value),
        poll: r.providerMessageId ? encuestas.get(r.providerMessageId) ?? null : null,
      })));

      return c.json({
        data,
        meta: { nextBefore: rows.length === limit ? rows.at(-1)!.timestamp.toISOString() : null },
      }, 200);
    },
  );

  /*
   * Compatibilidad de cable. Migrar desde WasenderAPI es cambiar la URL base.
   * Se monta bajo `/compat/wasender` y NO pasa por el middleware de `/v1`:
   * tiene su propia autenticación, igual de estricta.
   */
  app.route("/compat/wasender", wasenderCompat(container));
  app.route("/compat/evolution", evolutionCompat(container));

  registerRealtimeRoutes(app, container);
  registerIdentityRoutes(app, container);
  registerCloudWebhookRoutes(app, container);
  registerMessagingRoutes(app, container);
  registerLineAdminRoutes(app, container);
  registerGroupRoutes(app, container);
  registerGroupChatRoutes(app, container);
  registerLabelRoutes(app, container);
  registerPluginRoutes(app, container, container.plugins, HOST_VERSION);
  registerNewsletterRoutes(app, container);
  registerCrmRoutes(app, container);
  registerCommerceRoutes(app, container);
  registerMediaRoutes(app, container);
  registerMcp(app, container);
  registerWebhookRoutes(app, container);
  registerSandboxRoutes(app, container);
  registerDocs(app, container);
  return app;
}

/** Aplana el estado del driver a la forma que publica el contrato. */
function linkState(s: LineStatus): { state: string; qr?: string; pairingCode?: string; self?: string } {
  return {
    state: s.state,
    ...("qr" in s && s.qr ? { qr: s.qr } : {}),
    ...("pairingCode" in s && s.pairingCode ? { pairingCode: s.pairingCode } : {}),
    ...("self" in s ? { self: s.self.value } : {}),
  };
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
      })) }, 200);
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
      })) }, 200);
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
      responses: { 200: json(z.object({ data: LinkStateSchema }), "enlazada"), ...errors },
    }),
    async (c) => {
      const principal = guard(c);
      const { lineId } = c.req.valid("param");
      const { phone } = c.req.valid("json");
      await authorize(principal, routeOf("line.connect"), { lineId });
      const status = await container.sandbox!.scan(lineId as LineId, phone);
      return c.json({ data: linkState(status) }, 200);
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
          kind: z.enum([
            "text", "image", "video", "audio", "document", "sticker",
          ]).optional().describe("Para simular un mensaje con fichero"),
        })),
      },
      responses: { 201: json(z.object({ data: z.object({ id: z.string(), chat: z.string() }) }), "creado"), ...errors },
    }),
    async (c) => {
      const principal = guard(c);
      const { lineId } = c.req.valid("param");
      const input = c.req.valid("json");
      await authorize(principal, routeOf("line.connect"), { lineId });
      const msg = await container.sandbox!.inbound(lineId as LineId, input.from, input.text, {
        ...(input.chat ? { chat: input.chat } : {}),
        ...(input.pushName ? { pushName: input.pushName } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      });
      return c.json({ data: { id: msg.id, chat: msg.chat } }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/sandbox/lines/{lineId}/newsletters", tags: ["sandbox"],
      summary: "Fabricar un canal AJENO, de los que se siguen",
      description:
        "Distinto de crear uno propio: del propio eres dueño, y probar seguir y " +
        "dejar de seguir necesita uno que no sea tuyo.",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({
          name: z.string().min(1).max(100),
          description: z.string().max(2048).optional(),
        })),
      },
      responses: {
        201: json(z.object({ data: z.object({ address: z.string(), inviteCode: z.string().optional() }) }), "creado"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = guard(c);
      const { lineId } = c.req.valid("param");
      const { name, description } = c.req.valid("json");
      await authorize(principal, routeOf("line.connect"), { lineId });
      const meta = await container.sandbox!.simulateNewsletter(lineId as LineId, name, description);
      return c.json({ data: {
        address: meta.address.value,
        ...(meta.inviteCode ? { inviteCode: meta.inviteCode } : {}),
      } }, 201);
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
      const thread = container.sandbox!.thread(lineId as LineId, chat);
      return c.json({ data: thread.map((m) => ({
        id: m.id, chat: m.chat, fromMe: m.fromMe, text: m.text, state: m.state,
      })) }, 200);
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


// ─────────────────────────────────────────────── MCP
function registerMcp(app: OpenAPIHono<Env>, container: Container): void {
  if (!container.config.MCP_ENABLED) return;

  /**
   * El montaje MCP autentica FUERA del middleware REST, así que hace su propia
   * comprobación. OpenWA documenta esto mismo: cada superficie que puede
   * devolver datos de un chat necesita su propio control, porque no hereda el
   * del guard REST. Aquí además cada herramienta vuelve a comprobar por llamada.
   */
  app.post("/mcp", async (c) => {
    const principal = await authenticateApiKey(container.dbh.db, c.req.header("authorization"));
    const { handleMcp } = await import("./mcp/server.js");

    const body: unknown = await c.req.json().catch(() => null);
    const answer = await handleMcp(container, principal, {
      readOnly: container.config.MCP_READONLY,
    }, body);

    // Una notificación no lleva respuesta: 202 sin cuerpo, como manda el protocolo.
    if (answer === null) return c.body(null, 202);
    return c.json(answer as Record<string, unknown>, 200);
  });
}

// ─────────────────────────────────────────────── medios
function registerMediaRoutes(app: OpenAPIHono<Env>, container: Container): void {
  app.openapi(
    createRoute({
      method: "post", path: "/v1/media", tags: ["medios"],
      summary: "Subir un fichero y obtener su clave",
      description:
        "Devuelve una `storageKey` que luego se pasa a `POST /v1/lines/{lineId}/messages` " +
        "en el campo del tipo correspondiente. Útil para reutilizar el mismo fichero en " +
        "varios envíos sin volver a subirlo.",
      request: {
        body: {
          content: {
            "multipart/form-data": {
              schema: z.object({
                file: z.any().openapi({ type: "string", format: "binary" }),
                lineId: z.string(),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        201: json(z.object({ data: z.object({
          storageKey: z.string(), size: z.number(), mimeType: z.string(), checksum: z.string(),
        }) }), "subido"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const form = await c.req.formData();
      const lineId = String(form.get("lineId") ?? "");
      await authorize(principal, routeOf("media.upload"), { lineId });

      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new OmniError("validation_failed", "falta el campo `file`");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const key = `media/${principal.orgId}/${lineId}/subidos/${crypto.randomUUID()}`;
      const stored = await container.storage.put(key, bytes, {
        mimeType: file.type || "application/octet-stream",
        ...(file.name ? { fileName: file.name } : {}),
      });
      // Se expone como `storageKey` porque es el nombre del campo con el que
      // se vuelve a usar al enviar; llamarlo `key` obligaría a traducir.
      return c.json({
        data: {
          storageKey: stored.key, size: stored.size,
          mimeType: stored.mimeType, checksum: stored.checksum,
        },
      }, 201);
    },
  );

  /**
   * Sirve un medio local. NO lleva autenticación por credencial a propósito: se
   * accede con una URL firmada y caducada, que es lo que permite pegarla en un
   * `<img>` o mandarla a un tercero sin repartir claves de API.
   *
   * Lo que sí es imprescindible es que la firma se compruebe de verdad. En el
   * gateway anterior los adjuntos se escribían bajo `public/` y los servía el
   * framework sin comprobar nada: quien tuviera la URL leía los adjuntos de
   * cualquier inquilino, para siempre.
   */
  /*
   * La ruta lleva un comodín, que `createRoute` no sabe describir, así que su
   * documentación se registra a mano. Si no, quedaría FUERA del contrato: los
   * SDK y la CLI se generan desde ahí y no verían que existe.
   */
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/media/{key}",
    tags: ["medios"],
    summary: "Descargar un medio con su URL firmada",
    description:
      "No lleva credencial: la firma y su caducidad SON la credencial, que es lo " +
      "que permite pegar el enlace en un `<img>` o pasárselo a un tercero sin " +
      "repartir claves de API.",
    request: {
      params: z.object({ key: z.string() }),
      query: z.object({
        expires: z.string().describe("Epoch en segundos"),
        signature: z.string().describe("HMAC de la clave y la caducidad"),
      }),
    },
    responses: {
      200: { description: "el contenido del medio" },
      403: { description: "firma inválida o caducada" },
      404: { description: "el medio ya no está disponible" },
    },
  });

  app.get("/v1/media/:key{.+}", async (c) => {
    if (container.storage.kind !== "local") {
      throw new OmniError("not_found", "con almacén S3 los medios se sirven por su URL firmada");
    }
    const key = decodeURIComponent(c.req.param("key"));
    const expires = Number(c.req.query("expires"));
    const signature = c.req.query("signature") ?? "";

    const local = container.storage as unknown as {
      verify(k: string, e: number, s: string): { ok: true } | { ok: false; reason: string };
    };
    const check = local.verify(key, expires, signature);
    if (!check.ok) throw new OmniError("forbidden", check.reason);

    const found = await container.storage.get(key);
    if (!found) throw new OmniError("not_found", "el medio ya no está disponible");
    return c.body(found.bytes as unknown as ArrayBuffer, 200, {
      "content-type": found.mimeType,
      // Es contenido privado servido por URL firmada: que no lo cachee un proxy.
      "cache-control": "private, max-age=60",
    });
  });
}
