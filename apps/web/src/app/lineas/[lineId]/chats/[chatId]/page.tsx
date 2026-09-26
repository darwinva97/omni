import { apiFetch, apiFetchAuth, type Mensaje } from "@/lib/api";
import { Cabecera } from "@/lib/ui";
import { Conversacion } from "./conversacion";

export default async function Chat({
  params,
}: {
  params: Promise<{ lineId: string; chatId: string }>;
}) {
  const { lineId, chatId } = await params;
  const chat = decodeURIComponent(chatId);

  const mensajes = await apiFetchAuth<Mensaje[]>(
    `/v1/lines/${lineId}/chats/${encodeURIComponent(chat)}/messages?limit=100`,
  );

  async function enviar(formData: FormData): Promise<void> {
    "use server";
    const texto = String(formData.get("texto") ?? "").trim();
    if (!texto) return;
    // `clientMessageId` propio: si el envío se reintenta —por recarga, por red—
    // el destinatario recibe UN mensaje, no dos.
    await apiFetch(`/v1/lines/${lineId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        to: chat, text: texto,
        clientMessageId: `panel-${crypto.randomUUID()}`,
      }),
    });
  }

  return (
    <>
      <Cabecera titulo={chat} volver={{ href: `/lineas/${lineId}`, texto: "conversaciones" }} />
      <Conversacion
        lineId={lineId}
        chat={chat}
        iniciales={[...mensajes].reverse()}
        enviar={enviar}
      />
    </>
  );
}
