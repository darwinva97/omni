"use client";

import { useEffect, useRef, useState } from "react";
import { IconoCerrar } from "./iconos";

interface StickerGuardado {
  storageKey: string;
  url: string;
  usados: number;
}

/**
 * Los stickers que han pasado por la línea.
 *
 * WhatsApp no deja consultar los paquetes de stickers: viven en el teléfono y
 * no se exponen por ninguna vía. Así que esto no es «la biblioteca de
 * WhatsApp», y no se vende como tal: es lo que SÍ se puede ofrecer —los que
 * has recibido o enviado— y en la práctica resuelve lo mismo, porque los que
 * uno manda son casi siempre los que ya circulan en sus grupos.
 *
 * Se envían por su clave del almacén, así que reenviar uno no vuelve a subir
 * nada.
 */
export function Stickers({
  lineId, onElegir, onCerrar,
}: {
  lineId: string;
  onElegir: (storageKey: string) => void | Promise<void>;
  onCerrar: () => void;
}) {
  const [lista, setLista] = useState<StickerGuardado[] | null>(null);
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/omni/v1/lines/${lineId}/stickers?limit=60`);
      if (!r.ok) { setLista([]); return; }
      const { data } = (await r.json()) as { data: StickerGuardado[] };
      setLista(data);
    })();
  }, [lineId]);

  useEffect(() => {
    const fuera = (e: MouseEvent): void => {
      if (!caja.current?.contains(e.target as Node)) onCerrar();
    };
    const tecla = (e: KeyboardEvent): void => { if (e.key === "Escape") onCerrar(); };
    document.addEventListener("mousedown", fuera, true);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera, true);
      document.removeEventListener("keydown", tecla);
    };
  }, [onCerrar]);

  return (
    <div
      ref={caja}
      className="absolute bottom-16 left-3 z-30 w-80 overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) shadow-[0_12px_32px_rgba(0,0,0,0.22)]"
    >
      <header className="flex items-center justify-between border-b border-(--color-borde) px-3 py-2">
        <h2 className="text-sm font-semibold">Stickers</h2>
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar"
          className="flex size-7 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido)"
        >
          <IconoCerrar className="size-4" />
        </button>
      </header>

      <div className="scroll-discreto max-h-72 overflow-y-auto p-2">
        {lista === null ? (
          // Esqueleto y no un giro: ocupa el sitio que va a ocupar el
          // contenido, así la rejilla no salta al llegar.
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-lg bg-(--color-hundido)" />
            ))}
          </div>
        ) : lista.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-(--color-tenue)">
            Todavía no ha pasado ningún sticker por esta línea. Los que recibas
            aparecerán aquí listos para reenviar.
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {lista.map((s) => (
              <button
                key={s.storageKey}
                type="button"
                onClick={() => { void onElegir(s.storageKey); onCerrar(); }}
                title={s.usados > 1 ? `Visto ${s.usados} veces` : undefined}
                className="aspect-square rounded-lg p-1 transition-transform duration-150 hover:scale-110 hover:bg-(--color-hundido)"
              >
                <img src={s.url} alt="" loading="lazy" className="size-full object-contain" />
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="border-t border-(--color-borde) px-3 py-2 text-[11px] text-(--color-apagado)">
        Los que han pasado por esta línea. WhatsApp no deja leer los paquetes
        del teléfono.
      </p>
    </div>
  );
}

/**
 * Reacciones rápidas.
 *
 * Seis y las mismas que ofrece WhatsApp, en el mismo orden: son las que la
 * gente ya busca con el ojo, y cambiarlas por otras «mejores» obliga a leer.
 * El resto se escribe a mano, que es lo que hace el botón del final.
 */
export const REACCIONES = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export function Reacciones({
  onElegir, onCerrar,
}: {
  onElegir: (emoji: string) => void | Promise<void>;
  onCerrar: () => void;
}) {
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fuera = (e: MouseEvent): void => {
      if (!caja.current?.contains(e.target as Node)) onCerrar();
    };
    const tecla = (e: KeyboardEvent): void => { if (e.key === "Escape") onCerrar(); };
    document.addEventListener("mousedown", fuera, true);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera, true);
      document.removeEventListener("keydown", tecla);
    };
  }, [onCerrar]);

  return (
    <div
      ref={caja}
      role="menu"
      className="flex items-center gap-0.5 rounded-full border border-(--color-borde) bg-(--color-panel) px-1.5 py-1 shadow-[0_6px_20px_rgba(0,0,0,0.18)]"
    >
      {REACCIONES.map((e) => (
        <button
          key={e}
          type="button"
          role="menuitem"
          aria-label={`Reaccionar con ${e}`}
          onClick={() => { void onElegir(e); onCerrar(); }}
          className="flex size-8 items-center justify-center rounded-full text-lg transition-transform duration-150 hover:scale-125 hover:bg-(--color-hundido)"
        >
          {e}
        </button>
      ))}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          const otro = prompt("¿Con qué emoji?");
          if (otro?.trim()) void onElegir(otro.trim());
          onCerrar();
        }}
        aria-label="Otro emoji"
        className="flex size-8 items-center justify-center rounded-full text-sm text-(--color-tenue) hover:bg-(--color-hundido)"
      >
        +
      </button>
    </div>
  );
}
