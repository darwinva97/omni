import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OmniError } from "@omni/shared";

const ejecutar = promisify(execFile);

/**
 * Conversión de medios para que WhatsApp los acepte.
 *
 * Existe porque lo que graba un navegador NO es lo que WhatsApp reproduce:
 *
 * - Chrome graba audio en `audio/webm;codecs=opus`. El flujo Opus ya es el
 *   bueno, pero el envoltorio WebM no: una nota de voz así llega y no suena.
 *   Se cambia de envoltorio SIN recodificar, que es instantáneo y no pierde
 *   calidad.
 * - Chrome graba vídeo en WebM/VP8. WhatsApp quiere H.264 en MP4, y eso sí
 *   hay que recodificarlo.
 * - Un sticker tiene que ser WebP de 512×512. Cualquier imagen se puede
 *   convertir, y conviene hacerlo en el servidor para no depender de lo que
 *   sepa hacer el navegador de cada uno.
 */

export interface Convertido {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface ConversorOptions {
  /** Ruta del binario. Se inyecta para poder probar sin tenerlo instalado. */
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/** Qué hace falta convertir, decidido por el tipo que trae el fichero. */
export function necesitaConversion(campo: string, mimeType: string): boolean {
  const tipo = mimeType.split(";")[0]!.trim().toLowerCase();
  // Un GIF se manda por el campo del vídeo, y hay que convertirlo siempre.
  if (campo === "video" && tipo === "image/gif") return true;
  if (campo === "audio") return tipo !== "audio/ogg" && tipo !== "audio/mpeg" && tipo !== "audio/mp4";
  // Un GIF entra por el campo del vídeo y SIEMPRE hay que convertirlo:
  // WhatsApp no reproduce ficheros GIF.
  if (campo === "video") return tipo !== "video/mp4";
  if (campo === "sticker") return tipo !== "image/webp";
  return false;
}

export class Conversor {
  readonly #ffmpeg: string;
  readonly #timeout: number;
  readonly #maxBytes: number;

  constructor(opts: ConversorOptions = {}) {
    this.#ffmpeg = opts.ffmpegPath ?? "ffmpeg";
    this.#timeout = opts.timeoutMs ?? 120_000;
    this.#maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  }

  /** `true` si el binario está donde se dijo y responde. */
  async disponible(): Promise<boolean> {
    try {
      await ejecutar(this.#ffmpeg, ["-hide_banner", "-version"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async convertir(campo: string, entrada: Uint8Array, mimeType: string): Promise<Convertido> {
    if (entrada.byteLength > this.#maxBytes) {
      throw new OmniError("validation_failed", "el fichero es demasiado grande para convertirlo");
    }

    switch (campo) {
      case "audio": return this.#audio(entrada);
      case "video": return this.#video(entrada);
      case "sticker": return this.#sticker(entrada);
      default:
        throw new OmniError("validation_failed", `no se convierte nada para "${campo}"`);
    }
  }

  /**
   * A OGG/Opus, sin recodificar si ya viene en Opus.
   *
   * Se intenta primero `-c:a copy`: cambiar de envoltorio es instantáneo y no
   * toca un bit del audio. Solo si el origen no es Opus se recodifica.
   */
  async #audio(entrada: Uint8Array): Promise<Convertido> {
    const copia = await this.#correr(entrada, "entrada", "salida.ogg",
      ["-c:a", "copy", "-f", "ogg"]).catch(() => null);
    if (copia) return { bytes: copia, mimeType: "audio/ogg; codecs=opus" };

    const recodificado = await this.#correr(entrada, "entrada", "salida.ogg", [
      "-c:a", "libopus",
      // 32 kbps mono es lo que usa WhatsApp para las notas de voz: suena bien
      // para una voz y pesa una décima parte que la música.
      "-b:a", "32k", "-ac", "1", "-ar", "48000",
      "-f", "ogg",
    ]);
    return { bytes: recodificado, mimeType: "audio/ogg; codecs=opus" };
  }

  /** A MP4/H.264, que es lo único que reproducen todos los clientes. */
  async #video(entrada: Uint8Array): Promise<Convertido> {
    const bytes = await this.#correr(entrada, "entrada", "salida.mp4", [
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      // `yuv420p` y dimensiones pares: sin eso, iOS no lo reproduce aunque el
      // fichero sea válido.
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:a", "aac", "-b:a", "96k",
      // `faststart` mueve el índice al principio: sin él, el reproductor tiene
      // que bajar el fichero entero antes de empezar.
      "-movflags", "+faststart",
      "-f", "mp4",
    ]);
    return { bytes, mimeType: "video/mp4" };
  }

  /**
   * A WebP de 512×512 con fondo transparente.
   *
   * No se recorta ni se estira: se escala hasta caber y se rellena con
   * transparencia. Recortar se come la cabeza de quien sale en la foto, y
   * estirar la deforma.
   */
  async #sticker(entrada: Uint8Array): Promise<Convertido> {
    const bytes = await this.#correr(entrada, "entrada", "salida.webp", [
      "-vf",
      "scale=512:512:force_original_aspect_ratio=decrease,format=rgba," +
        "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000",
      "-c:v", "libwebp", "-lossless", "0", "-q:v", "80",
      // Un solo fotograma: un sticker animado es otra cosa y pesa mucho más.
      "-frames:v", "1",
      "-f", "webp",
    ]);
    return { bytes, mimeType: "image/webp" };
  }

  async #correr(
    entrada: Uint8Array, nombreEntrada: string, nombreSalida: string, args: string[],
  ): Promise<Uint8Array> {
    /*
     * Por ficheros y no por tuberías.
     *
     * ffmpeg necesita poder BUSCAR en el origen para leer el índice de un WebM
     * o un MP4, y en una tubería no puede: falla con "Invalid data found"
     * sobre un fichero perfectamente válido.
     */
    const dir = await mkdtemp(join(tmpdir(), "omni-conv-"));
    const origen = join(dir, nombreEntrada);
    const destino = join(dir, nombreSalida);
    try {
      await writeFile(origen, entrada);
      await ejecutar(
        this.#ffmpeg,
        ["-hide_banner", "-loglevel", "error", "-y", "-i", origen, ...args, destino],
        { timeout: this.#timeout, maxBuffer: 1024 * 1024 },
      );
      const salida = await readFile(destino);
      if (salida.byteLength === 0) {
        throw new OmniError("upstream_failed", "la conversión no produjo nada");
      }
      return new Uint8Array(salida);
    } catch (err) {
      if (err instanceof OmniError) throw err;
      const mensaje = (err as { stderr?: string; message: string }).stderr?.trim()
        || (err as Error).message;
      throw new OmniError(
        "validation_failed",
        `no se pudo convertir el fichero: ${mensaje.slice(0, 300)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
