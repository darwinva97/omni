import { and, eq, inArray } from "drizzle-orm";
import { MotorDeAutomatizacion, type Efectos, type RegistroDeDisparo } from "@omni/core";
import { parseAddress, type EventEnvelope, type Rule, type RuleContext, type Trigger } from "@omni/shared";
import {
  automationRuleTable, automationRunTable, conversationTable,
  labelAssignmentTable, messageTable, type Database,
} from "@omni/db";
import type { Kv } from "@omni/platform";
import type { EngineRuntime } from "@omni/engine";
import type { Conversaciones } from "./conversaciones.js";

/**
 * El puente entre los eventos que salen de la ingesta y el motor de reglas.
 *
 * Aquí viven las decisiones de "cómo se traduce un evento a un contexto" y
 * "qué hace de verdad cada acción"; el motor solo sabe de reglas.
 */

/** Qué eventos del sistema corresponden a qué disparador. */
const DISPAROS: Partial<Record<string, Trigger>> = {
  "message.received": "message.received",
  "message.sent": "message.sent",
  "session.connected": "line.connected",
  "session.disconnected": "line.disconnected",
  // `message.upsert` NO está: acompaña a los dos anteriores y dispararía una
  // segunda vez el mismo hecho. La deduplicación lo atraparía, pero no hay que
  // apoyarse en una red de seguridad para algo que se puede no hacer.
};

export interface AutomatizacionesDeps {
  readonly db: Database;
  readonly runtime: EngineRuntime;
  readonly conversaciones: Conversaciones;
  /** Guarda la profundidad de lo que envía una regla, para cortar el bucle. */
  readonly kv: Kv;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Cuánto vive la marca de profundidad.
 *
 * Solo tiene que cubrir el viaje de ida y vuelta de un mensaje: se envía, sale
 * de verdad y el evento de salida vuelve. Son segundos. Guardarla más tiempo
 * no aporta nada y llena el KV.
 */
const MARCA_SEGUNDOS = 300;

export class Automatizaciones {
  readonly #deps: AutomatizacionesDeps;
  readonly #motor: MotorDeAutomatizacion;

  constructor(deps: AutomatizacionesDeps) {
    this.#deps = deps;
    this.#motor = new MotorDeAutomatizacion({ efectos: this.#efectos() });
  }

  /** Traduce un evento del sistema y ejecuta lo que corresponda. */
  async despachar(envelope: EventEnvelope): Promise<void> {
    const disparo = DISPAROS[envelope.event];
    if (!disparo) return;

    const reglas = await this.#reglasDe(envelope.orgId, disparo, envelope.lineId);
    if (reglas.length === 0) return;

    const ctx = await this.#contexto(disparo, envelope);
    if (!ctx) return;
    await this.#motor.ejecutar(reglas, ctx);
  }

  async #reglasDe(orgId: string, trigger: Trigger, lineId: string): Promise<Rule[]> {
    const filas = await this.#deps.db.select().from(automationRuleTable)
      .where(and(
        eq(automationRuleTable.orgId, orgId),
        eq(automationRuleTable.trigger, trigger),
        eq(automationRuleTable.enabled, true),
      ));
    return filas
      .filter((f) => f.lineId === null || f.lineId === lineId)
      .map((f) => ({
        id: f.id, orgId: f.orgId, name: f.name,
        trigger: f.trigger as Trigger,
        conditions: f.conditions as Rule["conditions"],
        actions: f.actions as Rule["actions"],
        priority: f.priority, lineId: f.lineId, enabled: f.enabled,
        createdAt: f.createdAt,
      }));
  }

  async #contexto(event: Trigger, e: EventEnvelope): Promise<RuleContext | null> {
    const data = e.data as {
      key?: { id?: string; remoteJid?: string; fromMe?: boolean };
      text?: string | null; from?: string | null; isGroup?: boolean;
      /** Lo pone el driver cuando el envío salió de aquí. */
      clientMessageId?: string;
    };

    if (event === "line.connected" || event === "line.disconnected") {
      return {
        event, orgId: e.orgId, lineId: e.lineId, target: e.lineId,
        at: new Date(e.timestamp), depth: 0,
      };
    }

    const chat = data.key?.remoteJid;
    if (!chat) return null;
    const direccion = parseAddress(chat);

    const conv = await this.#deps.conversaciones.viva(e.lineId, direccion.value);
    const etiquetas = await this.#etiquetasDe(e.lineId, direccion.value);

