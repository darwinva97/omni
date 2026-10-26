/**
 * Las reglas de automatización, en lenguaje llano.
 *
 * La API habla de `trigger`, `field`, `op` y `actions`; quien las configura no
 * programa. Aquí vive la traducción, en las dos direcciones: qué se puede
 * elegir en el formulario —solo lo que el servidor sabe hacer DE VERDAD— y
 * cómo se lee una regla ya hecha («Cuando llegue un mensaje que contenga
 * “factura” → responder…»).
 *
 * Lo que el servidor admite sale de `apps/api/src/crm/automatizaciones.ts` y
 * de `packages/core/src/automation`, no de la lista de nombres del esquema:
 * el esquema acepta disparadores que nadie emite todavía (los de cambios de
 * conversación y de listas), y ofrecerlos sería prometer una regla que no
 * salta nunca.
 */

export type Disparador =
  | "message.received" | "message.sent" | "line.connected" | "line.disconnected" | "call.received"
  | "conversation.opened" | "conversation.status" | "conversation.assigned" | "label.added";

export type Campo =
  | "text" | "from" | "chat" | "chatKind" | "labels" | "status" | "priority"
  | "assignee" | "lineId" | "hour" | "weekday";

export type Operador =
  | "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "matches" | "in" | "not_in" | "gte" | "lte" | "is_empty" | "is_not_empty";

export interface Condicion {
  field: Campo;
  op: Operador;
  value?: string | number | string[];
  caseSensitive?: boolean;
  timeZone?: string;
}

export type Accion =
  | { type: "send_message"; text: string; asReply?: boolean }
  | { type: "add_label"; labelId: string }
  | { type: "remove_label"; labelId: string }
  | { type: "assign"; userId: string | null }
  | { type: "set_status"; status: "open" | "pending" | "snoozed" | "resolved" }
  | { type: "set_priority"; priority: "low" | "normal" | "high" | "urgent" }
  | { type: "webhook"; url: string; headers?: Record<string, string> }
  | { type: "reject_call" }
  | { type: "stop" };

export interface Regla {
  id: string;
  name: string;
  trigger: Disparador;
  conditions: Condicion[];
  actions: Accion[];
  priority: number;
  enabled: boolean;
  lineId: string | null;
}

export interface Disparo {
  id: string; event: string;
  outcome: "matched" | "skipped" | "failed";
  reason: string | null; target: string | null;
  actionsRun: string[]; durationMs: number | null; createdAt: string;
}

/** Lo que hace falta para poner nombres en vez de identificadores. */
export interface Diccionario {
  lineas: { id: string; name: string }[];
  /** Las listas, con la línea a la que pertenecen: son de UNA línea. */
  listas: { id: string; name: string; lineId: string }[];
  miembros: { userId: string; name: string }[];
}

// ------------------------------------------------------------ disparadores

/** Los que el servidor dispara de verdad, en el orden en que se eligen. */
export const DISPARADORES: { valor: Disparador; texto: string; deMensaje: boolean }[] = [
  { valor: "message.received", texto: "llegue un mensaje", deMensaje: true },
  { valor: "message.sent", texto: "se envíe un mensaje", deMensaje: true },
  // Al empezar a sonar. Tiene chat, así que se le puede contestar por escrito.
  { valor: "call.received", texto: "entre una llamada", deMensaje: true },
  { valor: "line.disconnected", texto: "la línea se desconecte", deMensaje: false },
  { valor: "line.connected", texto: "la línea se conecte", deMensaje: false },
];

/** Los que acepta el esquema y todavía no emite nadie: se enseñan si existen, no se ofrecen. */
const SIN_EMISOR: Partial<Record<Disparador, string>> = {
  "conversation.opened": "se abra una conversación",
  "conversation.status": "cambie el estado de una conversación",
  "conversation.assigned": "se asigne una conversación",
  "label.added": "se ponga un chat en una lista",
};

export const esDeMensaje = (d: Disparador): boolean =>
  DISPARADORES.find((x) => x.valor === d)?.deMensaje ?? false;

// ------------------------------------------------------------ condiciones

export interface OpcionDeOperador {
  op: Operador;
  texto: string;
  /** Qué se escribe o elige como valor. */
  valor: "texto" | "lista" | "estado" | "prioridad" | "miembro" | "tipo-chat" | "hora" | "dias" | "nada";
}

export interface OpcionDeCampo {
  campo: Campo;
  texto: string;
  /** Solo tiene sentido con un mensaje: con la línea conectándose no hay texto ni chat. */
  deMensaje: boolean;
  operadores: OpcionDeOperador[];
}

