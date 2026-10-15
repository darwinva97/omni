/**
 * Lo que alguien escribe en el buscador, leído como teléfono.
 *
 * La gente pega números como los tiene: «+51 987 654 321», «987-654-321»,
 * «0051987654321», «(01) 234 5678». WhatsApp los quiere en formato
 * internacional y solo con cifras. Aquí se decide, con reglas que se pueden
 * explicar, qué número es y si hubo que suponer el prefijo del país.
 */

/**
 * Los prefijos de país de dos cifras.
 *
 * Los de la UIT no se solapan entre sí: el 1 y el 7 son de una cifra, estos
 * de dos y TODOS los demás de tres. Con esta lista corta se puede saber el
 * prefijo de cualquier número internacional sin una tabla de doscientos
 * países.
 */
const DE_DOS = new Set([
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45",
  "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61",
  "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94",
  "95", "98",
]);

/** El prefijo de país de un número internacional (solo cifras). */
export function prefijoDe(internacional: string): string {
  if (internacional.startsWith("1") || internacional.startsWith("7")) return internacional[0]!;
  const dos = internacional.slice(0, 2);
  return DE_DOS.has(dos) ? dos : internacional.slice(0, 3);
}

/** Si lo escrito parece un teléfono y no un nombre: cifras y los signos de siempre. */
export function pareceTelefono(texto: string): boolean {
  const t = texto.trim();
  if (!/^\+?[\d\s().-]+$/.test(t)) return false;
  return t.replace(/\D/g, "").length >= 7;
}

export type LecturaDeTelefono =
  | {
      ok: true;
      /** Solo cifras, con prefijo de país: lo que espera WhatsApp. */
      numero: string;
      /** Para enseñarlo: «+51 987 654 321». */
      bonito: string;
      /** El prefijo se puso por nosotros, copiado del de la línea. */
      prefijoSupuesto: string | null;
    }
  | { ok: false; motivo: string };

/**
 * Lee un teléfono escrito a mano.
 *
 * - Con `+` o con `00` delante: ya es internacional, se toma tal cual.
 * - Sin ninguno y con once cifras o más: se da por internacional escrito sin
 *   el `+`, que es como lo copia mucha gente de WhatsApp («51987654321»).
 * - Sin ninguno y con diez cifras o menos: es un número NACIONAL, y se le pone
 *   el prefijo del país de la propia línea —lo normal es escribir a gente de
 *   tu país—, quitando el 0 de larga distancia si lo trae. Se dice siempre
 *   («prefijo +51 de esta línea»), para que nadie escriba a otro país sin
 *   darse cuenta. Si la línea no tiene número, no se adivina: se pide.
 */
export function leerTelefono(texto: string, numeroDeLaLinea: string | null): LecturaDeTelefono {
  const t = texto.trim();
  const cifras = t.replace(/\D/g, "");
  let numero: string;
  let prefijoSupuesto: string | null = null;

  if (t.startsWith("+")) numero = cifras;
  else if (cifras.startsWith("00")) numero = cifras.slice(2);
  else if (cifras.length >= 11) numero = cifras;
  else {
    const propio = numeroDeLaLinea?.split("@")[0]?.replace(/\D/g, "") ?? "";
    if (propio.length < 8) {
      return { ok: false, motivo: "Escribe el número con el prefijo del país, por ejemplo +51 987 654 321." };
    }
    prefijoSupuesto = prefijoDe(propio);
    numero = prefijoSupuesto + cifras.replace(/^0/, "");
  }

  // E.164: hasta quince cifras, y algo menos de ocho no es un móvil de nadie.
  if (numero.length < 8 || numero.length > 15) {
    return { ok: false, motivo: "Eso no parece un número de teléfono completo." };
  }
  return { ok: true, numero, bonito: bonito(numero), prefijoSupuesto };
}

/** «51987654321» → «+51 987 654 321»: prefijo aparte y el resto de tres en tres. */
export function bonito(numero: string): string {
  const cc = prefijoDe(numero);
  const resto = numero.slice(cc.length);
  return `+${cc} ${resto.replace(/(\d{3})(?=\d)/g, "$1 ")}`.trim();
}
