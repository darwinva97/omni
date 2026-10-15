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
  /** Su @usuario de WhatsApp, sin la arroba. */
  username?: string | null;
  /** Foto de perfil, ya firmada. */
  avatarUrl: string | null;
  /** El teléfono detrás de un LID, cuando se sabe. */
  phone: string | null;
  lastMessageAt: string | null; unreadCount: number;
  /** Resumen del último mensaje, para la lista. */
  ultimo: string | null;
  ultimoPropio: boolean;
  /**
   * Silenciada en WhatsApp hasta este instante.
   *
   * Es el silencio de la cuenta, no un ajuste de este panel: lo que callas
   * aquí queda callado en el teléfono, y al revés.
   */
  mutedUntil?: string | null;
  archived?: boolean;
  pinned?: boolean;
  /** Cuánto duran los mensajes, en segundos: 0 = desactivados, `null` = no se sabe. */
  ephemeralSeconds?: number | null;
  /** Las listas de Omni en las que está. No existen en WhatsApp. */
  labelIds?: string[];
  /**
   * Quién lo lleva y en qué estado: la conversación de atención del chat.
   *
   * La abierta, o si no hay, la última ya resuelta. `null` si el chat aún no
   * ha tenido ninguna.
   */
  conversation?: Conversacion | null;
}

export type EstadoDeConversacion = "open" | "pending" | "snoozed" | "resolved";

export interface Conversacion {
  id: string; lineId: string; chatId: string;
  status: EstadoDeConversacion;
  priority: string;
  assigneeId: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

/** Alguien del equipo, como lo da `/v1/members`. */
export interface Miembro {
  userId: string; email: string; name: string; role: string;
}

/**
 * Una lista de Omni: agrupa conversaciones en una pestaña.
 *
 * En la API se llama etiqueta, que es lo que es por debajo; en el panel se
 * llama lista porque es lo que la gente hace con ella, y es el nombre que usa
 * WhatsApp para lo mismo.
 */
export interface Lista {
  id: string; name: string; color: string | null; usos: number;
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
  /** La foto de quien lo escribió, en un grupo. */
  senderAvatarUrl?: string | null;
  kind: string; body: string | null; state: string; timestamp: string;
  media?: Medio | null;
  /** Por qué no hay fichero, cuando debería haberlo. */
  mediaError?: string | null;
  /** Por qué no salió, cuando `state` es `failed`: lo que dijo el transporte. */
  failureReason?: string | null;
  /** Si lo tiene destacado quien mira. La estrella es de cada uno, no del chat. */
  starred?: boolean;
  /** Reacciones agrupadas por emoji. */
  reacciones?: { emoji: string; cuantas: number; mia: boolean }[];
  /** Retirado por quien lo escribió. El cuerpo llega, pero no se enseña. */
  deleted?: boolean;
  /** Si se editó, cuándo. El cuerpo ya es el texto nuevo. */
  editedAt?: string | null;
  /**
   * A quién menciona, ya resuelto por el servidor.
   *
   * El texto trae `@120238196658384`; cada entrada dice qué número es y qué
   * nombre enseñar en su lugar. El ORDEN de nombres —agenda, el suyo,
   * @usuario, número, id— lo decide el servidor, no el panel.
   */
  mentions?: { token: string; address?: string; name: string }[];
  /** A qué mensaje responde, ya resuelto por la API. */
  replyTo?: Cita | null;
  /** La encuesta, con sus votos ya contados, cuando el mensaje es una. */
  poll?: Encuesta | null;
}

export interface Encuesta {
  question: string;
  allowMultiple: boolean;
  totalVotes: number;
  options: { name: string; votes: number; mine: boolean }[];
}

export interface Cita {
  id: string;
  fromMe: boolean;
  senderName: string | null;
  kind: string;
  body: string | null;
  /** Miniatura del citado, cuando lo tenemos y lleva fichero. */
  thumbUrl: string | null;
  /** Duración de un audio o vídeo citado, en segundos. */
  seconds?: number | null;
  /** Nota de voz, y no un fichero de audio. */
  ptt?: boolean;
  /** Nombre del documento citado. */
  fileName?: string | null;
  /**
   * `false` cuando el original no está en esta base: la cita se enseña igual
   * —WhatsApp manda una copia dentro— pero no se puede saltar a ella.
   */
  disponible: boolean;
}

export interface Yo {
  id: string; email: string; name: string; orgId: string | null; role: string | null;
}

/** Una nota interna: la ve el equipo dentro del chat, nunca el cliente. */
export interface Nota {
  id: string;
  chatId: string;
  body: string;
  createdAt: string;
  author: { kind: "user" | "api-key"; userId: string | null; name: string | null };
}
