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
  address: string; kind: string;
  /** Lo que hay que ENSEÑAR. La dirección es el detalle. */
  displayName: string;
  title: string | null;
  /** El que tú le pusiste en tu agenda. */
  savedName: string | null;
  /** El que esa persona se puso a sí misma. */
  pushName: string | null;
  /** Foto de perfil, ya firmada. */
  avatarUrl: string | null;
  /** El teléfono detrás de un LID, cuando se sabe. */
  phone: string | null;
  lastMessageAt: string | null; unreadCount: number;
  /** Resumen del último mensaje, para la lista. */
  ultimo: string | null;
  ultimoPropio: boolean;
}

export interface Medio {
  url: string; mimeType: string; fileName: string | null; size: number | null;
}

export interface Mensaje {
  id: string; providerMessageId: string | null; fromMe: boolean;
  /**
   * El identificador que pusimos nosotros al enviar.
   *
   * Es el puente para reconocer un mensaje propio cuando vuelve: lo que llega
   * por el socket trae el identificador de WhatsApp, que al enviar todavía no
   * conocíamos.
   */
  clientMessageId?: string | null;
  /** Quién lo escribió. Solo se enseña en grupos: en un chat de dos sobra. */
  senderAddress?: string | null;
  senderName?: string | null;
  kind: string; body: string | null; state: string; timestamp: string;
  media?: Medio | null;
  /** Por qué no hay fichero, cuando debería haberlo. */
  mediaError?: string | null;
  /** Reacciones agrupadas por emoji. */
  reacciones?: { emoji: string; cuantas: number; mia: boolean }[];
  /** Retirado por quien lo escribió. El cuerpo llega, pero no se enseña. */
  deleted?: boolean;
}

export interface Yo {
  id: string; email: string; name: string; orgId: string | null; role: string | null;
}
