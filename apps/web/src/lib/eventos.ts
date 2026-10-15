"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Un solo WebSocket por página, compartido por quien lo necesite.
 *
 * La lista de conversaciones y la conversación abierta quieren los mismos
 * eventos. Con un socket por componente, cada pestaña abriría dos conexiones y
 * pediría dos billetes, y la cuenta sube con cada vista nueva.
 *
 * El billete se pide por el intermediario, con la cookie de sesión; el socket
 * se abre DIRECTAMENTE contra la API, porque un manejador de ruta HTTP no
 * puede reenviar una conexión WebSocket. La credencial que va en esa URL es el
 * billete: dura un minuto y sirve una vez.
 */

type Oyente = (
  evento: string, data: Record<string, unknown>, lineId: string,
) => void | Promise<void>;

/*
 * `presence.*`: quién escribe o graba. Sin él, el «escribiendo…» llegaba al
 * motor y no salía de ahí.
 * `conversation.*`: quién lleva cada chat y si está resuelto.
 * `note.*`: la nota interna que deja un compañero en el chat abierto.
 */
const DE_UNA_LINEA = [
  "message.*", "chat.*", "session.*", "presence.*", "conversation.*", "note.*",
] as const;

/**
 * `lineId` nulo = TODAS las líneas que alcance la sesión, para lo que se
 * vigila desde cualquier pantalla (el aviso de línea caída). Con `eventos`
 * se pide solo lo que hace falta: no tiene sentido recibir cada mensaje de
 * cada línea para enterarse de que una se cayó.
 */
export function useEventos(lineId: string | null, eventos: readonly string[] = DE_UNA_LINEA): {
  conectado: boolean;
  suscribir: (oyente: Oyente) => () => void;
} {
  const [conectado, setConectado] = useState(false);
  const oyentes = useRef(new Set<Oyente>());
  // Por valor y no por identidad: un `[...]` escrito en la llamada es otro en
  // cada repintado y reabriría el socket cada vez.
  const patrones = eventos.join(",");

  const suscribir = useCallback((oyente: Oyente) => {
    oyentes.current.add(oyente);
    return () => { oyentes.current.delete(oyente); };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let cerrado = false;
    let reintento: ReturnType<typeof setTimeout> | undefined;
    let espera = 1000;

    const abrir = async (): Promise<void> => {
      try {
        const r = await fetch("/api/omni/v1/realtime/ticket", { method: "POST" });
        if (!r.ok) throw new Error("sin billete");
        const { data } = (await r.json()) as { data: { url: string } };

        ws = new WebSocket(data.url);

        ws.onopen = () => {
          espera = 1000;
          setConectado(true);
          ws?.send(JSON.stringify({
            type: "subscribe",
            events: patrones.split(","),
            lines: lineId ? [lineId] : [],
          }));
        };

        ws.onmessage = (e) => {
          const m = JSON.parse(e.data as string) as {
            type: string; event?: string; lineId?: string; data?: Record<string, unknown>;
          };
          if (m.type !== "event" || !m.event) return;
          for (const oyente of oyentes.current) void oyente(m.event, m.data ?? {}, m.lineId ?? "");
        };

        const reconectar = (): void => {
          setConectado(false);
          if (cerrado) return;
          // Espera creciente: reconectar en bucle cerrado castiga al servidor
          // justo cuando ya está teniendo problemas.
          reintento = setTimeout(() => void abrir(), espera);
          espera = Math.min(espera * 2, 30000);
        };
        ws.onclose = reconectar;
        ws.onerror = () => ws?.close();
      } catch {
        if (!cerrado) {
          reintento = setTimeout(() => void abrir(), espera);
          espera = Math.min(espera * 2, 30000);
        }
      }
    };

    void abrir();
    return () => {
      cerrado = true;
      if (reintento) clearTimeout(reintento);
      ws?.close();
    };
  }, [lineId, patrones]);

  return { conectado, suscribir };
}
