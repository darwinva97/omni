"use client";

import { useEffect, useRef, useState } from "react";
import { grabar, puedeGrabar, reloj, type Grabador } from "@/lib/grabar";

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
      // Menos de un segundo es un toque sin querer, no una nota de voz.
      if (dur < 1 || file.size === 0) return;
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
          className="pointer-events-none fixed right-4 bottom-24 z-10 h-40 w-32 rounded-lg border border-(--color-borde) object-cover"
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
          className={`rounded-lg border px-3 py-2 text-sm ${
            grabando
              ? "border-red-500 bg-red-500/20 text-red-400"
              : "border-(--color-borde) hover:bg-(--color-ajeno)"
          } disabled:opacity-50`}
        >
          {tipo === "audio" ? "🎙" : "🎥"}
        </button>

        {grabando && (
          <>
            <span className="text-xs text-red-400 tabular-nums">{reloj(segundos)}</span>
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
