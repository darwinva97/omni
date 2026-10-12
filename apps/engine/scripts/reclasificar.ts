/*
 * Reinterpreta los mensajes que se guardaron como ilegibles.
 *
 * El `raw` se guardó tal cual vino, así que el clasificador nuevo puede
 * volver a leerlo: lo que era una plantilla pasa a ser una plantilla con su
 * texto, y lo que no llevaba nada se va. Nada se adivina: todo sale del nodo
 * original.
 */
import { createDatabase } from "@omni/db";
import {
  messageKind, extractText, esVacio, extractReply, extractPollVote, encuestaDe,
  descifrarVoto, extractMentions,
} from "@omni/channels";

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

/*
 * Tercera pasada: las encuestas y sus votos.
 *
 * Un voto no es un mensaje, pero se guardó como uno: en un grupo real son 143
 * burbujas de «mensaje no compatible» alrededor de una sola encuesta. El voto
 * viene cifrado y la clave está en la encuesta, que también está guardada: con
 * las dos cosas se puede abrir ahora lo que entonces no se abrió.
 */
const encuestas = await sql`
  SELECT id, line_id, chat_id, provider_message_id, timestamp, raw, sender_address
  FROM message WHERE kind = 'poll'`;

let registradas = 0;
const secretos = new Map<string, { id: string; options: string[]; secret: string }>();
for (const f of encuestas) {
  const e = encuestaDe((f.raw as { raw?: unknown })?.raw as never);
  if (!e || !e.secret) continue;
  const id = `p-${f.line_id}-${f.provider_message_id}`;
  await sql`
    INSERT INTO poll (id, line_id, provider_message_id, chat_id, question, options,
                      allow_multiple, created_by, at)
    VALUES (${id}, ${f.line_id}, ${f.provider_message_id}, ${f.chat_id}, ${e.question},
            ${JSON.stringify(e.options)}::jsonb, ${e.multiple}, ${f.sender_address},
            ${f.timestamp})
    ON CONFLICT (id) DO NOTHING`;
  secretos.set(`${f.line_id}:${f.provider_message_id}`, {
    id, options: e.options, secret: e.secret,
  });
  registradas++;
}

const votosGuardados = await sql`
  SELECT id, line_id, timestamp, raw FROM message
  WHERE raw->'raw'->'message' ? 'pollUpdateMessage'`;

/*
 * Se borra DESPUÉS de guardar, nunca antes.
 *
 * Esto se escribió al revés la primera vez —borrar y luego intentar abrir— y
 * un fallo en el descifrado se llevó por delante 143 votos reales que ya no se
 * pueden recuperar. La fila es la única copia de lo que llegó: hasta que su
 * contenido esté guardado en otro sitio, no se toca.
 */
let votos = 0, ilegibles = 0;
for (const f of votosGuardados) {
  const v = extractPollVote((f.raw as { raw?: unknown })?.raw as never);
  const encuesta = v ? secretos.get(`${f.line_id}:${v.poll.id}`) : undefined;
  if (!v || !encuesta) { ilegibles++; continue; }

  try {
    const elegidas = descifrarVoto(v.vote, {
      pollId: v.poll.id, pollAuthor: v.poll.author, voter: v.voter,
      secret: encuesta.secret,
    }, encuesta.options);
    const indices = elegidas.map((o) => encuesta.options.indexOf(o)).filter((i) => i >= 0);
    await sql`
      INSERT INTO poll_vote (poll_id, voter, selected, at)
      VALUES (${encuesta.id}, ${v.voter}, ${JSON.stringify(indices)}::jsonb,
              ${new Date(v.at)})
      ON CONFLICT (poll_id, voter) DO UPDATE SET selected = EXCLUDED.selected,
                                                 at = EXCLUDED.at`;
  } catch {
    ilegibles++;
    continue;
  }

  // Ya está guardado como voto: aquí deja de ser un mensaje.
  await sql`DELETE FROM message WHERE id = ${f.id} AND timestamp = ${f.timestamp}`;
  votos++;
}

/*
 * Cuarta pasada: a quién menciona cada mensaje.
 *
 * Como la cita, estuvo siempre en el nodo guardado y no lo leía nadie. Solo
 * ESCRIBE una columna vacía: no borra ni cambia nada que ya estuviera.
 */
const sinMenciones = await sql`
  SELECT id, timestamp, raw FROM message
  WHERE mentions IS NULL AND raw IS NOT NULL AND body ~ '@[0-9]{5,}'`;
let menciones = 0;
for (const f of sinMenciones) {
  const envelope = (f.raw as { raw?: unknown })?.raw;
  if (!envelope) continue;
  const lista = extractMentions(envelope as never);
  if (lista.length === 0) continue;
  await sql`
    UPDATE message SET mentions = ${JSON.stringify(lista)}::jsonb
    WHERE id = ${f.id} AND timestamp = ${f.timestamp} AND mentions IS NULL`;
  menciones++;
}

type Proto = { key?: { id?: string }; type?: number | string };

console.log({
  reacciones, protocolos, retirados, vaciados, reclasificados,
  revisados: filas.length,
  citas, revisadosParaCita: sinCita.length,
  encuestas: registradas, votos,
  // Votos cuya encuesta no está aquí: se quedan como estaban, a la vista, en
  // vez de desaparecer. Lo que no se sabe leer no se tira.
  ilegiblesConservados: ilegibles,
  menciones, revisadosParaMencion: sinMenciones.length,
});
await close();
