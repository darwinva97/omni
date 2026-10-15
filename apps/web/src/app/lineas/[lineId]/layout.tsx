import { notFound } from "next/navigation";
import { apiFetchAuth, type Chat, type Linea } from "@/lib/api";
import { Rail } from "@/componentes/armazon";
import { ListaChats } from "./lista-chats";
import { PanelDerecho } from "./panel-derecho";
import { FranjaDeLineas } from "@/componentes/franja-lineas";

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

  /*
   * En escritorio, dos columnas; en móvil, una.
   *
   * No se apretan: en una pantalla de 390 píxeles, una lista de 22rem y una
   * conversación al lado dejan ambas inservibles. Se enseña la que toca según
   * la ruta —lista en la raíz de la línea, conversación dentro— que es como se
   * comporta cualquier cliente de mensajería en el teléfono.
   *
   * El reparto se hace con clases y no con JavaScript: así el servidor manda
   * ya el HTML correcto y no hay un salto al hidratar.
   */
  return (
    <>
      <Rail actual="/lineas" />
      {/* `pb-16` en móvil: la barra inferior flota sobre el contenido y sin
          esto taparía el compositor de mensajes. */}
      <div className="flex h-dvh flex-col overflow-hidden pb-16 md:ml-14 md:pb-0">
        {/* Encima de las dos columnas: una línea caída se ve también desde
            una conversación de OTRA línea, que es donde se está. */}
        <FranjaDeLineas />
        <div className="flex min-h-0 flex-1">
          <ListaChats linea={linea} iniciales={chats} />
          <PanelDerecho lineId={lineId}>{children}</PanelDerecho>
        </div>
      </div>
    </>
  );
}
