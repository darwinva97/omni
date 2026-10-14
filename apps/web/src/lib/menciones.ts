/**
 * Mencionar con «@» al escribir, como en WhatsApp o Teams.
 *
 * Lo que se ve y lo que se manda son distintos. Mientras se escribe, el campo
 * dice «@Rodrigo Chumpitaz»; WhatsApp espera «@248975076663346» en el texto y
 * la dirección aparte, en la lista de mencionados. La conversión se hace al
 * ENVIAR, con lo que se eligió en la lista: escribir «@Rodrigo» a mano, sin
 * elegirlo, no menciona a nadie —tampoco en WhatsApp—.
 */

export interface Participante {
  readonly address: string;
  readonly name: string;
  readonly me?: boolean;
  /**
   * De la agenda pero NO del grupo —o cualquiera, en un chat de dos—.
   *
   * Se ofrece igual, pero se inserta su nombre como texto y no como mención:
   * WhatsApp solo avisa a quien está en el grupo, y convertirlo en
   * «@número» haría que los demás vieran un número en vez de un nombre.
   */
  readonly fuera?: boolean;
}

/**
 * Los participantes, y después la agenda que no está ya entre ellos.
 *
 * Una persona del grupo aparece en la agenda con su teléfono y en el grupo
 * con su LID: se reconoce por cualquiera de las dos para no ofrecerla dos
 * veces.
 */
export function candidatosDeMencion(
  participantes: readonly Participante[],
  agenda: readonly { address: string; lid: string | null; phone: string | null; name: string }[],
): Participante[] {
  const ya = new Set(participantes.map((p) => p.address));
  const fuera = agenda
    .filter((c) => !ya.has(c.address) && !(c.lid && ya.has(c.lid)) && !(c.phone && ya.has(c.phone)))
    .map((c) => ({ address: c.address, name: c.name, fuera: true }));
  return [...participantes, ...fuera];
}

/** Sin tildes ni mayúsculas, para comparar lo que se escribe con los nombres. */
const plano = (t: string): string =>
  t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * Si el cursor está justo detrás de un «@algo», qué se está buscando.
 *
 * Solo cuenta un «@» al principio o tras un espacio: el de un correo
 * («hola@empresa.com») no abre la lista.
 */
export function consultaDeMencion(
  texto: string, cursor: number,
): { inicio: number; filtro: string } | null {
  const antes = texto.slice(0, cursor);
  const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(antes);
  if (!m) return null;
  return { inicio: antes.length - m[2]!.length - 1, filtro: m[2]! };
}

/**
 * Los que encajan con lo escrito: primero los que tienen una palabra que
 * EMPIEZA así, luego los que lo contienen. Nunca uno mismo.
 */
export function filtrarParticipantes(
  lista: readonly Participante[], filtro: string, max = 8,
): Participante[] {
  const f = plano(filtro);
  const candidatos = lista.filter((p) => !p.me);
  if (!f) {
    return [...candidatos]
      .sort((a, b) => Number(a.fuera ?? false) - Number(b.fuera ?? false)
        || a.name.localeCompare(b.name, "es"))
      .slice(0, max);
  }
  const empieza = candidatos.filter((p) => plano(p.name).split(/\s+/).some((w) => w.startsWith(f)));
  const contiene = candidatos.filter((p) => !empieza.includes(p) && plano(p.name).includes(f));
  // Los del grupo antes que la agenda: son a quienes de verdad se avisa.
  const orden = (p: Participante) => (p.fuera ? 1 : 0);
  return [...empieza, ...contiene]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => orden(a.p) - orden(b.p) || a.i - b.i)
    .map(({ p }) => p)
    .slice(0, max);
}

/** Cambia el «@algo» que se estaba escribiendo por «@Nombre ». */
export function insertarMencion(
  texto: string, inicio: number, cursor: number, nombre: string,
): { texto: string; cursor: number } {
  const insercion = `@${nombre} `;
  return {
    texto: texto.slice(0, inicio) + insercion + texto.slice(cursor),
    cursor: inicio + insercion.length,
  };
}

/**
 * Lo que se manda: el texto con «@número» y a quién menciona.
 *
 * Los nombres más largos se sustituyen primero, para que «@Ana María» no se
 * quede a medias por haber reconocido antes «@Ana». Y solo cuenta el nombre
 * entero: «@Anabel» no es una mención de «Ana».
 *
 * `menciones` es lo que se pinta en la burbuja propia sin esperar al
 * servidor: el texto ya trae los números, y sin esto se verían.
 */
export function prepararMenciones(
  texto: string, elegidas: ReadonlyMap<string, string>,
): { texto: string; mentions: string[]; menciones: { token: string; name: string }[] } {
  const nombres = [...elegidas.keys()].sort((a, b) => b.length - a.length);
  const mentions: string[] = [];
  const menciones: { token: string; name: string }[] = [];
  let salida = texto;

  for (const nombre of nombres) {
    const address = elegidas.get(nombre)!;
    const token = address.split("@")[0]!.split(":")[0]!;
    const escapado = nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patron = new RegExp(`@${escapado}(?![\\p{L}\\p{N}])`, "gu");
    if (!patron.test(salida)) continue;
    salida = salida.replace(patron, `@${token}`);
    mentions.push(address);
    menciones.push({ token, name: nombre });
  }
  return { texto: salida, mentions, menciones };
}
