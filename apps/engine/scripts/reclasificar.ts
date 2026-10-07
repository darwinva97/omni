/*
 * Reinterpreta los mensajes que se guardaron como ilegibles.
 *
 * El `raw` se guardó tal cual vino, así que el clasificador nuevo puede
 * volver a leerlo: lo que era una plantilla pasa a ser una plantilla con su
 * texto, y lo que no llevaba nada se va. Nada se adivina: todo sale del nodo
 * original.
 */
import { createDatabase } from "@omni/db";
import { messageKind, extractText, esVacio, extractReply } from "@omni/channels";

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
/*
 * Segunda pasada: a qué respondía cada mensaje.
 *
 * La cita siempre estuvo en el nodo original —WhatsApp la manda dentro del
 * mensaje que responde— y no la leía nadie. Se recupera de ahí, junto con la
 * copia del citado, que es lo que permite enseñar la cita de algo que no está
 * en esta base.
 */
const sinCita = await sql`
  SELECT id, timestamp, raw FROM message WHERE reply_to_id IS NULL AND raw IS NOT NULL`;

let citas = 0;
for (const f of sinCita) {
  const envelope = (f.raw as { raw?: unknown })?.raw;
  if (!envelope) continue;
  const cita = extractReply(envelope as never);
  if (!cita) continue;
  await sql`
    UPDATE message
    SET reply_to_id = ${cita.id},
        raw = jsonb_set(raw, '{replyTo}', ${JSON.stringify(cita)}::jsonb, true)
    WHERE id = ${f.id} AND timestamp = ${f.timestamp}`;
  citas++;
}

type Proto = { key?: { id?: string }; type?: number | string };

console.log({
  reacciones, protocolos, retirados, vaciados, reclasificados,
  revisados: filas.length,
  citas, revisadosParaCita: sinCita.length,
});
await close();
