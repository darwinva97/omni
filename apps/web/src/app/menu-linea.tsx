"use client";

import { useRouter } from "next/navigation";
import type { Linea } from "@/lib/api";
import { Menu, useMenu, type OpcionMenu } from "@/componentes/menu";
import {
  IconoBloquear, IconoMas, IconoPapelera, IconoSalir, IconoLineas,
} from "@/componentes/iconos";

/**
 * Las acciones de una línea.
 *
 * Son cuatro y están ordenadas por lo que cuesta deshacerlas: conectar y pausar
 * se deshacen solas, desvincular obliga a escanear otra vez, y borrar no se
 * deshace. Las dos últimas van separadas y en rojo.
 *
 * «Pausar» y «desconectar» NO son lo mismo y por eso están las dos: pausada, la
 * línea no envía aunque esté conectada —útil para parar una fuga sin perder la
 * sesión—; desconectada, se cae el socket pero las credenciales siguen y vuelve
 * sola al reconectar.
 */
export function MenuLinea({ linea }: { linea: Linea }) {
  const menu = useMenu();
  const router = useRouter();

  const pedir = async (ruta: string, init: RequestInit): Promise<void> => {
    const r = await fetch(`/api/omni/v1/lines/${linea.id}${ruta}`, init);
    if (r.ok) router.refresh();
    else alert((await r.json().catch(() => null))?.detail ?? "no se pudo");
  };

  const opciones: OpcionMenu[] = [
    linea.enabled
      ? {
          texto: "Pausar los envíos",
          Icono: IconoBloquear,
          onSelect: () => pedir("", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: false }),
          }),
        }
      : {
          texto: "Reanudar los envíos",
          Icono: IconoLineas,
          onSelect: () => pedir("", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: true }),
          }),
        },
    linea.status === "connected"
      ? {
          texto: "Desconectar",
          Icono: IconoSalir,
          onSelect: () => pedir("/disconnect", { method: "POST" }),
        }
      : {
          texto: "Conectar",
          Icono: IconoLineas,
          onSelect: () => pedir("/connect", { method: "POST" }),
        },
    {
      texto: "Eliminar la línea",
      peligro: true,
      Icono: IconoPapelera,
      onSelect: async () => {
        if (!confirm(
          `Se elimina «${linea.name}»: se cierra la conexión y se borran sus `
          + "credenciales, así que habrá que volver a escanear el QR para usarla.\n\n"
          + "Los mensajes se conservan: la bitácora necesita saber qué pasó.",
        )) return;
        await pedir("", { method: "DELETE" });
      },
    },
  ];

  return (
    <>
      <button
        type="button"
        aria-label={`Opciones de ${linea.name}`}
        onClick={menu.enBoton}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) transition-colors duration-150 hover:bg-(--color-hundido) hover:text-(--color-texto)"
      >
        <IconoMas className="size-4" />
      </button>
      <Menu punto={menu.punto} opciones={opciones} onCerrar={menu.cerrar} />
    </>
  );
}
