import { and, eq, inArray, or } from "drizzle-orm";
import { nombreVisible } from "@omni/shared";
import type { DbHandle } from "./client.js";
import { chatTable, contactTable, identityMapTable } from "./schema/index.js";

type Db = DbHandle["db"];

interface Ficha {
  savedName: string | null;
  pushName: string | null;
  username: string | null;
  phone: string | null;
  /** `true` si se sabe algo de esta persona más allá de su dirección. */
  conocida: boolean;
}

/**
 * Los nombres de un puñado de direcciones, en DOS consultas.
 *
 * Cada dirección se busca también por su gemela. La misma persona puede estar
 * en la agenda bajo su LID y aparecer mencionada por su teléfono, o al revés:
 * WhatsApp está a medio camino entre las dos formas y usa una u otra según el
 * cliente de quien escribe. El mapa de identidad las une, y sin mirarlo, una
 * persona con nombre guardado salía como un número.
 */
export async function fichasDe(
  db: Db, lineId: string, direcciones: readonly string[],
): Promise<Map<string, Ficha>> {
  const unicas = [...new Set(direcciones)].filter(Boolean);
  if (unicas.length === 0) return new Map();

  const lids = unicas.filter((a) => a.endsWith("@lid"));
  const telefonos = unicas.filter((a) => a.endsWith("@s.whatsapp.net"));
  const mapa = lids.length + telefonos.length > 0
    ? await db
        .select({ lid: identityMapTable.lid, phone: identityMapTable.phone })
        .from(identityMapTable)
        .where(and(
          eq(identityMapTable.lineId, lineId),
          or(
            lids.length > 0 ? inArray(identityMapTable.lid, lids) : undefined,
            telefonos.length > 0 ? inArray(identityMapTable.phone, telefonos) : undefined,
          ),
        ))
    : [];

  const gemela = new Map<string, string>();
  for (const m of mapa) {
    gemela.set(m.lid, m.phone);
    gemela.set(m.phone, m.lid);
  }

  const todas = [...new Set([...unicas, ...unicas.map((a) => gemela.get(a)).filter(
    (x): x is string => x !== undefined,
  )])];
  const contactos = await db
    .select({
      address: contactTable.address,
      savedName: contactTable.savedName,
      pushName: contactTable.pushName,
      username: contactTable.username,
    })
    .from(contactTable)
    .where(and(eq(contactTable.lineId, lineId), inArray(contactTable.address, todas)));
  const porDireccion = new Map(contactos.map((c) => [c.address, c]));

  const fichas = new Map<string, Ficha>();
  for (const a of unicas) {
    const propia = porDireccion.get(a);
    const otra = gemela.has(a) ? porDireccion.get(gemela.get(a)!) : undefined;
    /*
     * El nombre de agenda, del lado del TELÉFONO primero.
     *
     * Tu agenda guarda a la gente por su número. Lo que llega como «nombre»
     * de un LID suele ser otra cosa: Baileys mete en el mismo campo el nombre
     * con que WhatsApp titula esa conversación, que para un LID es el que la
     * persona se puso. En los datos reales, 39 de 41 «nombres de agenda» de un
     * LID eran idénticos al suyo propio, y uno de ellos tapaba a «Victor
     * Sanchez» con «Victor Manuelle». Si los dos lados tienen uno, gana el del
     * teléfono; si solo lo tiene el LID, vale ese.
     */
    const delTelefono = a.endsWith("@s.whatsapp.net") ? propia : otra;
    const delLid = a.endsWith("@s.whatsapp.net") ? otra : propia;
    const savedName = delTelefono?.savedName ?? delLid?.savedName ?? null;
    // El resto, el primero que lo tenga: la ficha de la dirección pedida
    // manda, la de su gemela rellena huecos.
    const pushName = propia?.pushName ?? otra?.pushName ?? null;
    const username = propia?.username ?? otra?.username ?? null;
    const phone = a.endsWith("@s.whatsapp.net") ? a : gemela.get(a) ?? null;
    fichas.set(a, {
      savedName, pushName, username, phone,
      // El teléfono NO cuenta: una dirección `@s.whatsapp.net` siempre "tiene"
      // el suyo, así que contarlo daría por conocida a cualquier cifra, y un
      // `@2024` en un texto saldría como `+2024`. Hace falta un nombre, o que
      // el servidor haya dicho que esa dirección es de alguien.
      conocida: Boolean(savedName || pushName || username || gemela.has(a)),
    });
  }
  return fichas;
}

