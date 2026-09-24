import type { Sql } from "postgres";
import type { Bus } from "../ports/bus.port.js";

/**
 * Bus sobre `LISTEN`/`NOTIFY` de Postgres. Abanica eventos entre procesos sin
 * Redis, que es lo que hace viable el perfil de coste cero.
 *
 * Límite real de `NOTIFY`: la carga útil no puede pasar de 8000 bytes. En vez
 * de fallar con un error críptico de Postgres, lo decimos aquí.
 */
export class PostgresBus implements Bus {
  static readonly MAX_PAYLOAD_BYTES = 7900;
  readonly #sql: Sql;
  readonly #unlisten = new Set<() => Promise<void>>();

  constructor(sql: Sql) { this.#sql = sql; }

  #channel(topic: string): string {
    // Los identificadores de canal de Postgres no admiten cualquier carácter.
    return `omni_${topic.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

  async publish<T>(topic: string, payload: T): Promise<void> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > PostgresBus.MAX_PAYLOAD_BYTES) {
      throw new Error(
        `la carga de "${topic}" supera el límite de NOTIFY (${PostgresBus.MAX_PAYLOAD_BYTES} bytes); ` +
          "publica una referencia y guarda el cuerpo en la base de datos",
      );
    }
    await this.#sql.notify(this.#channel(topic), body);
  }

  async subscribe<T>(topic: string, handler: (p: T) => void | Promise<void>): Promise<() => Promise<void>> {
    const listener = await this.#sql.listen(this.#channel(topic), (raw) => {
      try {
        void handler(JSON.parse(raw) as T);
      } catch {
        /* una carga corrupta no puede tumbar la suscripción */
      }
    });
    const off = async (): Promise<void> => { await listener.unlisten(); };
    this.#unlisten.add(off);
    return async () => {
      this.#unlisten.delete(off);
      await off();
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.#unlisten].map((off) => off().catch(() => {})));
    this.#unlisten.clear();
  }
}
