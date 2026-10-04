"use client";

import { useEffect, useRef, useState } from "react";
import { grabar, puedeGrabar, reloj, type Grabador } from "@/lib/grabar";
import { IconoCamara, IconoMicrofono } from "./iconos";

/**
 * Grabar una nota de voz o un vídeo, como en WhatsApp.
 *
 * El gesto es el que la gente ya conoce: se mantiene pulsado para grabar y se
 * suelta para enviar. Se añade un botón de cancelar porque en un ratón
 * "soltar fuera" no es un gesto fiable —en un móvil sí— y perder una nota de
 * voz por mover el dedo es más molesto que un botón de más.
 */
export function Grabadora({
  tipo,
  onGrabado,
  onError,
  deshabilitado,
}: {
  tipo: "audio" | "video";
  onGrabado: (file: File) => void | Promise<void>;
  onError: (mensaje: string) => void;
  deshabilitado?: boolean;
}) {
  const [grabando, setGrabando] = useState(false);
  const [segundos, setSegundos] = useState(0);
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

      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={deshabilitado}
          aria-label={tipo === "audio" ? "Grabar una nota de voz" : "Grabar un vídeo"}
          // Ratón y dedo: `pointer*` cubre los dos sin duplicar manejadores.
          onPointerDown={(e) => { e.preventDefault(); void empezar(); }}
          onPointerUp={() => void soltar()}
          // Si el puntero se va fuera, se envía lo grabado en vez de perderlo.
          onPointerLeave={() => { if (grabando) void soltar(); }}
          onContextMenu={(e) => e.preventDefault()}
          className={`flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 ${
            grabando
              ? "bg-(--color-error-tenue) text-(--color-error)"
              : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
          } disabled:opacity-40`}
        >
          {tipo === "audio" ? <IconoMicrofono className="size-5" /> : <IconoCamara className="size-5" />}
        </button>

        {grabando && (
          <>
            <span className="text-xs font-medium text-(--color-error) tabular-nums">
              {reloj(segundos)}
            </span>
            <button
              type="button"
              onClick={cancelar}
              className="text-xs text-(--color-tenue) hover:underline"
            >
              cancelar
            </button>
          </>
        )}
      </div>
    </>
  );
}
