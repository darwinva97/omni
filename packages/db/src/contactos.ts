import { contactosDe, nombreVisible, type ContactoCompartido } from "@omni/shared";
import type { DbHandle } from "./client.js";
import { chatsDe, fichasDe, fotosDe } from "./nombres.js";

type Db = DbHandle["db"];

/** Un contacto compartido, cruzado con lo que la línea sabe de él. */
export interface ContactoDeLinea extends Omit<ContactoCompartido, "photo" | "phones"> {
  phones: (ContactoCompartido["phones"][number] & {
    /** La conversación que ya hay con ese número, por su teléfono o su LID. */
    chat: string | null;
    /** Cómo lo conoce la línea: tu agenda, el nombre que se puso o su @usuario. */
    knownAs: string | null;
  })[];
  /** Su foto de perfil si la línea la tiene; si no, la que traiga la tarjeta. */
  avatarUrl: string | null;
}

/**
 * Los contactos compartidos de varios mensajes, cruzados con la línea.
 *
 * De cada número con WhatsApp se busca, en una tanda para todos, si ya hay
 * chat con él —por su teléfono o por su LID—, cómo se llama en la agenda y su
 * foto. Es lo que deja ofrecer «Enviar mensaje» que lleve al chat que ya
 * existe y no abra un segundo con la misma persona.
 *
 * Lo usan la API, al leer la conversación, y el motor, en el evento en vivo:
 * así un contacto recién llegado se ve igual que al recargar.
 */
export async function contactosDeLinea(
  db: Db, lineId: string, crudos: readonly unknown[],
  firmar: (clave: string) => Promise<string | null>,
): Promise<ContactoDeLinea[][]> {
  const leidos = crudos.map((c) => contactosDe(c));
  const direccion = (waId: string): string => `${waId}@s.whatsapp.net`;
  const direcciones = [...new Set(leidos.flat().flatMap((c) =>
    c.phones.flatMap((p) => (p.waId ? [direccion(p.waId)] : []))))];
  if (leidos.every((l) => l.length === 0)) return leidos.map(() => []);

  const [chats, fichas, fotos] = await Promise.all([
    chatsDe(db, lineId, direcciones),
    fichasDe(db, lineId, direcciones),
    fotosDe(db, lineId, direcciones),
  ]);
  // Firmadas una vez por persona, no una por mensaje.
  const firmadas = new Map<string, string | null>();
  for (const [a, clave] of fotos) firmadas.set(a, await firmar(clave).catch(() => null));

  return leidos.map((contactos) => contactos.map(({ photo, ...c }) => ({
    ...c,
    phones: c.phones.map((p) => {
      const a = p.waId ? direccion(p.waId) : null;
      const ficha = a ? fichas.get(a) : undefined;
      // Solo si de verdad lo conoce: un número a secas no es un nombre.
      const conocido = a && ficha && (ficha.savedName || ficha.pushName || ficha.username)
        ? nombreVisible({ address: a, ...ficha })
        : null;
      return { ...p, chat: a ? chats.get(a) ?? null : null, knownAs: conocido };
    }),
    avatarUrl: c.phones.map((p) => (p.waId ? firmadas.get(direccion(p.waId)) : null))
      .find(Boolean) ?? photo,
  })));
}
