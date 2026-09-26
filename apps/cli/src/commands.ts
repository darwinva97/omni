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
