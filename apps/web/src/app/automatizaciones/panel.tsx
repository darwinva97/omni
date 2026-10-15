"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ACCIONES, ACCION_HECHA, CAMPOS, DIAS, DISPARADORES, ESTADOS_TEXTO, PRIORIDADES_TEXTO,
  TIPOS_DE_CHAT, accionNueva, campoDe, condicionNueva, describirRegla, disparadorSinEmisor,
  esDeMensaje, operadorDe, problemasDe,
  type Accion, type Campo, type Condicion, type Diccionario, type Disparo, type Operador,
  type OpcionDeOperador, type Regla, type TipoDeAccion,
} from "@/lib/automatizaciones";
import { bonito } from "@/lib/telefono";
import { Vacio } from "@/componentes/piezas";
import { IconoCerrar, IconoPapelera, IconoRayo, IconoReloj } from "@/componentes/iconos";

type Borrador = Omit<Regla, "id" | "enabled">;

const CONTROL =
  "rounded-lg border border-(--color-borde) bg-(--color-panel) px-2.5 py-1.5 text-sm outline-none transition-colors duration-150 focus:border-(--color-acento) focus:ring-2 focus:ring-(--color-acento)/25 disabled:opacity-50";

const BOTON_SOBRIO =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-(--color-borde) px-3 py-1.5 text-sm font-medium transition-colors duration-150 hover:bg-(--color-hundido) active:scale-[0.97] disabled:opacity-40";

const BOTON_PRIMARIO =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-(--color-acento) px-3.5 py-2 text-sm font-medium text-(--color-sobre-acento) transition-opacity duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-40";

/** La zona horaria de quien escribe la regla: la de sus «de 9 a 18». */
const zonaLocal = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

async function pedir(ruta: string, init: RequestInit = {}): Promise<{ ok: boolean; detalle: string | null }> {
  const r = await fetch(`/api/omni${ruta}`, {
    ...init,
    headers: init.body ? { "content-type": "application/json" } : {},
  }).catch(() => null);
  if (!r) return { ok: false, detalle: "No hay conexión con el servidor." };
  if (r.ok) return { ok: true, detalle: null };
  const e = (await r.json().catch(() => null)) as { detail?: string } | null;
  return { ok: false, detalle: e?.detail ?? `El servidor respondió ${r.status}.` };
}

/**
 * La lista de reglas, su editor y su historial.
 *
 * Cada regla se lee como una frase —«Cuando llegue un mensaje, si el mensaje
 * contiene “factura” → responder…»— y no como un JSON, porque quien la mira
 * no tiene por qué programar. Al lado, su último disparo: una regla que dejó
 * de funcionar tiene que verse desde aquí, sin entrar a buscarla.
 */