export const CAMPOS: OpcionDeCampo[] = [
  {
    campo: "text", texto: "el mensaje", deMensaje: true,
    operadores: [
      { op: "contains", texto: "contiene", valor: "texto" },
      { op: "not_contains", texto: "no contiene", valor: "texto" },
      { op: "starts_with", texto: "empieza por", valor: "texto" },
      { op: "ends_with", texto: "termina en", valor: "texto" },
      { op: "equals", texto: "es exactamente", valor: "texto" },
      { op: "matches", texto: "cumple la expresión regular", valor: "texto" },
      { op: "is_empty", texto: "no tiene texto (una foto, un audio…)", valor: "nada" },
    ],
  },
  {
    campo: "chatKind", texto: "el chat", deMensaje: true,
    operadores: [{ op: "equals", texto: "es", valor: "tipo-chat" }],
  },
  {
    campo: "from", texto: "el número de quien escribe", deMensaje: true,
    operadores: [
      { op: "contains", texto: "contiene", valor: "texto" },
      { op: "starts_with", texto: "empieza por", valor: "texto" },
    ],
  },
  {
    campo: "labels", texto: "el chat", deMensaje: true,
    operadores: [
      { op: "contains", texto: "está en la lista", valor: "lista" },
      { op: "not_contains", texto: "no está en la lista", valor: "lista" },
      { op: "is_empty", texto: "no está en ninguna lista", valor: "nada" },
    ],
  },
  {
    campo: "status", texto: "la conversación", deMensaje: true,
    operadores: [
      { op: "equals", texto: "está", valor: "estado" },
      { op: "not_equals", texto: "no está", valor: "estado" },
    ],
  },
  {
    campo: "assignee", texto: "el responsable", deMensaje: true,
    operadores: [
      { op: "is_empty", texto: "no hay nadie", valor: "nada" },
      { op: "is_not_empty", texto: "ya hay alguien", valor: "nada" },
      { op: "equals", texto: "es", valor: "miembro" },
    ],
  },
  {
    campo: "priority", texto: "la prioridad", deMensaje: true,
    operadores: [
      { op: "equals", texto: "es", valor: "prioridad" },
      { op: "not_equals", texto: "no es", valor: "prioridad" },
    ],
  },
  {
    campo: "hour", texto: "la hora", deMensaje: false,
    operadores: [
      { op: "gte", texto: "es desde las", valor: "hora" },
      { op: "lte", texto: "es hasta las", valor: "hora" },
    ],
  },
  {
    campo: "weekday", texto: "el día", deMensaje: false,
    operadores: [
      { op: "in", texto: "es", valor: "dias" },
      { op: "not_in", texto: "no es", valor: "dias" },
    ],
  },
];

export const ESTADOS_TEXTO: Record<string, string> = {
  open: "abierta", pending: "pendiente", snoozed: "pospuesta", resolved: "resuelta",
};
export const PRIORIDADES_TEXTO: Record<string, string> = {
  low: "baja", normal: "normal", high: "alta", urgent: "urgente",
};
export const TIPOS_DE_CHAT: Record<string, string> = {
  individual: "de una persona", group: "un grupo",
};
/** `getDay()`: el 0 es domingo. Se enseñan de lunes a domingo. */
export const DIAS: { valor: string; corto: string; largo: string }[] = [
  { valor: "1", corto: "L", largo: "lunes" },
  { valor: "2", corto: "M", largo: "martes" },
  { valor: "3", corto: "X", largo: "miércoles" },
  { valor: "4", corto: "J", largo: "jueves" },
  { valor: "5", corto: "V", largo: "viernes" },
  { valor: "6", corto: "S", largo: "sábado" },
  { valor: "0", corto: "D", largo: "domingo" },
];

export const campoDe = (c: Campo): OpcionDeCampo | undefined => CAMPOS.find((x) => x.campo === c);
export const operadorDe = (c: Campo, op: Operador): OpcionDeOperador | undefined =>
  campoDe(c)?.operadores.find((x) => x.op === op);

/** Una condición nueva de ese campo, con su primer operador y un valor vacío razonable. */
export function condicionNueva(campo: Campo, zona: string): Condicion {
  const op = campoDe(campo)!.operadores[0]!;
  const base: Condicion = { field: campo, op: op.op };
  switch (op.valor) {
    case "hora": return { ...base, value: campo === "hour" && op.op === "gte" ? 9 : 18, timeZone: zona };
    case "dias": return { ...base, value: ["1", "2", "3", "4", "5"], timeZone: zona };
    case "tipo-chat": return { ...base, value: "individual" };
    case "estado": return { ...base, value: "open" };
    case "prioridad": return { ...base, value: "urgent" };
    case "nada": return base;
    default: return { ...base, value: "" };
  }
}

