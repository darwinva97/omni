"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LecturaDeTelefono } from "@/lib/telefono";
import { IconoAlerta, IconoEnviar } from "./iconos";

type Estado =
  | { tipo: "listo" }
  | { tipo: "comprobando" }
  | { tipo: "no-tiene" }
  /** No se pudo saber: el transporte no sabe comprobarlo, o la línea no responde. */
  | { tipo: "sin-saber"; motivo: string };

/**
 * «Escribir a +51 987 654 321», para un número que no está ni en los chats
 * ni en la agenda.
 *
 * Antes de abrir se pregunta a WhatsApp si ese número lo tiene: abrir un chat
 * con alguien que no está en WhatsApp y escribirle es mandar mensajes que no
 * van a llegar nunca, y el acuse se quedaría en un reloj sin explicación.
 *
 * Si el transporte no puede saberlo —la API oficial no lo dice—, se deja abrir
 * igual, avisando de por qué no se comprobó: bloquearlo sería dejar a esa
 * línea sin forma de escribir a nadie nuevo.
 *
 * Se abre por el mismo camino que un contacto de la agenda sin chat: la ruta
 * del chat con su dirección. El chat existe de verdad con el primer mensaje.
 */
export function EscribirANumero({
  lineId, lectura, onAbierto,
}: {
  lineId: string;
  lectura: LecturaDeTelefono;
  /** Al abrir el chat: la lista limpia la búsqueda, como en WhatsApp. */
  onAbierto: () => void;
}) {
  const router = useRouter();
  const [estado, setEstado] = useState<{ para: string; e: Estado }>({ para: "", e: { tipo: "listo" } });
  const numero = lectura.ok ? lectura.numero : "";
  // Lo comprobado es de ESE número: al seguir tecleando, vuelve a estar listo.
  const actual = estado.para === numero ? estado.e : { tipo: "listo" as const };

  if (!lectura.ok) {
    return (
      <p className="flex items-start gap-2 border-b border-(--color-borde-sutil) px-4 py-3 text-xs text-(--color-tenue)">
        <IconoAlerta className="mt-px size-4 shrink-0 text-(--color-aviso)" />
        {lectura.motivo}
      </p>
    );
  }

  const abrir = (direccion: string): void => {
    setEstado({ para: "", e: { tipo: "listo" } });
    router.push(`/lineas/${lineId}/chats/${encodeURIComponent(direccion)}`);
    onAbierto();
  };

  const comprobar = async (): Promise<void> => {
    if (actual.tipo === "comprobando") return;
    setEstado({ para: numero, e: { tipo: "comprobando" } });
    const r = await fetch(
      `/api/omni/v1/lines/${lineId}/contacts/${encodeURIComponent(numero)}/exists`,
    ).catch(() => null);
    if (!r) {
      setEstado({ para: numero, e: { tipo: "sin-saber", motivo: "No hay conexión con el servidor." } });
      return;
    }
    const cuerpo = (await r.json().catch(() => null)) as
      { data?: { exists: boolean; address: string | null }; detail?: string } | null;
    if (r.ok && cuerpo?.data) {
      if (!cuerpo.data.exists) { setEstado({ para: numero, e: { tipo: "no-tiene" } }); return; }
      // La dirección que da WhatsApp, si la da: es la que usará el chat.
      abrir(cuerpo.data.address ?? `${numero}@s.whatsapp.net`);
      return;
    }
    /*
     * 422: este transporte no sabe comprobarlo, y lo dice con el motivo —que
     * nombra cuál sí—. Otro fallo (la línea desconectada, por ejemplo) tampoco
     * dice que NO lo tenga. En los dos casos se puede abrir igualmente.
     */
    setEstado({
      para: numero,
      e: { tipo: "sin-saber", motivo: cuerpo?.detail ?? `la comprobación falló (${r.status})` },
    });
  };

  return (
    <div className="border-b border-(--color-borde-sutil)">
      <button
        type="button"
        onClick={() => void comprobar()}
        disabled={actual.tipo === "comprobando"}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-(--color-hundido) disabled:cursor-wait"
      >
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-(--color-acento-tenue) text-(--color-acento-fuerte)">
          <IconoEnviar className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">Escribir a {lectura.bonito}</span>
          <span className="block truncate text-xs text-(--color-tenue)">
            {actual.tipo === "comprobando"
              ? "Comprobando si tiene WhatsApp…"
              : lectura.prefijoSupuesto
                ? `Con el prefijo +${lectura.prefijoSupuesto} de esta línea. No está en tu agenda.`
                : "No está en tu agenda ni en tus chats."}
          </span>
        </span>
      </button>

      {actual.tipo === "no-tiene" && (
        <p role="status" className="flex items-start gap-2 px-4 pb-3 text-xs text-(--color-error)">
          <IconoAlerta className="mt-px size-4 shrink-0" />
          {lectura.bonito} no tiene WhatsApp. Revisa el número
          {lectura.prefijoSupuesto ? `, y si es de otro país, escríbelo con su prefijo (+…)` : ""}.
        </p>
      )}

      {actual.tipo === "sin-saber" && (
        <div role="status" className="flex items-start gap-2 px-4 pb-3 text-xs text-(--color-tenue)">
          <IconoAlerta className="mt-px size-4 shrink-0 text-(--color-aviso)" />
          <span className="min-w-0 flex-1">
            No se pudo comprobar si tiene WhatsApp: {actual.motivo}. Puedes abrir el chat igualmente;
            si no lo tiene, el mensaje no llegará.
            <button
              type="button"
              onClick={() => abrir(`${numero}@s.whatsapp.net`)}
              className="mt-1.5 block font-semibold text-(--color-acento-fuerte) hover:underline"
            >
              Abrir el chat igualmente
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
