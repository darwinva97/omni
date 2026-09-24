import type { CloudSendResponse } from "./types.js";

/**
 * Meta falso.
 *
 * Responde como la Graph API a lo que el driver le pide. No simula el negocio
 * de WhatsApp: simula la SUPERFICIE HTTP, que es lo que hay que fijar para que
 * un cambio en el driver no rompa el contrato en silencio.
 */
export interface FakeMeta {
  readonly fetchImpl: typeof fetch;
  /** Todo lo enviado, para poder afirmar sobre ello. */
  readonly llamadas: { url: string; method: string; body: unknown }[];
  /** Si se define, la siguiente llamada falla así. */
  fallo: { status: number; message: string; code?: number } | null;
  numeroVerificado: string;
}

export function createFakeMeta(opts: { numero?: string } = {}): FakeMeta {
  let contador = 0;
  const meta: FakeMeta = {
    llamadas: [],
    fallo: null,
    numeroVerificado: opts.numero ?? "+51 999 888 777",
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      meta.llamadas.push({ url: u, method: init?.method ?? "GET", body });

      if (meta.fallo) {
        const f = meta.fallo;
        meta.fallo = null;
        return new Response(
          JSON.stringify({ error: { message: f.message, type: "OAuthException", code: f.code ?? 100 } }),
          { status: f.status, headers: { "content-type": "application/json" } },
        );
      }

      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({ display_phone_number: meta.numeroVerificado, verified_name: "Empresa" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const respuesta: CloudSendResponse = {
        messaging_product: "whatsapp",
        messages: [{ id: `wamid.FAKE${String(++contador).padStart(4, "0")}` }],
      };
      return new Response(JSON.stringify(respuesta), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  };
  return meta;
}