    return {
      event, orgId: e.orgId, lineId: e.lineId,
      target: direccion.value,
      text: data.text ?? null,
      from: data.from ?? (data.key?.fromMe ? null : direccion.value),
      chat: direccion.value,
      chatKind: direccion.kind === "group" ? "group" : direccion.kind === "pn" || direccion.kind === "lid" ? "individual" : "other",
      labels: etiquetas,
      status: conv?.status ?? null,
      priority: conv?.priority ?? null,
      assignee: conv?.assigneeId ?? null,
      at: new Date(e.timestamp),
      messageId: data.key?.id ?? null,
      /*
       * Profundidad heredada del mensaje que la originó.
       *
       * Cuando una regla envía algo, deja una marca con la profundidad. Al
       * volver el evento de salida se busca esa marca: si está, esta vuelta es
       * una más de la misma cadena, y el motor la corta antes de que una regla
       * conteste a su propia respuesta. Va por el KV y no por memoria porque
       * el envío puede salir por un nodo y el evento entrar por otro.
       */
      depth: await this.#profundidadDe(e.lineId, data.clientMessageId ?? null, data.key?.id ?? null),
    };
  }

  /**
   * Busca la marca que dejó la regla que originó este mensaje, si la hubo.
   *
   * El camino bueno es el identificador del cliente que trae el propio evento.
   * Cuando el transporte no puede darlo —whatsapp-web.js ve su propio mensaje
   * rebotado por el cliente web, sin saber de dónde salió— se cae al camino
   * lento por la fila del mensaje, que puede llegar tarde: en ese caso el
   * corte del bucle depende de la deduplicación, que es más débil pero existe.
   */
  async #profundidadDe(
    lineId: string, clientMessageId: string | null, providerMessageId: string | null,
  ): Promise<number> {
    let cliente = clientMessageId;
    if (!cliente && providerMessageId) {
      const filas = await this.#deps.db
        .select({ clientMessageId: messageTable.clientMessageId })
        .from(messageTable)
        .where(and(
          eq(messageTable.lineId, lineId),
          eq(messageTable.providerMessageId, providerMessageId),
        ))
        .limit(1);
      cliente = filas[0]?.clientMessageId ?? null;
    }
    if (!cliente) return 0;
    const marca = await this.#deps.kv.get(`auto:depth:${lineId}:${cliente}`);
    return marca ? Number(marca) : 0;
  }

  async #etiquetasDe(lineId: string, target: string): Promise<string[]> {
    const filas = await this.#deps.db
      .select({ labelId: labelAssignmentTable.labelId })
      .from(labelAssignmentTable)
      .where(and(
        eq(labelAssignmentTable.lineId, lineId),
        eq(labelAssignmentTable.target, target),
      ));
    return filas.map((f) => f.labelId);
  }

  #efectos(): Efectos {
    const { db, runtime, conversaciones, kv } = this.#deps;
    const fetchImpl = this.#deps.fetchImpl ?? fetch;

    const conversacionDe = async (ctx: RuleContext): Promise<string | null> => {
      const c = await conversaciones.viva(ctx.lineId, ctx.target);
      return c?.id ?? null;
    };

    return {
      enviarMensaje: async (ctx, texto, responderA) => {
        const clientMessageId = `auto-${crypto.randomUUID()}`;
        /*
         * La marca se pone ANTES de enviar.
         *
         * Al revés habría una ventana en la que el mensaje ya ha salido, su
         * evento ha vuelto y la marca todavía no está: justo la vuelta que
         * había que cortar se colaría.
         */
        await kv.set(`auto:depth:${ctx.lineId}:${clientMessageId}`, String(ctx.depth + 1), MARCA_SEGUNDOS);
        await runtime.send(ctx.lineId, {
          to: ctx.target, text: texto,
          ...(responderA ? { replyTo: responderA } : {}),
          clientMessageId,
        });
      },

      ponerEtiqueta: async (ctx, labelId) => {
        await db.insert(labelAssignmentTable).values({
          labelId, lineId: ctx.lineId, target: ctx.target, targetKind: "chat",
        }).onConflictDoNothing();
      },

      quitarEtiqueta: async (ctx, labelId) => {
        await db.delete(labelAssignmentTable).where(and(
          eq(labelAssignmentTable.labelId, labelId),
          eq(labelAssignmentTable.lineId, ctx.lineId),
          eq(labelAssignmentTable.target, ctx.target),
        ));
      },

      asignar: async (ctx, userId) => {
        const id = await conversacionDe(ctx);
        if (!id) return;
        await db.update(conversationTable)
          .set({ assigneeId: userId, updatedAt: new Date() })
          .where(eq(conversationTable.id, id));
      },

      cambiarEstado: async (ctx, estado) => {
        const id = await conversacionDe(ctx);
        if (!id) return;
        await db.update(conversationTable)
          .set({
            status: estado as "open",
            ...(estado === "resolved" ? { resolvedAt: new Date() } : { resolvedAt: null }),
            updatedAt: new Date(),
          })
          .where(eq(conversationTable.id, id));
      },

      cambiarPrioridad: async (ctx, prioridad) => {
        const id = await conversacionDe(ctx);
        if (!id) return;
        await db.update(conversationTable)
          .set({ priority: prioridad as "normal", updatedAt: new Date() })
          .where(eq(conversationTable.id, id));
      },

      llamarWebhook: async (ctx, url, headers) => {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ event: ctx.event, lineId: ctx.lineId, target: ctx.target, text: ctx.text }),
        });
        // Un webhook que responde mal es un FALLO, no un aviso: si se tragara,
        // la regla parecería funcionar mientras el otro extremo no recibe nada.
        if (!res.ok) throw new Error(`el webhook respondió ${res.status}`);
      },

      registrar: async (run: RegistroDeDisparo) => {
        await db.insert(automationRunTable).values({
          id: `run-${crypto.randomUUID()}`,
          orgId: run.rule.orgId, ruleId: run.rule.id,
          lineId: run.ctx.lineId, target: run.ctx.target,
          event: run.ctx.event, outcome: run.outcome,
          reason: run.reason ?? null,
          actionsRun: [...run.actionsRun],
          durationMs: run.durationMs,
        });
      },
    };
  }

  /** Borra los registros viejos: la tabla crece con cada mensaje. */
  async podar(orgId: string, dejarUltimos: number): Promise<number> {
    const ids = await this.#deps.db
      .select({ id: automationRunTable.id })
      .from(automationRunTable)
      .where(eq(automationRunTable.orgId, orgId))
      .orderBy(automationRunTable.createdAt)
      .limit(100000);
    const sobran = ids.slice(0, Math.max(0, ids.length - dejarUltimos)).map((r) => r.id);
    if (sobran.length === 0) return 0;
    await this.#deps.db.delete(automationRunTable).where(inArray(automationRunTable.id, sobran));
    return sobran.length;
  }
}