/** El nombre a enseñar de cada dirección. Siempre hay uno: el último es el id. */
export async function nombresDe(
  db: Db, lineId: string, direcciones: readonly string[],
): Promise<Map<string, string>> {
  const fichas = await fichasDe(db, lineId, direcciones);
  return new Map([...fichas].map(([address, f]) => [address, nombreVisible({ address, ...f })]));
}

/**
 * A quién se refiere cada `@número` de un texto.
 *
 * Con las direcciones que WhatsApp mandó como mencionadas, se empareja cada
 * número con la suya y el nombre sale siempre —aunque sea el número—.
 *
 * Sin ellas —mensajes de antes de que se guardaran, o clientes que no las
 * mandan— se prueba el número como LID y como teléfono, y SOLO se resuelve si
 * una de las dos es alguien conocido. Un `@2024` en un texto puede ser un año:
 * convertirlo en el nombre de un desconocido sería inventar.
 */
export async function nombresDeMenciones(
  db: Db, lineId: string, tokens: readonly string[], mencionadas: readonly string[],
): Promise<Map<string, { address: string; name: string }>> {
  if (tokens.length === 0) return new Map();
  const usuario = (a: string): string => a.split("@")[0]!.split(":")[0]!;
  const declaradas = new Map(mencionadas.map((a) => [usuario(a), a]));

  const candidatas = tokens.flatMap((t) => declaradas.has(t)
    ? [declaradas.get(t)!]
    : [`${t}@lid`, `${t}@s.whatsapp.net`]);
  const fichas = await fichasDe(db, lineId, candidatas);

  const resultado = new Map<string, { address: string; name: string }>();
  for (const t of tokens) {
    const address = declaradas.get(t)
      ?? [`${t}@lid`, `${t}@s.whatsapp.net`].find((a) => fichas.get(a)?.conocida);
    if (!address) continue;
    const f = fichas.get(address);
    resultado.set(t, { address, name: nombreVisible({ address, ...f }) });
  }
  return resultado;
}

/**
 * La foto de cada dirección, como clave del almacén.
 *
 * De la conversación propia si la hay, y si no, del contacto: quien solo
 * escribe en grupos tiene la foto ahí. También por la dirección gemela —la
 * misma persona puede tener la foto bajo su teléfono y escribir con su LID—.
 * La que no tiene foto no aparece: el panel pone la inicial.
 */
export async function fotosDe(
  db: Db, lineId: string, direcciones: readonly string[],
): Promise<Map<string, string>> {
  const unicas = [...new Set(direcciones)].filter(Boolean);
  if (unicas.length === 0) return new Map();

  const mapa = await db
    .select({ lid: identityMapTable.lid, phone: identityMapTable.phone })
    .from(identityMapTable)
    .where(and(
      eq(identityMapTable.lineId, lineId),
      or(inArray(identityMapTable.lid, unicas), inArray(identityMapTable.phone, unicas)),
    ));
  const gemela = new Map<string, string>();
  for (const m of mapa) { gemela.set(m.lid, m.phone); gemela.set(m.phone, m.lid); }
  const todas = [...new Set([...unicas, ...unicas.map((a) => gemela.get(a))
    .filter((x): x is string => x !== undefined)])];

  const [deChats, deContactos] = await Promise.all([
    db.select({ address: chatTable.address, key: chatTable.avatarKey })
      .from(chatTable)
      .where(and(eq(chatTable.lineId, lineId), inArray(chatTable.address, todas))),
    db.select({ address: contactTable.address, key: contactTable.avatarKey })
      .from(contactTable)
      .where(and(eq(contactTable.lineId, lineId), inArray(contactTable.address, todas))),
  ]);
  const clave = new Map<string, string>();
  // El contacto primero y el chat encima: si están las dos, gana la del chat,
  // que es la que se refresca al abrir la conversación.
  for (const f of [...deContactos, ...deChats]) if (f.key) clave.set(f.address, f.key);

  const fotos = new Map<string, string>();
  for (const a of unicas) {
    const k = clave.get(a) ?? (gemela.has(a) ? clave.get(gemela.get(a)!) : undefined);
    if (k) fotos.set(a, k);
  }
  return fotos;
}

