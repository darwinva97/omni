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

type Oyente = (evento: string, data: Record<string, unknown>) => void | Promise<void>;

export function useEventos(lineId: string): {
  conectado: boolean;
  suscribir: (oyente: Oyente) => () => void;
} {
  const [conectado, setConectado] = useState(false);
  const oyentes = useRef(new Set<Oyente>());

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
            events: ["message.*", "chat.*", "session.*"],
            lines: [lineId],
          }));
        };

        ws.onmessage = (e) => {
          const m = JSON.parse(e.data as string) as {
            type: string; event?: string; data?: Record<string, unknown>;
          };
          if (m.type !== "event" || !m.event) return;
          for (const oyente of oyentes.current) void oyente(m.event, m.data ?? {});
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
  }, [lineId]);

  return { conectado, suscribir };
}
