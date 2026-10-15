"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEventos } from "@/lib/eventos";
import { avisar, usePreferencias } from "@/lib/notificaciones";
import {
  caidaDe, estadoTrasEvento, textoDeCaida, type LineaVigilada,
} from "@/lib/lineas-caidas";
import { IconoAlerta } from "./iconos";

/** Solo lo que dice cómo está cada línea: no hace falta cada mensaje de cada una. */
const DE_SESION = ["session.*"] as const;

/**
 * Cuánto se espera antes de avisar en el navegador.
 *
 * Baileys se reconecta solo tras un corte de red, a menudo en segundos. Un
 * aviso del sistema por cada parpadeo enseña a ignorarlo; la franja sí sale
 * al momento, porque mientras dura es verdad que la línea no recibe nada.
 */
const ESPERA_AVISO_MS = 15_000;

/**
 * La franja de «la línea X se ha desconectado», en TODO el panel.
 *
 * Una línea caída no recibe mensajes, y en su propia pantalla ya se veía;
 * el problema es que nadie está en esa pantalla: está en una conversación de
 * otra línea, o en Equipo. Aquí se ve desde cualquier sitio, se queda
 * mientras dure y lleva el botón para arreglarlo. Si el panel está en otra
 * pestaña, además avisa el navegador, con el mismo interruptor de avisos que
 * los mensajes.
 */
export function FranjaDeLineas() {
  const [lineas, setLineas] = useState<LineaVigilada[] | null>(null);
  const { suscribir } = useEventos(null, DE_SESION);
  const { prefs } = usePreferencias();
  const router = useRouter();
  // Los avisos pendientes de cada línea: se cancelan si vuelve antes.
  const pendientes = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    let vivo = true;
    void fetch("/api/omni/v1/lines")
      .then(async (r) => (r.ok ? ((await r.json()) as { data: LineaVigilada[] }).data : null))
      .then((l) => { if (vivo && l) setLineas(l); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // Las preferencias se leen al avisar, no al suscribirse: cambiarlas no
  // tiene que reabrir nada.
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  // Lo último que se sabe de cada línea, para el manejador del socket, que
  // se crea una vez: los avisos se deciden fuera de `setLineas`, que tiene
  // que ser puro.
  const lineasRef = useRef<LineaVigilada[] | null>(null);
  useEffect(() => { lineasRef.current = lineas; }, [lineas]);

  useEffect(() => suscribir((evento, data, lineId) => {
    const estado = estadoTrasEvento(evento, data);
    const antes = lineasRef.current?.find((l) => l.id === lineId);
    if (!estado || !antes) return;
    const despues: LineaVigilada = {
      ...antes, status: estado,
      // Al enlazar por primera vez, la línea pasa a «haber funcionado».
      address: antes.address ?? (typeof data["self"] === "string" ? data["self"] : null),
    };
    lineasRef.current = lineasRef.current!.map((l) => (l.id === lineId ? despues : l));
    setLineas(lineasRef.current);

    const caida = caidaDe(despues);
    const temporizador = pendientes.current.get(lineId);
    if (!caida && temporizador) {
      clearTimeout(temporizador);
      pendientes.current.delete(lineId);
    }
    // Solo al CAER, no en cada evento mientras sigue caída.
    if (caida && !caidaDe(antes) && !temporizador) {
      pendientes.current.set(lineId, setTimeout(() => {
        pendientes.current.delete(lineId);
        const { titulo, detalle } = textoDeCaida(despues.name, caida);
        avisar(prefsRef.current, {
          titulo, cuerpo: detalle, etiqueta: `linea-${lineId}`, privado: false,
          alPulsar: () => router.push(`/lineas/${lineId}`),
        });
      }, ESPERA_AVISO_MS));
    }
  }), [suscribir, router]);

  useEffect(() => () => {
    for (const t of pendientes.current.values()) clearTimeout(t);
  }, []);

  const caidas = (lineas ?? [])
    .map((l) => ({ l, caida: caidaDe(l) }))
    .filter((x): x is { l: LineaVigilada; caida: NonNullable<ReturnType<typeof caidaDe>> } => x.caida !== null);
  if (caidas.length === 0) return null;

  return (
    <div role="status" aria-live="polite" className="shrink-0 divide-y divide-(--color-error)/25 border-b border-(--color-error)/40 bg-(--color-error-tenue)">
      {caidas.map(({ l, caida }) => (
        <FilaDeLinea
          key={l.id}
          linea={l}
          caida={caida}
          onEstado={(status) => setLineas((prev) => prev?.map((x) => (x.id === l.id ? { ...x, status } : x)) ?? prev)}
        />
      ))}
    </div>
  );
}

function FilaDeLinea({
  linea, caida, onEstado,
}: {
  linea: LineaVigilada;
  caida: "desconectada" | "sin-sesion";
  onEstado: (status: string) => void;
}) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [problema, setProblema] = useState<string | null>(null);
  const { titulo, detalle } = textoDeCaida(linea.name, caida);

  /*
   * Reconectar desde aquí, sin ir a la línea. Si la sesión se perdió, el
   * enlace pide QR y eso solo se puede escanear en la pantalla de la línea:
   * se lleva ahí.
   */
  const reconectar = async (): Promise<void> => {
    setOcupado(true);
    setProblema(null);
    const r = await fetch(`/api/omni/v1/lines/${encodeURIComponent(linea.id)}/connect`, { method: "POST" })
      .catch(() => null);
    setOcupado(false);
    const cuerpo = (await r?.json().catch(() => null)) as { data?: { state: string }; detail?: string } | null;
    if (!r?.ok || !cuerpo?.data) {
      setProblema(cuerpo?.detail ?? "No se pudo reconectar.");
      return;
    }
    onEstado(cuerpo.data.state);
    if (cuerpo.data.state === "awaiting-link") router.push(`/lineas/${linea.id}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm text-(--color-error) md:px-5">
      <IconoAlerta className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{titulo}.</span>{" "}
        {/* En el teléfono, solo el titular y el botón: con la explicación,
            la franja se comía un tercio de la pantalla. */}
        <span className={`opacity-90 ${problema ? "" : "hidden sm:inline"}`}>{problema ?? detalle}</span>
      </p>
      {caida === "sin-sesion" ? (
        <Link
          href={`/lineas/${linea.id}`}
          className="shrink-0 rounded-lg bg-(--color-error) px-3 py-1 text-xs font-semibold text-(--color-panel) transition-opacity duration-150 hover:opacity-90"
        >
          Volver a enlazar
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => void reconectar()}
          disabled={ocupado}
          className="shrink-0 rounded-lg bg-(--color-error) px-3 py-1 text-xs font-semibold text-(--color-panel) transition-opacity duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-60"
        >
          {ocupado ? "Reconectando…" : "Reconectar"}
        </button>
      )}
    </div>
  );
}
