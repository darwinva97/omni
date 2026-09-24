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
