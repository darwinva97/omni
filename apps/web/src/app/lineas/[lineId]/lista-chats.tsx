"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Chat, Linea } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { cuando, resumen } from "@/lib/formato";
import { Avatar } from "@/componentes/piezas";
import {
  IconoArchivar, IconoBuscar, IconoCampana, IconoCampanaTachada, IconoCanal,
  IconoCerrar, IconoMas, IconoPapelera, IconoSilenciar,
} from "@/componentes/iconos";
import { Menu, useMenu, type OpcionMenu } from "@/componentes/menu";
import { useRouter } from "next/navigation";
import { AjustesAvisos } from "@/componentes/ajustes-avisos";
import { Silenciar } from "@/componentes/silenciar";
import {
  avisar, prepararSonido, silenciado, usePreferencias, useTituloConPendientes,
} from "@/lib/notificaciones";

/**
 * La columna de conversaciones.
 *
 * Tres cosas la hacen útil y las tres son decisiones, no adornos:
 *
 * 1. **Viva.** Escucha el mismo socket que el hilo abierto. Recargar para ver
 *    si alguien ha contestado es lo que un panel de mensajería no debe pedir.
 * 2. **Ordenada por lo último.** Lo que acaba de llegar sube. Es la única
 *    ordenación que sirve cuando hay sesenta conversaciones.
 * 3. **Buscable sin ir al servidor.** Con doscientas cargadas, filtrar en el
 *    navegador es instantáneo; pedirlo al servidor añade un viaje por letra
 *    para un resultado idéntico.
 */
