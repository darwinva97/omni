import { redirect } from "next/navigation";
import { ApiError, apiFetch, apiFetchAuth, type Linea, type Lista, type Miembro } from "@/lib/api";
import { Pagina } from "@/componentes/armazon";
import { Aviso } from "@/componentes/piezas";
import type { Diccionario, Disparo, Regla } from "@/lib/automatizaciones";
import { PanelDeAutomatizaciones } from "./panel";

/**
 * Automatizaciones: reglas que actúan solas cuando pasa algo.
 *
 * Es una pantalla administrativa —una regla actúa sobre toda la organización
 * y puede mandar mensajes a clientes—, así que solo la abre quien la
 * administra. A los demás se les dice, en vez de mandarles a la entrada como
 * si se les hubiera caído la sesión.
 */
export default async function Automatizaciones() {
  let reglas: Regla[];
  try {
    reglas = await apiFetch<Regla[]>("/v1/automations");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect("/entrar");
    if (err instanceof ApiError && err.status === 403) {
      return (
        <Pagina actual="/automatizaciones" titulo="Automatizaciones">
          <Aviso>
            Solo quien administra la organización puede ver y cambiar las
            automatizaciones: una regla actúa sobre todas las conversaciones y
            puede escribir a los clientes por su cuenta.
          </Aviso>
        </Pagina>
      );
    }
    throw err;
  }

  const [lineas, miembros] = await Promise.all([
    apiFetchAuth<Linea[]>("/v1/lines"),
    apiFetchAuth<Miembro[]>("/v1/members").catch(() => [] as Miembro[]),
  ]);
  // Las listas son de cada línea, y una regla las usa cuando está acotada a una.
  const listasPorLinea = await Promise.all(lineas.map(async (l) =>
    (await apiFetch<Lista[]>(`/v1/lines/${l.id}/labels`).catch(() => [] as Lista[]))
      .map((x) => ({ id: x.id, name: x.name, lineId: l.id }))));
  // El último disparo de cada regla: es lo que dice de un vistazo si funciona.
  const ultimos = Object.fromEntries(await Promise.all(reglas.map(async (r) => [
    r.id,
    (await apiFetch<Disparo[]>(`/v1/automations/${r.id}/runs?limit=1`).catch(() => []))[0] ?? null,
  ] as const)));

  const dic: Diccionario = {
    lineas: lineas.map((l) => ({ id: l.id, name: l.name })),
    listas: listasPorLinea.flat(),
    miembros: miembros.map((m) => ({ userId: m.userId, name: m.name })),
  };

  return (
    <Pagina
      actual="/automatizaciones"
      titulo="Automatizaciones"
      descripcion="Reglas que actúan solas cuando pasa algo: responder, poner en una lista, asignar, avisar. Toda regla nace apagada; la enciendes cuando la tengas lista."
    >
      <PanelDeAutomatizaciones reglas={reglas} ultimos={ultimos} dic={dic} />
    </Pagina>
  );
}
