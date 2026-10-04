import { notFound } from "next/navigation";
import { apiFetchAuth, type Chat, type Linea } from "@/lib/api";
import { Rail } from "@/componentes/armazon";
import { ListaChats } from "./lista-chats";

/**
 * Dos columnas: conversaciones a la izquierda, lo que se abra a la derecha.
 *
 * Vive en un layout y no en la página a propósito. Un layout de Next conserva
 * su estado al navegar entre rutas hijas, así que cambiar de conversación no
 * vuelve a pedir la lista, no pierde el desplazamiento y no corta el
 * WebSocket. En la página habría que recuperar las tres cosas a mano en cada
 * clic, y es exactamente lo que hace que un panel se sienta lento.
 */
export default async function LayoutLinea({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lineId: string }>;
}) {
  const { lineId } = await params;

  const [lineas, chats] = await Promise.all([
    apiFetchAuth<Linea[]>("/v1/lines"),
    apiFetchAuth<Chat[]>(`/v1/lines/${lineId}/chats?limit=200`).catch(() => [] as Chat[]),
  ]);
  const linea = lineas.find((l) => l.id === lineId);
  if (!linea) notFound();

  return (
    <>
      <Rail actual="/lineas" />
      <div className="ml-14 flex h-dvh overflow-hidden">
        <ListaChats linea={linea} iniciales={chats} />
        <section className="min-w-0 flex-1">{children}</section>
      </div>
    </>
  );
}
