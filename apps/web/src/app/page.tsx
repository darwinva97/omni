import Link from "next/link";
import { apiFetchAuth, type Linea, type Yo } from "@/lib/api";
import { Pagina } from "@/componentes/armazon";
import { Aviso, Avatar, Estado, Vacio } from "@/componentes/piezas";
import { IconoCanal } from "@/componentes/iconos";
import { MenuLinea } from "./menu-linea";

/**
 * Las líneas: la portada del panel.
 *
 * Es lo primero que se ve al entrar y lo que menos se mira después, así que su
 * trabajo es uno solo: decir de un vistazo si todo sigue conectado y dejar
 * entrar a la que haga falta.
 */
export default async function Lineas() {
  const [yo, lineas] = await Promise.all([
    apiFetchAuth<Yo>("/v1/auth/me"),
    apiFetchAuth<Linea[]>("/v1/lines"),
  ]);

  const noOficiales = lineas.filter(
    (l) => l.channelKind.startsWith("whatsapp.") && l.channelKind !== "whatsapp.cloud",
  );
  const caidas = lineas.filter((l) => l.status !== "connected" && l.enabled);

  return (
    <Pagina
      actual="/"
      titulo="Líneas"
      descripcion={`${yo.name}${yo.role ? ` · ${yo.role}` : ""}`}
      acciones={
        <Link
          href="/lineas/nueva"
          className="rounded-lg bg-(--color-acento) px-3.5 py-2 text-sm font-medium text-(--color-sobre-acento) transition-opacity duration-150 hover:opacity-90"
        >
          Nueva línea
        </Link>
      }
    >
      <div className="space-y-5">
        {caidas.length > 0 && (
          <Aviso tono="error">
            <strong>
              {caidas.length === 1
                ? "Una línea no está conectada"
                : `${caidas.length} líneas no están conectadas`}
            </strong>
            . Mientras tanto no reciben ni envían nada: ábrelas para reconectar.
          </Aviso>
        )}

        {noOficiales.length > 0 && (
          <Aviso>
            <strong>
              {noOficiales.length === 1
                ? "Una línea usa un cliente no oficial de WhatsApp"
                : `${noOficiales.length} líneas usan un cliente no oficial de WhatsApp`}
            </strong>
            . La cuenta puede ser restringida o baneada, y ninguna calidad de
            código evita ese riesgo: usa números que puedas permitirte perder y,
            para entornos regulados, el transporte oficial.
          </Aviso>
        )}

        {lineas.length === 0 ? (
          <Vacio
            titulo="Todavía no hay ninguna línea"
            accion={
              <Link
                href="/lineas/nueva"
                className="rounded-lg bg-(--color-acento) px-3.5 py-2 text-sm font-medium text-(--color-sobre-acento)"
              >
                Crear la primera
              </Link>
            }
          >
            Una línea es una cuenta de cualquier canal: un número de WhatsApp,
            un bot de Telegram, un buzón de correo. Empieza por una de sandbox
            si quieres probar sin teléfono.
          </Vacio>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {lineas.map((l) => (
              <li
                key={l.id}
                className="relative flex h-full items-start gap-3 rounded-xl border border-(--color-borde) bg-(--color-panel) p-4 transition-colors duration-150 hover:border-(--color-acento)"
              >
                <Link href={`/lineas/${l.id}`} className="flex min-w-0 flex-1 items-start gap-3">
                  <Avatar
                    nombre={l.name}
                    direccion={l.id}
                    kind={l.channelKind.startsWith("whatsapp") ? "pn" : "broadcast"}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{l.name}</span>
                      <Estado estado={l.enabled ? l.status : "pausada"} />
                    </span>
                    <span className="mt-1 block truncate text-xs text-(--color-tenue)">
                      {l.channelKind}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-(--color-apagado)">
                      {l.address ? `+${l.address.split("@")[0]}` : "sin número todavía"}
                      {` · ${l.sendRatePerMinute}/min`}
                      {!l.enabled && " · pausada"}
                    </span>
                  </span>
                </Link>
                <MenuLinea linea={l} />
              </li>
            ))}
          </ul>
        )}

        <p className="flex items-center gap-2 text-xs text-(--color-apagado)">
          <IconoCanal className="size-4" />
          Cada línea es una cuenta de un canal. El ritmo de envío limita cuántos
          mensajes salen por minuto: WhatsApp castiga la ráfaga más que el
          volumen.
        </p>
      </div>
    </Pagina>
  );
}
