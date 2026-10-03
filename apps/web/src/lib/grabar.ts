"use client";

/**
 * Grabación de notas de voz y vídeos desde el navegador.
 *
 * Lo que un navegador puede grabar NO es lo que WhatsApp reproduce, y cada uno
 * puede lo suyo: Chrome graba audio en WebM/Opus, Firefox en OGG/Opus, y el
 * vídeo casi siempre en WebM/VP8. Aquí se pide lo MÁS CERCANO que acepte cada
 * navegador y el servidor termina de ajustarlo con ffmpeg.
 *
 * Pedir el formato bueno aquí no es un detalle: cuando el navegador ya puede
 * dar OGG/Opus, el servidor se limita a cambiar el envoltorio sin recodificar,
 * que es instantáneo y no pierde calidad.
 */

/** Formatos de audio, del que menos trabajo da al servidor al que más. */
const AUDIO = [
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

/** Igual con el vídeo: si el navegador sabe MP4/H.264, no hay que recodificar. */
const VIDEO = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function primeroQueSirva(candidatos: string[]): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return candidatos.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export const puedeGrabar = (): boolean =>
  typeof navigator !== "undefined"
  && typeof navigator.mediaDevices?.getUserMedia === "function"
  && typeof MediaRecorder !== "undefined";

export interface Grabacion {
  readonly file: File;
  readonly segundos: number;
}

export interface Grabador {
  detener(): Promise<Grabacion>;
  cancelar(): void;
  readonly stream: MediaStream;
}

/**
 * Arranca una grabación y devuelve cómo pararla.
 *
 * El `stream` se expone para poder enseñar la cámara mientras se graba: sin
 * verse, grabar un vídeo es apuntar a ciegas.
 */
export async function grabar(tipo: "audio" | "video"): Promise<Grabador> {
  const stream = await navigator.mediaDevices.getUserMedia(
    tipo === "audio"
      ? { audio: { echoCancellation: true, noiseSuppression: true } }
      : { audio: true, video: { facingMode: "user", width: { ideal: 1280 } } },
  );

  const mimeType = primeroQueSirva(tipo === "audio" ? AUDIO : VIDEO);
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  const trozos: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) trozos.push(e.data); };

  const empezado = Date.now();
  // Un trozo por segundo: si algo va mal a mitad, lo grabado hasta entonces
  // ya está en memoria y no se pierde la nota entera.
  rec.start(1000);

  /** Suelta el micrófono y la cámara. Sin esto, el indicador se queda encendido. */
  const soltar = (): void => { for (const t of stream.getTracks()) t.stop(); };

  return {
    stream,
    cancelar: () => {
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      soltar();
    },
    detener: () =>
      new Promise<Grabacion>((resolver, rechazar) => {
        rec.onerror = () => { soltar(); rechazar(new Error("la grabación falló")); };
        rec.onstop = () => {
          soltar();
          const real = rec.mimeType || mimeType || "application/octet-stream";
          const base = real.split(";")[0]!;
          const extension = base.includes("ogg") ? "ogg"
            : base.includes("mp4") ? "mp4"
            : base.includes("webm") ? "webm" : "bin";
          const nombre = tipo === "audio" ? `nota.${extension}` : `video.${extension}`;
          resolver({
            file: new File(trozos, nombre, { type: real }),
            segundos: Math.max(1, Math.round((Date.now() - empezado) / 1000)),
          });
        };
        if (rec.state === "inactive") rec.onstop?.(new Event("stop"));
        else rec.stop();
      }),
  };
}

export const reloj = (segundos: number): string =>
  `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")}`;
