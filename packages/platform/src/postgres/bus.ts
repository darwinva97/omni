import type { Sql } from "postgres";
import type { Bus } from "../ports/bus.port.js";

/**
 * Bus sobre `LISTEN`/`NOTIFY` de Postgres. Abanica eventos entre procesos sin
 * Redis, que es lo que hace viable el perfil de coste cero.
 *
 * Límite real de `NOTIFY`: la carga útil no puede pasar de 8000 bytes. En vez
 * de fallar con un error críptico de Postgres, lo decimos aquí.
 */
/**
 * Un evento sin lo que no cabe en `NOTIFY`: sin `data.raw` (el mensaje original del canal) y,
 * si aún no cabe, con los textos largos recortados y sin los objetos anidados grandes. Lo marca
 * con `data.recortado`. Lo que no es un sobre con `data`, tal cual.
 */
export function aligerar<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return payload;
  const sobre = payload as T & { data: unknown };
  if (!sobre.data || typeof sobre.data !== "object" || Array.isArray(sobre.data)) return payload;
  const { raw: _raw, ...data } = sobre.data as Record<string, unknown>;
  let ligero = { ...sobre, data } as T;
  if (Buffer.byteLength(JSON.stringify(ligero), "utf8") <= PostgresBus.MAX_PAYLOAD_BYTES) return ligero;
  const recorte: Record<string, unknown> = { recortado: true };
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string") recorte[k] = v.length > 1000 ? v.slice(0, 1000) + "…" : v;
    else if (v === null || typeof v !== "object") recorte[k] = v;
    else if (JSON.stringify(v).length <= 500) recorte[k] = v;
  }
  ligero = { ...sobre, data: recorte } as T;
  return ligero;
}

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
    let body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > PostgresBus.MAX_PAYLOAD_BYTES) {
      // Un mensaje de WhatsApp con foto, vídeo o vista previa de enlace pasaba del límite por el
      // mensaje original (`raw`, con miniaturas) y el aviso se PERDÍA: no llegaba al panel. Se
      // publica aligerado; quien necesite el cuerpo entero lo lee de la base.
      body = JSON.stringify(aligerar(payload));
    }
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
      /*
       * Ni una carga corrupta ni un manejador que falle pueden tumbar la
       * suscripción. El `try` de antes no veía el rechazo de un manejador
       * asíncrono, y un rechazo sin nadie que lo espere tumba el proceso.
       */
      void Promise.resolve()
        .then(() => handler(JSON.parse(raw) as T))
        .catch(() => {});
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