// ------------------------------------------------------------ acciones

export type TipoDeAccion = Exclude<Accion["type"], "stop">;

export const ACCIONES: { tipo: TipoDeAccion; texto: string; deMensaje: boolean }[] = [
  { tipo: "send_message", texto: "responder", deMensaje: true },
  { tipo: "add_label", texto: "poner en la lista", deMensaje: true },
  { tipo: "remove_label", texto: "quitar de la lista", deMensaje: true },
  { tipo: "assign", texto: "asignar a", deMensaje: true },
  { tipo: "set_status", texto: "marcar la conversación como", deMensaje: true },
  { tipo: "set_priority", texto: "poner prioridad", deMensaje: true },
  { tipo: "reject_call", texto: "colgar la llamada", deMensaje: true },
  // Lo único que tiene sentido cuando lo que pasa es que la línea se cae: no
  // hay chat al que contestar, pero sí alguien a quien avisar.
  { tipo: "webhook", texto: "avisar a una dirección web (webhook)", deMensaje: false },
];

export function accionNueva(tipo: TipoDeAccion): Accion {
  switch (tipo) {
    case "send_message": return { type: tipo, text: "", asReply: false };
    case "add_label": case "remove_label": return { type: tipo, labelId: "" };
    case "assign": return { type: tipo, userId: null };
    case "set_status": return { type: tipo, status: "resolved" };
    case "set_priority": return { type: tipo, priority: "urgent" };
    case "webhook": return { type: tipo, url: "" };
    case "reject_call": return { type: tipo };
  }
}

// ------------------------------------------------------------ leer una regla

const comillas = (v: unknown): string => `«${String(v ?? "")}»`;
const hora2 = (v: unknown): string => `${String(v ?? "").padStart(2, "0")}:00`;

/** «factura» y «presupuesto»: una lista de cosas, en castellano. */
export function enumerar(partes: string[], y = "y"): string {
  if (partes.length <= 1) return partes[0] ?? "";
  return `${partes.slice(0, -1).join(", ")} ${y} ${partes.at(-1)}`;
}

export function describirDisparador(d: string): string {
  const texto = DISPARADORES.find((x) => x.valor === d)?.texto
    ?? SIN_EMISOR[d as Disparador];
  return texto ? `Cuando ${texto}` : `Cuando ocurra «${d}»`;
}

/** El disparador existe en el esquema pero hoy no lo emite nadie. */
export const disparadorSinEmisor = (d: string): boolean => d in SIN_EMISOR;

export function describirCondicion(c: Condicion, dic: Diccionario): string {
  const campo = campoDe(c.field);
  const op = operadorDe(c.field, c.op);
  if (!campo || !op) return `${c.field} ${c.op} ${JSON.stringify(c.value ?? "")}`;
  const lista = (id: unknown) => dic.listas.find((l) => l.id === id)?.name ?? "una lista que ya no existe";
  const valor = ((): string => {
    switch (op.valor) {
      case "nada": return "";
      case "texto": return comillas(c.value);
      case "lista": return comillas(lista(c.value));
      case "estado": return ESTADOS_TEXTO[String(c.value)] ?? String(c.value);
      case "prioridad": return PRIORIDADES_TEXTO[String(c.value)] ?? String(c.value);
      case "tipo-chat": return TIPOS_DE_CHAT[String(c.value)] ?? String(c.value);
      case "miembro": return dic.miembros.find((m) => m.userId === c.value)?.name ?? "alguien que ya no está";
      case "hora": return hora2(c.value);
      case "dias": {
        const dias = (Array.isArray(c.value) ? c.value : []).map(String);
        return enumerar(DIAS.filter((d) => dias.includes(d.valor)).map((d) => d.largo), "o");
      }
    }
  })();
  return `${campo.texto} ${op.texto}${valor ? ` ${valor}` : ""}`;
}

export function describirAccion(a: Accion, dic: Diccionario): string {
  const lista = (id: string) => dic.listas.find((l) => l.id === id)?.name ?? "una lista que ya no existe";
  switch (a.type) {
    case "send_message": return `${a.asReply ? "responder citando" : "responder"} ${comillas(a.text)}`;
    case "add_label": return `poner el chat en la lista ${comillas(lista(a.labelId))}`;
    case "remove_label": return `quitar el chat de la lista ${comillas(lista(a.labelId))}`;
    case "assign": return a.userId
      ? `asignarlo a ${dic.miembros.find((m) => m.userId === a.userId)?.name ?? "alguien que ya no está"}`
      : "dejarlo sin responsable";
    case "set_status": return `marcar la conversación como ${ESTADOS_TEXTO[a.status] ?? a.status}`;
    case "set_priority": return `poner prioridad ${PRIORIDADES_TEXTO[a.priority] ?? a.priority}`;
    case "webhook": return `avisar a ${a.url}`;
    case "reject_call": return "colgar la llamada";
    case "stop": return "no seguir con las reglas de después";
  }
}

