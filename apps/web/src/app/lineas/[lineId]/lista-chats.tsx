"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Chat, Linea, Lista } from "@/lib/api";
import { useEventos } from "@/lib/eventos";
import { conNombres, cuando, resumen } from "@/lib/formato";
import { Avatar } from "@/componentes/piezas";
import {
  IconoArchivar, IconoBuscar, IconoCampana, IconoCampanaTachada, IconoCanal,
  IconoCerrar, IconoEstados, IconoLineas, IconoMas, IconoPapelera, IconoSilenciar,
  IconoVolver,
} from "@/componentes/iconos";
import { COLOR_DE_LISTA, EditarLista, ListasDeChat } from "@/componentes/listas";
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
  const enCanales = ruta.endsWith("/canales");
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
   * Pestañas.
   *
   * Las tres de WhatsApp —todas, no leídas, grupos— más una por cada lista
   * propia. Filtran en el navegador sobre lo ya cargado: cambiar de pestaña
   * es instantáneo y no corta el socket.
   */
  type Pestana = "todos" | "no-leidos" | "grupos" | `lista:${string}`;
  const [pestana, setPestana] = useState<Pestana>("todos");
  const [verArchivados, setVerArchivados] = useState(false);
  const [listas, setListas] = useState<Lista[]>([]);
  const [listando, setListando] = useState<Chat | null>(null);
  const [editandoLista, setEditandoLista] = useState<Lista | "nueva" | null>(null);
  const menuLista = useMenu();
  const [sobreLista, setSobreLista] = useState<Lista | null>(null);

  const cargarListas = async (): Promise<void> => {
    const r = await fetch(`/api/omni/v1/lines/${linea.id}/labels`);
    if (!r.ok) return;
    const { data } = (await r.json()) as { data: Lista[] };
    setListas(data);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void cargarListas(); }, [linea.id]);

  /*
   * Lo que no es una conversación no va en la lista.
   *
   * Un canal es difusión: nadie contesta, y mezclado con los chats pone una
   * fila que nunca tiene a nadie al otro lado. Va en su propia vista, como
   * los estados.
   */
  const conversaciones = useMemo(
    () => chats.filter((c) => c.kind !== "newsletter"),
    [chats],
  );
  const archivados = useMemo(
    () => conversaciones.filter((c) => c.archived),
    [conversaciones],
  );
  const archivadosSinLeer = archivados.filter((c) => c.unreadCount > 0).length;

  /*
   * Los avisos.
   *
   * Viven aquí y no en la conversación abierta porque lo que hay que avisar es
   * precisamente lo que NO se está mirando, y esta lista es la única que ve
   * todas las conversaciones de la línea a la vez.
   */
  const { prefs } = usePreferencias();
  useEffect(prepararSonido, []);
  /*
   * Lo que cuenta para el número de la pestaña: ni lo silenciado, ni lo
   * archivado, ni los canales. Es lo mismo que decide si suena: si el número
   * subiera por algo que no avisa, dejaría de significar «tienes que mirar».
   */
  const cuentaParaAvisar = (c: Chat): boolean =>
    !silenciado(c.mutedUntil) && !c.archived && c.kind !== "newsletter";
  const pendientes = useMemo(
    () => chats.reduce((n, c) => n + (cuentaParaAvisar(c) ? c.unreadCount : 0), 0),
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
        texto: "Añadir a una lista…",
        Icono: IconoLineas,
        onSelect: () => setListando(c),
      },
      {
        // Es el archivado DE WHATSAPP: se archiva también en el teléfono.
        texto: c.archived ? "Desarchivar" : "Archivar",
        Icono: IconoArchivar,
        onSelect: async () => {
          const archivar = !c.archived;
          // Se mueve ya, sin esperar: la conversación desaparece de donde
          // estaba en el momento del clic, que es lo que se espera ver.
          setChats((prev) => prev.map((x) =>
            x.address === c.address ? { ...x, archived: archivar } : x));
          const ok = await pedir(`/chats/${dir}/archive`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ archived: archivar }),
          });
          if (!ok) {
            setChats((prev) => prev.map((x) =>
              x.address === c.address ? { ...x, archived: c.archived } : x));
          }
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
    // Las menciones con el nombre puesto: lo trae el evento, resuelto por el
    // motor, y es lo que se ve en el adelanto y en el aviso.
    const crudo = (data["text"] as string | null) ?? null;
    const texto = crudo
      ? conNombres(crudo, data["mentionNames"] as Record<string, string> | undefined)
      : null;
    const tipo = String(data["kind"] ?? "text");

    /*
     * Lo que cambia en WhatsApp llega por su evento.
     *
     * Silenciar desde el teléfono tiene que callar este panel al instante; si
     * no, el silencio solo valdría donde se pulsó.
     */
    if (evento === "chat.updated" || evento === "chat.archived") {
      const mudo = data["mutedUntil"];
      const archivado = data["archived"];
      const pendientesAhi = data["unreadCount"];
      setChats((prev) => prev.map((x) => x.address !== direccion ? x : {
        ...x,
        ...(mudo !== undefined
          ? { mutedUntil: mudo ? new Date(Number(mudo)).toISOString() : null } : {}),
        ...(typeof archivado === "boolean" ? { archived: archivado } : {}),
        // Leído en el teléfono: el contador baja aquí también.
        ...(typeof pendientesAhi === "number" ? { unreadCount: pendientesAhi } : {}),
      }));
      return;
    }

    if (evento === "chat.read") {
      setChats((prev) => prev.map((x) =>
        x.address === direccion ? { ...x, unreadCount: 0 } : x));
      return;
    }

    /*
     * Solo un mensaje DE VERDAD mueve la lista.
     *
     * Antes cualquier evento con dirección caía aquí: un acuse de lectura, una
     * reacción, un cambio de chat. Cada uno subía la conversación arriba con la
     * hora de ese instante y «Mensaje» de adelanto —el resumen de un mensaje
     * que no existe—, así que bastaba con que alguien leyera algo para que la
     * lista se reordenara sola.
     */
    if (evento !== "message.received" && evento !== "message.sent") return;
    if (tipo === "reaction" || tipo === "system") return;

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
            : direccion === abierto ? 0 : actual.unreadCount,
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
      && chat && cuentaParaAvisar(chat)
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
    /*
     * La búsqueda mira en TODO, archivados incluidos.
     *
     * Es lo que hace WhatsApp, y con razón: quien busca a alguien no sabe si
     * lo archivó, y un buscador que no lo encuentra parece que ha perdido la
     * conversación.
     */
    if (q) {
      return conversaciones.filter((c) =>
        c.displayName.toLowerCase().includes(q)
        || c.address.toLowerCase().includes(q)
        || (c.phone ?? "").includes(q));
    }

    const base = conversaciones.filter((c) => Boolean(c.archived) === verArchivados);
    if (pestana === "no-leidos") return base.filter((c) => c.unreadCount > 0);
    if (pestana === "grupos") return base.filter((c) => c.kind === "group");
    if (pestana.startsWith("lista:")) {
      const id = pestana.slice("lista:".length);
      return base.filter((c) => c.labelIds?.includes(id));
    }
    return base;
  }, [conversaciones, busqueda, verArchivados, pestana]);

  /** Guarda las listas de una conversación y las refleja sin recargar. */
  const fijarListas = async (c: Chat, ids: string[]): Promise<void> => {
    setChats((prev) => prev.map((x) =>
      x.address === c.address ? { ...x, labelIds: ids } : x));
    await fetch(
      `/api/omni/v1/lines/${linea.id}/chats/${encodeURIComponent(c.address)}/labels`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labelIds: ids }),
      },
    );
  };

  /** Crea o edita una lista. Devuelve el error para enseñarlo, o `null`. */
  const guardarLista = async (
    lista: Lista | null, datos: { name: string; color: string },
  ): Promise<string | null> => {
    const r = await fetch(
      lista
        ? `/api/omni/v1/lines/${linea.id}/labels/${encodeURIComponent(lista.id)}`
        : `/api/omni/v1/lines/${linea.id}/labels`,
      {
        method: lista ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(datos),
      },
    );
    if (!r.ok) {
      const e = (await r.json().catch(() => null)) as { detail?: string } | null;
      return e?.detail ?? "No se pudo guardar la lista.";
    }
    const { data } = (await r.json()) as { data: Lista };
    await cargarListas();
    // Una lista recién creada se abre: es lo siguiente que uno quiere ver.
    if (!lista) setPestana(`lista:${data.id}`);
    return null;
  };

  const borrarLista = async (l: Lista): Promise<void> => {
    if (!confirm(
      `Se borrará la lista «${l.name}». Las conversaciones no se tocan: solo `
      + "dejan de estar agrupadas ahí.",
    )) return;
    const r = await fetch(
      `/api/omni/v1/lines/${linea.id}/labels/${encodeURIComponent(l.id)}`,
      { method: "DELETE" },
    );
    if (!r.ok) return;
    setListas((prev) => prev.filter((x) => x.id !== l.id));
    setChats((prev) => prev.map((x) => ({
      ...x, labelIds: (x.labelIds ?? []).filter((id) => id !== l.id),
    })));
    if (pestana === `lista:${l.id}`) setPestana("todos");
  };

  const PESTANAS_FIJAS = [
    { id: "todos", texto: "Todos" },
    { id: "no-leidos", texto: "No leídos" },
    { id: "grupos", texto: "Grupos" },
  ] as const;

  return (
    <aside
      className={`${
        abierto || enEstados || enCanales ? "hidden md:flex" : "flex"
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

        {/*
          Las pestañas. En una fila que se desplaza de lado y no en varias
          líneas: con cinco listas propias, envolver empujaría las
          conversaciones hacia abajo justo en un teléfono, donde menos sobra.
          Al buscar desaparecen: la búsqueda mira en todo.
        */}
        {!busqueda && !verArchivados && (
          <div
            role="tablist"
            aria-label="Filtrar conversaciones"
            className="scroll-discreto -mx-4 mt-2.5 flex gap-1.5 overflow-x-auto px-4 pb-0.5"
          >
            {PESTANAS_FIJAS.map((t) => (
              <Pastilla
                key={t.id}
                activa={pestana === t.id}
                onClick={() => setPestana(t.id)}
              >
                {t.texto}
              </Pastilla>
            ))}
            {listas.map((l) => (
              <Pastilla
                key={l.id}
                activa={pestana === `lista:${l.id}`}
                onClick={() => setPestana(`lista:${l.id}`)}
                // Clic derecho para editarla o borrarla: es donde uno la tiene
                // delante cuando decide que sobra o que se llama mal.
                onContextMenu={(e) => { setSobreLista(l); menuLista.enContexto(e); }}
                color={COLOR_DE_LISTA[l.color ?? "gris"]}
              >
                {l.name}
              </Pastilla>
            ))}
            <button
              type="button"
              onClick={() => setEditandoLista("nueva")}
              aria-label="Nueva lista"
              title="Nueva lista: agrupa conversaciones en su propia pestaña"
              className="flex h-7 shrink-0 items-center rounded-full border border-dashed border-(--color-borde) px-2.5 text-xs text-(--color-tenue) transition-colors duration-150 hover:border-(--color-acento) hover:text-(--color-acento-fuerte)"
            >
              + Lista
            </button>
          </div>
        )}
      </header>

      {/*
        Estados y canales tienen su propia entrada, fija y fuera de la lista.

        Ninguno es una conversación: los estados no son de nadie en concreto y
        en un canal nadie contesta. Mezclados con los chats, los estados salían
        con el nombre del último que publicó y el canal como una fila que nunca
        tiene a nadie al otro lado. Van juntos y a medio ancho porque son dos
        destinos del mismo tipo, y una fila entera para cada uno empujaba las
        conversaciones hacia abajo.
      */}
      {!verArchivados && (
        <nav aria-label="Otras vistas" className="grid grid-cols-2 border-b border-(--color-borde)">
          <Destino
            href={`/lineas/${linea.id}/estados`}
            activo={enEstados}
            Icono={IconoEstados}
            texto="Estados"
          />
          <Destino
            href={`/lineas/${linea.id}/canales`}
            activo={enCanales}
            Icono={IconoCanal}
            texto="Canales"
            borde
          />
        </nav>
      )}

      {/*
        Archivados: arriba, como en WhatsApp, y solo si hay alguno. Dentro,
        la cabecera dice dónde se está y cómo salir: en una lista que se
        parece a la principal, perderse es fácil.
      */}
      {verArchivados ? (
        <button
          type="button"
          onClick={() => setVerArchivados(false)}
          className="flex items-center gap-3 border-b border-(--color-borde) px-4 py-2.5 text-left hover:bg-(--color-hundido)"
        >
          <IconoVolver className="size-5 text-(--color-tenue)" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Archivados</span>
            <span className="block text-xs text-(--color-tenue)">
              Archivados también en tu WhatsApp. Siguen así aunque llegue algo.
            </span>
          </span>
        </button>
      ) : archivados.length > 0 && !busqueda && (
        <button
          type="button"
          onClick={() => { setVerArchivados(true); setPestana("todos"); }}
          className="flex items-center gap-3 px-4 py-2 text-left hover:bg-(--color-hundido)"
        >
          <span className="flex size-11 shrink-0 items-center justify-center text-(--color-acento-fuerte)">
            <IconoArchivar className="size-5" />
          </span>
          <span className="flex-1 text-sm font-medium">Archivados</span>
          <span
            className={`text-xs ${
              archivadosSinLeer > 0
                ? "font-semibold text-(--color-acento-fuerte)"
                : "text-(--color-apagado)"
            }`}
          >
            {archivadosSinLeer > 0 ? archivadosSinLeer : archivados.length}
          </span>
        </button>
      )}

      <div className="scroll-discreto flex-1 overflow-y-auto">
        {visibles.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-(--color-tenue)">
            {busqueda
              ? `Nada que coincida con «${busqueda}»`
              : verArchivados
                ? "No hay conversaciones archivadas."
                : pestana === "no-leidos"
                  ? "Todo leído."
                  : pestana === "grupos"
                    ? "No hay grupos."
                    : pestana.startsWith("lista:")
                      ? "Esta lista está vacía. Añade conversaciones desde su menú: clic derecho o los tres puntos."
                      : "Sin conversaciones todavía."}
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
      <Menu
        punto={menuLista.punto}
        opciones={sobreLista ? [
          { texto: "Editar lista", onSelect: () => setEditandoLista(sobreLista) },
          {
            texto: "Borrar lista", peligro: true, Icono: IconoPapelera,
            onSelect: () => borrarLista(sobreLista),
          },
        ] : []}
        onCerrar={menuLista.cerrar}
      />
      {listando && (
        <ListasDeChat
          nombre={listando.displayName}
          listas={listas}
          actuales={listando.labelIds ?? []}
          onGuardar={(ids) => fijarListas(listando, ids)}
          onNueva={() => setEditandoLista("nueva")}
          onCerrar={() => setListando(null)}
        />
      )}
      {editandoLista && (
        <EditarLista
          lista={editandoLista === "nueva" ? null : editandoLista}
          onGuardar={(datos) =>
            guardarLista(editandoLista === "nueva" ? null : editandoLista, datos)}
          onCerrar={() => setEditandoLista(null)}
        />
      )}
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

/** Una pestaña de filtro. Con color, es una lista propia. */
function Pastilla({
  activa, onClick, onContextMenu, color, children,
}: {
  activa: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  color?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activa}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors duration-150 ${
        activa
          ? "bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
          : "bg-(--color-hundido) text-(--color-tenue) hover:text-(--color-texto)"
      }`}
    >
      {color && <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />}
      <span className="max-w-32 truncate">{children}</span>
    </button>
  );
}

/** Una entrada a otra vista: estados o canales. */
function Destino({
  href, activo, Icono, texto, borde,
}: {
  href: string;
  activo: boolean;
  Icono: (p: { className?: string }) => React.ReactElement;
  texto: string;
  borde?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={activo ? "page" : undefined}
      className={`flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors duration-150 ${
        borde ? "border-l border-(--color-borde)" : ""
      } ${
        activo
          ? "bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
          : "text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
      }`}
    >
      <Icono className="size-4.5" />
      {texto}
    </Link>
  );
}
