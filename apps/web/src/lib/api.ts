import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { API_URL, SESSION_COOKIE } from "./config";

/**
 * Cliente de la API para componentes de servidor.
 *
 * El panel hace de intermediario y la cookie de sesión es de PRIMERA PARTE:
 * el navegador nunca habla directamente con la API, así que no hay CORS ni
 * cookies de terceros que los navegadores están retirando.
 */

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    // Los datos de una conversación cambian a cada momento; cachearlos aquí
    // mostraría mensajes viejos sin que nadie entienda por qué.
    cache: "no-store",
  });

  const texto = await res.text();
  const cuerpo: unknown = texto ? JSON.parse(texto) : {};

  if (!res.ok) {
    const problema = cuerpo as { detail?: string; title?: string };
    throw new ApiError(res.status, problema.detail ?? problema.title ?? `la API respondió ${res.status}`);
  }
  return ((cuerpo as { data?: T }).data ?? cuerpo) as T;
}

/** Como `apiFetch`, pero manda a la pantalla de entrada si no hay sesión. */
export async function apiFetchAuth<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await apiFetch<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) redirect("/entrar");
    throw err;
  }
}

export interface Linea {
  id: string; name: string; slug: string; channelKind: string;
  address: string | null; status: string; enabled: boolean; sendRatePerMinute: number;
}

export interface Chat {
  address: string; kind: string; title: string | null;
  lastMessageAt: string | null; unreadCount: number;
}

export interface Mensaje {
  id: string; providerMessageId: string | null; fromMe: boolean;
  kind: string; body: string | null; state: string; timestamp: string;
}

export interface Yo {
  id: string; email: string; name: string; orgId: string | null; role: string | null;
}
