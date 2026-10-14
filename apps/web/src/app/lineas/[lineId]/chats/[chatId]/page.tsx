import { apiFetch, apiFetchAuth, type Chat, type Mensaje } from "@/lib/api";
import { Conversacion } from "./conversacion";

export default async function ChatAbierto({
  params,
}: {
  params: Promise<{ lineId: string; chatId: string }>;
}) {
  const { lineId, chatId } = await params;
  const chat = decodeURIComponent(chatId);

  const [mensajes, delChat] = await Promise.all([
    apiFetchAuth<Mensaje[]>(
      `/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages?limit=100`,
    ),
    apiFetchAuth<Chat>(`/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}`)
      .catch(() => null),
  ]);
  const info = delChat ?? await deLaAgenda(lineId, chat);

  /**
   * Envía y DEVUELVE lo enviado.
   *
   * Si no devolviera nada, el mensaje escrito desaparecería de la pantalla al
   * terminar la acción: el estado optimista de React se descarta al acabar y
   * lo que queda debajo no lo incluye. Parecía no haberse enviado cuando sí.
   */
  async function enviar(
    texto: string, replyTo?: string, mentions?: string[],
  ): Promise<Mensaje | null> {
    "use server";
    const limpio = texto.trim();
    if (!limpio) return null;

    // `clientMessageId` propio: si el envío se reintenta —por recarga, por
    // red— el destinatario recibe UN mensaje, no dos.
    const clientMessageId = `panel-${crypto.randomUUID()}`;
    const res = await apiFetch<{ clientMessageId: string; messageId: string; state: string }>(
      `/v1/lines/${lineId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          to: chat, text: limpio, clientMessageId,
          ...(replyTo ? { replyTo } : {}),
          ...(mentions?.length ? { mentions } : {}),
        }),
      },
    );
    return {
      id: res.messageId, providerMessageId: null, clientMessageId: res.clientMessageId,
      fromMe: true, kind: "text", body: limpio, state: res.state,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Envía un fichero ya subido.
   *
   * Se manda la `storageKey` que devolvió la subida, no los bytes: el fichero
   * ya está en nuestro almacén, y repetirlo lo subiría dos veces y lo metería
   * entero en memoria del servidor del panel.
   */
  async function enviarMedio(
    campo: string, storageKey: string, pie: string, fileName: string,
    extra: Record<string, unknown> = {},
    replyTo?: string,
  ): Promise<Mensaje | null> {
    "use server";
    const clientMessageId = `panel-${crypto.randomUUID()}`;
    const res = await apiFetch<{
      messageId: string; state: string;
      media: { url: string; mimeType: string; fileName: string | null; size: number } | null;
    }>(
      `/v1/lines/${lineId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          to: chat,
          [campo]: { storageKey },
          ...(pie ? { caption: pie } : {}),
          ...(campo === "document" && fileName ? { fileName } : {}),
          // `ptt` llega desde la grabadora: es lo que distingue una nota de voz
          // de un fichero de audio adjunto.
          ...extra,
          ...(replyTo ? { replyTo } : {}),
          clientMessageId,
        }),
      },
    );
    return {
      id: res.messageId, providerMessageId: null, clientMessageId,
      fromMe: true, kind: campo, body: pie || null, state: res.state,
      timestamp: new Date().toISOString(),
      media: res.media,
    };
  }

  return (
    <Conversacion
      lineId={lineId}
      chat={chat}
      info={info}
      iniciales={[...mensajes].reverse()}
      enviar={enviar}
      enviarMedio={enviarMedio}
    />
  );
}

/**
 * Una conversación que aún no existe, abierta desde la agenda.
 *
 * Hasta el primer mensaje no hay fila de chat y la API dice 404; sin esto la
 * cabecera enseñaba la dirección cruda. Se busca a la persona en la agenda
 * por su número y se presenta como un chat vacío, con su nombre.
 */
async function deLaAgenda(lineId: string, chat: string): Promise<Chat | null> {
  const digitos = chat.split("@")[0]!.replace(/\D/g, "");
  if (digitos.length < 5) return null;
  const encontrados = await apiFetchAuth<{
    address: string; name: string; savedName: string | null; pushName: string | null;
    username: string | null; phone: string | null;
  }[]>(`/v1/lines/${lineId}/contacts?q=${digitos}&limit=20`).catch(() => []);
  const p = encontrados.find((c) => c.address === chat || c.phone === chat);
  if (!p) return null;
  return {
    address: chat, kind: chat.endsWith("@lid") ? "lid" : "pn",
    displayName: p.name, title: null, savedName: p.savedName, pushName: p.pushName,
    username: p.username, avatarUrl: null, phone: p.phone,
    lastMessageAt: null, unreadCount: 0, ultimo: null, ultimoPropio: false,
  };
}
