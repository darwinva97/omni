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
