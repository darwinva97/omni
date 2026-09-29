/**
 * Un Telegram falso: responde a `fetch` como lo haría la API de bots.
 *
 * Existe por lo mismo que el resto de falsos del paquete: poder correr la
 * batería de contrato y las pruebas de ingesta en CI sin un token de bot real
 * ni una conexión a internet.
 */

export interface FakeTelegram {
  readonly fetchImpl: typeof fetch;
  /** Todo lo pedido, para poder afirmar sobre ello. */
  readonly llamadas: { metodo: string; cuerpo: Record<string, unknown> }[];
  /** Actualizaciones que devolverá la siguiente `getUpdates`. */
  readonly pendientes: Record<string, unknown>[];
  /** Si se define, la siguiente llamada responde con este error de Telegram. */
  fallarCon: { error_code: number; description: string } | null;
  /** Encola un mensaje entrante como si alguien hubiera escrito al bot. */
  entrante(de: number, texto: string, opts?: { chat?: number; tipo?: string }): void;
}

export function createFakeTelegram(): FakeTelegram {
  let siguienteUpdate = 1;
  let siguienteMensaje = 100;

  const control: FakeTelegram = {
    llamadas: [],
    pendientes: [],
    fallarCon: null,
    fetchImpl: null as unknown as typeof fetch,
    entrante: (de, texto, opts = {}) => {
      const chat = opts.chat ?? de;
      control.pendientes.push({
        update_id: siguienteUpdate++,
        message: {
          message_id: siguienteMensaje++,
          date: 1_800_000_000,
          text: texto,
          chat: { id: chat, type: chat < 0 ? "supergroup" : "private" },
          from: { id: de, first_name: "Ada" },
        },
      });
    },
  };

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const ruta = String(url);
    const metodo = ruta.slice(ruta.lastIndexOf("/") + 1);
    const cuerpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    control.llamadas.push({ metodo, cuerpo });

    const responder = (datos: unknown): Response =>
      new Response(JSON.stringify(datos), {
        status: 200, headers: { "content-type": "application/json" },
      });

    if (control.fallarCon) {
      const fallo = control.fallarCon;
      control.fallarCon = null;
      return responder({ ok: false, ...fallo });
    }

    switch (metodo) {
      case "getMe":
        return responder({ ok: true, result: { id: 777000, username: "bot_falso", first_name: "Bot" } });
      case "getUpdates": {
        // Se vacían: repetir lo ya entregado es justo lo que evita el offset.
        const lote = control.pendientes.splice(0, control.pendientes.length);
        return responder({ ok: true, result: lote });
      }
      case "getChat":
        return responder({
          ok: true,
          result: { id: cuerpo["chat_id"], title: "Grupo falso", description: "de prueba", type: "supergroup" },
        });
      case "getChatMemberCount":
        return responder({ ok: true, result: 42 });
      case "deleteMessage":
      case "setMessageReaction":
      case "sendChatAction":
        return responder({ ok: true, result: true });
      case "editMessageText":
        return responder({ ok: true, result: { message_id: Number(cuerpo["message_id"]), date: 1_800_000_000 } });
      default:
        return responder({
          ok: true,
          result: { message_id: siguienteMensaje++, date: 1_800_000_000 },
        });
    }
  }) as unknown as typeof fetch;

  (control as { fetchImpl: typeof fetch }).fetchImpl = fetchImpl;
  return control;
}
