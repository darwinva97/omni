"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A qué llega una persona del equipo: todo, unas líneas enteras o solo unos
 * chats de ellas.
 *
 * Son tres modos y no una lista libre porque el alcance tiene dos ejes —líneas
 * y chats— y los chats valen dentro de TODAS las líneas elegidas. «Esta línea
 * entera y dos chats de aquella» no se puede expresar, así que el control no
 * deja pedirlo.
 *
 * Se manda como un único campo `alcance` en JSON: es lo que la API recibe, y
 * así el formulario del servidor no tiene que reconstruirlo a partir de veinte
 * casillas.
 */

export interface LineaElegible { id: string; name: string }
export interface Alcance {
  restricted: boolean;
  allowedLines: string[];
  allowedChats: string[];
  canCreateLines: boolean;
}

type Modo = "todo" | "lineas" | "chats";

interface ChatElegible { address: string; displayName: string }

const modoDe = (a: Alcance): Modo =>
  !a.restricted ? "todo" : a.allowedChats.length > 0 ? "chats" : "lineas";

/** Lo que se enseña de una dirección sin nombre: el número, no el sufijo del protocolo. */
const corta = (address: string): string => {
  const [local, sufijo] = address.split("@");
  return sufijo === "s.whatsapp.net" ? `+${local}` : address;
};

