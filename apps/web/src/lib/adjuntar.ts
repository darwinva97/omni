"use client";

/**
 * Qué campo de envío le toca a un fichero.
 *
 * El envío de la API es polimórfico: el tipo lo decide el campo que se
 * rellena, no un parámetro aparte. Así que hay que traducir el tipo MIME del
 * fichero al nombre del campo.
 */
export type CampoDeMedio = "image" | "video" | "audio" | "document" | "sticker";

export function campoPara(file: File): CampoDeMedio {
  const tipo = (file.type || "").toLowerCase();

  /*
   * Un WebP se manda como STICKER y no como imagen.
   *
   * Es el formato que WhatsApp usa para los stickers, y es casi siempre lo que
   * se quiere al adjuntar uno. Quien quiera mandarlo como foto puede cambiar el
   * tipo en el selector.
   */
  if (tipo === "image/webp") return "sticker";
  /*
   * Un GIF va por el campo del VÍDEO.
   *
   * WhatsApp no envía ficheros GIF: lo que enseña como «GIF» es un MP4 en
   * bucle, y el servidor lo convierte. Mandarlo como imagen llegaría como un
   * fichero estático que hay que abrir aparte.
   */
  if (tipo === "image/gif") return "video";
  if (tipo.startsWith("image/")) return "image";
  if (tipo.startsWith("video/")) return "video";
  if (tipo.startsWith("audio/")) return "audio";
  return "document";
}

export const ETIQUETAS: Record<CampoDeMedio, string> = {
  image: "Foto",
  video: "Vídeo",
  audio: "Audio",
  sticker: "Sticker",
  document: "Documento",
};

/** Tamaño legible, para avisar antes de intentar subir algo enorme. */
export function tamanoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * WhatsApp corta por aquí.
 *
 * El límite real depende del tipo —los documentos llegan a 100 MB y las fotos
 * no— pero avisar antes de subir dieciséis megas para que el otro lado los
 * rechace ahorra el viaje entero.
 */
export const MAX_BYTES = 64 * 1024 * 1024;

/** Lo mínimo de un `DataTransfer` que hace falta: así se puede probar sin navegador. */
export interface Portapapeles {
  readonly files: ArrayLike<File>;
  getData(tipo: string): string;
}

/**
 * Qué ficheros hay que adjuntar de lo que se acaba de pegar.
 *
 * Lista vacía cuando lo pegado es texto: entonces el campo se comporta como
 * siempre y no se toca nada.
 *
 * Un caso engañoso: al copiar celdas de Excel o un párrafo de Word, el sistema
 * pone en el portapapeles el texto Y una imagen de cómo se ve. Quien copia de
 * ahí quiere el texto. Se distingue porque esa imagen viene sin `<img>` en el
 * HTML; al copiar una imagen de verdad —de una web, de una captura— o no hay
 * texto o el HTML la incluye.
 */
export function ficherosPegados(datos: Portapapeles, ahora: Date = new Date()): File[] {
  const ficheros = Array.from(datos.files);
  if (ficheros.length === 0) return [];

  const texto = datos.getData("text/plain").trim();
  const html = datos.getData("text/html");
  const soloUnaImagen = ficheros.length === 1 && ficheros[0]!.type.startsWith("image/");
  if (texto && soloUnaImagen && html && !/<img[\s>]/i.test(html)) return []; // impeccable-disable-line broken-image -- es una expresión regular, no una etiqueta

  // Varias capturas pegadas a la vez tendrían el mismo nombre: se numeran.
  const sinNombre = ficheros.filter((f) => !tieneNombre(f)).length;
  let n = 0;
  return ficheros.map((f) => tieneNombre(f) ? f : conNombre(f, ahora, sinNombre > 1 ? ++n : 0));
}

/** El nombre genérico con que llega una captura no cuenta como nombre. */
function tieneNombre(f: File): boolean {
  return Boolean(f.name) && !/^image\.\w+$/i.test(f.name);
}

/** Un fichero listo para enviar, con su pie. */
export interface Adjunto {
  readonly id: string;
  readonly file: File;
  readonly campo: CampoDeMedio;
  readonly gif: boolean;
  readonly pie: string;
}

/**
 * Cuántos de golpe. WhatsApp deja treinta por envío, y más que eso en una
 * tira de miniaturas ya no se revisa: se manda sin mirar.
 */
export const MAX_ADJUNTOS = 30;

/**
 * Añade ficheros a los que ya hay, y dice por qué rechazó los que rechazó.
 *
 * Lo rechazado se DICE, uno por uno: un fichero que no entra en silencio
 * deja a quien lo eligió creyendo que se mandó.
 */
export function agregarAdjuntos(
  lista: readonly Adjunto[], ficheros: readonly File[], nuevoId: () => string,
): { lista: Adjunto[]; avisos: string[] } {
  const resultado = [...lista];
  const avisos: string[] = [];
  const huella = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
  const yaEstan = new Set(resultado.map((a) => huella(a.file)));

  for (const file of ficheros) {
    if (file.size > MAX_BYTES) {
      avisos.push(`«${file.name}» pesa ${tamanoLegible(file.size)}; el máximo es ${tamanoLegible(MAX_BYTES)}.`);
      continue;
    }
    // El mismo fichero dos veces es casi siempre un doble pegado sin querer.
    if (yaEstan.has(huella(file))) continue;
    if (resultado.length >= MAX_ADJUNTOS) {
      avisos.push(`Caben ${MAX_ADJUNTOS} por envío: «${file.name}» y los siguientes se quedaron fuera.`);
      break;
    }
    yaEstan.add(huella(file));
    resultado.push({
      id: nuevoId(), file, campo: campoPara(file), gif: file.type === "image/gif", pie: "",
    });
  }
  return { lista: resultado, avisos };
}

/**
 * Un nombre que diga algo.
 *
 * Una captura pegada llega como «image.png», sin más. Si se manda como
 * documento, eso es lo que ve quien la recibe; y si se pegan dos, se llaman
 * igual. Los ficheros copiados del explorador conservan su nombre.
 */
function conNombre(file: File, ahora: Date, numero: number): File {
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*$/, "") || "bin";
  const p = (n: number) => String(n).padStart(2, "0");
  const marca = `${ahora.getFullYear()}-${p(ahora.getMonth() + 1)}-${p(ahora.getDate())}`
    + `-${p(ahora.getHours())}${p(ahora.getMinutes())}${p(ahora.getSeconds())}`;
  return new File([file], `captura-${marca}${numero ? `-${numero}` : ""}.${ext}`, {
    type: file.type, lastModified: file.lastModified,
  });
}
