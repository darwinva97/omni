/**
 * Dónde está lo buscado dentro de un texto, para resaltarlo.
 *
 * El servidor encuentra «canción» buscando «cancion»; aquí hay que saber QUÉ
 * trozo del texto original coincidió para marcarlo. Se compara carácter a
 * carácter sin tildes ni mayúsculas, sin cambiar la longitud, así que la
 * posición encontrada vale en el texto original tal cual.
 */

const plano = (ch: string): string =>
  ch.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase() || ch;

/** Un carácter por posición: misma longitud que el original. */
function aplanar(texto: string): string {
  return [...texto].map((ch) => {
    const p = plano(ch);
    // Si aplanar cambiara la longitud (algún símbolo raro), se deja tal cual
    // para no descolocar las posiciones.
    return p.length === ch.length ? p : ch;
  }).join("");
}

/**
 * El trozo que se enseña: con contexto delante, la coincidencia y lo que
 * sigue. Si la coincidencia está lejos del principio se recorta lo de antes,
 * para que se vea sin desplazar.
 */
export function fragmentoConCoincidencia(
  texto: string, q: string, contexto = 30,
): { antes: string; coincide: string; despues: string } {
  const i = q ? aplanar(texto).indexOf(aplanar(q)) : -1;
  if (i < 0) return { antes: texto, coincide: "", despues: "" };
  const desde = Math.max(0, i - contexto);
  return {
    antes: (desde > 0 ? "…" : "") + texto.slice(desde, i),
    coincide: texto.slice(i, i + q.length),
    despues: texto.slice(i + q.length),
  };
}
