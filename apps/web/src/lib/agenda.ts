"use client";

import { useEffect, useState } from "react";

/** Una persona de la agenda, como la da la API: una vez, con sus dos direcciones. */
export interface Contacto {
  address: string;
  name: string;
  savedName: string | null;
  pushName: string | null;
  lid: string | null;
  phone: string | null;
  /** La conversación que ya existe con ella, si la hay. */
  chat: string | null;
}

/*
 * La agenda se pide UNA vez por línea y se comparte.
 *
 * La usan la lista (para buscar) y la conversación (para el «@»), y cambia
 * poco. Una petición por pestaña o por cada «@» sería pedir trescientos
 * contactos cada vez que alguien escribe una arroba.
 */
const cache = new Map<string, Promise<Contacto[]>>();

function pedir(lineId: string): Promise<Contacto[]> {
  let p = cache.get(lineId);
  if (!p) {
    p = fetch(`/api/omni/v1/lines/${lineId}/contacts?agenda=true&limit=2000`)
      .then(async (r) => (r.ok ? ((await r.json()) as { data: Contacto[] }).data : []))
      .catch(() => []);
    cache.set(lineId, p);
    // Si falló, que el próximo lo vuelva a intentar en vez de quedarse vacío.
    void p.then((l) => { if (l.length === 0) cache.delete(lineId); });
  }
  return p;
}

export function useAgenda(lineId: string): Contacto[] {
  const [agenda, setAgenda] = useState<{ lineId: string; lista: Contacto[] } | null>(null);
  useEffect(() => {
    let vivo = true;
    void pedir(lineId).then((lista) => { if (vivo) setAgenda({ lineId, lista }); });
    return () => { vivo = false; };
  }, [lineId]);
  return agenda?.lineId === lineId ? agenda.lista : [];
}

const plano = (t: string): string =>
  t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Los contactos que coinciden con lo buscado: por nombre o por número. */
export function buscarEnAgenda(agenda: readonly Contacto[], q: string): Contacto[] {
  const f = plano(q.trim());
  if (!f) return [];
  const digitos = q.replace(/\D/g, "");
  return agenda.filter((c) =>
    [c.name, c.savedName, c.pushName].some((n) => n && plano(n).includes(f))
    || (digitos.length >= 3 && (c.phone ?? "").includes(digitos)));
}
