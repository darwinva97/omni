import { apiFetch, apiFetchAuth, type Chat, type Mensaje } from "@/lib/api";
import { Cabecera } from "@/lib/ui";
import { Conversacion } from "./conversacion";

export default async function Chat({
  params,
}: {
  params: Promise<{ lineId: string; chatId: string }>;
}) {
  const { lineId, chatId } = await params;
  const chat = decodeURIComponent(chatId);

  const [mensajes, info] = await Promise.all([
    apiFetchAuth<Mensaje[]>(
      `/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages?limit=100`,
    ),
    apiFetchAuth<Chat>(`/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}`)
      .catch(() => null),
  ]);

  /**
   * Envía y DEVUELVE lo enviado.
   *
   * Antes no devolvía nada, y el mensaje escrito desaparecía de la pantalla en
   * cuanto la acción terminaba: el estado optimista de React se descarta al
   * acabar, y lo que quedaba debajo no incluía el mensaje. Parecía que no se
   * había enviado cuando sí.
   */
  async function enviar(texto: string): Promise<Mensaje | null> {
    "use server";
    const limpio = texto.trim();
    if (!limpio) return null;

    // `clientMessageId` propio: si el envío se reintenta —por recarga, por red—
    // el destinatario recibe UN mensaje, no dos.
    const clientMessageId = `panel-${crypto.randomUUID()}`;
    const res = await apiFetch<{ clientMessageId: string; messageId: string; state: string }>(
      `/v1/lines/${lineId}/messages`,
      { method: "POST", body: JSON.stringify({ to: chat, text: limpio, clientMessageId }) },
    );
    return {
      id: res.messageId, providerMessageId: null, fromMe: true,
      kind: "text", body: limpio, state: res.state,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Envía un fichero ya subido.
   *
   * Se manda la `storageKey` que devolvió la subida, no los bytes: el fichero
   * ya está en nuestro almacén, y volver a mandarlo por aquí lo subiría dos
   * veces y lo metería entero en memoria del servidor del panel.
   */
  async function enviarMedio(
    campo: string, storageKey: string, pie: string, fileName: string,
  ): Promise<Mensaje | null> {
    "use server";
    const clientMessageId = `panel-${crypto.randomUUID()}`;
    const res = await apiFetch<{ messageId: string; state: string }>(
      `/v1/lines/${lineId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          to: chat,
          [campo]: { storageKey },
          ...(pie ? { caption: pie } : {}),
          ...(campo === "document" && fileName ? { fileName } : {}),
          // Una nota de voz y un fichero de audio son cosas distintas para
          // WhatsApp; desde el panel se manda como fichero, que es lo que uno
          // adjunta. Grabar una nota es otra función.
          clientMessageId,
        }),
      },
    );
    return {
      id: res.messageId, providerMessageId: null, fromMe: true,
      kind: campo, body: pie || null, state: res.state,
      timestamp: new Date().toISOString(),
      media: null,
    };
  }

  return (
    <>
      <Cabecera
        titulo={info?.displayName ?? chat}
        detalle={info?.phone ? `+${info.phone.split("@")[0]} · ${chat}` : chat}
        volver={{ href: `/lineas/${lineId}`, texto: "conversaciones" }}
      />
      <Conversacion
        lineId={lineId}
        chat={chat}
        iniciales={[...mensajes].reverse()}
        enviar={enviar}
        enviarMedio={enviarMedio}
      />
    </>
  );
}
