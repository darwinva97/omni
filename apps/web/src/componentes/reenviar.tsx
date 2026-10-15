"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat } from "@/lib/api";
import { buscarEnAgenda, useAgenda } from "@/lib/agenda";
import { Avatar } from "./piezas";
import { IconoBuscar, IconoCerrar, IconoEnviar, IconoReenviar } from "./iconos";

/**
 * A cuántos chats se puede reenviar de una vez: los de WhatsApp.
 *
 * No es paridad por paridad. WhatsApp lo limitó para frenar las cadenas, y
 * reenviar lo mismo a treinta chats desde un número no oficial es justo el
 * patrón que hace que lo restrinjan.
 */
export const MAX_DESTINOS = 5;

interface Destino { address: string; nombre: string; kind: string; avatarUrl: string | null }

const plano = (t: string): string =>
  t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * Elegir a dónde reenviar un mensaje.
 *
 * Solo a chats de la MISMA línea: la API reenvía desde el mensaje original,
 * que vive en la cuenta de WhatsApp de esa línea; otra línea es otra cuenta y
 * no lo tiene. Por eso aquí no se ofrecen otras líneas.
 *
 * Los chats recientes primero —es a donde se reenvía casi siempre— y, al
 * buscar, también la agenda: reenviar a alguien con quien aún no hay chat es
 * igual de válido.
 */
