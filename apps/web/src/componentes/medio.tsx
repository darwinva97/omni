import type { Medio } from "@/lib/api";

/**
 * El contenido de un mensaje con fichero.
 *
 * Se usa `<img>` y no `next/image` a propósito. Las URLs vienen FIRMADAS y
 * CADUCAN: el optimizador de Next descargaría la imagen, la guardaría en su
 * caché y serviría contenido privado desde su propia ruta, además de romperse
 * en cuanto la firma venciera. Aquí no hay nada que optimizar que compense eso.
 */
export function Medio({ kind, medio, error }: {
  kind: string;
  medio: Medio | null | undefined;
  error: string | null | undefined;
}) {
  if (!medio) {
    // Sin fichero: o falló, o aún está bajando. Son dos cosas distintas y el
    // usuario tiene que poder distinguirlas en vez de ver el mismo hueco.
    return (
      <p className="text-xs text-(--color-tenue) italic">
        {error ? `${kind}: no se pudo descargar` : `${kind}: descargando…`}
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
        className="h-32 w-32 object-contain"
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
      className="flex items-center gap-2 text-sm text-(--color-acento) hover:underline"
    >
      <span aria-hidden>📄</span>
      <span className="truncate">{medio.fileName ?? "documento"}</span>
      {medio.size !== null && (
        <span className="shrink-0 text-xs text-(--color-tenue)">
          {Math.round(medio.size / 1024)} kB
        </span>
      )}
    </a>
  );
}
