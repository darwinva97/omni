"use client";

import { useState } from "react";
import type { Conversacion, EstadoDeConversacion, Miembro } from "@/lib/api";
import { ESTADOS, cambiarAtencion, nombreDeResponsable, type CambioDeAtencion } from "@/lib/atencion";
import { iniciales, tonoDe } from "@/lib/formato";
import { Menu, useMenu, type OpcionMenu } from "./menu";
import { IconoDesplegar, IconoPersona, IconoReabrir, IconoResuelta } from "./iconos";

/**
 * Las iniciales de alguien del equipo, en pequeño.
 *
 * Es la marca de «esto lo lleva Ana» en la lista: un círculo de dieciséis
 * píxeles se reconoce de un vistazo sin quitarle sitio al adelanto del último
 * mensaje. El tono sale de su identificador, así que Ana es siempre del mismo
 * color en toda la lista.
 */
export function Responsable({
  id, nombre, mio, className = "size-4.5 text-[9px]",
}: {
  id: string; nombre: string; mio: boolean; className?: string;
}) {
  const tono = tonoDe(id);
  return (
    <span
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center rounded-full font-semibold select-none ${
        mio ? "ring-2 ring-(--color-acento) ring-offset-1 ring-offset-(--color-panel)" : ""
      }`}
      style={{ background: `oklch(0.9 0.055 ${tono})`, color: `oklch(0.35 0.09 ${tono})` }}
    >
      {iniciales(nombre) || <IconoPersona className="size-3" />}
    </span>
  );
}

/**
 * Responsable y estado, en la cabecera de la conversación.
 *
 * Resolver es UN clic, en un botón propio y a la vista: es lo que se hace al
 * terminar cada conversación, decenas de veces al día, y meterlo en un menú
 * lo convertiría en tres. El resto de estados —pendiente, pospuesta— son
 * menos frecuentes y van en el pico de al lado.
 *
 * Los cambios se pintan al instante y se deshacen si el servidor dice que no,
 * con el motivo: una asignación que tarda medio segundo en verse se pulsa dos
 * veces, y una que falla en silencio deja a dos personas creyendo que el
 * cliente lo lleva la otra.
 */
export function ControlesDeAtencion({
  lineId, chat, conv, miembros, yo, onCambio, onError,
}: {
  lineId: string;
  chat: string;
  conv: Conversacion | null;
  miembros: readonly Miembro[];
  yo: string | null;
  onCambio: (c: Conversacion | null) => void;
  onError: (motivo: string | null) => void;
}) {
  const menuResponsable = useMenu();
  const menuEstado = useMenu();
  const [ocupado, setOcupado] = useState(false);

  const viva = conv && conv.status !== "resolved" ? conv : null;
  const responsable = viva?.assigneeId ?? null;
  const nombre = nombreDeResponsable(responsable, miembros, yo);
  const resuelta = conv?.status === "resolved";

  const cambiar = async (cambio: CambioDeAtencion): Promise<void> => {
    if (ocupado) return;
    setOcupado(true);
    onError(null);
    const antes = conv;
    // Lo que se pinta mientras contesta el servidor. Sin conversación todavía,
    // se espera a la respuesta: no hay nada que pintar por adelantado.
    if (conv) {
      onCambio({
        ...conv,
        ...(cambio.status ? { status: cambio.status } : {}),
        ...(cambio.assigneeId !== undefined ? { assigneeId: cambio.assigneeId } : {}),
      });
    }
    const r = await cambiarAtencion(lineId, chat, conv, cambio);
    setOcupado(false);
    if ("error" in r) {
      onCambio(antes);
      onError(r.error);
      return;
    }
    onCambio(r.conv);
  };

  const opcionesResponsable: OpcionMenu[] = [
    ...(yo && responsable !== yo
      ? [{ texto: "Asignarme", Icono: IconoPersona, onSelect: () => cambiar({ assigneeId: yo }) }]
      : []),
    ...miembros
      .filter((m) => m.userId !== yo && m.userId !== responsable)
      .map((m) => ({ texto: m.name, onSelect: () => cambiar({ assigneeId: m.userId }) })),
    ...(responsable
      ? [{ texto: "Quitar responsable", peligro: true, onSelect: () => cambiar({ assigneeId: null }) }]
      : []),
  ];

  const opcionesEstado: OpcionMenu[] = (Object.keys(ESTADOS) as EstadoDeConversacion[])
    .filter((e) => e !== (conv?.status ?? null))
    .map((e) => ({ texto: ESTADOS[e].texto, onSelect: () => cambiar({ status: e }) }));

  const estado = conv?.status ?? null;
  // Las iniciales de «Tú» serían «TÚ»: se pintan las del nombre de verdad.
  const nombreCompleto = responsable
    ? miembros.find((m) => m.userId === responsable)?.name ?? nombre ?? "?"
    : null;
  const etiqueta = !nombre
    ? "Nadie lleva este chat. Asignar"
    : nombre === "Tú" ? "Lo llevas tú. Cambiar responsable" : `Lo lleva ${nombre}. Cambiar responsable`;

  return (
    <>
      <button
        type="button"
        onClick={(e) => menuResponsable.enBoton(e)}
        disabled={ocupado}
        aria-haspopup="menu"
        aria-label={etiqueta}
        title={etiqueta}
        className="flex h-9 max-w-40 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-(--color-tenue) transition-colors duration-150 hover:bg-(--color-hundido) hover:text-(--color-texto) active:scale-[0.97] disabled:opacity-60"
      >
        {responsable && nombreCompleto
          ? <Responsable id={responsable} nombre={nombreCompleto} mio={responsable === yo} className="size-5 text-[9px]" />
          : <IconoPersona className="size-4.5" />}
        <span className="hidden truncate lg:inline">{nombre ?? "Asignar"}</span>
      </button>

      {/*
        Resolver y el resto de estados: un botón partido. El lado grande hace
        lo de siempre en un clic; el pico abre los demás estados y dice en cuál
        está cuando no es el normal.
      */}
      <div className="flex h-9 shrink-0 items-stretch overflow-hidden rounded-lg border border-(--color-borde)">
        <button
          type="button"
          onClick={() => void cambiar({ status: resuelta ? "open" : "resolved" })}
          disabled={ocupado}
          title={resuelta ? "Reabrir: vuelve a la bandeja" : "Resolver: ya está atendida"}
          aria-label={resuelta ? "Reabrir la conversación" : "Resolver la conversación"}
          className={`flex items-center gap-1.5 px-2 text-xs font-medium transition-colors duration-150 active:scale-[0.97] disabled:opacity-60 ${
            resuelta
              ? "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
              : "text-(--color-exito) hover:bg-(--color-exito-tenue)"
          }`}
        >
          {resuelta ? <IconoReabrir className="size-4.5" /> : <IconoResuelta className="size-4.5" />}
          <span className="hidden lg:inline">{resuelta ? "Reabrir" : "Resolver"}</span>
        </button>
        <button
          type="button"
          onClick={(e) => menuEstado.enBoton(e)}
          disabled={ocupado}
          aria-haspopup="menu"
          aria-label={`Estado: ${estado ? ESTADOS[estado].texto : "sin conversación"}. Cambiar`}
          title={estado ? `${ESTADOS[estado].texto}: ${ESTADOS[estado].explica}. Cambiar el estado` : "Cambiar el estado"}
          className="flex items-center gap-1 border-l border-(--color-borde) px-1.5 text-xs text-(--color-tenue) transition-colors duration-150 hover:bg-(--color-hundido) hover:text-(--color-texto) disabled:opacity-60"
        >
          {(estado === "pending" || estado === "snoozed") && (
            <span className="hidden font-medium text-(--color-aviso) sm:inline">{ESTADOS[estado].texto}</span>
          )}
          {estado === "resolved" && (
            <span className="hidden font-medium text-(--color-exito) sm:inline">Resuelta</span>
          )}
          <IconoDesplegar className="size-4" />
        </button>
      </div>

      <Menu punto={menuResponsable.punto} opciones={opcionesResponsable} onCerrar={menuResponsable.cerrar} />
      <Menu punto={menuEstado.punto} opciones={opcionesEstado} onCerrar={menuEstado.cerrar} />
    </>
  );
}
