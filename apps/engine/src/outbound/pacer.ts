import type { Kv } from "@omni/platform";

/**
 * Marcapasos de envío por línea.
 *
 * Es la defensa concreta contra el baneo. WhatsApp no castiga tanto el volumen
 * total como la RÁFAGA: mil mensajes repartidos en un día son normales, los
 * mismos mil en un minuto son una señal inequívoca de automatización.
 *
 * Funciona porque la cola ya garantiza que los envíos de una línea van en serie
 * por partición: basta con esperar entre uno y el siguiente.
 */
export class SendPacer {
  readonly #kv: Kv;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    kv: Kv,
    opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.#kv = kv;
    this.#now = opts.now ?? (() => Date.now());
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Espera lo necesario para no superar `ratePerMinute` en esta línea. */
  async pace(lineId: string, ratePerMinute: number): Promise<number> {
    if (ratePerMinute <= 0) return 0;
    const minIntervalMs = Math.ceil(60_000 / ratePerMinute);
    const key = `pace:${lineId}`;
    const now = this.#now();

    const last = Number((await this.#kv.get(key)) ?? 0);
    const waitMs = Math.max(0, last + minIntervalMs - now);
    if (waitMs > 0) await this.#sleep(waitMs);

    // Se apunta el instante del envío REAL, no el de la comprobación.
    await this.#kv.set(key, String(now + waitMs), 3600);
    return waitMs;
  }
}
