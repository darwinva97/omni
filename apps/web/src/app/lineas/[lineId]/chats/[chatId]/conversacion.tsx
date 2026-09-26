"use client";

import { useEffect, useOptimistic, useRef, useState, startTransition } from "react";
import type { Mensaje } from "@/lib/api";

/**
 * La conversación, con los mensajes que llegan en vivo.
 *
 * El histórico lo trae el servidor; a partir de ahí, el WebSocket. Recargar la
 * página para ver si alguien ha contestado es exactamente lo que un panel de
 * mensajería no debe obligar a hacer.
 */
export function Conversacion({
  lineId,
  chat,
  iniciales,
  enviar,
}: {
  lineId: string;
  chat: string;
  iniciales: Mensaje[];
  enviar: (formData: FormData) => Promise<void>;
}) {
  const [mensajes, setMensajes] = useState<Mensaje[]>(iniciales);
  const [conectado, setConectado] = useState(false);
  const fondo = useRef<HTMLDivElement>(null);
  const formulario = useRef<HTMLFormElement>(null);

  // Lo enviado aparece al instante y se marca como "enviando": esperar al
  // servidor para pintar lo que el usuario acaba de escribir se siente roto.
  const [conPendientes, añadirPendiente] = useOptimistic(
    mensajes,
    (actuales: Mensaje[], texto: string) => [
      ...actuales,
      {
        id: `pendiente-${texto}`, providerMessageId: null, fromMe: true,
        kind: "text", body: texto, state: "enviando",
        timestamp: new Date().toISOString(),
      },
    ],
  );

  useEffect(() => {
    let ws: WebSocket | null = null;
    let cerrado = false;
    let reintento: ReturnType<typeof setTimeout> | undefined;
    let espera = 1000;

    const abrir = async (): Promise<void> => {
      try {
        // El billete se pide por el intermediario, con la cookie de sesión;
        // el socket se abre DIRECTAMENTE contra la API, porque un manejador de
        // ruta HTTP no puede reenviar una conexión WebSocket. La credencial en
        // esa URL es el billete: dura un minuto y sirve una vez.
        const r = await fetch("/api/omni/v1/realtime/ticket", { method: "POST" });
        if (!r.ok) throw new Error("sin billete");
        const { data } = (await r.json()) as { data: { url: string } };

        ws = new WebSocket(data.url);

        ws.onopen = () => {
          espera = 1000;
          setConectado(true);
          ws?.send(JSON.stringify({ type: "subscribe", events: ["message.*"], lines: [lineId] }));
        };

        ws.onmessage = (e) => {
          const m = JSON.parse(e.data as string) as {
            type: string; event?: string; data?: Record<string, unknown>;
          };
          if (m.type !== "event" || !m.event?.startsWith("message.")) return;

          const key = (m.data?.["key"] ?? {}) as { id?: string; remoteJid?: string; fromMe?: boolean };
          if (key.remoteJid !== chat) return;

          if (m.event === "message.receipt") {
            const estado = String(m.data?.["state"] ?? "");
            setMensajes((prev) =>
              prev.map((x) => (x.providerMessageId === key.id ? { ...x, state: estado } : x)),
            );
            return;
          }
          // `upsert` duplica lo que ya llegó por `received`/`sent`: se ignora.
          if (m.event === "message.upsert") return;

          setMensajes((prev) => {
            if (prev.some((x) => x.providerMessageId === key.id)) return prev;
            return [...prev, {
              id: key.id ?? crypto.randomUUID(),
              providerMessageId: key.id ?? null,
              fromMe: key.fromMe ?? false,
              kind: String(m.data?.["kind"] ?? "text"),
              body: (m.data?.["text"] as string | null) ?? null,
              state: key.fromMe ? "sent" : "delivered",
              timestamp: new Date(Number(m.data?.["timestamp"] ?? Date.now())).toISOString(),
            }];
          });
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
  }, [lineId, chat]);

  useEffect(() => {
    fondo.current?.scrollIntoView({ behavior: "smooth" });
  }, [conPendientes.length]);

  return (
    <main className="mx-auto flex h-[calc(100dvh-57px)] max-w-3xl flex-col px-5">
      <div className="flex items-center gap-2 py-2 text-xs text-(--color-tenue)">
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${conectado ? "bg-green-500" : "bg-(--color-tenue)"}`}
        />
        {conectado ? "en vivo" : "reconectando…"}
      </div>

      <ol className="flex-1 space-y-2 overflow-y-auto py-2">
        {conPendientes.map((m) => (
          <li key={m.id} className={m.fromMe ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                m.fromMe ? "bg-(--color-propio)" : "bg-(--color-ajeno)"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{m.body ?? <em className="text-(--color-tenue)">{m.kind}</em>}</p>
              <p className="mt-1 text-[10px] text-(--color-tenue)">
                {new Date(m.timestamp).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                {m.fromMe && ` · ${m.state}`}
              </p>
            </div>
          </li>
        ))}
        <div ref={fondo} />
      </ol>

      <form
        ref={formulario}
        action={async (formData) => {
          const texto = String(formData.get("texto") ?? "").trim();
          if (!texto) return;
          formulario.current?.reset();
          startTransition(() => añadirPendiente(texto));
          await enviar(formData);
        }}
        className="flex gap-2 border-t border-(--color-borde) py-3"
      >
        <input
          name="texto" autoComplete="off" placeholder="Escribe un mensaje…"
          className="flex-1 rounded-lg border border-(--color-borde) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-acento)"
        />
        <button className="rounded-lg bg-(--color-acento) px-4 py-2 text-sm text-white hover:opacity-90">
          Enviar
        </button>
      </form>
    </main>
  );
}
