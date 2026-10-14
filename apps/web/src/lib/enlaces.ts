/**
 * Enlaces dentro del texto de un mensaje, como los marca WhatsApp.
 *
 * Cuatro formas, por este orden: con `http(s)://`, empezando por `www.`, un
 * correo, y un dominio suelto con una terminación conocida («smartdata.com.pe/blog»).
 * La lista de terminaciones es corta a propósito: con cualquiera, «node.js»
 * o «archivo.txt» acabarían siendo enlaces.
 *
 * El `href` lo construye esta función y siempre empieza por `https://`,
 * `http://` o `mailto:`. Lo escrito en el mensaje nunca llega tal cual al
 * atributo, así que un «javascript:» en un mensaje se queda en texto.
 */

export type Trozo =
  | { texto: string }
  | { enlace: string; href: string };

const TERMINACIONES = [
  "com", "net", "org", "info", "io", "app", "dev", "ai", "co", "me", "ly", "gl",
  "tv", "link", "site", "store", "shop", "online", "edu", "gob", "gov",
  "pe", "es", "mx", "ar", "cl", "bo", "ec", "uy", "py", "ve", "us", "uk",
].join("|");

const PATRON = new RegExp(
  [
    String.raw`(https?:\/\/[^\s<>"]+)`,
    String.raw`(www\.[^\s<>"]+)`,
    String.raw`([\w.+-]+@[\w-]+(?:\.[\w-]+)+)`,
    String.raw`((?<![\w@./-])(?:[a-z0-9-]+\.)+(?:${TERMINACIONES})(?![\w-])(?:\/[^\s<>"]*)?)`,
  ].join("|"),
  "gi",
);

/**
 * Lo que va pegado al final de un enlace sin ser suyo: el punto de la frase,
 * una coma, el cierre de un paréntesis que se abrió fuera, o los asteriscos y
 * guiones bajos del formato de WhatsApp (*negrita*, _cursiva_).
 */
function recortar(enlace: string): string {
  let fin = enlace;
  for (;;) {
    const ultimo = fin.at(-1);
    if (!ultimo) return fin;
    if (".,;:!?'\"*_~".includes(ultimo)) { fin = fin.slice(0, -1); continue; }
    if (ultimo === ")") {
      // Solo se quita si sobra: en «wikipedia.org/wiki/Lima_(Perú)» es suyo.
      const abiertos = [...fin].filter((c) => c === "(").length;
      const cerrados = [...fin].filter((c) => c === ")").length;
      if (cerrados > abiertos) { fin = fin.slice(0, -1); continue; }
    }
    return fin;
  }
}

export function partirEnlaces(texto: string): Trozo[] {
  const trozos: Trozo[] = [];
  let desde = 0;
  for (const m of texto.matchAll(PATRON)) {
    const enlace = recortar(m[0]);
    if (!enlace) continue;
    const inicio = m.index!;
    if (inicio > desde) trozos.push({ texto: texto.slice(desde, inicio) });
    // «Https://» escrito por el corrector del teléfono: el esquema, en minúsculas.
    const href = m[1] ? enlace.replace(/^https?/i, (e) => e.toLowerCase())
      : m[3] ? `mailto:${enlace}`
      : `https://${enlace}`;
    trozos.push({ enlace, href });
    desde = inicio + enlace.length;
  }
  if (desde < texto.length) trozos.push({ texto: texto.slice(desde) });
  return trozos;
}
