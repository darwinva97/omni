"use client";

import { useEffect, useState } from "react";
import type { Miembro, Yo } from "./api";

/**
 * El equipo y quién soy yo, pedidos UNA vez por página.
 *
 * Los usan la lista —para decir quién lleva cada chat y saber cuáles son
 * «míos»— y la cabecera de la conversación —para elegir responsable—. Cambian
 * muy de vez en cuando, y pedirlos en cada conversación que se abre sería un
 * viaje por clic para traer siempre lo mismo.
 */
interface Equipo { yo: Yo | null; miembros: Miembro[] }

let pedido: Promise<Equipo> | null = null;

async function leer<T>(ruta: string): Promise<T | null> {
  const r = await fetch(`/api/omni${ruta}`).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as { data: T }).data;
}

function pedir(): Promise<Equipo> {
  if (!pedido) {
    pedido = Promise.all([leer<Yo>("/v1/auth/me"), leer<Miembro[]>("/v1/members")])
      .then(([yo, miembros]) => ({ yo, miembros: miembros ?? [] }));
    // Si falló, que el próximo lo intente otra vez en vez de quedarse vacío.
    void pedido.then((e) => { if (!e.yo) pedido = null; });
  }
  return pedido;
}

export function useEquipo(): Equipo {
  const [equipo, setEquipo] = useState<Equipo>({ yo: null, miembros: [] });
  useEffect(() => {
    let vivo = true;
    void pedir().then((e) => { if (vivo) setEquipo(e); });
    return () => { vivo = false; };
  }, []);
  return equipo;
}