/** Una persona de la agenda, con sus dos direcciones juntas. */
export interface Persona {
  /** Su dirección de teléfono si se sabe; si no, la que haya. */
  readonly address: string;
  readonly lid: string | null;
  readonly phone: string | null;
  readonly name: string;
  readonly savedName: string | null;
  readonly pushName: string | null;
  readonly username: string | null;
  readonly blocked: boolean;
  /** La conversación que ya existe con ella, por cualquiera de sus direcciones. */
  readonly chat: string | null;
}

/**
 * La agenda de una línea: UNA entrada por persona.
 *
 * La tabla de contactos guarda una fila por dirección, y la misma persona
 * suele tener dos: la de su teléfono —donde vive el nombre que le pusiste— y
 * la de su LID —donde suele estar el que se puso ella—. Listarlas tal cual
 * enseñaba a cada uno dos veces, una con cada nombre. Se juntan por el mapa de
 * identidad, con la regla de nombres de siempre: si los dos lados tienen
 * nombre de agenda, gana el del teléfono.
 *
 * `chat` dice si ya hay conversación y con qué dirección: abrir a alguien por
 * su teléfono cuando su chat está abierto por LID crearía una segunda
 * conversación con la misma persona.
 */
export async function agendaDe(db: Db, lineId: string): Promise<Persona[]> {
  const [contactos, mapa, chats] = await Promise.all([
    db.select().from(contactTable).where(eq(contactTable.lineId, lineId)),
    db.select({ lid: identityMapTable.lid, phone: identityMapTable.phone })
      .from(identityMapTable).where(eq(identityMapTable.lineId, lineId)),
    db.select({ address: chatTable.address }).from(chatTable).where(eq(chatTable.lineId, lineId)),
  ]);
  const telefonoDe = new Map(mapa.map((m) => [m.lid, m.phone]));
  const lidDe = new Map(mapa.map((m) => [m.phone, m.lid]));
  const conChat = new Set(chats.map((c) => c.address));

  const grupos = new Map<string, { pn?: typeof contactos[number]; lid?: typeof contactos[number] }>();
  for (const c of contactos) {
    const esLid = c.address.endsWith("@lid");
    if (!esLid && !c.address.endsWith("@s.whatsapp.net")) continue;
    const clave = esLid ? telefonoDe.get(c.address) ?? c.address : c.address;
    const g = grupos.get(clave) ?? {};
    if (esLid) g.lid = c; else g.pn = c;
    grupos.set(clave, g);
  }

  return [...grupos].map(([clave, g]) => {
    const phone = clave.endsWith("@s.whatsapp.net") ? clave : null;
    const lid = g.lid?.address ?? (phone ? lidDe.get(phone) ?? null : null);
    const savedName = g.pn?.savedName ?? g.lid?.savedName ?? null;
    const pushName = g.lid?.pushName ?? g.pn?.pushName ?? null;
    const username = g.lid?.username ?? g.pn?.username ?? null;
    return {
      address: clave, lid, phone,
      name: nombreVisible({ address: clave, savedName, pushName, username, phone }),
      savedName, pushName, username,
      blocked: Boolean(g.pn?.blocked || g.lid?.blocked),
      chat: lid && conChat.has(lid) ? lid : phone && conChat.has(phone) ? phone : null,
    };
  });
}