/** El nombre que se enseña de una acción ya ejecutada, en el historial. */
export const ACCION_HECHA: Record<string, string> = {
  send_message: "respondió", add_label: "puso en lista", remove_label: "quitó de lista",
  assign: "asignó", set_status: "cambió el estado", set_priority: "cambió la prioridad",
  webhook: "avisó al webhook", reject_call: "colgó",
};

/** La regla entera en una frase: «Cuando llegue un mensaje que…, → responder…». */
export function describirRegla(r: Regla, dic: Diccionario): { cuando: string; entonces: string } {
  const condiciones = r.conditions.map((c) => describirCondicion(c, dic));
  const acciones = r.actions.map((a) => describirAccion(a, dic));
  return {
    cuando: describirDisparador(r.trigger)
      + (condiciones.length > 0 ? `, si ${enumerar(condiciones)}` : ""),
    entonces: enumerar(acciones),
  };
}

// ------------------------------------------------------------ validar

/**
 * Lo que falta para poder guardar, dicho en llano. Vacío = se puede.
 *
 * Repite a propósito lo que el servidor rechazaría —o, peor, aceptaría y
 * luego fallaría al disparar—, para decirlo junto al campo y no con un 422.
 */
export function problemasDe(r: Omit<Regla, "id" | "enabled">): string[] {
  const p: string[] = [];
  if (!r.name.trim()) p.push("Ponle un nombre a la regla.");
  const acciones = r.actions.filter((a) => a.type !== "stop");
  if (acciones.length === 0) p.push("Añade al menos una cosa que hacer.");
  if (!esDeMensaje(r.trigger)) {
    // Con la línea conectándose o cayéndose no hay mensaje, ni chat, ni
    // conversación: «responder» no tendría a quién, y fallaría al disparar.
    if (r.conditions.some((c) => campoDe(c.field)?.deMensaje)) {
      p.push("Con la línea conectándose o desconectándose solo valen condiciones de hora y día.");
    }
    if (r.actions.some((a) => a.type !== "stop" && ACCIONES.find((x) => x.tipo === a.type)?.deMensaje)) {
      p.push("Cuando cambia la línea no hay chat al que contestar: lo único que se puede hacer es avisar a una dirección web.");
    }
  }
  if (r.trigger !== "call.received" && r.actions.some((a) => a.type === "reject_call")) {
    p.push("Solo se puede colgar cuando lo que dispara la regla es una llamada.");
  }
  if (r.trigger === "call.received" && r.conditions.some((c) => c.field === "text")) {
    p.push("Una llamada no trae texto: la condición sobre el texto no se cumpliría nunca.");
  }
  const usaListas = r.conditions.some((c) => c.field === "labels" && c.op !== "is_empty")
    || r.actions.some((a) => a.type === "add_label" || a.type === "remove_label");
  if (usaListas && !r.lineId) {
    p.push("Las listas son de una línea: elige en qué línea actúa la regla para usarlas.");
  }
  for (const c of r.conditions) {
    const op = operadorDe(c.field, c.op);
    if (op?.valor === "texto" && !String(c.value ?? "").trim()) {
      p.push(`Completa la condición «${campoDe(c.field)?.texto} ${op.texto}».`);
    }
    if (op?.valor === "lista" && !c.value) p.push("Elige la lista de la condición.");
    if (op?.valor === "miembro" && !c.value) p.push("Elige quién es el responsable en la condición.");
    if (op?.valor === "dias" && (!Array.isArray(c.value) || c.value.length === 0)) {
      p.push("Marca al menos un día.");
    }
    if (c.op === "matches") {
      try { new RegExp(String(c.value ?? "")); } catch { p.push("La expresión regular no es válida."); }
    }
  }
  for (const a of acciones) {
    if (a.type === "send_message" && !a.text.trim()) p.push("Escribe el texto de la respuesta.");
    if ((a.type === "add_label" || a.type === "remove_label") && !a.labelId) p.push("Elige la lista.");
    if (a.type === "webhook" && !/^https?:\/\/\S+$/.test(a.url)) p.push("La dirección del webhook tiene que empezar por https://.");
  }
  return [...new Set(p)];
}