export function Reenviar({
  lineId, resumen, onReenviar, onCerrar,
}: {
  lineId: string;
  /** Lo que se reenvía, en una línea: «Foto», o el texto. */
  resumen: string;
  /** Reenvía a UN destino. Devuelve el motivo si no se pudo, o null. */
  onReenviar: (to: string) => Promise<string | null>;
  onCerrar: () => void;
}) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [q, setQ] = useState("");
  const [elegidos, setElegidos] = useState<Destino[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [fallos, setFallos] = useState<{ nombre: string; motivo: string }[]>([]);
  const agenda = useAgenda(lineId);
  const buscador = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let vivo = true;
    void fetch(`/api/omni/v1/lines/${lineId}/chats?limit=200`)
      .then(async (r) => (r.ok ? ((await r.json()) as { data: Chat[] }).data : []))
      .catch(() => [] as Chat[])
      .then((lista) => { if (vivo) setChats(lista); });
    return () => { vivo = false; };
  }, [lineId]);

  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !enviando) onCerrar();
    };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [onCerrar, enviando]);
  useEffect(() => { buscador.current?.focus(); }, []);

  const opciones = useMemo((): { recientes: Destino[]; agenda: Destino[] } => {
    // Un canal no es una conversación: ahí solo escribe quien lo administra.
    const conversaciones = (chats ?? []).filter((c) => c.kind !== "newsletter");
    const f = plano(q.trim());
    const deChat = (c: Chat): Destino => ({
      address: c.address, nombre: c.displayName, kind: c.kind, avatarUrl: c.avatarUrl,
    });
    if (!f) return { recientes: conversaciones.map(deChat), agenda: [] };
    const digitos = q.replace(/\D/g, "");
    const recientes = conversaciones
      .filter((c) => plano(c.displayName).includes(f)
        || (digitos.length >= 3 && (c.phone ?? c.address).includes(digitos)))
      .map(deChat);
    const conChat = new Set(conversaciones.map((c) => c.address));
    const otros = buscarEnAgenda(agenda, q)
      .filter((p) => !p.chat || !conChat.has(p.chat))
      .slice(0, 30)
      .map((p) => ({ address: p.chat ?? p.address, nombre: p.name, kind: "pn", avatarUrl: null }));
    return { recientes, agenda: otros };
  }, [chats, agenda, q]);

  const lleno = elegidos.length >= MAX_DESTINOS;
  const alternar = (d: Destino): void => {
    setFallos([]);
    setElegidos((prev) => prev.some((x) => x.address === d.address)
      ? prev.filter((x) => x.address !== d.address)
      : prev.length >= MAX_DESTINOS ? prev : [...prev, d]);
  };

  /*
   * Uno detrás de otro, no a la vez: el ritmo de envío de la línea los iba a
   * espaciar igual, y así un fallo se atribuye a SU chat. Lo que salió se
   * quita de la selección; lo que no, se queda con su motivo para reintentar.
   */
  const reenviar = async (): Promise<void> => {
    if (elegidos.length === 0 || enviando) return;
    setEnviando(true);
    const quedan: Destino[] = [];
    const motivos: { nombre: string; motivo: string }[] = [];
    for (const d of elegidos) {
      const motivo = await onReenviar(d.address);
      if (motivo) { quedan.push(d); motivos.push({ nombre: d.nombre, motivo }); }
    }
    setEnviando(false);
    if (quedan.length === 0) { onCerrar(); return; }
    setElegidos(quedan);
    setFallos(motivos);
  };

  const fila = (d: Destino) => {
    const marcado = elegidos.some((x) => x.address === d.address);
    const bloqueado = !marcado && lleno;
    return (
      <li key={d.address}>
        <button
          type="button"
          role="checkbox"
          aria-checked={marcado}
          disabled={bloqueado || enviando}
          onClick={() => alternar(d)}
          className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-100 hover:bg-(--color-hundido) disabled:opacity-45 disabled:hover:bg-transparent"
        >
          <span
            aria-hidden
            className={`flex size-4.5 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition-colors duration-100 ${
              marcado
                ? "border-(--color-acento) bg-(--color-acento) text-(--color-sobre-acento)"
                : "border-(--color-apagado)"
            }`}
          >
            {marcado && (
              <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="m2.5 6.2 2.3 2.3 4.7-5" />
              </svg>
            )}
          </span>
          <Avatar nombre={d.nombre} direccion={d.address} kind={d.kind} tamano="sm" url={d.avatarUrl} />
          <span className="min-w-0 flex-1 truncate text-sm">{d.nombre}</span>
        </button>
      </li>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !enviando) onCerrar(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reenviar mensaje"
        className="flex max-h-[min(36rem,85vh)] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) shadow-[0_12px_40px_rgba(0,0,0,0.25)]"
      >
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <IconoReenviar className="mt-0.5 size-5 shrink-0 text-(--color-tenue)" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Reenviar mensaje</h2>
            <p className="mt-0.5 truncate text-xs text-(--color-tenue)">{resumen}</p>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            disabled={enviando}
            aria-label="Cerrar"
            className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
          >
            <IconoCerrar className="size-4" />
          </button>
        </div>

        <div className="relative px-4 pb-2">
          <IconoBuscar className="pointer-events-none absolute top-1/2 left-6.5 size-4 -translate-y-[calc(50%+4px)] text-(--color-apagado)" />
          <input
            ref={buscador}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Enter elige la primera coincidencia: buscar «ana» + Enter es
              // el camino más corto a reenviarle algo a Ana.
              if (e.key !== "Enter") return;
              e.preventDefault();
              const primera = opciones.recientes[0] ?? opciones.agenda[0];
              if (primera) { alternar(primera); setQ(""); }
            }}
            placeholder="Buscar un chat o un contacto"
            aria-label="Buscar un chat o un contacto"
            className="w-full rounded-lg bg-(--color-hundido) py-2 pr-3 pl-8.5 text-sm outline-none placeholder:text-(--color-apagado) focus:bg-(--color-panel) focus:ring-2 focus:ring-(--color-acento)"
          />
        </div>

        <div className="scroll-discreto min-h-40 flex-1 overflow-y-auto border-t border-(--color-borde-sutil) py-1">
          {chats === null ? (
            <p className="px-4 py-6 text-center text-sm text-(--color-tenue)">Cargando chats…</p>
          ) : opciones.recientes.length + opciones.agenda.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-(--color-tenue)">
              {q ? `Nada que coincida con «${q}»` : "No hay chats todavía."}
            </p>
          ) : (
            <>
              {opciones.recientes.length > 0 && (
                <>
                  <p className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-(--color-apagado) uppercase">
                    {q ? "Chats" : "Chats recientes"}
                  </p>
                  <ul>{opciones.recientes.map(fila)}</ul>
                </>
              )}
              {opciones.agenda.length > 0 && (
                <>
                  <p className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-(--color-apagado) uppercase">
                    Otros contactos
                  </p>
                  <ul>{opciones.agenda.map(fila)}</ul>
                </>
              )}
            </>
          )}
        </div>

        {fallos.length > 0 && (
          <ul role="alert" className="space-y-0.5 border-t border-(--color-error) bg-(--color-error-tenue) px-4 py-2 text-xs text-(--color-error)">
            {fallos.map((f) => (
              <li key={f.nombre}><span className="font-semibold">{f.nombre}:</span> {f.motivo}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3 border-t border-(--color-borde) px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-xs text-(--color-tenue)" aria-live="polite">
            {elegidos.length === 0
              ? `Elige hasta ${MAX_DESTINOS} chats`
              : lleno
                ? `${elegidos.map((d) => d.nombre).join(", ")} · máximo ${MAX_DESTINOS}`
                : elegidos.map((d) => d.nombre).join(", ")}
          </p>
          <button
            type="button"
            onClick={() => void reenviar()}
            disabled={elegidos.length === 0 || enviando}
            aria-label={enviando ? "Reenviando…" : `Reenviar a ${elegidos.length} ${elegidos.length === 1 ? "chat" : "chats"}`}
            title="Reenviar"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-(--color-acento) text-(--color-sobre-acento) transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
          >
            <IconoEnviar className="size-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
