"use client";

import { useEffect, useRef, useState } from "react";
import type { Medio } from "@/lib/api";
import { IconoMicrofono } from "./iconos";
import { Avatar } from "./piezas";

/**
 * Una nota de voz como en WhatsApp: botón redondo, la onda del audio que se
 * va llenando, la duración y la velocidad (1×, 1,5×, 2×).
 *
 * El `<audio controls>` del navegador cambiaba de aspecto en cada sistema, no
 * decía cuánto duraba antes de darle (las notas grabadas en webm dan
 * «Infinity») y no dejaba acelerar, que es lo primero que hace la gente con
 * una nota larga.
 *
 * La onda sale del propio audio, decodificado en el navegador cuando la nota
 * aparece en pantalla: el mensaje no trae la que manda WhatsApp. Si no se
 * puede decodificar, se dibuja una a partir de la dirección, para que la
 * burbuja tenga siempre la misma forma.
 */

const BARRAS = 36;
const VELOCIDADES = [1, 1.5, 2] as const;
/** Al empezar una, las demás se paran: dos notas a la vez no se entienden. */
const EVENTO = "omni:nota-de-voz";

interface Analisis { barras: number[]; segundos: number | null }
const cache = new Map<string, Promise<Analisis>>();
let contexto: AudioContext | null = null;

function ondaDeReserva(clave: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < clave.length; i++) h = Math.imul(h ^ clave.charCodeAt(i), 16777619);
  return Array.from({ length: BARRAS }, () => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return 0.25 + ((h >>> 0) % 1000) / 1000 * 0.75;
  });
}

async function analizar(url: string, clave: string): Promise<Analisis> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const datos = await r.arrayBuffer();
    contexto ??= new AudioContext();
    const audio = await contexto.decodeAudioData(datos);
    const canal = audio.getChannelData(0);
    const tramo = Math.max(1, Math.floor(canal.length / BARRAS));
    const crudas = Array.from({ length: BARRAS }, (_, i) => {
      let suma = 0;
      for (let j = i * tramo; j < (i + 1) * tramo && j < canal.length; j++) suma += canal[j]! * canal[j]!;
      return Math.sqrt(suma / tramo);
    });
    const max = Math.max(...crudas, 1e-6);
    return { barras: crudas.map((v) => 0.15 + 0.85 * (v / max)), segundos: audio.duration };
  } catch {
    return { barras: ondaDeReserva(clave), segundos: null };
  }
}

