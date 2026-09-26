import type { WebClient } from "./driver.js";

/**
 * Cliente de whatsapp-web.js falso.
 *
 * Simula la superficie que usa el driver, no un navegador. Permite correr la
 * batería de contrato sin abrir un Chromium de cuatrocientos megas — y sin él,
 * este driver no se podría probar en CI en absoluto.
 */
export interface FakeWebControl {
  readonly cliente: WebClient;
  /** Dispara un evento como lo haría el cliente real. */
  emitir(evento: string, ...args: unknown[]): void;
  readonly enviados: { chatId: string; contenido: unknown; opciones: unknown }[];
  readonly vistos: string[];
  /** Mensajes que `fetchMessages` devolverá. */
  historial: Record<string, unknown[]>;
  fallarAlEnviar: Error | null;
  destruido: boolean;
}

export function createFakeWebClient(opts: { numero?: string } = {}): FakeWebControl {
  const manejadores = new Map<string, ((...a: never[]) => void)[]>();
  let contador = 0;

  const control: FakeWebControl = {
    enviados: [],
    vistos: [],
    historial: {},
    fallarAlEnviar: null,
    destruido: false,
    cliente: null as unknown as WebClient,
    emitir: (evento, ...args) => {
      for (const h of manejadores.get(evento) ?? []) (h as (...a: unknown[]) => void)(...args);
    },
  };

  const chatDe = (id: string): Record<string, unknown> => ({
    id: { _serialized: id },
    name: id.endsWith("@g.us") ? "Grupo falso" : "Contacto falso",
    isGroup: id.endsWith("@g.us"),
    groupMetadata: id.endsWith("@g.us")
      ? {
          desc: "descripción",
          owner: { _serialized: "51999888777@c.us" },
          participants: [
            { id: { _serialized: "51999888777@c.us" }, isSuperAdmin: true },
            { id: { _serialized: "51988777666@c.us" } },
          ],
        }
      : undefined,
    sendSeen: async () => { control.vistos.push(id); },
    sendStateTyping: async () => {},
    sendStateRecording: async () => {},
    clearState: async () => {},
    fetchMessages: async () => control.historial[id] ?? [],
    addParticipants: async (ids: string[]) =>
      Object.fromEntries(ids.map((i, n) => [i, n === 0 ? { code: 200 } : { code: 403, message: "no se puede añadir" }])),
    removeParticipants: async () => undefined,
    promoteParticipants: async () => undefined,
    demoteParticipants: async () => undefined,
  });

  const cliente: WebClient = {
    info: { wid: { _serialized: opts.numero ?? "51999888777@c.us" }, pushname: "Prueba" },
    initialize: async () => {},
    destroy: async () => { control.destruido = true; },
    on: (evento, manejador) => {
      manejadores.set(evento, [...(manejadores.get(evento) ?? []), manejador]);
    },
    sendMessage: async (chatId, contenido, opciones) => {
      if (control.fallarAlEnviar) throw control.fallarAlEnviar;
      control.enviados.push({ chatId, contenido, opciones });
      return {
        id: { _serialized: `false_${chatId}_WEB${String(++contador).padStart(4, "0")}` },
        timestamp: 1_800_000_000,
      };
    },
    isRegisteredUser: async (numero) => numero.startsWith("5199"),
    getNumberId: async (numero) =>
      numero.startsWith("5199") ? { _serialized: `${numero}@c.us` } : null,
    getChats: async () => [chatDe("120@g.us"), chatDe("51988777666@c.us")],
    getChatById: async (id) => chatDe(id),
  };

  (control as { cliente: WebClient }).cliente = cliente;
  return control;
}
