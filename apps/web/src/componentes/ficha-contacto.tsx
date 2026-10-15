"use client";

import { useEffect, useMemo, useState } from "react";
import type { Chat, Mensaje } from "@/lib/api";
import { diaDeSeparador, hora } from "@/lib/formato";
import { Avatar } from "./piezas";
import type { Resultado } from "./buscar-en-chat";
import { IconoCerrar, IconoDocumento, IconoEstrella } from "./iconos";
import { Temporales } from "./temporales";

/** Un destacado, como lo da la API. */
interface Destacado {
  id: string; providerMessageId: string | null; fromMe: boolean;
  senderName: string | null; kind: string; body: string | null; timestamp: string;
}

/** Lo que se lee de un destacado sin texto: qué es. */
const QUE_ES: Record<string, string> = {
  image: "Foto", video: "Vídeo", audio: "Audio", document: "Documento", sticker: "Sticker",
  poll: "Encuesta", contact: "Contacto", location: "Ubicación",
};

/**
 * La ficha de la conversación.
 *
 * WhatsApp la abre a la derecha y no en una ventana modal, y tiene razón: se
 * consulta MIENTRAS se lee el hilo —«¿qué número es este?», «¿cuántos somos en
 * el grupo?»— y un modal taparía justo lo que se está consultando.
 *
 * Lo que enseña sale de lo que ya tenemos: nada inventado. Los medios se sacan
 * del hilo cargado, así que son los recientes y no «todos», y lo dice.
 */
