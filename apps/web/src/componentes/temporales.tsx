"use client";

import { useEffect, useState } from "react";
import type { Linea } from "@/lib/api";
import { IconoReloj } from "./iconos";

/**
 * Los valores que admite WhatsApp, y ninguno más: otro no falla allí, se
 * ignora en silencio, y la API lo rechaza antes. En el orden del teléfono.
 */
const OPCIONES = [
  { segundos: 0, texto: "Desactivados" },
  { segundos: 86400, texto: "24 horas" },
  { segundos: 604800, texto: "7 días" },
  { segundos: 7776000, texto: "90 días" },
] as const;

/** Qué transportes saben hacer qué, como lo dice la API. */
interface Capacidades { kind: string; capabilities: string[] }

/**
 * Si el transporte de esta línea sabe poner los mensajes a caducar y, si no,
 * cuáles sí. Se pregunta a la API y no se escribe aquí: la lista de
 * capacidades vive en los drivers y cambia con ellos.
 */
function usePuede(lineId: string): { puede: boolean; motivo: string | null } | null {
  const [res, setRes] = useState<{ lineId: string; puede: boolean; motivo: string | null } | null>(null);
  useEffect(() => {
    let vivo = true;
    void Promise.all([
      fetch("/api/omni/v1/lines").then((r) => (r.ok ? r.json() : { data: [] })) as Promise<{ data: Linea[] }>,
      fetch("/api/omni/v1/capabilities").then((r) => (r.ok ? r.json() : { data: [] })) as Promise<{ data: Capacidades[] }>,
    ]).then(([{ data: lineas }, { data: transportes }]) => {
      if (!vivo) return;
      const tipo = lineas.find((l) => l.id === lineId)?.channelKind;
      const propio = transportes.find((t) => t.kind === tipo);
      // Si no se pudo saber, se deja intentar: la API dirá que no con su motivo.
      if (!propio) { setRes({ lineId, puede: true, motivo: null }); return; }
      const puede = propio.capabilities.includes("chat.ephemeral");
      const otros = transportes
        .filter((t) => t.kind !== "sandbox" && t.capabilities.includes("chat.ephemeral"))
        .map((t) => t.kind);
      setRes({
        lineId, puede,
        motivo: puede ? null
          : `Esta línea va por ${tipo}, que no sabe poner mensajes temporales.${
            otros.length > 0 ? ` Sí saben: ${otros.join(", ")}.` : ""}`,
      });
    }).catch(() => { if (vivo) setRes({ lineId, puede: true, motivo: null }); });
    return () => { vivo = false; };
  }, [lineId]);
  return res?.lineId === lineId ? res : null;
}

/**
 * Mensajes temporales de una conversación, en la ficha.
 *
 * El estado actual se enseña solo si se SABE: WhatsApp no deja preguntarlo y
 * solo se conoce cuando alguien lo cambia —desde aquí, desde el teléfono o el
 * otro lado—. Hasta entonces no se marca ninguna opción, en vez de dar por
 * hecho que están desactivados.
 */
export function Temporales({
  lineId, chat, actuales,
}: {
  lineId: string;
  chat: string;
  /** Segundos; 0 = desactivados; `null` = no se sabe. */
  actuales: number | null;
}) {
  const [valor, setValor] = useState<{ chat: string; segundos: number | null }>({ chat, segundos: actuales });
  const segundos = valor.chat === chat ? valor.segundos : actuales;
  const [guardando, setGuardando] = useState<number | null>(null);
  const [problema, setProblema] = useState<{ chat: string; texto: string } | null>(null);
  const capacidad = usePuede(lineId);
  const deshabilitado = capacidad !== null && !capacidad.puede;

  const elegir = async (s: number): Promise<void> => {
    if (s === segundos || guardando !== null) return;
    setGuardando(s);
    setProblema(null);
    const r = await fetch(`/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/ephemeral`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seconds: s }),
    }).catch(() => null);
    setGuardando(null);
    if (r?.ok) { setValor({ chat, segundos: s }); return; }
    const detalle = (await r?.json().catch(() => null)) as { detail?: string } | null;
    setProblema({ chat, texto: detalle?.detail ?? "no hay conexión con el servidor" });
  };

  const error = problema?.chat === chat ? problema.texto : null;

  return (
    <section className="border-t border-(--color-borde) px-4 py-4">
      <h3 id="temporales" className="flex items-center gap-1.5 text-xs font-medium text-(--color-tenue)">
        <IconoReloj className="size-3.5" />
        Mensajes temporales
      </h3>
      <p className="mt-1 text-xs text-(--color-apagado)">
        {deshabilitado
          ? capacidad?.motivo
          : segundos === null
            ? "No se sabe cómo están: WhatsApp no deja preguntarlo. Elige uno para fijarlo."
            : "Los mensajes nuevos desaparecen pasado ese tiempo, para los dos."}
      </p>
      <div
        role="radiogroup"
        aria-labelledby="temporales"
        aria-disabled={deshabilitado || undefined}
        className="mt-2.5 grid grid-cols-2 gap-1.5"
      >
        {OPCIONES.map((o) => {
          const marcada = segundos === o.segundos;
          return (
            <button
              key={o.segundos}
              type="button"
              role="radio"
              aria-checked={marcada}
              disabled={deshabilitado || guardando !== null}
              onClick={() => void elegir(o.segundos)}
              className={`rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors duration-150 disabled:cursor-not-allowed ${
                marcada
                  ? "border-(--color-acento) bg-(--color-acento-tenue) font-medium text-(--color-acento-fuerte)"
                  : "border-(--color-borde) hover:bg-(--color-hundido) disabled:opacity-50 disabled:hover:bg-transparent"
              }`}
            >
              {guardando === o.segundos ? "Guardando…" : o.texto}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-(--color-error)">No se pudo cambiar: {error}.</p>
      )}
    </section>
  );
}
