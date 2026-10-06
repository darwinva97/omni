"use client";

import { useEffect, useRef } from "react";
import {
  usePreferencias, sonar, type Preferencias, type Permiso,
} from "@/lib/notificaciones";
import { IconoCampana, IconoCerrar } from "./iconos";

/**
 * Los ajustes de aviso, donde ocurren los avisos.
 *
 * Van en la cabecera de la lista de conversaciones y no en una página de
 * configuración aparte: quien quiere apagar el sonido lo quiere apagar en el
 * momento en que acaba de sonar, no después de buscarlo en un menú.
 *
 * Cada interruptor dice lo que hace EN CONCRETO, no su nombre. «Sonido» no
 * explica si suena también por los grupos ni si suena con la pestaña delante;
 * la línea de abajo sí.
 */

function Interruptor({
  titulo, detalle, puesto, onCambiar, deshabilitado,
}: {
  titulo: string;
  detalle: string;
  puesto: boolean;
  onCambiar: (v: boolean) => void;
  deshabilitado?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 ${
        deshabilitado ? "cursor-not-allowed opacity-50" : "hover:bg-(--color-hundido)"
      }`}
    >
      <input
        type="checkbox"
        checked={puesto}
        disabled={deshabilitado}
        onChange={(e) => onCambiar(e.target.checked)}
        className="sr-only"
      />
      {/*
        Dibujado y no la casilla del sistema: una casilla nativa no se puede
        alinear con el resto ni hereda el tema, y aquí hay cuatro seguidas
        donde eso se nota.
      */}
      <span
        aria-hidden
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 ${
          puesto ? "bg-(--color-acento)" : "bg-(--color-hundido)"
        }`}
      >
        <span
          className={`size-4 rounded-full bg-(--color-panel) shadow-sm transition-transform duration-150 ${
            puesto ? "translate-x-4" : ""
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm">{titulo}</span>
        <span className="block text-xs text-(--color-tenue)">{detalle}</span>
      </span>
    </label>
  );
}

function explicar(permiso: Permiso, prefs: Preferencias): string | null {
  if (permiso === "no-disponible") {
    return "Este navegador no admite avisos del sistema. El sonido sí funciona.";
  }
  if (permiso === "denegado") {
    return "El navegador tiene bloqueados los avisos para este sitio. Hay que "
      + "desbloquearlos en sus ajustes; desde aquí no se puede volver a pedir.";
  }
  if (prefs.escritorio) {
    return "Los avisos del sistema solo salen con la pestaña de fondo: con ella "
      + "delante basta el sonido y la conversación subiendo en la lista.";
  }
  return null;
}

export function AjustesAvisos({ onCerrar }: { onCerrar: () => void }) {
  const { prefs, permiso, cambiar } = usePreferencias();
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

  const nota = explicar(permiso, prefs);

  return (
    <div
      ref={caja}
      role="dialog"
      aria-label="Avisos"
      className="absolute top-full right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-(--color-borde) bg-(--color-panel) p-2 shadow-[0_8px_28px_rgba(0,0,0,0.18)]"
    >
      <div className="flex items-center justify-between px-2 py-1">
        <h2 className="text-sm font-semibold">Avisos</h2>
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar"
          className="flex size-7 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido)"
        >
          <IconoCerrar className="size-4" />
        </button>
      </div>

      <Interruptor
        titulo="Sonido"
        detalle="Una señal corta al llegar algo de una conversación que no tienes abierta."
        puesto={prefs.sonido}
        onCambiar={(v) => {
          void cambiar({ sonido: v });
          // Al encenderlo suena una vez: así se sabe qué se acaba de activar
          // sin esperar a que alguien escriba. Y el clic desbloquea el audio.
          if (v) sonar();
        }}
      />
      <Interruptor
        titulo="Avisos del sistema"
        detalle="Una notificación del escritorio cuando la pestaña está de fondo."
        puesto={prefs.escritorio}
        deshabilitado={permiso === "denegado" || permiso === "no-disponible"}
        onCambiar={(v) => void cambiar({ escritorio: v })}
      />
      <Interruptor
        titulo="Enseñar el mensaje"
        detalle="Con esto apagado el aviso dice «Mensaje nuevo» sin el texto ni el nombre."
        puesto={prefs.vistaPrevia}
        deshabilitado={!prefs.escritorio}
        onCambiar={(v) => void cambiar({ vistaPrevia: v })}
      />
      <Interruptor
        titulo="Contador en la pestaña"
        detalle="El número de pendientes delante del título, para verlo sin volver."
        puesto={prefs.contadorEnTitulo}
        onCambiar={(v) => void cambiar({ contadorEnTitulo: v })}
      />

      {nota && (
        <p className="mx-2 mt-1 mb-1 border-t border-(--color-borde-sutil) pt-2 text-xs text-(--color-tenue)">
          {nota}
        </p>
      )}

      <p className="mx-2 mb-1 text-xs text-(--color-apagado)">
        Para callar una conversación concreta, silénciala en su menú: ese
        silencio es el de WhatsApp y vale también en el teléfono.
      </p>
    </div>
  );
}

export { IconoCampana };
