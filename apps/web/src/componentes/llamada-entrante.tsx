"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Llamada } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { suena, textoDeLlamada } from "@/lib/llamadas";
import { avisar, usePreferencias } from "@/lib/notificaciones";
import { IconoCamara, IconoTelefono } from "./iconos";

const DE_LLAMADAS = ["call.*"] as const;

interface Sonando {
  lineId: string;
  chatId: string;
  nombre: string | null;
  call: Llamada;
}

/**
 * «Te están llamando», en TODO el panel, mientras suena.
 *
 * El audio no llega aquí: con Baileys la llamada solo se puede contestar en el
 * teléfono. Lo que sí se puede es saber quién es, ir a su conversación o
 * colgarle, y eso hay que poder hacerlo en los segundos que dura el timbre y
 * desde cualquier pantalla, no solo desde ese chat.
 */
export function LlamadaEntrante() {
  const [sonando, setSonando] = useState<Sonando[]>([]);
  const { suscribir } = useEventos(null, DE_LLAMADAS);
  const { prefs } = usePreferencias();
  const router = useRouter();
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  useEffect(() => suscribir((evento, data, lineId) => {
    if (evento !== "call.received") return;
    const call = data["call"] as Llamada | undefined;
    const chatId = data["chatId"] as string | undefined;
    if (!call || !chatId) return;
    if (!suena(call)) {
      setSonando((prev) => prev.filter((s) => s.call.id !== call.id));
      return;
    }
    const nombre = (data["senderName"] as string | undefined) ?? null;
    setSonando((prev) => {
      if (prev.some((s) => s.call.id === call.id)) return prev;
      // Solo al EMPEZAR a sonar: cada aviso de timbre no es otra llamada.
      avisar(prefsRef.current, {
        titulo: textoDeLlamada(call),
        cuerpo: nombre ?? numeroDe(call.from),
        etiqueta: `llamada-${call.id}`, privado: false,
        alPulsar: () => router.push(`/lineas/${lineId}/chats/${encodeURIComponent(chatId)}`),
      });
      return [...prev, { lineId, chatId, nombre, call }];
    });
  }), [suscribir, router]);

  // Si el aviso de cómo acabó no llega, se retira solo al pasar el timbre.
  useEffect(() => {
    if (sonando.length === 0) return;
    const t = setInterval(() => setSonando((prev) => {
      const siguen = prev.filter((s) => suena(s.call));
      return siguen.length === prev.length ? prev : siguen;
    }), 5000);
    return () => clearInterval(t);
  }, [sonando.length]);

  if (sonando.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="shrink-0 divide-y divide-(--color-acento)/20 border-b border-(--color-acento)/30 bg-(--color-acento-tenue)">
      {sonando.map((s) => (
        <FilaDeLlamada
          key={s.call.id}
          sonando={s}
          onFin={() => setSonando((prev) => prev.filter((x) => x.call.id !== s.call.id))}
        />
      ))}
    </div>
  );
}

function FilaDeLlamada({ sonando: s, onFin }: { sonando: Sonando; onFin: () => void }) {
  const [ocupado, setOcupado] = useState(false);
  const [problema, setProblema] = useState<string | null>(null);

  const rechazar = async (): Promise<void> => {
    setOcupado(true);
    setProblema(null);
    const r = await fetch(
      `/api/omni/v1/lines/${encodeURIComponent(s.lineId)}/calls/${encodeURIComponent(s.call.id)}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: s.call.from }),
      },
    ).catch(() => null);
    setOcupado(false);
    if (r?.ok) { onFin(); return; }
    const detalle = (await r?.json().catch(() => null)) as { detail?: string } | null;
    setProblema(detalle?.detail ?? "no hay conexión con el servidor");
  };

  const Icono = s.call.isVideo ? IconoCamara : IconoTelefono;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm md:px-5">
      <Icono className="llamada-sonando size-4 shrink-0 text-(--color-acento-fuerte)" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{s.nombre ?? numeroDe(s.call.from)}</span>{" "}
        <span className="text-(--color-tenue)">
          {problema ? `No se pudo rechazar: ${problema}.` : `${textoDeLlamada(s.call)}${s.call.isGroup ? " en un grupo" : ""} · se contesta en el teléfono`}
        </span>
      </p>
      <Link
        href={`/lineas/${s.lineId}/chats/${encodeURIComponent(s.chatId)}`}
        className="shrink-0 rounded-lg px-3 py-1 text-xs font-semibold text-(--color-acento-fuerte) transition-colors duration-150 hover:bg-(--color-acento)/10"
      >
        Abrir chat
      </Link>
      <button
        type="button"
        onClick={() => void rechazar()}
        disabled={ocupado}
        className="shrink-0 rounded-lg bg-(--color-error) px-3 py-1 text-xs font-semibold text-(--color-panel) transition-opacity duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-60"
      >
        {ocupado ? "Rechazando…" : "Rechazar"}
      </button>
    </div>
  );
}

/** «+51 988 777 666» de una dirección, cuando no hay nombre. Un LID no es un número. */
function numeroDe(direccion: string): string {
  const [usuario = "", dominio] = direccion.split("@");
  return dominio === "lid" ? "Alguien sin número visible" : `+${usuario.split(":")[0]}`;
}
