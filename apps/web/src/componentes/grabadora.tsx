"use client";

import { useEffect, useRef, useState } from "react";
import { grabar, puedeGrabar, reloj, type Grabador } from "@/lib/grabar";
import { IconoCamara, IconoEnviar, IconoMicrofono, IconoPapelera } from "./iconos";

/**
 * Grabar una nota de voz o un vídeo, como en WhatsApp.
 *
 * Los dos gestos de WhatsApp: mantener pulsado y soltar para enviar (el del
 * móvil), o un toque para empezar —como en WhatsApp Web— y luego la barra con
 * papelera, el tiempo y enviar. Antes un toque corto se tiraba por «toque sin
 * querer» y en escritorio, donde nadie mantiene pulsado, no se podía grabar.
 */
/** Menos que esto entre pulsar y soltar es un toque: la grabación se queda fija. */
const TOQUE_MS = 350;

export function Grabadora({
  tipo,
  onGrabado,
  onError,
  deshabilitado,
  onGrabando,
}: {
  tipo: "audio" | "video";
  onGrabado: (file: File) => void | Promise<void>;
  onError: (mensaje: string) => void;
  deshabilitado?: boolean;
  /** Avisa al empezar y al acabar: es lo que hace ver «grabando audio…» al otro. */
  onGrabando?: (activo: boolean) => void;
}) {
  const [grabando, setGrabando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  // Fija: empezó con un toque y sigue hasta pulsar enviar o la papelera.
  const [fija, setFija] = useState(false);
  const pulsadoEn = useRef(0);
  const grabadorRef = useRef<Grabador | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [soportado, setSoportado] = useState(true);

  // La comprobación va en un efecto: en el servidor no hay `navigator`, y
  // mirarlo durante el renderizado rompe la hidratación.
  useEffect(() => { setSoportado(puedeGrabar()); }, []);

  useEffect(() => {
    if (!grabando) return;
    const t = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [grabando]);

  // Si el componente se va mientras graba, hay que soltar el micrófono: si no,
  // el navegador deja el indicador de grabación encendido.
  useEffect(() => () => grabadorRef.current?.cancelar(), []);

  const empezar = async (): Promise<void> => {
    if (deshabilitado || grabando) return;
    try {
      const g = await grabar(tipo);
      grabadorRef.current = g;
      setSegundos(0);
      setGrabando(true);
      onGrabando?.(true);
      if (tipo === "video" && video.current) {
        video.current.srcObject = g.stream;
        await video.current.play().catch(() => {});
      }
    } catch (e) {
      // El motivo más común es que se deniegue el permiso, y decirlo así
      // ahorra buscar por qué no pasa nada.
      onError(
        (e as Error).name === "NotAllowedError"
          ? `hace falta permiso para usar ${tipo === "audio" ? "el micrófono" : "la cámara"}`
          : `no se pudo empezar a grabar: ${(e as Error).message}`,
      );
    }
  };

  const soltar = async (): Promise<void> => {
    const g = grabadorRef.current;
    if (!g) return;
    grabadorRef.current = null;
    setGrabando(false);
    setFija(false);
    onGrabando?.(false);
    try {
      const { file, segundos: dur } = await g.detener();
      /*
       * Un toque sin querer no es una nota de voz.
       *
       * Se mira el tamaño ADEMÁS del tiempo: el cronómetro cuenta desde que se
       * pulsa, pero el micrófono tarda en arrancar, así que un toque de medio
       * segundo puede marcar «1 s» y traer sesenta milisegundos de audio. Así
       * se coló una nota de 0,06 s que se enviaba y no se oía.
       */
      if (dur < 1 || file.size < 2048) return;
      await onGrabado(file);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const cancelar = (): void => {
    grabadorRef.current?.cancelar();
    grabadorRef.current = null;
    setGrabando(false);
    setFija(false);
    onGrabando?.(false);
  };

  const alSoltar = (): void => {
    if (fija) return;
    // Aún pidiendo permiso o arrancando el micrófono: queda fija, si no nadie la pararía.
    if (!grabadorRef.current) { setFija(true); return; }
    // Un toque: se queda grabando. Mantener pulsado: soltar envía.
    if (Date.now() - pulsadoEn.current < TOQUE_MS) { setFija(true); return; }
    void soltar();
  };

  if (!soportado) return null;

  return (
    <>
      {grabando && tipo === "video" && (
        <video
          ref={video}
          muted
          playsInline
          className="pointer-events-none fixed right-6 bottom-24 z-20 h-44 w-36 rounded-xl border-2 border-(--color-error) object-cover shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
        />
      )}

      {grabando && fija ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-(--color-hundido) py-1 pr-1 pl-2">
          <button
            type="button"
            onClick={cancelar}
            aria-label="Descartar la grabación"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-(--color-tenue) hover:bg-black/5 hover:text-(--color-error) dark:hover:bg-white/10"
          >
            <IconoPapelera className="size-5" />
          </button>
          <span aria-hidden className="size-2.5 shrink-0 animate-pulse rounded-full bg-(--color-error)" />
          <span className="text-sm font-medium tabular-nums">{reloj(segundos)}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-(--color-tenue)">
            {tipo === "audio" ? "Grabando…" : "Grabando vídeo…"}
          </span>
          <button
            type="button"
            onClick={() => void soltar()}
            aria-label="Enviar la grabación"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-(--color-acento) text-(--color-sobre-acento) hover:opacity-90 md:size-10"
          >
            <IconoEnviar className="size-5" />
          </button>
        </div>
      ) : (
      <div className={`flex items-center gap-2 ${grabando && tipo === "audio" ? "min-w-0 flex-1" : ""}`}>
        {/* Manteniendo pulsado: lo mismo que la barra fija, pero sin botones (el dedo está en el micrófono). */}
        {grabando && tipo === "audio" && (
          <span className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-(--color-hundido) px-3 py-2">
            <span aria-hidden className="size-2.5 shrink-0 animate-pulse rounded-full bg-(--color-error)" />
            <span className="text-sm font-medium tabular-nums">{reloj(segundos)}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-(--color-tenue)">Suelta para enviar</span>
          </span>
        )}
        <button
          type="button"
          disabled={deshabilitado}
          aria-label={tipo === "audio" ? "Grabar una nota de voz" : "Grabar un vídeo"}
          title={tipo === "audio" ? "Toca para grabar, o mantén pulsado y suelta para enviar" : "Toca para grabar un vídeo"}
          // Ratón y dedo: `pointer*` cubre los dos sin duplicar manejadores.
          onPointerDown={(e) => { e.preventDefault(); pulsadoEn.current = Date.now(); void empezar(); }}
          onPointerUp={alSoltar}
          // Si el puntero se va fuera manteniendo pulsado, se envía lo grabado en vez de perderlo.
          onPointerLeave={() => { if (grabando && !fija && Date.now() - pulsadoEn.current >= TOQUE_MS) void soltar(); }}
          onContextMenu={(e) => e.preventDefault()}
          className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 md:size-10 ${
            grabando
              ? "bg-(--color-error) text-white"
              : tipo === "audio"
                ? "bg-(--color-acento) text-(--color-sobre-acento) hover:opacity-90"
                : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
          } disabled:opacity-40`}
        >
          {tipo === "audio" ? <IconoMicrofono className="size-5" /> : <IconoCamara className="size-5" />}
        </button>

        {grabando && tipo === "video" && (
          <span className="text-xs font-medium text-(--color-error) tabular-nums">
            {reloj(segundos)}
          </span>
        )}
      </div>
      )}
    </>
  );
}