export function EditorAlcance({
  lineas, inicial = { restricted: false, allowedLines: [], allowedChats: [], canCreateLines: false },
}: {
  lineas: readonly LineaElegible[];
  inicial?: Alcance;
}) {
  const [modo, setModo] = useState<Modo>(modoDe(inicial));
  const [lineasSel, setLineasSel] = useState<Set<string>>(new Set(inicial.allowedLines));
  const [chatsSel, setChatsSel] = useState<Set<string>>(new Set(inicial.allowedChats));
  const [crea, setCrea] = useState(inicial.canCreateLines);
  // Sin entrada = cargando todavía.
  const [chats, setChats] = useState<Record<string, ChatElegible[] | "error">>({});
  const pedidas = useRef(new Set<string>());
  const [filtro, setFiltro] = useState("");
  const [otro, setOtro] = useState("");

  // Los chats se piden al elegir el modo y la línea, no al abrir la página:
  // quien solo invita con acceso completo no tiene por qué esperar a doscientos
  // chats por línea.
  useEffect(() => {
    if (modo !== "chats") return;
    for (const id of lineasSel) {
      if (pedidas.current.has(id)) continue;
      pedidas.current.add(id);
      fetch(`/api/omni/v1/lines/${encodeURIComponent(id)}/chats?limit=200`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const { data } = (await r.json()) as { data: ChatElegible[] };
          setChats((c) => ({ ...c, [id]: data.filter((x) => !x.address.endsWith("@newsletter")) }));
        })
        .catch(() => setChats((c) => ({ ...c, [id]: "error" })));
    }
  }, [modo, lineasSel]);

  const nombres = useMemo(() => {
    const m = new Map<string, string>();
    for (const lista of Object.values(chats)) {
      if (Array.isArray(lista)) for (const c of lista) m.set(c.address, c.displayName);
    }
    return m;
  }, [chats]);

  const alcance: Alcance = modo === "todo"
    ? { restricted: false, allowedLines: [], allowedChats: [], canCreateLines: crea }
    : modo === "lineas"
      ? { restricted: true, allowedLines: [...lineasSel], allowedChats: [], canCreateLines: crea }
      : { restricted: true, allowedLines: [...lineasSel], allowedChats: [...chatsSel], canCreateLines: crea };

  const alternar = <T,>(s: Set<T>, v: T): Set<T> => {
    const n = new Set(s);
    if (n.has(v)) n.delete(v); else n.add(v);
    return n;
  };

  const añadirOtro = (): void => {
    // La API normaliza (un teléfono suelto pasa a …@s.whatsapp.net) y dice si
    // alguno no vale; aquí solo se separa lo escrito.
    const nuevos = otro.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
      .map((x) => (x.includes("@") ? x : `${x.replace(/\D/g, "")}@s.whatsapp.net`));
    if (nuevos.length === 0) return;
    setChatsSel((s) => new Set([...s, ...nuevos]));
    setOtro("");
  };

  const q = filtro.trim().toLowerCase();
  const coincide = (c: ChatElegible): boolean =>
    !q || c.displayName.toLowerCase().includes(q) || c.address.includes(q);

  // Unas líneas pueden ser NINGUNA —solo las que ella dé de alta—; unos chats
  // necesitan sus líneas.
  const sinLineas = modo === "chats" && lineasSel.size === 0;
  const sinChats = modo === "chats" && chatsSel.size === 0;

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Acceso</legend>
      {/* Vacío cuando falta algo: el servidor lo rechaza con un motivo en vez
          de guardar, sin querer, «toda la línea» donde se pedían unos chats. */}
      <input type="hidden" name="alcance" value={sinLineas || sinChats ? "" : JSON.stringify(alcance)} />

      <div role="radiogroup" className="flex flex-wrap gap-2">
        {([
          ["todo", "Todo"],
          ["lineas", "Solo unas líneas"],
          ["chats", "Solo unos chats"],
        ] as const).map(([valor, texto]) => (
          <label
            key={valor}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors duration-150 ${
              modo === valor
                ? "border-(--color-acento) bg-(--color-acento-tenue) text-(--color-acento-fuerte)"
                : "border-(--color-borde) hover:bg-(--color-hundido)"
            }`}
          >
            <input
              type="radio" name="alcance_modo" value={valor} checked={modo === valor}
              onChange={() => setModo(valor)} className="sr-only"
            />
            {texto}
          </label>
        ))}
      </div>

      <p className="text-xs text-(--color-tenue)">
        {modo === "todo" && "Ve todas las líneas y conversaciones, también las que se creen después."}
        {modo === "lineas" && "Ve todas las conversaciones de las líneas que marques, y nada de las demás."}
        {modo === "chats" && (
          "Ve y atiende solo los chats que marques: no el resto de la línea, ni el equipo, ni las " +
          "notas internas, ni las respuestas rápidas. Con rol viewer solo lee; con agent también escribe."
        )}
      </p>

      {modo !== "todo" && (
        <div>
          <p className="text-xs font-medium text-(--color-tenue)">Líneas</p>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {lineas.map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox" checked={lineasSel.has(l.id)}
                  onChange={() => setLineasSel((s) => alternar(s, l.id))}
                  className="accent-(--color-acento)"
                />
                {l.name}
              </label>
            ))}
          </div>
          {sinLineas && <p className="mt-1.5 text-xs text-(--color-error)">Marca la línea de esos chats.</p>}
          {modo === "lineas" && lineasSel.size === 0 && (
            <p className="mt-1.5 text-xs text-(--color-tenue)">
              Sin ninguna marcada no verá ninguna línea tuya{crea ? ": solo las que dé de alta ella" : ""}.
            </p>
          )}
        </div>
      )}

      {modo === "chats" && lineasSel.size > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-(--color-tenue)">
              Chats {chatsSel.size > 0 && `· ${chatsSel.size} marcado${chatsSel.size === 1 ? "" : "s"}`}
            </p>
            <input
              type="search" value={filtro} onChange={(e) => setFiltro(e.target.value)}
              placeholder="Buscar" aria-label="Buscar chats"
              className="w-40 rounded-lg border border-(--color-borde) bg-(--color-panel) px-2.5 py-1 text-sm outline-none focus:border-(--color-acento)"
            />
          </div>

          {/* Los marcados van arriba y siempre a la vista: un chat viejo que ya
              no cae entre los doscientos últimos sigue compartido, y tiene que
              poder quitarse. */}
          {chatsSel.size > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {[...chatsSel].map((a) => (
                <li key={a}>
                  <button
                    type="button" onClick={() => setChatsSel((s) => alternar(s, a))}
                    title="Quitar"
                    className="rounded-full border border-(--color-acento) bg-(--color-acento-tenue) px-2.5 py-0.5 text-xs text-(--color-acento-fuerte) hover:opacity-80"
                  >
                    {nombres.get(a) ?? corta(a)} ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="scroll-discreto max-h-64 space-y-3 overflow-y-auto rounded-lg border border-(--color-borde) p-2.5">
            {[...lineasSel].map((id) => {
              const lista = chats[id];
              const nombre = lineas.find((l) => l.id === id)?.name ?? id;
              return (
                <div key={id}>
                  {lineasSel.size > 1 && <p className="mb-1 text-xs font-medium text-(--color-apagado)">{nombre}</p>}
                  {lista === undefined ? (
                    <p className="text-xs text-(--color-tenue)">Cargando…</p>
                  ) : lista === "error" ? (
                    <p className="text-xs text-(--color-error)">No se pudieron cargar los chats de esta línea.</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {lista.filter(coincide).map((c) => (
                        <li key={c.address}>
                          <label className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-(--color-hundido)">
                            <input
                              type="checkbox" checked={chatsSel.has(c.address)}
                              onChange={() => setChatsSel((s) => alternar(s, c.address))}
                              className="accent-(--color-acento)"
                            />
                            <span className="truncate">{c.displayName}</span>
                            <span className="ml-auto shrink-0 text-xs text-(--color-apagado)">{corta(c.address)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <span className="text-xs text-(--color-tenue)">¿No está en la lista? Escribe el número</span>
              <input
                value={otro} onChange={(e) => setOtro(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); añadirOtro(); } }}
                placeholder="51999888777"
                className="mt-1 w-full rounded-lg border border-(--color-borde) bg-(--color-panel) px-2.5 py-1.5 text-sm outline-none focus:border-(--color-acento)"
              />
            </label>
            <button
              type="button" onClick={añadirOtro}
              className="rounded-lg border border-(--color-borde) px-3 py-1.5 text-sm hover:bg-(--color-hundido)"
            >
              Añadir
            </button>
          </div>
          {sinChats && <p className="text-xs text-(--color-error)">Marca al menos un chat.</p>}
        </div>
      )}

      <label className="flex items-start gap-2 pt-1 text-sm">
        <input
          type="checkbox" checked={crea} onChange={(e) => setCrea(e.target.checked)}
          className="mt-0.5 accent-(--color-acento)"
        />
        <span>
          Puede dar de alta líneas
          <span className="block text-xs text-(--color-tenue)">
            Las que cree serán suyas y enteras: las ve, las enlaza con su teléfono, las configura y
            las borra{modo === "todo" ? "" : ", aunque del resto solo vea lo que marcaste"}.
          </span>
        </span>
      </label>
    </fieldset>
  );
}