export function FichaContacto({
  lineId, info, mensajes, versionDestacados, onIrA, onCerrar,
}: {
  lineId: string;
  info: Chat;
  mensajes: Mensaje[];
  /** Cambia cuando se destaca o se quita algo en el hilo: hay que volver a pedir. */
  versionDestacados: number;
  /** Lleva a un mensaje del hilo, aunque sea de hace meses. */
  onIrA: (r: Resultado) => void;
  onCerrar: () => void;
}) {
  /*
   * Los destacados se piden a la API y no se sacan del hilo: el hilo trae los
   * últimos cien, y lo que se destaca para acordarse suele ser de antes.
   */
  const [destacados, setDestacados] = useState<{ de: string; lista: Destacado[] } | null>(null);
  useEffect(() => {
    let vivo = true;
    void fetch(`/api/omni/v1/lines/${lineId}/chats/${encodeURIComponent(info.address)}/starred`)
      .then(async (r) => (r.ok ? ((await r.json()) as { data: Destacado[] }).data : []))
      .catch(() => [] as Destacado[])
      .then((lista) => { if (vivo) setDestacados({ de: info.address, lista }); });
    return () => { vivo = false; };
  }, [lineId, info.address, versionDestacados]);
  const estrellas = destacados?.de === info.address ? destacados.lista : null;

  const medios = useMemo(
    () => mensajes.filter((m) => m.media && (m.kind === "image" || m.kind === "video"))
      .slice(-12).reverse(),
    [mensajes],
  );
  const documentos = useMemo(
    () => mensajes.filter((m) => m.media && m.kind === "document").slice(-6).reverse(),
    [mensajes],
  );

  const tipo = info.kind === "group" ? "Grupo"
    : info.kind === "broadcast" ? "Difusión"
    : info.kind === "lid" ? "Contacto" : "Contacto";

  return (
    <aside className="scroll-discreto absolute inset-0 z-20 flex flex-col overflow-y-auto border-l border-(--color-borde) bg-(--color-panel) md:static md:z-auto md:w-80 md:shrink-0">
      <header className="flex items-center gap-2 border-b border-(--color-borde) px-4 py-2.5">
        <h2 className="flex-1 text-sm font-semibold">Información</h2>
        <button
          type="button"
          onClick={onCerrar}
          aria-label="Cerrar la información"
          className="flex size-8 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
        >
          <IconoCerrar className="size-4" />
        </button>
      </header>

      <div className="flex flex-col items-center gap-3 border-b border-(--color-borde) px-6 py-7 text-center">
        <Avatar
          nombre={info.displayName}
          direccion={info.address}
          kind={info.kind}
          tamano="lg"
          url={info.avatarUrl}
        />
        <div className="min-w-0">
          <p className="text-base font-semibold wrap-anywhere">{info.displayName}</p>
          <p className="mt-0.5 text-sm text-(--color-tenue)">{tipo}</p>
        </div>
      </div>

      <dl className="divide-y divide-(--color-borde-sutil) px-4 text-sm">
        {/*
          Los nombres, cada uno dicho por lo que es, en el mismo orden en
          que se eligen para enseñar: agenda, el suyo, su @usuario.
          Saber que alguien está guardado como «Juan» y se llama a sí mismo
          «Juan Pérez — Ventas» es información útil, no ruido: explica por qué
          la lista dice una cosa y el teléfono de otro dice otra.
        */}
        {info.savedName && (
          <div className="py-3">
            <dt className="text-xs text-(--color-tenue)">En tu agenda</dt>
            <dd className="mt-0.5 font-medium">{info.savedName}</dd>
          </div>
        )}
        {info.pushName && info.pushName !== info.savedName && (
          <div className="py-3">
            <dt className="text-xs text-(--color-tenue)">Se llama a sí mismo</dt>
            <dd className="mt-0.5">{info.pushName}</dd>
          </div>
        )}
        {info.username && (
          <div className="py-3">
            <dt className="text-xs text-(--color-tenue)">Usuario de WhatsApp</dt>
            <dd className="mt-0.5">@{info.username}</dd>
          </div>
        )}
        {info.phone && (
          <div className="py-3">
            <dt className="text-xs text-(--color-tenue)">Teléfono</dt>
            <dd className="mt-0.5 font-medium">+{info.phone.split("@")[0]}</dd>
          </div>
        )}
        <div className="py-3">
          <dt className="text-xs text-(--color-tenue)">Dirección</dt>
          {/*
            La dirección es dato técnico, no identidad. Va aquí abajo, en
            monoespaciada y seleccionable, porque hace falta para la API y para
            un informe de fallo, pero no sirve para reconocer a nadie.
          */}
          <dd className="mt-0.5 font-mono text-xs wrap-anywhere text-(--color-tenue) select-all">
            {info.address}
          </dd>
        </div>
        {info.kind === "group" && info.title && (
          <div className="py-3">
            <dt className="text-xs text-(--color-tenue)">Asunto del grupo</dt>
            <dd className="mt-0.5">{info.title}</dd>
          </div>
        )}
      </dl>

      {medios.length > 0 && (
        <section className="border-t border-(--color-borde) px-4 py-4">
          <h3 className="text-xs font-medium text-(--color-tenue)">
            Fotos y vídeos recientes
          </h3>
          <div className="mt-2.5 grid grid-cols-3 gap-1.5">
            {medios.map((m) => (
              <a
                key={m.id}
                href={m.media!.url}
                target="_blank"
                rel="noreferrer"
                className="aspect-square overflow-hidden rounded-lg bg-(--color-hundido)"
              >
                {m.kind === "image" ? (
                  <img
                    src={m.media!.url}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover transition-transform duration-150 hover:scale-105"
                  />
                ) : (
                  <video src={m.media!.url} preload="metadata" className="size-full object-cover" />
                )}
              </a>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-(--color-apagado)">
            De lo que hay cargado en esta conversación, no de todo el historial.
          </p>
        </section>
      )}

      {/* Un canal no tiene con quién acordar que los mensajes caduquen. */}
      {info.kind !== "newsletter" && info.kind !== "broadcast" && (
        <Temporales lineId={lineId} chat={info.address} actuales={info.ephemeralSeconds ?? null} />
      )}

      {/*
        Los destacados de esta conversación, los últimos primero. Pulsar uno
        lleva a él en el hilo, aunque sea de hace meses: es el mismo salto que
        el de la búsqueda.
      */}
      <section className="border-t border-(--color-borde) px-4 py-4">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-(--color-tenue)">
          <IconoEstrella className="size-3.5" />
          Mensajes destacados
          {estrellas && estrellas.length > 0 && (
            <span className="ml-auto tabular-nums text-(--color-apagado)">{estrellas.length}</span>
          )}
        </h3>
        {estrellas === null ? null : estrellas.length === 0 ? (
          <p className="mt-2 text-xs text-(--color-apagado)">
            Ninguno. Destaca un mensaje desde su menú (clic derecho) para encontrarlo aquí.
          </p>
        ) : (
          <ul className="mt-2 space-y-0.5">
            {estrellas.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onIrA({
                    id: d.id, providerMessageId: d.providerMessageId, timestamp: d.timestamp,
                    fromMe: d.fromMe, senderName: d.senderName, kind: d.kind, texto: d.body ?? "",
                  })}
                  className="block w-full rounded-lg px-2 py-2 text-left hover:bg-(--color-hundido)"
                >
                  <span className="flex items-baseline justify-between gap-2 text-[11px] text-(--color-apagado)">
                    <span className="truncate font-medium text-(--color-tenue)">
                      {d.fromMe ? "Tú" : d.senderName ?? info.displayName}
                    </span>
                    <span className="shrink-0">{diaDeSeparador(d.timestamp)}, {hora(d.timestamp)}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-sm wrap-anywhere">
                    {d.body || <em className="text-(--color-tenue)">{QUE_ES[d.kind] ?? "Mensaje"}</em>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {documentos.length > 0 && (
        <section className="border-t border-(--color-borde) px-4 py-4">
          <h3 className="text-xs font-medium text-(--color-tenue)">Documentos</h3>
          <ul className="mt-2 space-y-1">
            {documentos.map((m) => (
              <li key={m.id}>
                <a
                  href={m.media!.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm hover:bg-(--color-hundido)"
                >
                  <IconoDocumento className="size-4 shrink-0 text-(--color-tenue)" />
                  <span className="truncate">{m.media!.fileName ?? "Documento"}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
