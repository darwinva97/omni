"use client";

import { useRef, useState } from "react";
import type { Nota } from "@/lib/api";
import { diaDeSeparador, hora } from "@/lib/formato";
import { partirEnlaces } from "@/lib/enlaces";
import { IconoCandado, IconoCerrar, IconoNota, IconoPapelera } from "./iconos";

/**
 * Una nota interna en el hilo.
 *
 * Tiene que ser IMPOSIBLE de confundir con un mensaje. Por eso no es una
 * burbuja de ningún lado: ocupa el ancho del hilo, es ámbar —el único ámbar
 * del hilo—, lleva borde discontinuo como una nota pegada, y dice arriba, con
 * candado, que solo la ve el equipo. Quien la escribió va con nombre: en un
 * equipo, «quién lo dijo» es la mitad de lo que dice una nota.
 */
export function NotaEnHilo({
  nota, nuevoDia, mia, onBorrar,
}: {
  nota: Nota;
  nuevoDia: boolean;
  mia: boolean;
  onBorrar: () => void;
}) {
  const autor = mia ? "Tú" : nota.author.name ?? (nota.author.kind === "api-key" ? "Una integración" : "Alguien del equipo");
  return (
    <li id={`nota-${nota.id}`}>
      {nuevoDia && (
        <div className="flex justify-center py-3">
          <span className="rounded-full bg-(--color-panel) px-3 py-1 text-[11px] font-medium text-(--color-tenue) shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
            {diaDeSeparador(nota.createdAt)}
          </span>
        </div>
      )}
      <div className="group/nota mx-auto my-2 max-w-[min(40rem,92%)] rounded-(--radius-burbuja) border border-dashed border-(--color-nota-borde) bg-(--color-nota) px-3 py-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-(--color-nota-texto)">
          <IconoCandado className="size-3.5 shrink-0" />
          <span>Nota interna · solo la ve tu equipo</span>
          <span className="ml-auto flex items-center gap-1.5 font-normal">
            <span className="truncate">{autor}</span>
            <time dateTime={nota.createdAt}>{hora(nota.createdAt)}</time>
            {mia && (
              // Solo en las propias: una nota es lo que alguien dejó dicho, y
              // que la borre otro haría que nadie se fiara de lo escrito.
              <button
                type="button"
                onClick={onBorrar}
                aria-label="Borrar mi nota"
                title="Borrar mi nota"
                className="flex size-5 items-center justify-center rounded opacity-60 transition-opacity duration-150 hover:bg-(--color-nota-borde)/30 hover:opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover/nota:opacity-60"
              >
                <IconoPapelera className="size-3.5" />
              </button>
            )}
          </span>
        </p>
        <p className="mt-1 text-sm wrap-anywhere whitespace-pre-wrap">
          {partirEnlaces(nota.body).map((e, i) => "texto" in e
            ? <span key={i}>{e.texto}</span>
            : (
              <a
                key={i}
                href={e.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-(--color-enlace) underline decoration-1 underline-offset-2"
              >
                {e.enlace}
              </a>
            ))}
        </p>
      </div>
    </li>
  );
}

/** El interruptor entre mensaje y nota, en el sitio fijo del compositor. */
export function BotonNota({
  activo, onClick, deshabilitado = false, motivo,
}: {
  activo: boolean;
  onClick: () => void;
  deshabilitado?: boolean;
  /** Por qué no se puede ahora, para el `title`. */
  motivo?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={deshabilitado}
      aria-pressed={activo}
      aria-label={activo ? "Volver a escribir un mensaje al cliente" : "Escribir una nota interna"}
      title={deshabilitado && motivo ? motivo : activo
        ? "Volver a mensaje: lo que escribas irá al cliente"
        : "Nota interna: la ve tu equipo, nunca el cliente"}
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors duration-150 active:scale-[0.97] disabled:opacity-40 md:h-10 ${
        activo
          ? "bg-(--color-nota-fuerte) text-(--color-sobre-nota)"
          : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
      }`}
    >
      <IconoNota className="size-5" />
      <span className="hidden md:inline">Nota</span>
    </button>
  );
}

/**
 * El campo para escribir una nota.
 *
 * Es OTRO formulario, no el de los mensajes con otro color: no comparte el
 * texto, ni el borrador, ni el botón de enviar. Así no hay forma de que lo
 * escrito aquí salga por el camino de los mensajes por un estado que se quedó
 * a medias. Tampoco tiene adjuntos, stickers ni grabadora: una nota es texto.
 *
 * Todo él grita que no va al cliente: la franja de arriba, el ámbar, el
 * candado del botón y lo que dice el botón.
 */
export function CompositorDeNota({
  onGuardar, onSalir,
}: {
  onGuardar: (texto: string) => Promise<string | null>;
  onSalir: () => void;
}) {
  const campo = useRef<HTMLTextAreaElement>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ajustarAltura = (): void => {
    const el = campo.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  };

  const guardar = async (): Promise<void> => {
    const el = campo.current;
    const texto = el?.value.trim() ?? "";
    if (!texto || guardando) return;
    setGuardando(true);
    setError(null);
    const fallo = await onGuardar(texto);
    setGuardando(false);
    if (fallo) { setError(fallo); return; }
    if (el) { el.value = ""; ajustarAltura(); el.focus(); }
  };

  return (
    <div className="border-t-2 border-(--color-nota-fuerte) bg-(--color-nota)">
      <p className="flex items-center gap-1.5 px-4 pt-2 text-xs font-medium text-(--color-nota-texto)">
        <IconoCandado className="size-3.5" />
        Nota interna: la ve tu equipo, el cliente NO.
        <button
          type="button"
          onClick={onSalir}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-(--color-nota-borde)/30"
        >
          <IconoCerrar className="size-3.5" />
          Volver a mensaje
        </button>
      </p>
      {error && <p role="alert" className="px-4 pt-1 text-xs text-(--color-error)">{error}</p>}
      <form
        onSubmit={(e) => { e.preventDefault(); void guardar(); }}
        className="flex items-end gap-1.5 px-3 py-2.5"
      >
        <BotonNota activo onClick={onSalir} />
        <textarea
          ref={campo}
          rows={1}
          autoFocus
          autoComplete="off"
          aria-label="Nota interna"
          onInput={ajustarAltura}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onSalir(); return; }
            // Igual que en los mensajes: Enter guarda, Shift+Enter salta línea.
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            if (window.matchMedia("(pointer: coarse)").matches) return;
            e.preventDefault();
            void guardar();
          }}
          placeholder="Escribe una nota para tu equipo…"
          className="scroll-discreto max-h-48 min-w-0 flex-1 resize-none rounded-xl border border-(--color-nota-borde) bg-(--color-panel) px-3.5 py-2.5 text-sm leading-5 outline-none placeholder:text-(--color-apagado) focus:ring-2 focus:ring-(--color-nota-fuerte) focus-visible:outline-(--color-nota-fuerte) md:px-4"
        />
        <button
          disabled={guardando}
          aria-label="Guardar la nota interna"
          title="Guardar la nota (Enter). No se envía al cliente."
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-(--color-nota-fuerte) px-3 text-sm font-medium text-(--color-sobre-nota) transition-opacity duration-150 hover:opacity-90 disabled:opacity-40 md:h-10"
        >
          <IconoCandado className="size-4" />
          <span className="hidden sm:inline">Guardar nota</span>
        </button>
      </form>
    </div>
  );
}
