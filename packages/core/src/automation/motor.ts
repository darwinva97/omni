import type { Action, Rule, RuleContext } from "@omni/shared";
import { evaluarRegla, ordenarReglas } from "./evaluar.js";

/**
 * Motor de automatizaciones.
 *
 * Evalúa las reglas de un evento y ejecuta las que saltan, en orden. No sabe
 * de base de datos ni de HTTP: todo lo que hace hacia fuera pasa por `Efectos`,
 * lo que permite probar el comportamiento entero —incluidos el corte por bucle
 * y la deduplicación— sin levantar nada.
 */

export interface Efectos {
  enviarMensaje(ctx: RuleContext, texto: string, responderA: string | null): Promise<void>;
  ponerEtiqueta(ctx: RuleContext, labelId: string): Promise<void>;
  quitarEtiqueta(ctx: RuleContext, labelId: string): Promise<void>;
  asignar(ctx: RuleContext, userId: string | null): Promise<void>;
  cambiarEstado(ctx: RuleContext, estado: string): Promise<void>;
  cambiarPrioridad(ctx: RuleContext, prioridad: string): Promise<void>;
  llamarWebhook(ctx: RuleContext, url: string, headers: Record<string, string>): Promise<void>;
  /** Deja constancia del disparo. Un fallo silencioso es el modo de fallo a evitar. */
  registrar(run: RegistroDeDisparo): Promise<void>;
}

export interface RegistroDeDisparo {
  readonly rule: Rule;
  readonly ctx: RuleContext;
  readonly outcome: "matched" | "skipped" | "failed";
  readonly reason?: string;
  readonly actionsRun: readonly string[];
  readonly durationMs: number;
}

export interface MotorOptions {
  readonly efectos: Efectos;
  /**
   * Profundidad máxima de la cadena.
   *
   * Una regla que responde a los mensajes respondería a su propia respuesta:
   * el evento de salida vuelve a entrar. Por defecto es CERO, es decir, lo que
   * envía una automatización no dispara más automatizaciones. Encadenarlas es
   * legítimo, pero tiene que pedirse a propósito y con un límite.
   */
  readonly maxDepth?: number;
  /** Ventana de deduplicación en milisegundos. */
  readonly dedupeMs?: number;
  /** Reloj, inyectable para poder probar la ventana sin esperar. */
  readonly now?: () => number;
}

export interface Resultado {
  readonly disparadas: string[];
  readonly saltadas: number;
  readonly fallidas: string[];
  readonly cortada: boolean;
}

export class MotorDeAutomatizacion {
  readonly #efectos: Efectos;
  readonly #maxDepth: number;
  readonly #dedupeMs: number;
  readonly #now: () => number;
  /** `(regla, objetivo, disparo)` → cuándo se ejecutó por última vez. */
  readonly #vistos = new Map<string, number>();

  constructor(opts: MotorOptions) {
    this.#efectos = opts.efectos;
    this.#maxDepth = opts.maxDepth ?? 0;
    this.#dedupeMs = opts.dedupeMs ?? 5000;
    this.#now = opts.now ?? Date.now;
  }

  async ejecutar(reglas: readonly Rule[], ctx: RuleContext): Promise<Resultado> {
    const disparadas: string[] = [];
    const fallidas: string[] = [];
    let saltadas = 0;

    /*
     * Corte por profundidad, ANTES de evaluar nada.
     *
     * No es una optimización: es lo que evita el bucle. Sin esto, una regla
     * que responde a los mensajes entrantes ve su propia respuesta como un
     * evento nuevo y contesta otra vez, sin fin.
     */
    if (ctx.depth > this.#maxDepth) {
      return { disparadas, saltadas, fallidas, cortada: true };
    }

    for (const regla of ordenarReglas(reglas)) {
      const inicio = this.#now();
      const veredicto = evaluarRegla(regla, ctx);

      if (!veredicto.ok) {
        saltadas++;
        continue;
      }

      /*
       * Deduplicación por `(regla, objetivo, disparo)`.
       *
       * Un mismo mensaje produce varios eventos —`message.received` y
       * `message.upsert`— y sin esto la respuesta automática saldría dos veces
       * al mismo mensaje, que es el fallo que ve el cliente final.
       */
      const clave = `${regla.id}|${ctx.target}|${ctx.event}|${ctx.messageId ?? ""}`;
      const ultima = this.#vistos.get(clave);
      const ahora = this.#now();
      if (ultima !== undefined && ahora - ultima < this.#dedupeMs) {
        saltadas++;
        await this.#efectos.registrar({
          rule: regla, ctx, outcome: "skipped",
          reason: "repetida dentro de la ventana de deduplicación",
          actionsRun: [], durationMs: 0,
        }).catch(() => {});
        continue;
      }
      this.#vistos.set(clave, ahora);
      this.#limpiar(ahora);

      const hechas: string[] = [];
      const fallos: string[] = [];
      let corta = false;

      for (const accion of regla.actions) {
        if (accion.type === "stop") { corta = true; break; }
        try {
          await this.#hacer(accion, ctx);
          hechas.push(accion.type);
        } catch (err) {
          /*
           * Una acción que falla NO para las demás de la misma regla, pero SÍ
           * se registra, y se registran TODAS: quedarse con la última escondería
           * las anteriores y la explicación del panel señalaría a la acción
           * equivocada.
           */
          fallos.push(`${accion.type}: ${(err as Error).message}`);
        }
      }

      await this.#efectos.registrar({
        rule: regla, ctx,
        outcome: fallos.length > 0 ? "failed" : "matched",
        ...(fallos.length > 0 ? { reason: fallos.join(" | ") } : {}),
        actionsRun: hechas,
        durationMs: this.#now() - inicio,
      }).catch(() => {});

      if (fallos.length > 0) fallidas.push(regla.id);
      else disparadas.push(regla.id);

      if (corta) return { disparadas, saltadas, fallidas, cortada: true };
    }
    return { disparadas, saltadas, fallidas, cortada: false };
  }

  async #hacer(accion: Action, ctx: RuleContext): Promise<void> {
    switch (accion.type) {
      case "send_message":
        return this.#efectos.enviarMensaje(
          ctx, accion.text, accion.asReply ? (ctx.messageId ?? null) : null,
        );
      case "add_label": return this.#efectos.ponerEtiqueta(ctx, accion.labelId);
      case "remove_label": return this.#efectos.quitarEtiqueta(ctx, accion.labelId);
      case "assign": return this.#efectos.asignar(ctx, accion.userId);
      case "set_status": return this.#efectos.cambiarEstado(ctx, accion.status);
      case "set_priority": return this.#efectos.cambiarPrioridad(ctx, accion.priority);
      case "webhook": return this.#efectos.llamarWebhook(ctx, accion.url, accion.headers ?? {});
      case "stop": return;
    }
  }

  /** La memoria de deduplicación no puede crecer sin fin en un proceso largo. */
  #limpiar(ahora: number): void {
    if (this.#vistos.size < 5000) return;
    for (const [k, t] of this.#vistos) {
      if (ahora - t > this.#dedupeMs) this.#vistos.delete(k);
    }
  }
}
