import type { OmniClient } from "./client.js";

/**
 * Catálogo de comandos.
 *
 * Cada comando declara a qué operación de la API corresponde. Una prueba
 * comprueba que NO queda ninguna operación sin comando: es la idea de crafter,
 * y es buena porque el hueco se detecta en CI y no cuando alguien lo necesita.
 */
export interface Command {
  readonly name: string;
  readonly summary: string;
  /** `MÉTODO /ruta` de la API que cubre. Sirve para el guard de cobertura. */
  readonly operation: string;
  readonly args: readonly { name: string; required: boolean; description: string }[];
  readonly flags?: readonly { name: string; description: string }[];
  /** Destructivo: exige `--yes` en vez de adivinar la intención. */
  readonly destructive?: boolean;
  run(client: OmniClient, argv: Args): Promise<unknown>;
}

export interface Args {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

const req = (a: Args, i: number, nombre: string): string => {
  const v = a.positional[i];
  if (v === undefined) throw new Error(`falta el argumento <${nombre}>`);
  return v;
};

/** Las direcciones llevan `@`: sin escapar, la ruta se parte donde no debe. */
const enc = encodeURIComponent;

const flag = (a: Args, n: string): string | undefined => {
  const v = a.flags[n];
  return typeof v === "string" ? v : undefined;
};

export const COMMANDS: readonly Command[] = [
  {
    name: "salud",
    summary: "Comprobar que el servicio y sus dependencias responden",
    operation: "GET /health",
    args: [],
    run: (c) => c.request("GET", "/health"),
  },
  {
    name: "capacidades",
    summary: "Qué sabe hacer cada transporte disponible",
    operation: "GET /v1/capabilities",
    args: [],
    run: (c) => c.request("GET", "/v1/capabilities"),
  },
  {
    name: "lineas",
    summary: "Listar las líneas al alcance de la credencial",
    operation: "GET /v1/lines",
    args: [],
    run: (c) => c.request("GET", "/v1/lines"),
  },
  {
    name: "linea:crear",
    summary: "Crear una línea",
    operation: "POST /v1/lines",
    args: [
      { name: "nombre", required: true, description: "Nombre visible" },
      { name: "slug", required: true, description: "Identificador corto" },
      { name: "canal", required: true, description: "whatsapp.baileys, sandbox…" },
    ],
    flags: [{ name: "ritmo", description: "Mensajes por minuto (por defecto 12)" }],
    run: (c, a) => c.request("POST", "/v1/lines", {
      name: req(a, 0, "nombre"), slug: req(a, 1, "slug"), channelKind: req(a, 2, "canal"),
      ...(flag(a, "ritmo") ? { sendRatePerMinute: Number(flag(a, "ritmo")) } : {}),
    }),
  },
  {
    name: "linea:conectar",
    summary: "Iniciar el enlace de una línea y obtener su QR",
    operation: "POST /v1/lines/{lineId}/connect",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("POST", `/v1/lines/${req(a, 0, "linea")}/connect`),
  },
  {
    name: "linea:estado",
    summary: "Estado de conexión de una línea",
    operation: "GET /v1/lines/{lineId}/status",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/status`),
  },
  {
    name: "linea:desconectar",
    summary: "Cerrar la conexión sin desvincular el dispositivo",
    operation: "POST /v1/lines/{lineId}/disconnect",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("POST", `/v1/lines/${req(a, 0, "linea")}/disconnect`),
  },
  {
    name: "linea:ajustar",
    summary: "Cambiar los ajustes de una línea",
    operation: "PATCH /v1/lines/{lineId}",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    flags: [
      { name: "nombre", description: "Nuevo nombre" },
      { name: "ritmo", description: "Mensajes por minuto" },
      { name: "activa", description: "true o false" },
    ],
    run: (c, a) => c.request("PATCH", `/v1/lines/${req(a, 0, "linea")}`, {
      ...(flag(a, "nombre") ? { name: flag(a, "nombre") } : {}),
      ...(flag(a, "ritmo") ? { sendRatePerMinute: Number(flag(a, "ritmo")) } : {}),
      ...(flag(a, "activa") ? { enabled: flag(a, "activa") === "true" } : {}),
    }),
  },
  {
    name: "linea:borrar",
    summary: "Borrar una línea y sus credenciales",
    operation: "DELETE /v1/lines/{lineId}",
    destructive: true,
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("DELETE", `/v1/lines/${req(a, 0, "linea")}`),
  },
  {
    name: "enviar",
    summary: "Enviar un mensaje de texto",
    operation: "POST /v1/lines/{lineId}/messages",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "destino", required: true, description: "Teléfono o dirección completa" },
      { name: "texto", required: true, description: "Contenido del mensaje" },
    ],
    flags: [
      { name: "id", description: "clientMessageId, para que un reintento no duplique" },
      { name: "responde-a", description: "Identificador del mensaje al que se responde" },
    ],
    run: (c, a) => c.request("POST", `/v1/lines/${req(a, 0, "linea")}/messages`, {
      to: req(a, 1, "destino"), text: req(a, 2, "texto"),
      ...(flag(a, "id") ? { clientMessageId: flag(a, "id") } : {}),
      ...(flag(a, "responde-a") ? { replyTo: flag(a, "responde-a") } : {}),
    }),
  },
  {
    name: "chats",
    summary: "Listar conversaciones de una línea",
    operation: "GET /v1/lines/{lineId}/chats",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    flags: [{ name: "limite", description: "Cuántas devolver" }],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/chats`, undefined, {
      limit: flag(a, "limite"),
    }),
  },
  {
    name: "mensajes",
    summary: "Historial de una conversación",
    operation: "GET /v1/lines/{lineId}/chats/{chatId}/messages",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
    ],
    flags: [
      { name: "limite", description: "Cuántos devolver" },
      { name: "antes-de", description: "ISO-8601: devuelve lo anterior a esa fecha" },
    ],
    run: (c, a) => c.request(
      "GET",
      `/v1/lines/${req(a, 0, "linea")}/chats/${encodeURIComponent(req(a, 1, "chat"))}/messages`,
      undefined,
      { limit: flag(a, "limite"), before: flag(a, "antes-de") },
    ),
  },
  {
    name: "contactos",
    summary: "Contactos conocidos por una línea",
    operation: "GET /v1/lines/{lineId}/contacts",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/contacts`),
  },
  {
    name: "grupos",
    summary: "Grupos a los que pertenece una línea",
    operation: "GET /v1/lines/{lineId}/groups",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/groups`),
  },
  {
    name: "webhook:crear",
    summary: "Registrar un receptor de eventos",
    operation: "POST /v1/webhooks",
    args: [{ name: "url", required: true, description: "URL del receptor" }],
    flags: [
      { name: "linea", description: "Limitar a una línea" },
      { name: "eventos", description: "Lista separada por comas; vacío = todos" },
    ],
    run: (c, a) => c.request("POST", "/v1/webhooks", {
      url: req(a, 0, "url"),
      lineId: flag(a, "linea") ?? null,
      events: flag(a, "eventos")?.split(",").map((e) => e.trim()).filter(Boolean) ?? [],
    }),
  },
  {
    name: "webhooks",
    summary: "Listar receptores de eventos",
    operation: "GET /v1/webhooks",
    args: [],
    run: (c) => c.request("GET", "/v1/webhooks"),
  },
  {
    name: "entregas",
    summary: "Intentos de entrega de webhooks, con su error",
    operation: "GET /v1/dispatches",
    args: [],
    flags: [{ name: "limite", description: "Cuántos devolver" }],
    run: (c, a) => c.request("GET", "/v1/dispatches", undefined, { limit: flag(a, "limite") }),
  },
  {
    name: "claves",
    summary: "Listar claves de API, sin sus secretos",
    operation: "GET /v1/api-keys",
    args: [],
    run: (c) => c.request("GET", "/v1/api-keys"),
  },
  {
    name: "clave:crear",
    summary: "Acuñar una clave de API",
    operation: "POST /v1/api-keys",
    args: [{ name: "nombre", required: true, description: "Para reconocerla luego" }],
    flags: [
      { name: "rol", description: "admin, operator o viewer" },
      { name: "lineas", description: "Lista separada por comas; vacío = todas" },
      { name: "chats", description: "Lista separada por comas; vacío = todos" },
    ],
    run: (c, a) => c.request("POST", "/v1/api-keys", {
      name: req(a, 0, "nombre"),
      role: flag(a, "rol") ?? "operator",
      allowedLines: flag(a, "lineas")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
      allowedChats: flag(a, "chats")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    }),
  },
  {
    name: "clave:revocar",
    summary: "Revocar una clave de API",
    operation: "DELETE /v1/api-keys/{keyId}",
    destructive: true,
    args: [{ name: "clave", required: true, description: "Identificador de la clave" }],
    run: (c, a) => c.request("DELETE", `/v1/api-keys/${req(a, 0, "clave")}`),
  },
  {
    name: "equipo",
    summary: "Quién está en la organización y con qué rol",
    operation: "GET /v1/members",
    args: [],
    run: (c) => c.request("GET", "/v1/members"),
  },
  {
    name: "invitar",
    summary: "Invitar a alguien a la organización",
    operation: "POST /v1/invitations",
    args: [{ name: "correo", required: true, description: "A quién se invita" }],
    flags: [{ name: "rol", description: "owner, manager, agent o viewer" }],
    run: (c, a) => c.request("POST", "/v1/invitations", {
      email: req(a, 0, "correo"),
      role: flag(a, "rol") ?? "agent",
    }),
  },
  {
    name: "mensaje:editar",
    summary: "Editar un mensaje ya enviado, dentro de la ventana que WhatsApp permite",
    operation: "PATCH /v1/lines/{lineId}/chats/{chatId}/messages/{messageId}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
      { name: "mensaje", required: true, description: "Identificador del proveedor" },
      { name: "texto", required: true, description: "Nuevo contenido" },
    ],
    run: (c, a) => c.request("PATCH",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/messages/${enc(req(a, 2, "mensaje"))}`,
      { text: req(a, 3, "texto") }),
  },
  {
    name: "mensaje:borrar",
    summary: "Borrar un mensaje para todos",
    operation: "DELETE /v1/lines/{lineId}/chats/{chatId}/messages/{messageId}",
    destructive: true,
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
      { name: "mensaje", required: true, description: "Identificador del proveedor" },
    ],
    run: (c, a) => c.request("DELETE",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/messages/${enc(req(a, 2, "mensaje"))}`),
  },
  {
    name: "mensaje:reaccionar",
    summary: "Reaccionar a un mensaje; un emoji vacío retira la reacción",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/messages/{messageId}/reaction",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
      { name: "mensaje", required: true, description: "Identificador del proveedor" },
      { name: "emoji", required: false, description: "Vacío retira la reacción" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/messages/${enc(req(a, 2, "mensaje"))}/reaction`,
      { emoji: a.positional[3] ?? "" }),
  },
  {
    name: "chat:leido",
    summary: "Marcar mensajes como leídos",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/read",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
      { name: "mensajes", required: true, description: "Identificadores separados por comas" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/read`,
      { messageIds: req(a, 2, "mensajes").split(",").map((s) => s.trim()).filter(Boolean) }),
  },
  {
    name: "chat:escribiendo",
    summary: "Mostrar que se está escribiendo o grabando",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/presence",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
      { name: "estado", required: false, description: "composing, recording o paused" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/presence`,
      { presence: a.positional[2] ?? "composing" }),
  },
  {
    name: "chat:archivar",
    summary: "Archivar o desarchivar una conversación",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/archive",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
    ],
    flags: [{ name: "desarchivar", description: "Sacarla del archivo en vez de archivarla" }],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/archive`,
      { archived: a.flags["desarchivar"] !== true }),
  },
  {
    name: "contacto:existe",
    summary: "Comprobar si un número está registrado en la red del transporte",
    operation: "GET /v1/lines/{lineId}/contacts/{address}/exists",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "direccion", required: true, description: "Teléfono o dirección completa" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/contacts/${enc(req(a, 1, "direccion"))}/exists`),
  },
  {
    name: "contacto:bloquear",
    summary: "Bloquear o desbloquear un contacto",
    operation: "POST /v1/lines/{lineId}/contacts/{address}/block",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "direccion", required: true, description: "Teléfono o dirección completa" },
    ],
    flags: [{ name: "desbloquear", description: "Quitar el bloqueo en vez de ponerlo" }],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/contacts/${enc(req(a, 1, "direccion"))}/block`,
      { blocked: a.flags["desbloquear"] !== true }),
  },
  {
    name: "grupo:ver",
    summary: "Datos y participantes de un grupo",
    operation: "GET /v1/lines/{lineId}/groups/{groupId}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "grupo", required: true, description: "Dirección del grupo" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/groups/${enc(req(a, 1, "grupo"))}`),
  },
  {
    name: "grupo:crear",
    summary: "Crear un grupo con sus participantes",
    operation: "POST /v1/lines/{lineId}/groups",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "asunto", required: true, description: "Nombre del grupo" },
      { name: "participantes", required: true, description: "Separados por comas" },
    ],
    run: (c, a) => c.request("POST", `/v1/lines/${req(a, 0, "linea")}/groups`, {
      subject: req(a, 1, "asunto"),
      participants: req(a, 2, "participantes").split(",").map((s) => s.trim()).filter(Boolean),
    }),
  },
  {
    name: "grupo:renombrar",
    summary: "Cambiar el asunto o la descripción de un grupo",
    operation: "PATCH /v1/lines/{lineId}/groups/{groupId}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "grupo", required: true, description: "Dirección del grupo" },
    ],
    flags: [
      { name: "asunto", description: "Nuevo nombre" },
      { name: "descripcion", description: "Nueva descripción" },
    ],
    run: (c, a) => c.request("PATCH",
      `/v1/lines/${req(a, 0, "linea")}/groups/${enc(req(a, 1, "grupo"))}`,
      {
        ...(flag(a, "asunto") ? { subject: flag(a, "asunto") } : {}),
        ...(flag(a, "descripcion") ? { description: flag(a, "descripcion") } : {}),
      }),
  },
  {
    name: "grupo:salir",
    summary: "Salir de un grupo",
    operation: "POST /v1/lines/{lineId}/groups/{groupId}/leave",
    destructive: true,
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "grupo", required: true, description: "Dirección del grupo" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/groups/${enc(req(a, 1, "grupo"))}/leave`),
  },
  {
    name: "grupo:participantes",
    summary: "Añadir, quitar, promover o degradar participantes",
    operation: "POST /v1/lines/{lineId}/groups/{groupId}/participants",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "grupo", required: true, description: "Dirección del grupo" },
      { name: "accion", required: true, description: "add, remove, promote o demote" },
      { name: "participantes", required: true, description: "Separados por comas" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/groups/${enc(req(a, 1, "grupo"))}/participants`,
      {
        action: req(a, 2, "accion"),
        participants: req(a, 3, "participantes").split(",").map((s) => s.trim()).filter(Boolean),
      }),
  },
  {
    name: "etiquetas",
    summary: "Etiquetas de una línea, con cuántas veces se usa cada una",
    operation: "GET /v1/lines/{lineId}/labels",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/labels`),
  },
  {
    name: "etiqueta:crear",
    summary: "Crear una etiqueta",
    operation: "POST /v1/lines/{lineId}/labels",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "nombre", required: true, description: "Nombre de la etiqueta" },
    ],
    flags: [{ name: "color", description: "gris, rojo, ámbar, verde, azul o violeta" }],
    run: (c, a) => c.request("POST", `/v1/lines/${req(a, 0, "linea")}/labels`, {
      name: req(a, 1, "nombre"),
      ...(flag(a, "color") ? { color: flag(a, "color") } : {}),
    }),
  },
  {
    name: "etiqueta:borrar",
    summary: "Borrar una etiqueta y quitarla de donde estuviera",
    operation: "DELETE /v1/lines/{lineId}/labels/{labelId}",
    destructive: true,
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "etiqueta", required: true, description: "Identificador de la etiqueta" },
    ],
    run: (c, a) => c.request("DELETE",
      `/v1/lines/${req(a, 0, "linea")}/labels/${enc(req(a, 1, "etiqueta"))}`),
  },
  {
    name: "etiqueta:chats",
    summary: "Conversaciones que llevan una etiqueta",
    operation: "GET /v1/lines/{lineId}/labels/{labelId}/chats",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "etiqueta", required: true, description: "Identificador de la etiqueta" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/labels/${enc(req(a, 1, "etiqueta"))}/chats`),
  },
  {
    name: "chat:etiquetar",
    summary: "Fijar las etiquetas de una conversación; reemplaza el conjunto entero",
    operation: "PUT /v1/lines/{lineId}/chats/{chatId}/labels",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
      { name: "etiquetas", required: false, description: "Separadas por comas; vacío las quita todas" },
    ],
    run: (c, a) => c.request("PUT",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/labels`,
      { labelIds: (a.positional[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean) }),
  },
  {
    name: "grupo:invitacion",
    summary: "Código de invitación vigente de un grupo; lo lee, no lo rota",
    operation: "GET /v1/lines/{lineId}/groups/{groupId}/invite",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "grupo", required: true, description: "Dirección del grupo" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/groups/${enc(req(a, 1, "grupo"))}/invite`),
  },
  {
    name: "grupo:invitacion:rotar",
    summary: "Rotar el código de invitación; el anterior deja de servir",
    operation: "POST /v1/lines/{lineId}/groups/{groupId}/invite",
    destructive: true,
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "grupo", required: true, description: "Dirección del grupo" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/groups/${enc(req(a, 1, "grupo"))}/invite`),
  },
  {
    name: "mensaje:reintentar",
    summary: "Reintentar un mensaje que falló, sin crear otro",
    operation: "POST /v1/lines/{lineId}/messages/{messageId}/resend",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "mensaje", required: true, description: "Identificador interno del mensaje" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/messages/${enc(req(a, 1, "mensaje"))}/resend`),
  },
  {
    name: "identidad",
    summary: "El teléfono detrás de un LID, o el LID de un teléfono",
    operation: "GET /v1/lines/{lineId}/identity/{address}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "direccion", required: true, description: "Un @lid o un teléfono" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/identity/${enc(req(a, 1, "direccion"))}`),
  },
  {
    name: "chat:historial",
    summary: "Pedir historial anterior; es asíncrono, llega por eventos",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/history",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
    ],
    flags: [
      { name: "antes", description: "Fecha ISO desde la que retroceder" },
      { name: "cuantos", description: "Cuántos mensajes pedir" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/history`,
      {
        ...(flag(a, "antes") ? { before: flag(a, "antes") } : {}),
        count: Number(flag(a, "cuantos") ?? 50),
      }),
  },
  {
    name: "comunidades",
    summary: "Comunidades de la línea, con los grupos que cuelgan de cada una",
    operation: "GET /v1/lines/{lineId}/communities",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/communities`),
  },
  {
    name: "comunidad",
    summary: "Datos de una comunidad y sus grupos",
    operation: "GET /v1/lines/{lineId}/communities/{communityId}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "comunidad", required: true, description: "Dirección de la comunidad" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/communities/${enc(req(a, 1, "comunidad"))}`),
  },
  {
    name: "comunidad:crear",
    summary: "Crear una comunidad",
    operation: "POST /v1/lines/{lineId}/communities",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "nombre", required: true, description: "Nombre de la comunidad" },
    ],
    flags: [{ name: "descripcion", description: "Descripción de la comunidad" }],
    run: (c, a) => c.request("POST", `/v1/lines/${req(a, 0, "linea")}/communities`, {
      subject: req(a, 1, "nombre"), description: flag(a, "descripcion") ?? "",
    }),
  },
  {
    name: "comunidad:enlazar",
    summary: "Enlazar un grupo a una comunidad, o desenlazarlo con --no",
    operation: "POST /v1/lines/{lineId}/communities/{communityId}/groups",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "comunidad", required: true, description: "Dirección de la comunidad" },
      { name: "grupo", required: true, description: "Dirección del grupo" },
    ],
    flags: [{ name: "no", description: "Desenlazarlo en vez de enlazarlo" }],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/communities/${enc(req(a, 1, "comunidad"))}/groups`,
      { groupId: req(a, 2, "grupo"), linked: a.flags["no"] !== true }),
  },
  {
    name: "comunidad:salir",
    summary: "Salir de una comunidad; los grupos enlazados siguen existiendo",
    operation: "POST /v1/lines/{lineId}/communities/{communityId}/leave",
    destructive: true,
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "comunidad", required: true, description: "Dirección de la comunidad" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/communities/${enc(req(a, 1, "comunidad"))}/leave`),
  },
  {
    name: "productos",
    summary: "Catálogo de la línea, o el de otra cuenta de empresa con --de",
    operation: "GET /v1/lines/{lineId}/products",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    flags: [
      { name: "de", description: "Dirección de otra cuenta de empresa" },
      { name: "limite", description: "Cuántos devolver" },
    ],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/products`, undefined, {
      of: flag(a, "de"), limit: flag(a, "limite"),
    }),
  },
  {
    name: "colecciones",
    summary: "Colecciones del catálogo",
    operation: "GET /v1/lines/{lineId}/collections",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    flags: [
      { name: "de", description: "Dirección de otra cuenta de empresa" },
      { name: "limite", description: "Cuántas devolver" },
    ],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/collections`, undefined, {
      of: flag(a, "de"), limit: flag(a, "limite"),
    }),
  },
  {
    name: "producto:crear",
    summary: "Publicar un producto desde un JSON; nace pendiente de revisión",
    operation: "POST /v1/lines/{lineId}/products",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "json", required: true, description: "Objeto con name, description, price, currency e imageUrls" },
    ],
    run: (c, a) => {
      let producto: unknown;
      try {
        producto = JSON.parse(req(a, 1, "json"));
      } catch {
        throw new Error("el producto tiene que ser un objeto JSON válido");
      }
      return c.request("POST", `/v1/lines/${req(a, 0, "linea")}/products`,
        producto as Record<string, unknown>);
    },
  },
  {
    name: "producto:actualizar",
    summary: "Reemplazar un producto; vuelve a revisión",
    operation: "PUT /v1/lines/{lineId}/products/{productId}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "producto", required: true, description: "Identificador del producto" },
      { name: "json", required: true, description: "El producto entero, no solo lo que cambia" },
    ],
    run: (c, a) => {
      let producto: unknown;
      try {
        producto = JSON.parse(req(a, 2, "json"));
      } catch {
        throw new Error("el producto tiene que ser un objeto JSON válido");
      }
      return c.request("PUT",
        `/v1/lines/${req(a, 0, "linea")}/products/${enc(req(a, 1, "producto"))}`,
        producto as Record<string, unknown>);
    },
  },
  {
    name: "producto:borrar",
    summary: "Retirar un producto del catálogo",
    operation: "DELETE /v1/lines/{lineId}/products/{productId}",
    destructive: true,
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "producto", required: true, description: "Identificador del producto" },
    ],
    run: (c, a) => c.request("DELETE",
      `/v1/lines/${req(a, 0, "linea")}/products/${enc(req(a, 1, "producto"))}`),
  },
  {
    name: "pedido",
    summary: "Detalle de un pedido; el testigo viene en su mensaje",
    operation: "GET /v1/lines/{lineId}/orders/{orderId}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "pedido", required: true, description: "Identificador del pedido" },
      { name: "testigo", required: true, description: "El token que venía en el mensaje" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/orders/${enc(req(a, 1, "pedido"))}`,
      undefined, { token: req(a, 2, "testigo") }),
  },
  {
    name: "chat:silenciar",
    summary: "Silenciar una conversación en WhatsApp hasta una fecha",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/mute",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
    ],
    flags: [{ name: "hasta", description: "Fecha ISO; sin ella, la desilencia" }],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/mute`,
      { until: flag(a, "hasta") ?? null }),
  },
  {
    name: "chat:efimero",
    summary: "Poner los mensajes de una conversación a caducar",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/ephemeral",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
      { name: "segundos", required: true, description: "0, 86400, 604800 o 7776000" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/ephemeral`,
      { seconds: Number(req(a, 2, "segundos")) }),
  },
  {
    name: "mensaje:reenviar",
    summary: "Reenviar un mensaje a otra conversación",
    operation: "POST /v1/lines/{lineId}/chats/{chatId}/messages/{messageId}/forward",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Chat donde está el mensaje" },
      { name: "mensaje", required: true, description: "Identificador del mensaje" },
      { name: "destino", required: true, description: "Dirección a la que reenviarlo" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/messages/${enc(req(a, 2, "mensaje"))}/forward`,
      { to: req(a, 3, "destino") }),
  },
  {
    name: "contacto:perfil",
    summary: "Perfil público de un contacto; la foto caduca",
    operation: "GET /v1/lines/{lineId}/contacts/{address}/profile",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "contacto", required: true, description: "Dirección del contacto" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/contacts/${enc(req(a, 1, "contacto"))}/profile`),
  },
  {
    name: "etiquetas:whatsapp",
    summary: "Etiquetas de WhatsApp Business, distintas de las de Omni",
    operation: "GET /v1/lines/{lineId}/network-labels",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    run: (c, a) => c.request("GET", `/v1/lines/${req(a, 0, "linea")}/network-labels`),
  },
  {
    name: "llamada:rechazar",
    summary: "Rechazar una llamada entrante mientras suena",
    operation: "POST /v1/lines/{lineId}/calls/{callId}/reject",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "llamada", required: true, description: "Identificador de la llamada" },
      { name: "de", required: true, description: "Quién llama" },
    ],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/calls/${enc(req(a, 1, "llamada"))}/reject`,
      { from: req(a, 2, "de") }),
  },
  {
    name: "conversaciones",
    summary: "La bandeja: conversaciones por estado",
    operation: "GET /v1/conversations",
    args: [],
    flags: [
      { name: "estado", description: "open, pending, snoozed o resolved" },
      { name: "linea", description: "Acotar a una línea" },
      { name: "limite", description: "Cuántas devolver" },
    ],
    run: (c, a) => c.request("GET", "/v1/conversations", undefined, {
      status: flag(a, "estado"), lineId: flag(a, "linea"), limit: flag(a, "limite"),
    }),
  },
  {
    name: "conversacion:actualizar",
    summary: "Cambiar estado, prioridad o responsable de una conversación",
    operation: "PATCH /v1/conversations/{conversationId}",
    args: [{ name: "conversacion", required: true, description: "Identificador de la conversación" }],
    flags: [
      { name: "estado", description: "open, pending, snoozed o resolved" },
      { name: "prioridad", description: "low, normal, high o urgent" },
      { name: "responsable", description: "Identificador de la persona" },
      { name: "asunto", description: "Título de la conversación" },
    ],
    run: (c, a) => c.request("PATCH", `/v1/conversations/${enc(req(a, 0, "conversacion"))}`, {
      ...(flag(a, "estado") ? { status: flag(a, "estado") } : {}),
      ...(flag(a, "prioridad") ? { priority: flag(a, "prioridad") } : {}),
      ...(flag(a, "responsable") ? { assigneeId: flag(a, "responsable") } : {}),
      ...(flag(a, "asunto") ? { subject: flag(a, "asunto") } : {}),
    }),
  },
  {
    name: "automatizaciones",
    summary: "Reglas de la organización, en el orden en que se ejecutan",
    operation: "GET /v1/automations",
    args: [],
    run: (c) => c.request("GET", "/v1/automations"),
  },
  {
    name: "automatizacion:crear",
    summary: "Crear una regla desde un JSON; nace apagada",
    operation: "POST /v1/automations",
    args: [{ name: "json", required: true, description: "Objeto con name, trigger, conditions y actions" }],
    run: (c, a) => {
      let regla: unknown;
      try {
        regla = JSON.parse(req(a, 0, "json"));
      } catch {
        throw new Error("la regla tiene que ser un objeto JSON válido");
      }
      return c.request("POST", "/v1/automations", regla as Record<string, unknown>);
    },
  },
  {
    name: "automatizacion:encender",
    summary: "Encender una regla, o apagarla con --no",
    operation: "PATCH /v1/automations/{ruleId}",
    args: [{ name: "regla", required: true, description: "Identificador de la regla" }],
    flags: [{ name: "no", description: "Apagarla en vez de encenderla" }],
    run: (c, a) => c.request("PATCH", `/v1/automations/${enc(req(a, 0, "regla"))}`, {
      enabled: a.flags["no"] !== true,
    }),
  },
  {
    name: "automatizacion:borrar",
    summary: "Borrar una regla y su historial de disparos",
    operation: "DELETE /v1/automations/{ruleId}",
    destructive: true,
    args: [{ name: "regla", required: true, description: "Identificador de la regla" }],
    run: (c, a) => c.request("DELETE", `/v1/automations/${enc(req(a, 0, "regla"))}`),
  },
  {
    name: "automatizacion:disparos",
    summary: "Qué ha hecho una regla, incluido lo que falló",
    operation: "GET /v1/automations/{ruleId}/runs",
    args: [{ name: "regla", required: true, description: "Identificador de la regla" }],
    flags: [
      { name: "resultado", description: "matched, skipped o failed" },
      { name: "limite", description: "Cuántos devolver" },
    ],
    run: (c, a) => c.request("GET", `/v1/automations/${enc(req(a, 0, "regla"))}/runs`, undefined, {
      outcome: flag(a, "resultado"), limit: flag(a, "limite"),
    }),
  },
  {
    name: "organizacion",
    summary: "La organización de esta credencial y cuántas líneas tiene",
    operation: "GET /v1/org",
    args: [],
    run: (c) => c.request("GET", "/v1/org"),
  },
  {
    name: "chat:vaciar",
    summary: "Vaciar una conversación en la red y borrar nuestra copia",
    operation: "DELETE /v1/lines/{lineId}/chats/{chatId}/messages",
    destructive: true,
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "chat", required: true, description: "Dirección del chat" },
    ],
    run: (c, a) => c.request("DELETE",
      `/v1/lines/${req(a, 0, "linea")}/chats/${enc(req(a, 1, "chat"))}/messages`),
  },
  {
    name: "canal",
    summary: "Datos de un canal, por dirección o por el código de su enlace",
    operation: "GET /v1/lines/{lineId}/newsletters/{newsletterId}",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "canal", required: true, description: "Dirección @newsletter o código del enlace" },
    ],
    run: (c, a) => c.request("GET",
      `/v1/lines/${req(a, 0, "linea")}/newsletters/${enc(req(a, 1, "canal"))}`),
  },
  {
    name: "canal:seguir",
    summary: "Seguir un canal, o dejarlo con --no",
    operation: "POST /v1/lines/{lineId}/newsletters/{newsletterId}/follow",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "canal", required: true, description: "Dirección del canal" },
    ],
    flags: [{ name: "no", description: "Dejar de seguirlo" }],
    run: (c, a) => c.request("POST",
      `/v1/lines/${req(a, 0, "linea")}/newsletters/${enc(req(a, 1, "canal"))}/follow`,
      { follow: a.flags["no"] !== true }),
  },
  {
    name: "canal:crear",
    summary: "Crear un canal; solo si el transporte sabe publicar en ellos",
    operation: "POST /v1/lines/{lineId}/newsletters",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "nombre", required: true, description: "Nombre del canal" },
    ],
    flags: [{ name: "descripcion", description: "Descripción del canal" }],
    run: (c, a) => c.request("POST", `/v1/lines/${req(a, 0, "linea")}/newsletters`, {
      name: req(a, 1, "nombre"),
      ...(flag(a, "descripcion") ? { description: flag(a, "descripcion") } : {}),
    }),
  },
  {
    name: "plugins",
    summary: "Plugins instalados, con sus permisos y su estado",
    operation: "GET /v1/plugins",
    args: [],
    run: (c) => c.request("GET", "/v1/plugins"),
  },
  {
    name: "plugin:instalar",
    summary: "Instalar un plugin desde un directorio DEL SERVIDOR; nace apagado",
    operation: "POST /v1/plugins",
    args: [{
      name: "directorio", required: true,
      description: "Ruta en el servidor, no en tu máquina: no se sube nada",
    }],
    run: (c, a) => c.request("POST", "/v1/plugins", { directory: req(a, 0, "directorio") }),
  },
  {
    name: "plugin:habilitar",
    summary: "Arrancar un plugin en todos los nodos",
    operation: "POST /v1/plugins/{pluginId}/enable",
    args: [{ name: "plugin", required: true, description: "Identificador del plugin" }],
    flags: [{ name: "no", description: "Deshabilitarlo en vez de habilitarlo" }],
    run: (c, a) => c.request("POST", `/v1/plugins/${enc(req(a, 0, "plugin"))}/enable`, {
      enabled: a.flags["no"] !== true,
    }),
  },
  {
    name: "plugin:config",
    summary: "Cambiar la configuración de un plugin; entra sin reiniciarlo",
    operation: "PUT /v1/plugins/{pluginId}/config",
    args: [
      { name: "plugin", required: true, description: "Identificador del plugin" },
      { name: "json", required: true, description: "Objeto JSON con la configuración entera" },
    ],
    run: (c, a) => {
      let config: unknown;
      try {
        config = JSON.parse(req(a, 1, "json"));
      } catch {
        throw new Error("la configuración tiene que ser un objeto JSON válido");
      }
      if (config === null || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("la configuración tiene que ser un objeto JSON, no otra cosa");
      }
      return c.request("PUT", `/v1/plugins/${enc(req(a, 0, "plugin"))}/config`, { config });
    },
  },
  {
    name: "plugin:salud",
    summary: "Preguntar a un plugin si está bien",
    operation: "GET /v1/plugins/{pluginId}/health",
    args: [{ name: "plugin", required: true, description: "Identificador del plugin" }],
    run: (c, a) => c.request("GET", `/v1/plugins/${enc(req(a, 0, "plugin"))}/health`),
  },
  {
    name: "plugin:desinstalar",
    summary: "Detener un plugin y olvidarlo; no borra sus ficheros",
    operation: "DELETE /v1/plugins/{pluginId}",
    destructive: true,
    args: [{ name: "plugin", required: true, description: "Identificador del plugin" }],
    run: (c, a) => c.request("DELETE", `/v1/plugins/${enc(req(a, 0, "plugin"))}`),
  },
  {
    name: "auditoria",
    summary: "Quién hizo qué, con qué credencial y desde dónde",
    operation: "GET /v1/audit",
    args: [],
    flags: [{ name: "limite", description: "Cuántos devolver" }],
    run: (c, a) => c.request("GET", "/v1/audit", undefined, { limit: flag(a, "limite") }),
  },
  {
    name: "sandbox:escanear",
    summary: "Completar el enlace de una línea de sandbox sin teléfono",
    operation: "POST /v1/sandbox/lines/{lineId}/scan",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "telefono", required: true, description: "Número que simula la línea" },
    ],
    run: (c, a) => c.request("POST", `/v1/sandbox/lines/${req(a, 0, "linea")}/scan`, {
      phone: req(a, 1, "telefono"),
    }),
  },
  {
    name: "sandbox:entrante",
    summary: "Fabricar un mensaje entrante para probar un webhook",
    operation: "POST /v1/sandbox/lines/{lineId}/inbound",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "de", required: true, description: "Quién escribe" },
      { name: "texto", required: true, description: "Qué escribe" },
    ],
    flags: [{ name: "chat", description: "Para simular un grupo" }],
    run: (c, a) => c.request("POST", `/v1/sandbox/lines/${req(a, 0, "linea")}/inbound`, {
      from: req(a, 1, "de"), text: req(a, 2, "texto"),
      ...(flag(a, "chat") ? { chat: flag(a, "chat") } : {}),
    }),
  },
  {
    name: "sandbox:canal",
    summary: "Fabricar un canal ajeno, de los que se siguen",
    operation: "POST /v1/sandbox/lines/{lineId}/newsletters",
    args: [
      { name: "linea", required: true, description: "Identificador de la línea" },
      { name: "nombre", required: true, description: "Nombre del canal" },
    ],
    flags: [{ name: "descripcion", description: "Descripción del canal" }],
    run: (c, a) => c.request("POST", `/v1/sandbox/lines/${req(a, 0, "linea")}/newsletters`, {
      name: req(a, 1, "nombre"),
      ...(flag(a, "descripcion") ? { description: flag(a, "descripcion") } : {}),
    }),
  },
  {
    name: "sandbox:hilo",
    summary: "La conversación simulada, en ambos sentidos",
    operation: "GET /v1/sandbox/lines/{lineId}/thread",
    args: [{ name: "linea", required: true, description: "Identificador de la línea" }],
    flags: [{ name: "chat", description: "Filtrar por conversación" }],
    run: (c, a) => c.request("GET", `/v1/sandbox/lines/${req(a, 0, "linea")}/thread`, undefined, {
      chat: flag(a, "chat"),
    }),
  },
];

export const findCommand = (name: string): Command | undefined =>
  COMMANDS.find((c) => c.name === name);