function reloj(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function NotaDeVoz({ medio, quien, pie, reproducida = false }: {
  medio: Medio;
  /** De quién es: su foto va a la izquierda con el micrófono encima, como en WhatsApp. */
  quien?: { nombre: string; direccion: string; url?: string | null } | undefined;
  /** La hora y los checks, en la misma fila que la duración (sin otra línea debajo). */
  pie?: React.ReactNode;
  /** El otro ya la escuchó (acuse «played»): micrófono azul. */
  reproducida?: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const caja = useRef<HTMLDivElement>(null);
  // La clave es la dirección sin la firma: la firma cambia y la nota no.
  const clave = medio.url.split("?")[0]!;
  const [onda, setOnda] = useState<number[]>(() => ondaDeReserva(clave));
  const [duracion, setDuracion] = useState<number | null>(null);
  const [actual, setActual] = useState(0);
  const [sonando, setSonando] = useState(false);
  const [velocidad, setVelocidad] = useState<(typeof VELOCIDADES)[number]>(1);
  const [escuchada, setEscuchada] = useState(false);
  // Las notas de voz de WhatsApp son OGG/Opus; un MP3 o M4A es un fichero de audio.
  const esNota = /ogg|opus|webm/i.test(medio.mimeType);

  // La onda sólo cuando la nota se ve: una conversación con cien notas no baja cien audios.
  useEffect(() => {
    const el = caja.current;
    if (!el) return;
    let vivo = true;
    const obs = new IntersectionObserver((entradas) => {
      if (!entradas.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      let p = cache.get(clave);
      if (!p) { p = analizar(medio.url, clave); cache.set(clave, p); }
      void p.then((a) => {
        if (!vivo) return;
        setOnda(a.barras);
        if (a.segundos && Number.isFinite(a.segundos)) setDuracion((d) => d ?? a.segundos);
      });
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => { vivo = false; obs.disconnect(); };
  }, [clave, medio.url]);

  useEffect(() => {
    const parar = (e: Event): void => {
      if ((e as CustomEvent).detail !== audio.current) audio.current?.pause();
    };
    window.addEventListener(EVENTO, parar);
    return () => window.removeEventListener(EVENTO, parar);
  }, []);

  const alternar = (): void => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) {
      window.dispatchEvent(new CustomEvent(EVENTO, { detail: a }));
      a.playbackRate = velocidad;
      void a.play().catch(() => setSonando(false));
    } else a.pause();
  };

  const saltar = (e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>): void => {
    const a = audio.current;
    const total = duracion ?? a?.duration;
    if (!a || !total || !Number.isFinite(total)) return;
    if ("key" in e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      a.currentTime = Math.min(total, Math.max(0, a.currentTime + (e.key === "ArrowRight" ? 5 : -5)));
    } else {
      const r = e.currentTarget.getBoundingClientRect();
      a.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * total;
    }
    setActual(a.currentTime);
  };

  const cambiarVelocidad = (): void => {
    const i = VELOCIDADES.indexOf(velocidad);
    const v = VELOCIDADES[(i + 1) % VELOCIDADES.length]!;
    setVelocidad(v);
    if (audio.current) audio.current.playbackRate = v;
  };

  const total = duracion ?? 0;
  const avance = total > 0 ? Math.min(1, actual / total) : 0;

  // Micrófono como en WhatsApp: verde sin escuchar, azul ya escuchada.
  const micEscuchada = reproducida || escuchada;
  return (
    <div ref={caja} className="flex w-[19rem] max-w-full items-center gap-2 py-0.5">
      <audio
        ref={audio}
        src={medio.url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuracion(d);
        }}
        onTimeUpdate={(e) => setActual(e.currentTarget.currentTime)}
        onPlay={() => { setSonando(true); setEscuchada(true); }}
        onPause={() => setSonando(false)}
        onEnded={(e) => { setSonando(false); setActual(0); e.currentTarget.currentTime = 0; }}
      />

      {/* Mientras suena, la velocidad ocupa el sitio de la foto (como en WhatsApp). */}
      {sonando || velocidad !== 1 ? (
        <button
          type="button"
          onClick={cambiarVelocidad}
          aria-label={`Velocidad ${velocidad}×`}
          className="flex size-12 shrink-0 items-center justify-center"
        >
          <span className="rounded-full bg-black/10 px-2.5 py-1 text-xs font-semibold tabular-nums dark:bg-white/15">
            {String(velocidad).replace(".", ",")}×
          </span>
        </button>
      ) : (
        <span className="relative size-12 shrink-0">
          {quien ? (
            <span className="block size-12 overflow-hidden rounded-full [&>*]:size-12! [&>*]:text-sm!">
              <Avatar nombre={quien.nombre} direccion={quien.direccion} kind="pn" tamano="md" url={quien.url ?? null} />
            </span>
          ) : (
            <span className="flex size-12 items-center justify-center rounded-full bg-black/10 text-(--color-tenue) dark:bg-white/15">
              <IconoMicrofono className="size-6" />
            </span>
          )}
          {esNota && quien && (
            <span
              aria-hidden
              className={`absolute -right-1 -bottom-0.5 ${micEscuchada ? "text-[#53bdeb]" : "text-(--color-acento)"}`}
            >
              <IconoMicrofono className="size-5 drop-shadow-[0_0_1.5px_var(--color-panel)]" />
            </span>
          )}
        </span>
      )}

      <button
        type="button"
        onClick={alternar}
        aria-label={sonando ? "Pausar" : "Reproducir"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-(--color-tenue) hover:text-(--color-texto)"
      >
        {sonando ? (
          <svg viewBox="0 0 24 24" className="size-7" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="size-7 translate-x-0.5" fill="currentColor" aria-hidden>
            <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1 pt-3">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Posición de la nota"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(actual)}
          onClick={saltar}
          onKeyDown={saltar}
          className="relative flex h-6 cursor-pointer items-center gap-[2px] outline-none focus-visible:ring-2 focus-visible:ring-(--color-acento)"
        >
          {onda.map((h, i) => (
            <span
              key={i}
              className={`w-[3px] shrink-0 grow rounded-full transition-colors duration-100 ${
                (i + 0.5) / onda.length <= avance
                  ? micEscuchada ? "bg-[#53bdeb]" : "bg-(--color-acento)"
                  : "bg-current opacity-30"
              }`}
              style={{ height: `${Math.round(h * 100)}%` }}
            />
          ))}
          <span
            aria-hidden
            className={`pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow ${
              micEscuchada ? "bg-[#53bdeb]" : "bg-(--color-acento)"
            }`}
            style={{ left: `${Math.max(2, Math.min(98, avance * 100))}%` }}
          />
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-(--color-tenue) tabular-nums">
            {sonando || actual > 0 ? reloj(actual) : duracion ? reloj(duracion) : "--:--"}
          </span>
          {pie}
        </div>
      </div>
    </div>
  );
}
