import type { Medio } from "@/lib/api";
import { IconoDocumento } from "./iconos";
import { tamano } from "@/lib/formato";

/**
 * El contenido de un mensaje con fichero.
 *
 * Se usa `<img>` y no `next/image` a propósito. Las URLs vienen FIRMADAS y
 * CADUCAN: el optimizador de Next descargaría la imagen, la guardaría en su
 * caché y serviría contenido privado desde su propia ruta, además de romperse
 * en cuanto la firma venciera. Aquí no hay nada que optimizar que compense eso.
 */
export function Medio({ kind, medio, error, onReintentar }: {
  kind: string;
  medio: Medio | null | undefined;
  error: string | null | undefined;
  /** Vuelve a pedir el fichero. Sin esto, un fallo era para siempre. */
  onReintentar?: (() => void) | undefined;
}) {
  if (!medio) {
    // Sin fichero: o falló, o aún está bajando. Son dos cosas distintas y el
    // usuario tiene que poder distinguirlas en vez de ver el mismo hueco.
    return (
      <p
        // El motivo, para quien lo quiera ver: «No se pudo» a secas no dice si
        // fue la red, WhatsApp o que el fichero ya no existe.
        title={error ?? undefined}
        className={`flex items-center gap-1.5 text-xs ${
          error ? "text-(--color-error)" : "text-(--color-tenue)"
        }`}
      >
        {!error && (
          <span
            aria-hidden
            className="size-3 animate-pulse rounded-full bg-current opacity-60"
          />
        )}
        {error ? "No se pudo descargar" : "Descargando…"}
        {error && onReintentar && (
          <button
            type="button"
            onClick={onReintentar}
            className="ml-1 rounded-md px-1.5 py-0.5 font-medium text-(--color-acento-fuerte) underline-offset-2 hover:bg-(--color-hundido) hover:underline"
          >
            Reintentar
          </button>
        )}
      </p>
    );
  }

  if (kind === "sticker") {
    return (
      <img
        src={medio.url}
        alt="sticker"
        // Los stickers son pequeños y transparentes: a tamaño de foto se ven
        // mal y con fondo se ven peor.
        className="h-36 w-36 object-contain"
        loading="lazy"
      />
    );
  }

  if (kind === "image") {
    return (
      <a href={medio.url} target="_blank" rel="noreferrer">
        <img
          src={medio.url}
          alt={medio.fileName ?? "imagen"}
          className="max-h-80 rounded-lg object-contain"
          loading="lazy"
        />
      </a>
    );
  }

  if (kind === "video") {
    return (
      // `preload="metadata"`: con `auto`, abrir una conversación con veinte
      // vídeos se los descarga todos.
      <video src={medio.url} controls preload="metadata" className="max-h-80 rounded-lg" />
    );
  }

  if (kind === "audio") {
    return <audio src={medio.url} controls preload="metadata" className="w-64" />;
  }

  return (
    <a
      href={medio.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2.5 rounded-lg bg-black/5 px-2.5 py-2 text-sm hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
    >
      <IconoDocumento className="size-5 shrink-0 text-(--color-tenue)" />
      <span className="min-w-0">
        <span className="block truncate">{medio.fileName ?? "Documento"}</span>
        {medio.size !== null && (
          <span className="block text-xs text-(--color-tenue)">{tamano(medio.size)}</span>
        )}
      </span>
    </a>
  );
}
