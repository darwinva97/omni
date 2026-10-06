/*
 * Reinterpreta los mensajes que se guardaron como ilegibles.
 *
 * El `raw` se guardó tal cual vino, así que el clasificador nuevo puede
 * volver a leerlo: lo que era una plantilla pasa a ser una plantilla con su
 * texto, y lo que no llevaba nada se va. Nada se adivina: todo sale del nodo
 * original.
 */
import { createDatabase } from "@omni/db";
import { messageKind, extractText, esVacio } from "@omni/channels";

const { sql, close } = createDatabase(process.argv[2]!);
const filas = await sql`
  SELECT id, timestamp, kind, body, raw FROM message
  WHERE kind IN ('unknown', 'system', 'reaction')`;

let vaciados = 0, reclasificados = 0, reacciones = 0, retirados = 0, protocolos = 0;
for (const f of filas) {
  const envelope = (f.raw as { raw?: unknown })?.raw;
  if (f.kind === "reaction") {
    await sql`DELETE FROM message WHERE id = ${f.id} AND timestamp = ${f.timestamp}`;
    reacciones++;
    continue;
  }
  if (!envelope) continue;

  /*
   * Un `protocolMessage` es una orden, no un mensaje. La única que cambia lo
   * que se lee es REVOKE: se aplica sobre su objetivo —que puede llevar
   * semanas enseñándose como si no lo hubieran retirado— y la orden se va.
   */
  if (f.kind === "system") {
    const proto = (envelope as { message?: { protocolMessage?: Proto } })
      .message?.protocolMessage;
    if (proto && (proto.type === 0 || proto.type === "REVOKE") && proto.key?.id) {
      const hechos = await sql`
        UPDATE message SET deleted_at = ${f.timestamp}
        WHERE provider_message_id = ${proto.key.id} AND deleted_at IS NULL
        RETURNING id`;
      retirados += hechos.length;
    }
    await sql`DELETE FROM message WHERE id = ${f.id} AND timestamp = ${f.timestamp}`;
    protocolos++;
    continue;
  }

  const m = envelope as never;
  if (esVacio(m)) {
    await sql`DELETE FROM message WHERE id = ${f.id} AND timestamp = ${f.timestamp}`;
    vaciados++;
    continue;
  }
  const kind = messageKind(m);
  const body = extractText((m as { message?: object }).message ?? null);
  if (kind === f.kind && body === f.body) continue;
  await sql`
    UPDATE message SET kind = ${kind}, body = ${body}
    WHERE id = ${f.id} AND timestamp = ${f.timestamp}`;
  reclasificados++;
}
type Proto = { key?: { id?: string }; type?: number | string };

console.log({
  reacciones, protocolos, retirados, vaciados, reclasificados, revisados: filas.length,
});
await close();