export function PanelDeAutomatizaciones({
  reglas, ultimos, dic,
}: {
  reglas: Regla[];
  ultimos: Record<string, Disparo | null>;
  dic: Diccionario;
}) {
  const router = useRouter();
  const [editando, setEditando] = useState<Regla | "nueva" | null>(null);
  const [historial, setHistorial] = useState<Regla | null>(null);
  // Encendidas al instante: el interruptor responde al clic, no al servidor.
  const [encendidas, setEncendidas] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [recienCreada, setRecienCreada] = useState<string | null>(null);

  const encender = async (r: Regla, valor: boolean): Promise<void> => {
    setEncendidas((e) => ({ ...e, [r.id]: valor }));
    setError(null);
    const res = await pedir(`/v1/automations/${encodeURIComponent(r.id)}`, {
      method: "PATCH", body: JSON.stringify({ enabled: valor }),
    });
    if (!res.ok) {
      setEncendidas((e) => ({ ...e, [r.id]: !valor }));
      setError(`No se pudo ${valor ? "encender" : "apagar"} «${r.name}»: ${res.detalle}`);
      return;
    }
    if (r.id === recienCreada) setRecienCreada(null);
    router.refresh();
  };

  const borrar = async (r: Regla): Promise<void> => {
    if (!confirm(`Se borrará la regla «${r.name}» y todo su historial. No se puede deshacer.`)) return;
    const res = await pedir(`/v1/automations/${encodeURIComponent(r.id)}`, { method: "DELETE" });
    if (!res.ok) { setError(`No se pudo borrar «${r.name}»: ${res.detalle}`); return; }
    router.refresh();
  };

  const nueva = (
    <button type="button" onClick={() => setEditando("nueva")} className={`${BOTON_PRIMARIO} shrink-0 whitespace-nowrap`}>
      <IconoRayo className="size-4" />
      Nueva regla
    </button>
  );

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="rounded-lg border border-(--color-error) bg-(--color-error-tenue) px-3.5 py-2.5 text-sm text-(--color-error)">
          {error}
        </p>
      )}

      {reglas.length === 0 ? (
        <Vacio titulo="Todavía no hay ninguna regla" accion={nueva}>
          Por ejemplo: cuando llegue un mensaje que contenga «factura», ponerlo en
          la lista Facturas y asignárselo a quien lleva administración.
        </Vacio>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-(--color-tenue)">
              Se ejecutan de arriba abajo. Las apagadas no hacen nada.
            </p>
            {nueva}
          </div>
          <ul className="space-y-2.5">
            {reglas.map((r) => {
              const encendida = encendidas[r.id] ?? r.enabled;
              const frase = describirRegla(r, dic);
              const ultimo = ultimos[r.id] ?? null;
              const linea = r.lineId ? dic.lineas.find((l) => l.id === r.lineId)?.name ?? "una línea borrada" : null;
              return (
                <li
                  key={r.id}
                  className={`rounded-xl border bg-(--color-panel) p-4 transition-colors duration-150 ${
                    encendida ? "border-(--color-borde)" : "border-dashed border-(--color-borde)"
                  }`}
                >
                  <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
                    <Interruptor
                      puesto={encendida}
                      etiqueta={`${encendida ? "Apagar" : "Encender"} la regla ${r.name}`}
                      onCambiar={(v) => void encender(r, v)}
                    />
                    <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <h2 className={`text-sm font-semibold ${encendida ? "" : "text-(--color-tenue)"}`}>{r.name}</h2>
                        <span className="text-xs text-(--color-apagado)">
                          {encendida ? "encendida" : "apagada"} · {linea ? `solo en ${linea}` : "en todas las líneas"}
                        </span>
                      </div>
                      <p className="mt-1 text-sm">{frase.cuando}</p>
                      <p className="mt-0.5 text-sm text-(--color-tenue)">
                        <span aria-hidden className="text-(--color-acento-fuerte)">→ </span>
                        {frase.entonces}
                      </p>
                      {disparadorSinEmisor(r.trigger) && (
                        <p className="mt-1.5 text-xs text-(--color-aviso)">
                          Este disparador todavía no lo emite el servidor: la regla no saltará.
                        </p>
                      )}
                      {r.id === recienCreada && !encendida && (
                        <p className="mt-1.5 text-xs text-(--color-acento-fuerte)">
                          Creada apagada. Enciéndela con el interruptor cuando la tengas lista.
                        </p>
                      )}
                      <UltimoDisparo disparo={ultimo} onVer={() => setHistorial(r)} />
                    </div>
                    {/* En el teléfono, debajo: al lado se comían la frase entera. */}
                    <div className="ml-12 flex shrink-0 items-center gap-1 sm:ml-0">
                      <button type="button" onClick={() => setEditando(r)} className={BOTON_SOBRIO}>
                        Editar
                      </button>
                      <button
                        type="button"
                        onClick={() => void borrar(r)}
                        aria-label={`Borrar la regla ${r.name}`}
                        title="Borrar la regla"
                        className="flex size-8 items-center justify-center rounded-lg text-(--color-tenue) transition-colors duration-150 hover:bg-(--color-error-tenue) hover:text-(--color-error)"
                      >
                        <IconoPapelera className="size-4" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {editando && (
        <Editor
          regla={editando === "nueva" ? null : editando}
          dic={dic}
          onCerrar={() => setEditando(null)}
          onGuardada={(id, creada) => {
            setEditando(null);
            if (creada) setRecienCreada(id);
            router.refresh();
          }}
        />
      )}
      {historial && (
        <Historial regla={historial} dic={dic} onCerrar={() => setHistorial(null)} />
      )}
    </div>
  );
}

function Interruptor({
  puesto, etiqueta, onCambiar,
}: {
  puesto: boolean; etiqueta: string; onCambiar: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={puesto}
      aria-label={etiqueta}
      title={etiqueta}
      onClick={() => onCambiar(!puesto)}
      className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 ${
        puesto ? "bg-(--color-acento)" : "bg-(--color-hundido) ring-1 ring-(--color-borde)"
      }`}
    >
      <span
        className={`size-4 rounded-full bg-(--color-panel) shadow-sm transition-transform duration-150 ${
          puesto ? "translate-x-4" : ""
        }`}
      />
    </button>
  );
}

const cuandoFue = (iso: string): string =>
  new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });

function UltimoDisparo({ disparo, onVer }: { disparo: Disparo | null; onVer: () => void }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--color-tenue)">
      <IconoReloj className="size-3.5 shrink-0" />
      {!disparo ? (
        <span>Todavía no ha saltado.</span>
      ) : disparo.outcome === "failed" ? (
        <span className="text-(--color-error)">
          Falló el {cuandoFue(disparo.createdAt)}: {disparo.reason}
        </span>
      ) : (
        <span>Última vez el {cuandoFue(disparo.createdAt)}{disparo.outcome === "skipped" ? " (repetida, no hizo nada)" : ""}.</span>
      )}
      <button type="button" onClick={onVer} className="font-medium text-(--color-acento-fuerte) hover:underline">
        Ver historial
      </button>
    </p>
  );
}

/** Un diálogo grande, centrado, que se cierra con Esc o pulsando fuera. */
function Dialogo({
  titulo, onCerrar, children, pie,
}: {
  titulo: string; onCerrar: () => void; children: React.ReactNode; pie: React.ReactNode;
}) {
  const caja = useRef<HTMLDivElement>(null);
  // El foco entra UNA vez, al abrir: con cada repintado se lo quitaría al
  // campo en el que se está escribiendo.
  useEffect(() => {
    caja.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, []);
  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => { if (e.key === "Escape") onCerrar(); };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [onCerrar]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 md:items-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}
    >
      <div
        ref={caja}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-(--color-borde) bg-(--color-panel) shadow-[0_12px_40px_rgba(0,0,0,0.25)]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-(--color-borde) px-5 py-3.5">
          <h2 className="text-base font-semibold">{titulo}</h2>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="flex size-8 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-texto)"
          >
            <IconoCerrar className="size-4" />
          </button>
        </header>
        <div className="scroll-discreto flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <footer className="border-t border-(--color-borde) px-5 py-3">{pie}</footer>
      </div>
    </div>
  );
}

/** El valor por defecto cuando cambia lo que se compara: un número no vale como día. */
function valorPara(op: OpcionDeOperador, campo: Campo): Condicion["value"] {
  switch (op.valor) {
    case "hora": return op.op === "gte" ? 9 : 18;
    case "dias": return ["1", "2", "3", "4", "5"];
    case "tipo-chat": return "individual";
    case "estado": return "open";
    case "prioridad": return "urgent";
    case "nada": return undefined;
    default: return campo === "text" ? "" : "";
  }
}

/**
 * Crear o editar una regla, como una frase que se completa:
 * «Cuando [llegue un mensaje] en [todas las líneas], solo si […], entonces […]».
 *
 * Solo ofrece lo que el servidor sabe hacer de verdad con ese disparador: con
 * la línea cayéndose no hay mensaje ni chat, así que no hay «responder» ni
 * condiciones sobre el texto, solo la hora, el día y avisar a una web.
 */
function Editor({
  regla, dic, onCerrar, onGuardada,
}: {
  regla: Regla | null;
  dic: Diccionario;
  onCerrar: () => void;
  onGuardada: (id: string, creada: boolean) => void;
}) {
  const [b, setB] = useState<Borrador>(() => regla
    ? {
        name: regla.name, trigger: regla.trigger, lineId: regla.lineId, priority: regla.priority,
        conditions: regla.conditions.map((c) => ({ ...c })),
        actions: regla.actions.map((a) => ({ ...a })),
      }
    : { name: "", trigger: "message.received", lineId: null, priority: 100, conditions: [], actions: [] });
  const [intentado, setIntentado] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deMensaje = esDeMensaje(b.trigger);
  const problemas = problemasDe(b);
  const listas = dic.listas.filter((l) => l.lineId === b.lineId);
  const parar = b.actions.some((a) => a.type === "stop");
  const acciones = b.actions.filter((a) => a.type !== "stop");

  const fijar = (cambio: Partial<Borrador>): void => setB((x) => ({ ...x, ...cambio }));
  const fijarCondicion = (i: number, c: Condicion): void =>
    setB((x) => ({ ...x, conditions: x.conditions.map((y, j) => (j === i ? c : y)) }));
  const fijarAccion = (i: number, a: Accion): void =>
    setB((x) => {
      const resto = x.actions.filter((y) => y.type !== "stop");
      const nuevas = resto.map((y, j) => (j === i ? a : y));
      return { ...x, actions: parar ? [...nuevas, { type: "stop" }] : nuevas };
    });

  const guardar = async (): Promise<void> => {
    setIntentado(true);
    if (problemas.length > 0) return;
    setGuardando(true);
    setError(null);
    const cuerpo = {
      name: b.name.trim(), trigger: b.trigger, conditions: b.conditions,
      // `stop` siempre al final: corta la cadena DESPUÉS de hacer lo suyo.
      actions: [...acciones, ...(parar ? [{ type: "stop" as const }] : [])],
      priority: b.priority,
      ...(regla ? { lineId: b.lineId } : b.lineId ? { lineId: b.lineId } : {}),
    };
    const r = await fetch(regla ? `/api/omni/v1/automations/${encodeURIComponent(regla.id)}` : "/api/omni/v1/automations", {
      method: regla ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    }).catch(() => null);
    setGuardando(false);
    const datos = (await r?.json().catch(() => null)) as { data?: { id: string }; detail?: string } | null;
    if (!r?.ok || !datos?.data) {
      setError(datos?.detail ? `El servidor no la aceptó: ${datos.detail}` : "No se pudo guardar la regla.");
      return;
    }
    onGuardada(datos.data.id, !regla);
  };

  return (
    <Dialogo
      titulo={regla ? `Editar «${regla.name}»` : "Nueva regla"}
      onCerrar={onCerrar}
      pie={
        <div className="space-y-2.5">
          {intentado && problemas.length > 0 && (
            <ul role="alert" className="space-y-0.5 text-xs text-(--color-error)">
              {problemas.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {error && <p role="alert" className="text-xs text-(--color-error)">{error}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!regla && (
              <span className="mr-auto text-xs text-(--color-tenue)">
                Se guarda apagada: no hará nada hasta que la enciendas.
              </span>
            )}
            <button type="button" onClick={onCerrar} className={BOTON_SOBRIO}>Cancelar</button>
            <button type="button" onClick={() => void guardar()} disabled={guardando} className={BOTON_PRIMARIO}>
              {guardando ? "Guardando…" : regla ? "Guardar cambios" : "Crear regla"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <label className="block">
          <span className="text-sm font-medium">Nombre</span>
          <input
            value={b.name}
            onChange={(e) => fijar({ name: e.target.value })}
            maxLength={120}
            placeholder="Por ejemplo: Facturas a administración"
            className={`${CONTROL} mt-1.5 w-full`}
          />
        </label>

        <Seccion titulo="Cuando">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              aria-label="Qué tiene que pasar"
              value={DISPARADORES.some((d) => d.valor === b.trigger) ? b.trigger : ""}
              onChange={(e) => fijar({ trigger: e.target.value as Borrador["trigger"] })}
              className={CONTROL}
            >
              {!DISPARADORES.some((d) => d.valor === b.trigger) && (
                <option value="" disabled>{b.trigger} (no se emite todavía)</option>
              )}
              {DISPARADORES.map((d) => <option key={d.valor} value={d.valor}>{d.texto}</option>)}
            </select>
            <span className="text-(--color-tenue)">en</span>
            <select
              aria-label="En qué línea"
              value={b.lineId ?? ""}
              onChange={(e) => fijar({ lineId: e.target.value || null })}
              className={CONTROL}
            >
              <option value="">todas las líneas</option>
              {dic.lineas.map((l) => <option key={l.id} value={l.id}>la línea {l.name}</option>)}
            </select>
          </div>
          {b.trigger === "message.sent" && (
            <p className="mt-1.5 text-xs text-(--color-tenue)">
              Cuenta lo que se manda desde aquí, desde la API y desde el teléfono. No lo que manda otra regla.
            </p>
          )}
          {!deMensaje && (
            <p className="mt-1.5 text-xs text-(--color-tenue)">
              Aquí no hay mensaje ni chat: solo se puede condicionar por la hora y el día, y avisar a una dirección web.
            </p>
          )}
        </Seccion>

        <Seccion
          titulo="Solo si"
          ayuda={b.conditions.length > 1 ? "Tienen que cumplirse todas." : "Sin condiciones, salta siempre."}
        >
          <ul className="space-y-2">
            {b.conditions.map((c, i) => (
              <FilaCondicion
                key={i}
                c={c}
                dic={dic}
                listas={listas}
                hayLinea={b.lineId !== null}
                onCambiar={(nueva) => fijarCondicion(i, nueva)}
                onQuitar={() => setB((x) => ({ ...x, conditions: x.conditions.filter((_, j) => j !== i) }))}
              />
            ))}
          </ul>
          <AnadirDe
            etiqueta="+ Añadir condición"
            opciones={CAMPOS
              .filter((x) => deMensaje || !x.deMensaje)
              // El mismo campo dos veces solo tiene sentido con la hora: «desde» y «hasta».
              .map((x) => ({ valor: x.campo, texto: `${x.texto}${x.campo === "labels" ? " (listas)" : ""}` }))}
            onElegir={(campo) => setB((x) => ({
              ...x, conditions: [...x.conditions, condicionNueva(campo as Campo, zonaLocal())],
            }))}
          />
        </Seccion>

        <Seccion titulo="Entonces" ayuda="Se hacen en este orden.">
          <ul className="space-y-2">
            {acciones.map((a, i) => (
              <FilaAccion
                key={i}
                a={a}
                dic={dic}
                listas={listas}
                hayLinea={b.lineId !== null}
                deMensaje={deMensaje}
                trigger={b.trigger}
                onCambiar={(nueva) => fijarAccion(i, nueva)}
                onQuitar={() => setB((x) => ({
                  ...x, actions: x.actions.filter((y) => y !== a),
                }))}
              />
            ))}
          </ul>
          <AnadirDe
            etiqueta="+ Añadir qué hacer"
            opciones={ACCIONES
              .filter((x) => deMensaje || !x.deMensaje)
              .map((x) => ({ valor: x.tipo, texto: x.texto }))}
            onElegir={(tipo) => setB((x) => {
              const resto = x.actions.filter((y) => y.type !== "stop");
              const nuevas = [...resto, accionNueva(tipo as TipoDeAccion)];
              return { ...x, actions: parar ? [...nuevas, { type: "stop" }] : nuevas };
            })}
          />
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={parar}
              onChange={(e) => setB((x) => ({
                ...x,
                actions: e.target.checked
                  ? [...x.actions.filter((y) => y.type !== "stop"), { type: "stop" }]
                  : x.actions.filter((y) => y.type !== "stop"),
              }))}
              className="mt-0.5 accent-(--color-acento)"
            />
            <span>
              Después, no seguir con las reglas de debajo
              <span className="block text-xs text-(--color-tenue)">
                Para que, si salta esta, no salte también otra más general.
              </span>
            </span>
          </label>
        </Seccion>

        <details className="rounded-lg border border-(--color-borde-sutil) px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Orden</summary>
          <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-(--color-tenue)">Número de orden</span>
            <input
              type="number"
              min={0}
              max={1000}
              value={b.priority}
              onChange={(e) => fijar({ priority: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })}
              className={`${CONTROL} w-24`}
            />
            <span className="w-full text-xs text-(--color-tenue)">
              Las reglas con número más bajo se miran antes. Si dos tienen el mismo, va antes la más antigua.
            </span>
          </label>
        </details>
      </div>
    </Dialogo>
  );
}

function Seccion({ titulo, ayuda, children }: { titulo: string; ayuda?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold tracking-wide text-(--color-acento-fuerte) uppercase">{titulo}</h3>
      {ayuda && <p className="mt-0.5 text-xs text-(--color-tenue)">{ayuda}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Un desplegable que no guarda nada: elegir es añadir. */
function AnadirDe({
  etiqueta, opciones, onElegir,
}: {
  etiqueta: string;
  opciones: { valor: string; texto: string }[];
  onElegir: (valor: string) => void;
}) {
  return (
    <select
      aria-label={etiqueta}
      value=""
      onChange={(e) => { if (e.target.value) onElegir(e.target.value); }}
      className="mt-2 rounded-lg border border-dashed border-(--color-borde) bg-transparent px-2.5 py-1.5 text-sm text-(--color-acento-fuerte) hover:border-(--color-acento)"
    >
      <option value="">{etiqueta}</option>
      {opciones.map((o) => <option key={o.valor} value={o.valor}>{o.texto}</option>)}
    </select>
  );
}

function Quitar({ onClick, que }: { onClick: () => void; que: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Quitar ${que}`}
      title={`Quitar ${que}`}
      className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-lg text-(--color-tenue) hover:bg-(--color-hundido) hover:text-(--color-error)"
    >
      <IconoCerrar className="size-4" />
    </button>
  );
}

function SelectorDeLista({
  valor, listas, hayLinea, onCambiar,
}: {
  valor: string; listas: Diccionario["listas"]; hayLinea: boolean; onCambiar: (id: string) => void;
}) {
  if (!hayLinea) {
    return <span className="text-xs text-(--color-aviso)">Elige una línea arriba: las listas son de cada línea.</span>;
  }
  if (listas.length === 0) {
    return <span className="text-xs text-(--color-tenue)">Esa línea no tiene listas. Créalas desde sus pestañas.</span>;
  }
  return (
    <select aria-label="Lista" value={valor} onChange={(e) => onCambiar(e.target.value)} className={CONTROL}>
      <option value="" disabled>elige una lista</option>
      {listas.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  );
}

function FilaCondicion({
  c, dic, listas, hayLinea, onCambiar, onQuitar,
}: {
  c: Condicion;
  dic: Diccionario;
  listas: Diccionario["listas"];
  hayLinea: boolean;
  onCambiar: (c: Condicion) => void;
  onQuitar: () => void;
}) {
  const campo = campoDe(c.field);
  const op = operadorDe(c.field, c.op);
  if (!campo || !op) {
    // Una condición hecha por la API con algo que este formulario no ofrece:
    // se enseña tal cual y se puede quitar, pero no se reinterpreta.
    return (
      <li className="flex items-center gap-2 rounded-lg bg-(--color-hundido) px-3 py-2 text-sm">
        <code className="text-xs">{c.field} {c.op} {JSON.stringify(c.value ?? "")}</code>
        <Quitar onClick={onQuitar} que="la condición" />
      </li>
    );
  }
  const valor = ((): React.ReactNode => {
    switch (op.valor) {
      case "nada": return null;
      case "texto":
        return (
          <input
            aria-label="Valor"
            value={String(c.value ?? "")}
            onChange={(e) => onCambiar({ ...c, value: e.target.value })}
            placeholder={c.field === "from" ? "51987654321" : c.op === "matches" ? "^(hola|buenas)" : "factura"}
            className={`${CONTROL} min-w-0 flex-1`}
          />
        );
      case "lista":
        return (
          <SelectorDeLista
            valor={String(c.value ?? "")} listas={listas} hayLinea={hayLinea}
            onCambiar={(id) => onCambiar({ ...c, value: id })}
          />
        );
      case "estado": case "prioridad": case "tipo-chat": {
        const opciones = op.valor === "estado" ? ESTADOS_TEXTO : op.valor === "prioridad" ? PRIORIDADES_TEXTO : TIPOS_DE_CHAT;
        return (
          <select aria-label="Valor" value={String(c.value)} onChange={(e) => onCambiar({ ...c, value: e.target.value })} className={CONTROL}>
            {Object.entries(opciones).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        );
      }
      case "miembro":
        return (
          <select aria-label="Quién" value={String(c.value ?? "")} onChange={(e) => onCambiar({ ...c, value: e.target.value })} className={CONTROL}>
            <option value="" disabled>elige a alguien</option>
            {dic.miembros.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
        );
      case "hora":
        return (
          <span className="flex items-center gap-1.5">
            <select aria-label="Hora" value={String(c.value ?? 9)} onChange={(e) => onCambiar({ ...c, value: Number(e.target.value) })} className={CONTROL}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
            <span className="text-xs text-(--color-apagado)" title="La hora se cuenta en esta zona, no en la del servidor">
              {c.timeZone ?? "hora del servidor"}
            </span>
          </span>
        );
      case "dias": {
        const marcados = Array.isArray(c.value) ? c.value.map(String) : [];
        return (
          <span role="group" aria-label="Días" className="flex gap-1">
            {DIAS.map((d) => {
              const puesto = marcados.includes(d.valor);
              return (
                <button
                  key={d.valor}
                  type="button"
                  aria-pressed={puesto}
                  title={d.largo}
                  onClick={() => onCambiar({
                    ...c, value: puesto ? marcados.filter((x) => x !== d.valor) : [...marcados, d.valor],
                  })}
                  className={`size-7 rounded-md text-xs font-semibold transition-colors duration-150 ${
                    puesto
                      ? "bg-(--color-acento) text-(--color-sobre-acento)"
                      : "bg-(--color-hundido) text-(--color-tenue) hover:text-(--color-texto)"
                  }`}
                >
                  {d.corto}
                </button>
              );
            })}
          </span>
        );
      }
    }
  })();

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-(--color-hundido) px-3 py-2 text-sm">
      <span className="font-medium">{campo.texto}</span>
      <select
        aria-label="Cómo se compara"
        value={c.op}
        onChange={(e) => {
          const nuevo = operadorDe(c.field, e.target.value as Operador)!;
          // Si cambia lo que se compara (un texto, una persona, nada), el
          // valor viejo ya no vale.
          onCambiar(nuevo.valor === op.valor
            ? { ...c, op: nuevo.op }
            : { field: c.field, op: nuevo.op, value: valorPara(nuevo, c.field), ...(c.timeZone ? { timeZone: c.timeZone } : {}) });
        }}
        className={CONTROL}
      >
        {campo.operadores.map((o) => <option key={o.op} value={o.op}>{o.texto}</option>)}
      </select>
      {valor}
      <Quitar onClick={onQuitar} que="la condición" />
    </li>
  );
}

function FilaAccion({
  a, dic, listas, hayLinea, deMensaje, trigger, onCambiar, onQuitar,
}: {
  a: Accion;
  dic: Diccionario;
  listas: Diccionario["listas"];
  hayLinea: boolean;
  deMensaje: boolean;
  trigger: string;
  onCambiar: (a: Accion) => void;
  onQuitar: () => void;
}) {
  const nombre = ACCIONES.find((x) => x.tipo === a.type)?.texto ?? a.type;
  const fuera = !deMensaje && ACCIONES.find((x) => x.tipo === a.type)?.deMensaje;
  return (
    <li className={`rounded-lg px-3 py-2 text-sm ${fuera ? "bg-(--color-error-tenue)" : "bg-(--color-hundido)"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{nombre}</span>
        {(a.type === "add_label" || a.type === "remove_label") && (
          <SelectorDeLista
            valor={a.labelId} listas={listas} hayLinea={hayLinea}
            onCambiar={(id) => onCambiar({ ...a, labelId: id })}
          />
        )}
        {a.type === "assign" && (
          <select
            aria-label="A quién"
            value={a.userId ?? ""}
            onChange={(e) => onCambiar({ ...a, userId: e.target.value || null })}
            className={CONTROL}
          >
            <option value="">nadie (quitar responsable)</option>
            {dic.miembros.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
        )}
        {a.type === "set_status" && (
          <select aria-label="Estado" value={a.status} onChange={(e) => onCambiar({ ...a, status: e.target.value as typeof a.status })} className={CONTROL}>
            {Object.entries(ESTADOS_TEXTO).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        )}
        {a.type === "set_priority" && (
          <select aria-label="Prioridad" value={a.priority} onChange={(e) => onCambiar({ ...a, priority: e.target.value as typeof a.priority })} className={CONTROL}>
            {Object.entries(PRIORIDADES_TEXTO).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        )}
        {a.type === "webhook" && (
          <input
            aria-label="Dirección del webhook"
            type="url"
            value={a.url}
            onChange={(e) => onCambiar({ ...a, url: e.target.value })}
            placeholder="https://…"
            className={`${CONTROL} min-w-0 flex-1`}
          />
        )}
        <Quitar onClick={onQuitar} que={nombre} />
      </div>
      {a.type === "send_message" && (
        <div className="mt-2 space-y-1.5">
          <textarea
            aria-label="Texto de la respuesta"
            value={a.text}
            onChange={(e) => onCambiar({ ...a, text: e.target.value })}
            maxLength={4096}
            rows={2}
            placeholder="Gracias por escribir. Te contestamos en un momento."
            className={`${CONTROL} w-full resize-y`}
          />
          {trigger === "message.received" && (
            <label className="flex items-center gap-2 text-xs text-(--color-tenue)">
              <input
                type="checkbox"
                checked={a.asReply ?? false}
                onChange={(e) => onCambiar({ ...a, asReply: e.target.checked })}
                className="accent-(--color-acento)"
              />
              Citando el mensaje que la hizo saltar
            </label>
          )}
          <p className="text-xs text-(--color-tenue)">
            Sale por WhatsApp al cliente. Lo que manda una regla no hace saltar otras reglas.
          </p>
        </div>
      )}
      {a.type === "webhook" && (
        <p className="mt-1.5 text-xs text-(--color-tenue)">
          Se manda un POST con qué pasó, en qué línea y chat y el texto. Si responde con error, cuenta como fallo en el historial.
        </p>
      )}
    </li>
  );
}

/**
 * Lo que ha hecho una regla, incluido lo que falló.
 *
 * Es la otra mitad de una automatización: una regla que deja de funcionar y
 * nadie se entera es el fallo que hay que evitar, y aquí se ve con su motivo.
 */
function Historial({ regla, dic, onCerrar }: { regla: Regla; dic: Diccionario; onCerrar: () => void }) {
  const [soloFallos, setSoloFallos] = useState(false);
  const [disparos, setDisparos] = useState<{ clave: string; lista: Disparo[] } | null>(null);
  const clave = `${regla.id}|${soloFallos}`;

  useEffect(() => {
    let vivo = true;
    void fetch(`/api/omni/v1/automations/${encodeURIComponent(regla.id)}/runs?limit=50${soloFallos ? "&outcome=failed" : ""}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { data: Disparo[] }).data : []))
      .then((lista) => { if (vivo) setDisparos({ clave: `${regla.id}|${soloFallos}`, lista }); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [regla.id, soloFallos]);

  const lista = disparos?.clave === clave ? disparos.lista : null;
  const objetivo = (t: string | null): string => {
    if (!t) return "";
    const linea = dic.lineas.find((l) => l.id === t);
    if (linea) return `línea ${linea.name}`;
    if (t.endsWith("@s.whatsapp.net")) return bonito(t.split("@")[0]!);
    if (t.endsWith("@g.us")) return "un grupo";
    return t;
  };

  return (
    <Dialogo
      titulo={`Historial de «${regla.name}»`}
      onCerrar={onCerrar}
      pie={
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={soloFallos} onChange={(e) => setSoloFallos(e.target.checked)} className="accent-(--color-acento)" />
          Solo lo que falló
        </label>
      }
    >
      {lista === null ? (
        <p className="py-8 text-center text-sm text-(--color-tenue)">Cargando…</p>
      ) : lista.length === 0 ? (
        <p className="py-8 text-center text-sm text-(--color-tenue)">
          {soloFallos ? "No ha fallado nunca." : "Todavía no ha saltado."}
        </p>
      ) : (
        <ul className="divide-y divide-(--color-borde-sutil)">
          {lista.map((d) => (
            <li key={d.id} className="flex items-start gap-3 py-2.5 text-sm">
              <span
                className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  d.outcome === "failed"
                    ? "bg-(--color-error-tenue) text-(--color-error)"
                    : d.outcome === "skipped"
                      ? "bg-(--color-hundido) text-(--color-tenue)"
                      : "bg-(--color-exito-tenue) text-(--color-exito)"
                }`}
              >
                {d.outcome === "failed" ? "Falló" : d.outcome === "skipped" ? "Repetida" : "Hecho"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">
                  {d.actionsRun.length > 0
                    ? d.actionsRun.map((x) => ACCION_HECHA[x] ?? x).join(", ")
                    : d.outcome === "skipped" ? "No hizo nada: ese mismo mensaje ya la había hecho saltar." : "No llegó a hacer nada."}
                  {d.target && <span className="text-(--color-tenue)"> · {objetivo(d.target)}</span>}
                </span>
                {d.reason && d.outcome === "failed" && (
                  <span className="mt-0.5 block text-xs text-(--color-error)">{d.reason}</span>
                )}
              </span>
              <span className="shrink-0 text-right text-xs text-(--color-apagado)">
                {cuandoFue(d.createdAt)}
                {d.durationMs != null && <span className="block">{d.durationMs} ms</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialogo>
  );
}
