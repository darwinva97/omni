/**
 * Cómo se escriben las horas, las fechas y los nombres.
 *
 * Vive aparte porque las mismas reglas se usan en la lista de conversaciones,
 * en el hilo y en el panel de información, y tres copias divergen: una acaba
 * diciendo «ayer» y otra la fecha completa para el mismo mensaje.
 */

const HORA = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });
const DIA_SEMANA = new Intl.DateTimeFormat("es", { weekday: "long" });
const FECHA_CORTA = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const FECHA_LARGA = new Intl.DateTimeFormat("es", {
  day: "numeric", month: "long", year: "numeric",
});

const dia = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Días de diferencia entre dos instantes, contando días naturales. */
function diasDesde(fecha: Date, ahora: Date): number {
  return Math.round((dia(ahora) - dia(fecha)) / 86_400_000);
}

export const hora = (iso: string): string => HORA.format(new Date(iso));

/**
 * Lo que va en una lista de conversaciones.
 *
 * Hoy la hora, ayer la palabra, esta semana el día, y más atrás la fecha. Es
 * lo que hace que una lista larga se lea de un vistazo: lo reciente se
 * distingue por la forma del dato, no por leerlo.
 */
export function cuando(iso: string | null, ahora: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const dias = diasDesde(d, ahora);
  if (dias <= 0) return HORA.format(d);
  if (dias === 1) return "ayer";
  if (dias < 7) return DIA_SEMANA.format(d);
  return FECHA_CORTA.format(d);
}

/** El separador que va entre dos días dentro de un hilo. */
export function diaDeSeparador(iso: string, ahora: Date = new Date()): string {
  const d = new Date(iso);
  const dias = diasDesde(d, ahora);
  if (dias <= 0) return "Hoy";
  if (dias === 1) return "Ayer";
  if (dias < 7) {
    const nombre = DIA_SEMANA.format(d);
    return nombre.charAt(0).toUpperCase() + nombre.slice(1);
  }
  return FECHA_LARGA.format(d);
}

export const mismoDia = (a: string, b: string): boolean =>
  dia(new Date(a)) === dia(new Date(b));

/**
 * Las iniciales para un avatar.
 *
 * De dos palabras, la primera letra de cada una; de una, las dos primeras. De
 * un número de teléfono no se sacan iniciales: dos dígitos no identifican a
 * nadie y quedan peor que el icono de persona, así que devuelve vacío y quien
 * llama pinta el icono.
 */
export function iniciales(nombre: string): string {
  const limpio = nombre.replace(/^\+/, "").trim();
  if (/^[\d\s()-]+$/.test(limpio)) return "";
  const palabras = limpio.split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return "";
  if (palabras.length === 1) return palabras[0]!.slice(0, 2).toUpperCase();
  return (palabras[0]![0]! + palabras[1]![0]!).toUpperCase();
}

/**
 * Un color estable para cada conversación.
 *
 * El mismo contacto tiene siempre el mismo tono, lo que ayuda a reconocerlo en
 * una lista larga antes de leer el nombre. Se deriva de la dirección y no del
 * nombre: el nombre cambia cuando alguien se renombra, la dirección no.
 */
export function tonoDe(semilla: string): number {
  let h = 0;
  for (let i = 0; i < semilla.length; i++) h = (h * 31 + semilla.charCodeAt(i)) % 360;
  return h;
}

/** Lo que se enseña como resumen de un mensaje en la lista. */
export function resumen(kind: string, body: string | null): string {
  if (body && body.trim()) return body;
  const nombres: Record<string, string> = {
    image: "Foto", video: "Vídeo", audio: "Audio", sticker: "Sticker",
    document: "Documento", location: "Ubicación", contact: "Contacto",
    poll: "Encuesta", reaction: "Reacción",
  };
  return nombres[kind] ?? "Mensaje";
}

/** Tamaño legible de un fichero. */
export function tamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
