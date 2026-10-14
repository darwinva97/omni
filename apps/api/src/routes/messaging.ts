import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress, type LineId } from "@omni/shared";
import { assertCapability, type ChannelDriver } from "@omni/channels";
import { authorize, route as routeOf } from "@omni/core";
import { contactTable, lineTable, messageTable } from "@omni/db";
import { and, desc, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Acciones sobre mensajes y chats.
 *
 * Todas siguen el mismo patrón: autorizar, comprobar que ESTE transporte sabe
 * hacerlo, actuar. La comprobación de capacidad es la que evita que pedir algo
 * que el driver no soporta acabe en un 500 o, peor, en un silencio.
 */
export function registerMessagingRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const driverOf = async (lineId: string): Promise<ChannelDriver> => {
    const rows = await container.dbh.db
      .select({ kind: lineTable.channelKind })
      .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    if (!rows[0]) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
    return container.runtime.driverFor(rows[0].kind);
  };

  const Ok = z.object({ data: z.object({ ok: z.boolean() }) });
  const lineChat = z.object({ lineId: z.string(), chatId: z.string() });

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}",
      tags: ["mensajes"], summary: "Editar un mensaje ya enviado",
      description: "WhatsApp solo lo permite durante una ventana corta tras el envío.",
      request: {
        params: lineChat.extend({ messageId: z.string() }),
        ...body(z.object({ text: z.string().min(1).max(65536) })),
      },
      responses: { 200: json(Ok, "editado"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const { text } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("message.edit"), { lineId, chat });

      const driver = await driverOf(lineId);
      assertCapability(driver, "message.edit");
      await driver.editMessage!(lineId as LineId, chat, messageId, text);
      await container.dbh.db.update(messageTable)
        .set({ body: text, editedAt: new Date() })
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.providerMessageId, messageId)));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}",
      tags: ["mensajes"], summary: "Borrar un mensaje para todos",
      request: { params: lineChat.extend({ messageId: z.string() }) },
      responses: { 200: json(Ok, "borrado"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("message.delete"), { lineId, chat });

      const driver = await driverOf(lineId);
      assertCapability(driver, "message.delete");
      await driver.deleteMessage!(lineId as LineId, chat, messageId);
      // Se marca como borrado en vez de eliminar la fila: la auditoría necesita
      // saber que existió y quién lo quitó.
      await container.dbh.db.update(messageTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.providerMessageId, messageId)));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}/reaction",
      tags: ["mensajes"], summary: "Reaccionar a un mensaje",
      description: "Un emoji vacío retira la reacción, que es como lo expresa WhatsApp.",
      request: {
        params: lineChat.extend({ messageId: z.string() }),
        ...body(z.object({ emoji: z.string().max(8) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const { emoji } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("message.react"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "send.reaction");
      await driver.react!(lineId as LineId, chat, messageId, emoji);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/read",
      tags: ["chats"], summary: "Marcar como leído",
      description:
        "Sin `messageIds` marca la conversación ENTERA, que es lo que pasa al " +
        "abrirla. Con la lista, solo esos mensajes.\n\n" +
        "Pone a cero nuestro contador de pendientes además de decírselo a la red: " +
        "sin eso, abrir un chat lo dejaba leído en el teléfono y con el globo de " +
        "no leídos puesto aquí.",
      request: {
        params: lineChat,
        ...body(z.object({
          messageIds: z.array(z.string()).max(200).optional(),
        })),
      },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean(), marcados: z.number() }) }), "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { messageIds } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.markRead"), { lineId, chat });

      /*
       * Sin lista, se cogen los últimos entrantes que conocemos.
       *
       * WhatsApp marca por mensaje, no por conversación: para decir «lo he
       * leído todo» hay que nombrar mensajes. Veinte bastan —el acuse de uno
       * reciente arrastra a los anteriores— y pedir doscientos por abrir un
       * chat sería una ráfaga por cada clic.
       */
      let ids = messageIds ?? [];
      if (ids.length === 0) {
        const filas = await container.dbh.db
          .select({ providerMessageId: messageTable.providerMessageId })
          .from(messageTable)
          .where(and(
            eq(messageTable.lineId, lineId),
            eq(messageTable.chatId, chat.value),
            eq(messageTable.fromMe, false),
          ))
          .orderBy(desc(messageTable.timestamp))
          .limit(20);
        ids = filas.map((f) => f.providerMessageId).filter((x): x is string => x !== null);
      }

      const driver = await driverOf(lineId);
      assertCapability(driver, "chat.read");
      if (ids.length > 0) {
        // Que la red falle no puede dejar el contador puesto: lo que el usuario
        // ve aquí es nuestro, y ya lo ha leído.
        await driver.markRead!(lineId as LineId, chat, ids).catch(() => {});
      }

      const { chatTable } = await import("@omni/db");
      await container.dbh.db
        .update(chatTable)
        .set({ unreadCount: 0 })
        .where(and(eq(chatTable.lineId, lineId), eq(chatTable.address, chat.value)));

      return c.json({ data: { ok: true, marcados: ids.length } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/chats/{chatId}/messages",
      tags: ["chats"], summary: "Vaciar una conversación",
      description:
        "Vacía la conversación EN LA RED y borra nuestra copia. No es un borrado " +
        "para el otro lado: quien esté al otro extremo sigue teniendo los suyos.",
      request: { params: lineChat },
      responses: { 200: json(z.object({ data: z.object({ deleted: z.number() }) }), "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.clear"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "chat.clear");

      /*
       * WhatsApp no borra "hasta ahora": borra hasta un punto del historial, y
       * ese punto son los últimos mensajes que conocemos. Se sacan antes de
       * borrar nada, porque después ya no estarían.
       */
      const ultimos = await container.dbh.db
        .select({
          providerMessageId: messageTable.providerMessageId,
          fromMe: messageTable.fromMe,
          timestamp: messageTable.timestamp,
        })
        .from(messageTable)
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.chatId, chat.value)))
        .orderBy(desc(messageTable.timestamp))
        .limit(5);

      await driver.clearChat!(
        lineId as LineId, chat,
        ultimos
          .filter((m) => m.providerMessageId !== null)
          .map((m) => ({
            providerMessageId: m.providerMessageId!,
            fromMe: m.fromMe,
            timestamp: m.timestamp.getTime(),
          })),
      );

      // Solo después de que la red lo acepte: al revés, un fallo allí nos
      // dejaría sin nuestra copia y con la conversación intacta en el teléfono.
      const borrados = await container.dbh.db
        .delete(messageTable)
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.chatId, chat.value)))
        .returning({ id: messageTable.id });
      return c.json({ data: { deleted: borrados.length } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/presence",
      tags: ["chats"], summary: "Mostrar que se está escribiendo o grabando",
      request: {
        params: lineChat,
        ...body(z.object({ presence: z.enum(["composing", "recording", "paused"]) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { presence } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.presence"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "chat.presence");
      await driver.setPresence!(lineId as LineId, chat, presence);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/presence/watch",
      tags: ["chats"], summary: "Estar en línea un rato y ver quién escribe",
      description:
        "Pone la línea en línea durante 90 segundos desde la última llamada y, si se " +
        "indica `chat`, sigue su presencia. Mientras dure, llegan los eventos " +
        "`presence.updated` —«escribiendo», «grabando», «en línea»— y el teléfono NO " +
        "recibe notificaciones, que es como funciona WhatsApp con un cliente en " +
        "línea. Hay que renovarlo mientras se mire; al dejar de hacerlo, se apaga solo.",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({ chat: z.string().nullable().default(null) })),
      },
      responses: { 200: json(Ok, "en línea"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { chat } = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("presence.watch"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "presence.watch");
      await driver.watchPresence!(lineId as LineId, chat ? parseAddress(chat) : null);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/contacts",
      tags: ["contactos"], summary: "Contactos conocidos por esta línea",
      request: {
        params: z.object({ lineId: z.string() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          address: z.string(), pushName: z.string().nullable(),
          savedName: z.string().nullable(), blocked: z.boolean(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      await authorize(c.get("principal"), routeOf("contact.list"), { lineId });
      const rows = await container.dbh.db.select().from(contactTable)
        .where(eq(contactTable.lineId, lineId))
        .orderBy(desc(contactTable.updatedAt)).limit(limit);
      return c.json({ data: rows.map((r) => ({
        address: r.address, pushName: r.pushName, savedName: r.savedName, blocked: r.blocked,
      })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/contacts/{address}/exists",
      tags: ["contactos"], summary: "Comprobar si un número está registrado",
      description:
        "Responde si ese número existe en la red del transporte. Con Cloud API " +
        "no hay forma de saberlo y se responde 422.",
      request: { params: z.object({ lineId: z.string(), address: z.string() }) },
      responses: {
        200: json(z.object({ data: z.object({
          exists: z.boolean(), address: z.string().nullable(),
        }) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, address } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("contact.check"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "contact.check");
      const res = await driver.checkContact!(lineId as LineId, parseAddress(decodeURIComponent(address)));
      return c.json({ data: { exists: res.exists, address: res.address?.value ?? null } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/messages/{messageId}/resend",
      tags: ["mensajes"], summary: "Reintentar un mensaje que falló",
      description:
        "Solo los que están en `failed`. Se reencola con el MISMO identificador " +
        "de cliente, así que si el anterior llegó a salir sin que nos enteráramos, " +
        "la idempotencia del transporte evita la copia.",
      request: {
        params: z.object({ lineId: z.string(), messageId: z.string() }),
      },
      responses: {
        202: json(z.object({ data: z.object({ clientMessageId: z.string() }) }), "reencolado"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, messageId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("message.resend"), { lineId });
      const res = await container.runtime.resend(lineId, decodeURIComponent(messageId));
      return c.json({ data: res }, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/chats/{chatId}",
      tags: ["chats"], summary: "Eliminar una conversación",
      description:
        "`scope=local` (por defecto) borra solo lo que guardamos: en WhatsApp " +
        "sigue entera, y si llega un mensaje nuevo vuelve a aparecer aquí.\n\n" +
        "`scope=network` la borra TAMBIÉN en WhatsApp: desaparece de la lista " +
        "del teléfono y de los demás dispositivos enlazados. No es lo mismo que " +
        "vaciarla, que la deja en la lista sin mensajes.",
      request: {
        params: lineChat,
        query: z.object({
          scope: z.enum(["local", "network"]).default("local"),
        }),
      },
      responses: {
        200: json(z.object({ data: z.object({ deleted: z.number() }) }), "quitada"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { scope } = c.req.valid("query");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.clear"), { lineId, chat });

      if (scope === "network") {
        const driver = await driverOf(lineId);
        assertCapability(driver, "chat.delete");

        /*
         * El ancla se lee ANTES de borrar nada: son los últimos mensajes que
         * conocemos, y WhatsApp los necesita para saber hasta dónde borra.
         * Después de vaciar nuestra tabla ya no existirían.
         */
        const ultimos = await container.dbh.db
          .select({
            providerMessageId: messageTable.providerMessageId,
            fromMe: messageTable.fromMe,
            timestamp: messageTable.timestamp,
          })
          .from(messageTable)
          .where(and(eq(messageTable.lineId, lineId), eq(messageTable.chatId, chat.value)))
          .orderBy(desc(messageTable.timestamp))
          .limit(5);

        await driver.deleteChat!(
          lineId as LineId, chat,
          ultimos
            .filter((m) => m.providerMessageId !== null)
            .map((m) => ({
              providerMessageId: m.providerMessageId!,
              fromMe: m.fromMe,
              timestamp: m.timestamp.getTime(),
            })),
        );
      }

      const borrados = await container.dbh.db
        .delete(messageTable)
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.chatId, chat.value)))
        .returning({ id: messageTable.id });
      const { chatTable } = await import("@omni/db");
      await container.dbh.db
        .delete(chatTable)
        .where(and(eq(chatTable.lineId, lineId), eq(chatTable.address, chat.value)));
      return c.json({ data: { deleted: borrados.length } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/contacts/sync",
      tags: ["contactos"], summary: "Volver a pedir la agenda y las fotos de perfil",
      description:
        "Los nombres que guardaste en tu agenda viajan en la sincronización de " +
        "estado, que ocurre al enlazar y no se repite al reconectar. Esto la pide " +
        "otra vez y encola las fotos de perfil que falten.",
      request: { params: z.object({ lineId: z.string() }) },
      responses: {
        202: json(z.object({ data: z.object({ fotos: z.number() }) }), "pedido"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("contact.list"), { lineId });
      const res = await container.runtime.sincronizarContactos(lineId);
      // 202: la agenda llega por eventos, no en esta respuesta.
      return c.json({ data: res }, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/identity/{address}",
      tags: ["contactos"], summary: "El teléfono detrás de un LID, o el LID de un teléfono",
      description:
        "`null` significa QUE NO LO SABEMOS, no que no exista. WhatsApp solo dice " +
        "el par una vez, al entregar el mensaje; si no estaba allí, no hay forma " +
        "de deducirlo, y adivinarlo por los dígitos confundiría a dos personas.",
      request: { params: z.object({ lineId: z.string(), address: z.string() }) },
      responses: {
        200: json(z.object({ data: z.object({
          address: z.string(), kind: z.string(),
          phone: z.string().nullable(), lid: z.string().nullable(),
        }) }), "lo que sabemos"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, address } = c.req.valid("param");
      const direccion = parseAddress(decodeURIComponent(address));
      await authorize(c.get("principal"), routeOf("identity.read"), { lineId, chat: direccion });
      const driver = await driverOf(lineId);
      /*
       * Se comprueba la capacidad aunque el dato salga de NUESTRA tabla: solo
       * los transportes que direccionan con LID pueden haber aprendido algo, y
       * en los demás la respuesta sería un `null` que parecería un hueco de
       * datos en vez de "esta red no usa LIDs".
       */
      assertCapability(driver, "identity.lid");

      if (direccion.kind === "lid") {
        const telefono = await container.runtime.phoneForLid(lineId, direccion);
        return c.json({ data: {
          address: direccion.value, kind: direccion.kind,
          phone: telefono?.value ?? null, lid: direccion.value,
        } }, 200);
      }
      const lid = await container.runtime.lidForPhone(lineId, direccion);
      return c.json({ data: {
        address: direccion.value, kind: direccion.kind,
        phone: direccion.value, lid: lid?.value ?? null,
      } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/history",
      tags: ["mensajes"], summary: "Pedir historial anterior de una conversación",
      description:
        "Es ASÍNCRONO: WhatsApp responde con eventos, no con los mensajes. La " +
        "respuesta 202 dice que se ha pedido, no que ya esté; los mensajes " +
        "aparecen luego por `/messages` y por el webhook `history.synced`.",
      request: {
        params: lineChat,
        ...body(z.object({
          before: z.string().datetime().optional(),
          count: z.number().int().min(1).max(200).default(50),
        })),
      },
      responses: { 202: json(Ok, "pedido"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { before, count } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("history.sync"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "history.sync");
      await driver.fetchHistory!(
        lineId as LineId, chat, before ? new Date(before).getTime() : Date.now(), count,
      );
      return c.json({ data: { ok: true } }, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/mute",
      tags: ["chats"], summary: "Silenciar una conversación hasta un instante dado",
      description: "`until` nulo la desilencia. Es el silencio DE WHATSAPP, no un ajuste del panel.",
      request: {
        params: lineChat,
        ...body(z.object({ until: z.string().datetime().nullable() })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { until } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.mute"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "chat.mute");
      await driver.muteChat!(lineId as LineId, chat, until ? new Date(until).getTime() : null);

      /*
       * Y se guarda aquí también.
       *
       * Antes solo se le decía a WhatsApp. El aviso vuelve por el evento de
       * chat, pero puede tardar o perderse en una reconexión, y hasta entonces
       * el panel seguía sonando por una conversación que acabas de silenciar
       * —que es justo el momento en que más molesta—.
       */
      const { chatTable } = await import("@omni/db");
      await container.dbh.db
        .update(chatTable)
        .set({ muteUntil: until ? new Date(until) : null })
        .where(and(eq(chatTable.lineId, lineId), eq(chatTable.address, chat.value)));

      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/ephemeral",
      tags: ["chats"], summary: "Poner los mensajes de una conversación a caducar",
      description:
        "WhatsApp solo admite 0 (desactivado), 86400, 604800 y 7776000 segundos. " +
        "Cualquier otro valor NO falla en WhatsApp: se ignora en silencio, así que " +
        "aquí se rechaza con 422 antes de que alguien crea que ha caducado algo.",
      request: {
        params: lineChat,
        ...body(z.object({ seconds: z.union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(7776000)]) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { seconds } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.ephemeral"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "chat.ephemeral");
      await driver.setEphemeral!(lineId as LineId, chat, seconds);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}/forward",
      tags: ["mensajes"], summary: "Reenviar un mensaje a otra conversación",
      description:
        "Baileys necesita el mensaje original entero, que solo conservamos de los " +
        "ENTRANTES; de los que enviamos nosotros responde 422 en vez de reenviar " +
        "algo distinto. whatsapp-web.js no tiene esa limitación.",
      request: {
        params: z.object({ lineId: z.string(), chatId: z.string(), messageId: z.string() }),
        ...body(z.object({ to: z.string().min(1) })),
      },
      responses: {
        200: json(z.object({ data: z.object({ messageId: z.string() }) }), "reenviado"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const { to } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      const destino = parseAddress(to);
      await authorize(c.get("principal"), routeOf("message.forward"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "send.forward");

      const filas = await container.dbh.db
        .select({ raw: messageTable.raw })
        .from(messageTable)
        .where(and(
          eq(messageTable.lineId, lineId),
          eq(messageTable.providerMessageId, messageId),
        ))
        .limit(1);

      const receipt = await driver.forwardMessage!(
        lineId as LineId,
        { chat, providerMessageId: messageId, ...(filas[0]?.raw ? { raw: filas[0].raw } : {}) },
        destino,
      );
      return c.json({ data: { messageId: receipt.providerMessageId } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/contacts/{address}/profile",
      tags: ["contactos"], summary: "Perfil público de un contacto",
      description:
        "La foto puede caducar: es una URL firmada por WhatsApp, no un enlace " +
        "permanente, y guardarla como si lo fuera da imágenes rotas semanas después.",
      request: { params: z.object({ lineId: z.string(), address: z.string() }) },
      responses: {
        200: json(z.object({ data: z.object({
          address: z.string(), name: z.string().optional(),
          pictureUrl: z.string().optional(), about: z.string().optional(),
          isBusiness: z.boolean().optional(),
        }) }), "el perfil"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, address } = c.req.valid("param");
      const contacto = parseAddress(decodeURIComponent(address));
      await authorize(c.get("principal"), routeOf("contact.profile"), { lineId, chat: contacto });
      const driver = await driverOf(lineId);
      assertCapability(driver, "contact.profile");
      const perfil = await driver.contactProfile!(lineId as LineId, contacto);
      return c.json({ data: {
        address: perfil.address.value,
        ...(perfil.name ? { name: perfil.name } : {}),
        ...(perfil.pictureUrl ? { pictureUrl: perfil.pictureUrl } : {}),
        ...(perfil.about ? { about: perfil.about } : {}),
        ...(perfil.isBusiness !== undefined ? { isBusiness: perfil.isBusiness } : {}),
      } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/network-labels",
      tags: ["etiquetas"], summary: "Etiquetas de WhatsApp Business, las de la propia red",
      description:
        "NO son las etiquetas de Omni: estas viven en la cuenta de WhatsApp y solo " +
        "existen si la cuenta enlazada es de empresa. Las nuestras están en " +
        "`/v1/lines/{lineId}/labels`.",
      request: { params: z.object({ lineId: z.string() }) },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          id: z.string(), name: z.string(), color: z.string().optional(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("label.network.read"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "label.manage");
      const etiquetas = await driver.listNetworkLabels!(lineId as LineId);
      return c.json({ data: etiquetas.map((l) => ({
        id: l.id, name: l.name, ...(l.color ? { color: l.color } : {}),
      })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/calls/{callId}/reject",
      tags: ["llamadas"], summary: "Rechazar una llamada entrante",
      description:
        "Hay que hacerlo MIENTRAS suena: pasados unos segundos WhatsApp ya la ha " +
        "dado por perdida y rechazarla no hace nada.",
      request: {
        params: z.object({ lineId: z.string(), callId: z.string() }),
        ...body(z.object({ from: z.string().min(1) })),
      },
      responses: { 200: json(Ok, "rechazada"), ...errors },
    }),
    async (c) => {
      const { lineId, callId } = c.req.valid("param");
      const { from } = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("call.reject"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "call.reject");
      await driver.rejectCall!(lineId as LineId, callId, parseAddress(from));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/contacts/{address}/block",
      tags: ["contactos"], summary: "Bloquear o desbloquear un contacto",
      request: {
        params: z.object({ lineId: z.string(), address: z.string() }),
        ...body(z.object({ blocked: z.boolean().default(true) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, address } = c.req.valid("param");
      const { blocked } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(address));
      await authorize(c.get("principal"), routeOf("contact.block"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "contact.block");
      // Primero WhatsApp. Escribir solo en nuestra tabla marcaba el contacto
      // como bloqueado en el panel y lo dejaba escribiendo tan tranquilo.
      await driver.blockContact!(lineId as LineId, chat, blocked);
      await container.dbh.db.insert(contactTable)
        .values({ id: `c-${lineId}-${chat.value}`, lineId, address: chat.value, blocked })
        .onConflictDoUpdate({
          target: [contactTable.lineId, contactTable.address],
          set: { blocked, updatedAt: new Date() },
        });
      await container.runtime.publish("contact.blocked", lineId, { address: chat.value, blocked });
      return c.json({ data: { ok: true } }, 200);
    },
  );
}
