import { lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { messageTable, webhookDeliveryTable } from "./schema/index.js";

/**
 * Mantenimiento periódico.
 *
 * Son tareas que no puede hacer nadie a demanda: si no las corre un proceso
 * dedicado, la tabla de mensajes se queda sin particiones futuras un día 1 a
 * las 00:00 y todas las inserciones fallan a la vez.
 */

export interface MaintenanceResult {
  readonly particiones: number;
  readonly entregasPurgadas: number;
  readonly mediosCaducados: number;
}

export interface MaintenanceOptions {
  /** Meses de particiones por delante que deben existir siempre. */
  readonly mesesPorDelante?: number;
  /** Días que se guarda el registro de intentos de entrega. */
  readonly diasDeEntregas?: number;
  readonly now?: () => number;
}

export async function runMaintenance(
  db: Database,
  opts: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const ahora = opts.now?.() ?? Date.now();

  // 1 ── particiones futuras. Se pide una ventana amplia a propósito: quedarse
  // sin partición es un fallo total de escritura, y crearlas de más no cuesta.
  const porDelante = opts.mesesPorDelante ?? 3;
  await db.execute(sql`SELECT omni_ensure_message_partitions(1, ${porDelante})`);
  const particiones = await contarParticiones(db);

  // 2 ── el registro de entregas crece sin límite y sólo sirve para depurar.
  const dias = opts.diasDeEntregas ?? 30;
  const corte = new Date(ahora - dias * 24 * 3600 * 1000);
  const purgadas = await db
    .delete(webhookDeliveryTable)
    .where(lt(webhookDeliveryTable.createdAt, corte))
    .returning({ id: webhookDeliveryTable.id });

  // 3 ── medios cuya retención expiró. Se desreferencian aquí; el binario lo
  // borra el barrido de almacenamiento, que sabe de claves y no de SQL.
  const caducados = await db
    .update(messageTable)
    .set({ mediaKey: null, mediaMime: null, mediaSize: null, mediaFileName: null })
    .where(lt(messageTable.mediaRetainUntil, new Date(ahora)))
    .returning({ id: messageTable.id });

  return {
    particiones,
    entregasPurgadas: purgadas.length,
    mediosCaducados: caducados.length,
  };
}

async function contarParticiones(db: Database): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'message'`);
  const filas = res as unknown as { n: string }[];
  return Number(filas[0]?.n ?? 0);
}
