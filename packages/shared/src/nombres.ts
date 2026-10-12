/**
 * Qué nombre se enseña de una persona.
 *
 * UNA regla, en un solo sitio. Antes había cinco —la lista de chats, las
 * burbujas de un grupo, las citas, los estados y los adelantos— y cada una con
 * su orden: en un sitio salía el nombre de agenda y en otro el que la persona
 * se puso, y dos ponían `+` delante de un LID como si fuera un teléfono.
 *
 * El orden, de mejor a peor:
 *
 * 1. **El que TÚ le pusiste** en tu agenda. Lo elegiste para reconocerla.
 * 2. **El que esa persona se puso** a sí misma en WhatsApp.
 * 3. **Su @usuario** de WhatsApp.
 * 4. **Su número**, que al menos se reconoce.
 * 5. **El identificador**, que con el direccionamiento por LID no identifica a
 *    nadie. Por eso es el último y no el primero, y por eso NUNCA lleva `+`:
 *    los dígitos de un LID no son un teléfono, y enseñarlos como si lo fueran
 *    es invitar a alguien a marcarlos.
 */

export interface DatosDeNombre {
  readonly address: string;
  readonly savedName?: string | null | undefined;
  readonly pushName?: string | null | undefined;
  readonly username?: string | null | undefined;
  /** El teléfono, como dirección (`51…@s.whatsapp.net`) o como dígitos. */
  readonly phone?: string | null | undefined;
}

export function nombreVisible(d: DatosDeNombre): string {
  const limpio = (v: string | null | undefined): string | null => {
    const t = v?.trim();
    return t ? t : null;
  };

  const usuario = limpio(d.username)?.replace(/^@/, "");
  const telefono = numeroDe(d);

  return limpio(d.savedName)
    ?? limpio(d.pushName)
    ?? (usuario ? `@${usuario}` : null)
    ?? (telefono ? `+${telefono}` : null)
    ?? (d.address.split("@")[0] || d.address);
}

/**
 * El número de teléfono de una dirección, si de verdad lo es.
 *
 * Una dirección `@s.whatsapp.net` ES un teléfono; una `@lid` no, y su número
 * solo se sabe si el mapa de identidad lo tiene. Nunca se deduce de los
 * dígitos del LID.
 */
function numeroDe(d: DatosDeNombre): string | null {
  if (d.phone) return d.phone.split("@")[0]!.split(":")[0] || null;
  if (d.address.endsWith("@s.whatsapp.net")) {
    return d.address.split("@")[0]!.split(":")[0] || null;
  }
  return null;
}

/**
 * Las menciones escritas en un texto.
 *
 * WhatsApp no pone el nombre en el texto: pone `@` seguido de la parte de
 * usuario de la dirección —un teléfono o, cada vez más, un LID—, y manda
 * aparte la lista de direcciones mencionadas. Es el cliente quien sustituye el
 * número por el nombre al enseñarlo.
 */
export const PATRON_MENCION = /@(\d{5,20})\b/g;

export function tokensDeMencion(texto: string | null | undefined): string[] {
  if (!texto) return [];
  return [...new Set([...texto.matchAll(PATRON_MENCION)].map((m) => m[1]!))];
}

/**
 * Sustituye cada `@número` por `@Nombre`, cuando se sabe a quién se refiere.
 *
 * Para los sitios que solo admiten texto plano: el adelanto de la lista, el
 * aviso del sistema, una cita. En la burbuja el panel pinta la mención con
 * estilo propio.
 *
 * Lo que no se sabe a quién se refiere se deja como está: inventar un nombre
 * sería peor que enseñar el número.
 */
export function conNombres(
  texto: string,
  nombres: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  const buscar = (token: string): string | undefined =>
    nombres instanceof Map ? nombres.get(token) : (nombres as Record<string, string>)[token];
  return texto.replace(PATRON_MENCION, (todo, token: string) => {
    const nombre = buscar(token);
    return nombre ? `@${nombre.replace(/^@/, "")}` : todo;
  });
}
