import { z } from "zod";

/**
 * Reglas de automatización: disparador → condiciones → acciones.
 *
 * El modelo es el de Evo CRM, con sus tres garantías declaradas por escrito
 * porque son justo lo que suele faltar:
 *
 * 1. **Deduplicación** en una ventana corta por `(regla, objetivo, disparo)`.
 *    Dos eventos casi idénticos —un `message.received` y su `message.upsert`—
 *    no pueden producir dos respuestas automáticas al mismo mensaje.
 * 2. **Prevención de bucles.** Una acción que genera un evento no puede
 *    disparar la cadena otra vez: una regla que responde a los mensajes
 *    respondería a su propia respuesta, para siempre.
 * 3. **Fallos visibles.** Cada disparo se registra con su resultado. Una regla
 *    rota que falla en silencio es peor que una regla apagada.
 */

export const triggers = [
  "message.received",
  "message.sent",
  "conversation.opened",
  "conversation.status",
  "conversation.assigned",
  "label.added",
  "line.connected",
  "line.disconnected",
  // Solo cuando EMPIEZA a sonar, una vez por llamada; no con cada cambio de estado.
  "call.received",
] as const;
export const Trigger = z.enum(triggers);
export type Trigger = z.infer<typeof Trigger>;

/** Un campo del contexto sobre el que se puede condicionar. */
export const conditionFields = [
  "text", "from", "chat", "chatKind", "labels", "status", "priority",
  "assignee", "lineId", "hour", "weekday",
] as const;
export const ConditionField = z.enum(conditionFields);
export type ConditionField = z.infer<typeof ConditionField>;

export const operators = [
  "equals", "not_equals", "contains", "not_contains",
  "starts_with", "ends_with", "matches",
  "in", "not_in", "gte", "lte", "is_empty", "is_not_empty",
] as const;
export const Operator = z.enum(operators);
export type Operator = z.infer<typeof Operator>;

export const Condition = z.object({
  field: ConditionField,
  op: Operator,
  /** Ausente para `is_empty` y `is_not_empty`. */
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  /** Por defecto las comparaciones de texto NO distinguen mayúsculas. */
  caseSensitive: z.boolean().default(false),
  /**
   * Zona horaria para `hour` y `weekday`, como «America/Lima».
   *
   * Sin ella valen la hora y el día del SERVIDOR, que puede estar en otro
   * continente: «de 9 a 18» escrito desde Lima se cumplía en horario de
   * Berlín. El panel pone la de quien escribe la regla.
   */
  timeZone: z.string().min(1).max(64).optional(),
});
export type Condition = z.infer<typeof Condition>;

export const Action = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send_message"),
    text: z.string().min(1).max(4096),
    /** Responde al mensaje que disparó la regla, cuando lo hay. */
    asReply: z.boolean().default(false),
  }),
  z.object({ type: z.literal("add_label"), labelId: z.string().min(1) }),
  z.object({ type: z.literal("remove_label"), labelId: z.string().min(1) }),
  z.object({ type: z.literal("assign"), userId: z.string().min(1).nullable() }),
  z.object({
    type: z.literal("set_status"),
    status: z.enum(["open", "pending", "snoozed", "resolved"]),
  }),
  z.object({
    type: z.literal("set_priority"),
    priority: z.enum(["low", "normal", "high", "urgent"]),
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().url(),
    /** Se manda el contexto entero; sin cuerpo propio no hay que inventar formato. */
    headers: z.record(z.string(), z.string()).optional(),
  }),
  /**
   * Cuelga la llamada que disparó la regla. Solo tiene sentido con
   * `call.received`; con otro disparo falla, y el fallo queda registrado.
   */
  z.object({ type: z.literal("reject_call") }),
  /** Corta la cadena: las reglas de menor prioridad ya no se evalúan. */
  z.object({ type: z.literal("stop") }),
]);
export type Action = z.infer<typeof Action>;

export const RuleInput = z.object({
  name: z.string().min(1).max(120),
  trigger: Trigger,
  conditions: z.array(Condition).max(20).default([]),
  actions: z.array(Action).min(1).max(20),
  priority: z.number().int().min(0).max(1000).default(100),
  lineId: z.string().optional(),
});
export type RuleInput = z.infer<typeof RuleInput>;

/**
 * Cambios sobre una regla ya creada.
 *
 * Se declara APARTE y sin valores por defecto, en vez de `RuleInput.partial()`.
 * `.partial()` hace opcionales las claves pero NO quita los `.default(...)`:
 * una petición que solo enciende la regla llegaría al manejador con
 * `conditions: []` y `priority: 100` como si el cliente los hubiera mandado, y
 * encender una regla le borraría las condiciones. Un PATCH que destruye lo que
 * no menciona es el peor fallo posible en una ruta de edición.
 */
export const RulePatch = z.object({
  name: z.string().min(1).max(120).optional(),
  trigger: Trigger.optional(),
  conditions: z.array(Condition).max(20).optional(),
  actions: z.array(Action).min(1).max(20).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  lineId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});
export type RulePatch = z.infer<typeof RulePatch>;

export interface Rule {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly trigger: Trigger;
  readonly conditions: readonly Condition[];
  readonly actions: readonly Action[];
  readonly priority: number;
  readonly lineId: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

/** Lo que se sabe cuando una regla se evalúa. */
export interface RuleContext {
  readonly event: Trigger;
  readonly orgId: string;
  readonly lineId: string;
  /** El chat, la conversación o la línea, según el disparo. */
  readonly target: string;
  readonly text?: string | null;
  readonly from?: string | null;
  readonly chat?: string | null;
  readonly chatKind?: "individual" | "group" | "other";
  readonly labels?: readonly string[];
  readonly status?: string | null;
  readonly priority?: string | null;
  readonly assignee?: string | null;
  /** Momento del evento; decide `hour` y `weekday`. Inyectable para las pruebas. */
  readonly at: Date;
  /** Identificador del mensaje que lo originó, para poder responderle. */
  readonly messageId?: string | null;
  /** La llamada que lo originó, cuando el disparo es `call.received`. */
  readonly call?: { readonly id: string; readonly from: string; readonly isVideo: boolean } | null;
  /**
   * Cuántas veces ha rebotado ya esta cadena.
   *
   * Es lo que impide el bucle: una acción que produce un evento lo marca con
   * profundidad +1, y pasado el límite deja de disparar reglas.
   */
  readonly depth: number;
}
