"use client";

import { useState } from "react";
import type { Encuesta as Datos } from "@/lib/api";

/**
 * Una encuesta, con sus votos.
 *
 * Antes se pintaba como la palabra «Encuesta» dentro de una burbuja: ni la
 * pregunta, ni las opciones, ni quién había votado qué. La pregunta y las
 * opciones siempre estuvieron en el nodo original; los votos llegan cifrados y
 * uno a uno, y es el servidor quien los abre y los cuenta.
 *
 * La barra va DETRÁS del texto y no al lado: así la opción más votada se ve
 * antes de leerla, que es para lo que se mira una encuesta, y las opciones
 * largas no se parten en dos columnas.
 *
 * Con `onVotar`, cada opción es un botón y se vota como en WhatsApp: en una de
 * una respuesta, pulsar elige esa y pulsar la propia la retira; en una de
 * varias, cada pulsación marca o desmarca. Lo que se manda es el voto entero.
 */
export function Encuesta({ datos, onVotar }: {
  datos: Datos;
  /** Devuelve el motivo si no se pudo, para enseñarlo bajo la encuesta. */
  onVotar?: (opciones: string[]) => Promise<string | null>;
}) {
  const { question, options, totalVotes, allowMultiple } = datos;
  const [fallo, setFallo] = useState<string | null>(null);

  const pulsar = async (nombre: string): Promise<void> => {
    if (!onVotar) return;
    const mias = options.filter((o) => o.mine).map((o) => o.name);
    const ya = mias.includes(nombre);
    const voto = allowMultiple
      ? (ya ? mias.filter((o) => o !== nombre) : [...mias, nombre])
      : (ya ? [] : [nombre]);
    setFallo(null);
    setFallo(await onVotar(voto));
  };
  // El reparto se calcula sobre el MÁXIMO, no sobre el total: con opción
  // múltiple los votos suman más que los votantes y las barras se saldrían.
  const tope = Math.max(1, ...options.map((o) => o.votes));

  return (
    <div className="min-w-[14rem] space-y-1.5">
      {question && (
        <p className="text-sm font-medium wrap-anywhere whitespace-pre-wrap">{question}</p>
      )}

      <p className="text-[11px] text-(--color-tenue)">
        {allowMultiple ? "Varias respuestas" : "Una respuesta"}
        {" · "}
        {totalVotes === 1 ? "1 voto" : `${totalVotes} votos`}
      </p>

      <ul className="space-y-1">
        {options.map((o) => (
          <li
            key={o.name}
            className="relative overflow-hidden rounded-md border border-(--color-borde-sutil)"
          >
            {/*
              El botón cubre la fila entera por encima de la barra: la diana es
              la opción, no la bolita, y en una lista de cinco se acierta sin mirar.
            */}
            {onVotar && (
              <button
                type="button"
                aria-pressed={o.mine}
                aria-label={`${o.mine ? "Quitar mi voto de" : "Votar"} «${o.name}»`}
                onClick={() => void pulsar(o.name)}
                className="absolute inset-0 z-10 cursor-pointer rounded-md transition-colors hover:bg-(--color-acento)/10 focus-visible:outline-2 focus-visible:outline-(--color-acento)"
              />
            )}
            <span
              aria-hidden
              className={`absolute inset-y-0 left-0 ${
                o.mine ? "bg-(--color-acento)/25" : "bg-(--color-hundido)"
              }`}
              style={{ width: `${Math.round((o.votes / tope) * 100)}%` }}
            />
            <span className="relative flex items-center gap-2 px-2 py-1.5">
              {/*
                La marca de lo votado por esta línea. Dibujada y no un emoji:
                va junto a texto cincuenta veces y tiene que heredar el color.
              */}
              <span
                aria-hidden
                className={`flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
                  o.mine
                    ? "border-(--color-acento) bg-(--color-acento)"
                    : "border-(--color-apagado)"
                }`}
              >
                {o.mine && <span className="size-1.5 rounded-full bg-(--color-sobre-acento)" />}
              </span>
              <span className="min-w-0 flex-1 text-xs wrap-anywhere">{o.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-(--color-tenue)">
                {o.votes}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {fallo && (
        <p role="alert" className="text-[11px] text-(--color-error)">
          No se pudo votar: {fallo}.
        </p>
      )}
    </div>
  );
}