export function ListaChats({ linea, iniciales }: { linea: Linea; iniciales: Chat[] }) {
  const [chats, setChats] = useState<Chat[]>(iniciales);
  const [busqueda, setBusqueda] = useState("");
  const { conectado, suscribir } = useEventos(linea.id);
  const params = useParams<{ chatId?: string }>();
  const ruta = usePathname();
  const enEstados = ruta.endsWith("/estados");
  const abierto = params.chatId ? decodeURIComponent(params.chatId) : null;
  // La conversación abierta no tiene pendientes: el contador avisaba de algo
  // que se tiene delante.
  useEffect(() => {
    if (!abierto) return;
    setChats((prev) => prev.map((c) =>
      c.address === abierto && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c));
  }, [abierto]);

  const menu = useMenu();
  const [sobre, setSobre] = useState<Chat | null>(null);
  const [silenciando, setSilenciando] = useState<Chat | null>(null);
  const [ajustes, setAjustes] = useState(false);
  const router = useRouter();

  /*
   * Los avisos.
   *
   * Viven aquí y no en la conversación abierta porque lo que hay que avisar es
   * precisamente lo que NO se está mirando, y esta lista es la única que ve
   * todas las conversaciones de la línea a la vez.
   */
  const { prefs } = usePreferencias();
  useEffect(prepararSonido, []);
  const pendientes = useMemo(
    () => chats.reduce((n, c) => n + (silenciado(c.mutedUntil) ? 0 : c.unreadCount), 0),
    [chats],
  );
  useTituloConPendientes(pendientes, prefs.contadorEnTitulo);

  /**
   * Las acciones de una conversación.
   *
   * Cada una dice EXACTAMENTE lo que hace, y el aviso de confirmación también:
   * «vaciar» toca WhatsApp y «quitar» no, y confundirlas es perder mensajes de
   * verdad o creer que se perdieron cuando siguen ahí.
   */
  const quitar = (c: Chat): void => {
    setChats((prev) => prev.filter((x) => x.address !== c.address));
    if (abierto === c.address) router.push(`/lineas/${linea.id}`);
  };

  /**
   * Silencia o reactiva, en WhatsApp y aquí.
   *
   * La lista se actualiza sin esperar al servidor: el silencio se pide justo
   * cuando una conversación está molestando, y un segundo de retraso es un
   * aviso más.
   */
  const callar = async (c: Chat, hasta: Date | null): Promise<void> => {
    setChats((prev) => prev.map((x) =>
      x.address === c.address ? { ...x, mutedUntil: hasta?.toISOString() ?? null } : x));
    const r = await fetch(
      `/api/omni/v1/lines/${linea.id}/chats/${encodeURIComponent(c.address)}/mute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ until: hasta?.toISOString() ?? null }),
      },
    );
    // Si falla, se deshace: dejarlo puesto en la lista sería prometer un
    // silencio que WhatsApp no ha aplicado.
    if (!r.ok) {
      setChats((prev) => prev.map((x) =>
        x.address === c.address ? { ...x, mutedUntil: c.mutedUntil } : x));
    }
  };

  const acciones = (c: Chat): OpcionMenu[] => {
    const pedir = async (ruta: string, init: RequestInit): Promise<boolean> => {
      const r = await fetch(`/api/omni/v1/lines/${linea.id}${ruta}`, init);
      return r.ok;
    };
    const dir = encodeURIComponent(c.address);

    return [
      silenciado(c.mutedUntil)
        ? {
            texto: "Reactivar",
            Icono: IconoCampana,
            onSelect: async () => { await callar(c, null); },
          }
        : {
            // Abre el diálogo de plazos en vez de silenciar de golpe: «un año»
            // era la única opción y es la que menos se quiere casi siempre.
            texto: "Silenciar",
            Icono: IconoSilenciar,
            onSelect: () => setSilenciando(c),
          },
      {
        texto: "Archivar",
        Icono: IconoArchivar,
        onSelect: async () => {
          await pedir(`/chats/${dir}/archive`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ archived: true }),
          });
        },
      },
      {
        texto: "Vaciar en WhatsApp",
        peligro: true,
        Icono: IconoPapelera,
        onSelect: async () => {
          if (!confirm(
            `Se vaciará «${c.displayName}» TAMBIÉN en WhatsApp, en tu teléfono y en `
            + "los demás dispositivos enlazados. Quien esté al otro lado conserva los suyos.",
          )) return;
          if (await pedir(`/chats/${dir}/messages`, { method: "DELETE" })) {
            setChats((prev) => prev.map((x) =>
              x.address === c.address ? { ...x, ultimo: null, unreadCount: 0 } : x));
            router.refresh();
          }
        },
      },
      {
        texto: "Quitar solo de aquí",
        peligro: true,
        Icono: IconoCerrar,
        onSelect: async () => {
          if (!confirm(
            `Se quita «${c.displayName}» de Omni. En WhatsApp sigue entera, y si `
            + "llega un mensaje nuevo volverá a aparecer aquí.",
          )) return;
          if (await pedir(`/chats/${dir}?scope=local`, { method: "DELETE" })) {
            quitar(c);
          }
        },
      },
      {
        /*
         * La de verdad: desaparece también del teléfono.
         *
         * Va la última y con el aviso más duro porque es irreversible y toca
         * algo que no está en esta pantalla: quien la pulse desde aquí no ve
         * el WhatsApp donde va a desaparecer la conversación.
         */
        texto: "Eliminar en WhatsApp y aquí",
        peligro: true,
        Icono: IconoPapelera,
        onSelect: async () => {
          if (!confirm(
            `«${c.displayName}» desaparecerá de WhatsApp: de tu teléfono y de los `
            + "demás dispositivos enlazados, no solo de Omni.\n\n"
            + "No se puede deshacer. Quien esté al otro lado conserva la suya.",
          )) return;
          if (await pedir(`/chats/${dir}?scope=network`, { method: "DELETE" })) {
            quitar(c);
          }
        },
      },
    ];
  };

  useEffect(() => suscribir(async (evento, data) => {
    if (!evento.startsWith("message.") && !evento.startsWith("chat.")) return;

    const key = (data["key"] ?? {}) as { remoteJid?: string; fromMe?: boolean };
    const direccion = key.remoteJid ?? (data["chat"] as string | undefined);
    if (!direccion) return;

    const cuandoISO = new Date(Number(data["timestamp"] ?? Date.now())).toISOString();
    const texto = (data["text"] as string | null) ?? null;
    const tipo = String(data["kind"] ?? "text");

    /*
     * Lo que cambia en WhatsApp llega por su evento.
     *
     * Silenciar desde el teléfono tiene que callar este panel al instante; si
     * no, el silencio solo valdría donde se pulsó.
     */
    if (evento === "chat.updated") {
      const mudo = data["mutedUntil"];
      if (mudo !== undefined) {
        setChats((prev) => prev.map((x) => x.address === direccion
          ? { ...x, mutedUntil: mudo ? new Date(Number(mudo)).toISOString() : null }
          : x));
      }
    }

    setChats((prev) => {
      const i = prev.findIndex((c) => c.address === direccion);
      if (i < 0) return prev;
      const actual = prev[i]!;
      const copia = [...prev];
      copia[i] = {
        ...actual,
        lastMessageAt: cuandoISO,
        ultimo: resumen(tipo, texto),
        ultimoPropio: key.fromMe === true,
        // Lo que se está mirando no acumula pendientes: el contador existiría
        // para avisar de algo que ya se tiene delante.
        unreadCount:
          evento === "message.received" && !key.fromMe && direccion !== abierto
            ? actual.unreadCount + 1
            : evento === "chat.read" || direccion === abierto
              ? 0
              : actual.unreadCount,
      };
      return copia.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    });

    // Una conversación que no estaba en la lista no se puede pintar con lo que
    // trae el evento: el nombre hay que resolverlo, y eso vive en el servidor.
    const conocida = chats.find((c) => c.address === direccion);
    let chat = conocida;
    if (!conocida) {
      const r = await fetch(`/api/omni/v1/lines/${linea.id}/chats/${encodeURIComponent(direccion)}`);
      if (!r.ok) return;
      const { data: nuevo } = (await r.json()) as { data: Chat };
      chat = nuevo;
      setChats((prev) =>
        prev.some((c) => c.address === nuevo.address) ? prev : [nuevo, ...prev]);
    }

    /*
     * El aviso, con sus cuatro condiciones.
     *
     * Entrante, de otra persona, de una conversación que no se tiene abierta y
     * que no está silenciada. Las cuatro juntas: avisar de lo propio, o de lo
     * que ya se está leyendo, es ruido que enseña a ignorar el aviso.
     *
     * El aviso se manda DESPUÉS de resolver el nombre: «mensaje de
     * 51988777666@lid» no identifica a nadie.
     */
    if (
      evento === "message.received" && !key.fromMe && direccion !== abierto
      && chat && !silenciado(chat.mutedUntil)
    ) {
      avisar(prefs, {
        titulo: chat.displayName,
        cuerpo: resumen(tipo, texto),
        etiqueta: direccion,
        alPulsar: () => router.push(
          `/lineas/${linea.id}/chats/${encodeURIComponent(direccion)}`),
      });
    }
  }), [linea.id, chats, suscribir, abierto, prefs, router]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) =>
      c.displayName.toLowerCase().includes(q)
      || c.address.toLowerCase().includes(q)
      || (c.phone ?? "").includes(q));
  }, [chats, busqueda]);

  return (
    <aside
      className={`${
        abierto || enEstados ? "hidden md:flex" : "flex"
      } w-full shrink-0 flex-col border-r border-(--color-borde) bg-(--color-panel) md:w-[22rem]`}
    >
      <header className="border-b border-(--color-borde) px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{linea.name}</h1>
            <p className="truncate text-xs text-(--color-tenue)">
              {linea.address ? `+${linea.address.split("@")[0]}` : linea.channelKind}
            </p>
          </div>
          <div className="relative flex shrink-0 items-center gap-1.5">
            <span
              title={conectado ? "Recibiendo en vivo" : "Reconectando"}
              className="flex items-center gap-1.5 text-xs text-(--color-tenue)"
            >
              <span
                aria-hidden
                className={`size-2 rounded-full ${
                  conectado ? "bg-(--color-exito)" : "bg-(--color-apagado)"
                }`}
              />
              {conectado ? "en vivo" : "…"}
            </span>

            {/*
              Los ajustes de aviso, aquí arriba: es donde se mira cuando algo
              acaba de sonar y se quiere que deje de hacerlo.
            */}
            <button
              type="button"
              onClick={() => setAjustes((v) => !v)}
              aria-label="Avisos"
              aria-expanded={ajustes}
              title={
                prefs.sonido || prefs.escritorio
                  ? "Avisos activados"
                  : "Avisos en silencio"
              }
              className={`flex size-8 items-center justify-center rounded-lg transition-colors duration-150 ${
                ajustes
                  ? "bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
                  : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
              }`}
            >
              {prefs.sonido || prefs.escritorio
                ? <IconoCampana className="size-4.5" />
                : <IconoCampanaTachada className="size-4.5" />}
            </button>

            {ajustes && <AjustesAvisos onCerrar={() => setAjustes(false)} />}
          </div>
        </div>

        <div className="relative mt-3">
          <IconoBuscar className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-(--color-apagado)" />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar conversación"
            aria-label="Buscar conversación"
            className="w-full rounded-lg bg-(--color-hundido) py-2 pr-8 pl-8.5 text-sm outline-none placeholder:text-(--color-apagado) focus:bg-(--color-panel) focus:ring-2 focus:ring-(--color-acento)"
          />
          {busqueda && (
            <button
              type="button"
              onClick={() => setBusqueda("")}
              aria-label="Limpiar búsqueda"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-(--color-apagado) hover:text-(--color-texto)"
            >
              <IconoCerrar className="size-4" />
            </button>
          )}
        </div>
      </header>

      {/*
        Los estados tienen su propia entrada, arriba y fija: no son una
        conversación y mezclarlos con ellas los dejaba con el nombre del último
        que publicó, que no es de nadie.
      */}
      <Link
        href={`/lineas/${linea.id}/estados`}
        className={`flex items-center gap-3 border-b border-(--color-borde) px-4 py-2.5 transition-colors duration-150 ${
          enEstados ? "bg-(--color-acento-tenue)" : "hover:bg-(--color-hundido)"
        }`}
      >
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-(--color-acento) text-(--color-acento)">
          <IconoCanal className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">Estados</span>
          <span className="block text-xs text-(--color-tenue)">
            Lo que publican, de las últimas 24 horas
          </span>
        </span>
      </Link>

      <div className="scroll-discreto flex-1 overflow-y-auto">
        {visibles.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-(--color-tenue)">
            {busqueda ? `Nada que coincida con «${busqueda}»` : "Sin conversaciones todavía."}
          </p>
        ) : (
          <ul>
            {visibles.map((c) => {
              const activo = c.address === abierto;
              return (
                <li key={c.address}>
                  <Link
                    href={`/lineas/${linea.id}/chats/${encodeURIComponent(c.address)}`}
                    aria-current={activo ? "page" : undefined}
                    onContextMenu={(e) => { setSobre(c); menu.enContexto(e); }}
                    className={`group/fila relative flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 ${
                      activo ? "bg-(--color-acento-tenue)" : "hover:bg-(--color-hundido)"
                    }`}
                  >
                    <Avatar nombre={c.displayName} direccion={c.address} kind={c.kind} url={c.avatarUrl} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{c.displayName}</span>
                          {silenciado(c.mutedUntil) && (
                            <IconoCampanaTachada
                              titulo="Silenciada"
                              className="size-3.5 shrink-0 text-(--color-apagado)"
                            />
                          )}
                        </span>
                        <span
                          className={`shrink-0 text-[11px] ${
                            c.unreadCount > 0
                              ? "font-semibold text-(--color-acento-fuerte)"
                              : "text-(--color-apagado)"
                          }`}
                        >
                          {cuando(c.lastMessageAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-(--color-tenue)">
                          {c.ultimo
                            ? `${c.ultimoPropio ? "Tú: " : ""}${c.ultimo}`
                            : c.phone
                              ? `+${c.phone.split("@")[0]}`
                              : c.address}
                        </span>
                        {c.unreadCount > 0 && (
                          <span
                            className={`flex min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[11px] leading-5 font-semibold group-hover/fila:hidden ${
                              silenciado(c.mutedUntil)
                                ? "bg-(--color-hundido) text-(--color-tenue)"
                                : "bg-(--color-acento) text-(--color-sobre-acento)"
                            }`}
                          >
                            {c.unreadCount > 99 ? "99+" : c.unreadCount}
                          </span>
                        )}
                        {/*
                          Aparece al pasar por encima, en el sitio del contador.
                          El clic derecho hace lo mismo, pero sin algo visible
                          nadie sabría que hay opciones.
                        */}
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={`Opciones de ${c.displayName}`}
                          onClick={(e) => { setSobre(c); menu.enBoton(e); }}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            setSobre(c);
                            menu.enBoton(e as unknown as React.MouseEvent<HTMLElement>);
                          }}
                          className="hidden size-5 shrink-0 items-center justify-center rounded text-(--color-tenue) group-hover/fila:flex hover:text-(--color-texto)"
                        >
                          <IconoMas className="size-4" />
                        </span>
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Menu
        punto={menu.punto}
        opciones={sobre ? acciones(sobre) : []}
        onCerrar={menu.cerrar}
      />
      {silenciando && (
        <Silenciar
          nombre={silenciando.displayName}
          onCerrar={() => setSilenciando(null)}
          onElegir={(hasta) => callar(silenciando, hasta)}
        />
      )}
    </aside>
  );
}
