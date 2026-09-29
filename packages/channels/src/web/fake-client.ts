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
  readonly cambiosDeGrupo: { id: string; asunto?: string; desc?: string }[];
  readonly salidas: string[];
  readonly vaciados: string[];
  readonly archivados: { id: string; archivado: boolean }[];
  readonly silenciados: { id: string; hasta: Date | null }[];
  readonly bloqueos: { id: string; bloqueado: boolean }[];
  readonly reenviados: { id: string; a: string }[];
  readonly gruposCreados: string[];
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
    cambiosDeGrupo: [],
    salidas: [],
    vaciados: [],
    archivados: [],
    silenciados: [],
    bloqueos: [],
    reenviados: [],
    gruposCreados: [],
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
    setSubject: async (asunto: string) => { control.cambiosDeGrupo.push({ id, asunto }); },
    setDescription: async (desc: string) => { control.cambiosDeGrupo.push({ id, desc }); },
    leave: async () => { control.salidas.push(id); },
    clearMessages: async () => { control.vaciados.push(id); },
    archive: async () => { control.archivados.push({ id, archivado: true }); },
    unarchive: async () => { control.archivados.push({ id, archivado: false }); },
    mute: async (hasta?: Date) => { control.silenciados.push({ id, hasta: hasta ?? null }); },
    unmute: async () => { control.silenciados.push({ id, hasta: null }); },
    getInviteCode: async () => "WEBINVITE1234",
    revokeInvite: async () => "WEBINVITE5678",
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
    createGroup: async (asunto: string) => {
      control.gruposCreados.push(asunto);
      return { gid: { _serialized: "123@g.us" } };
    },
    acceptInvite: async () => "124@g.us",
    getContactById: async (cid: string) => ({
      name: "Contacto falso", isBusiness: false,
      block: async () => { control.bloqueos.push({ id: cid, bloqueado: true }); },
      unblock: async () => { control.bloqueos.push({ id: cid, bloqueado: false }); },
      getProfilePicUrl: async () => "https://falso.test/foto.jpg",
      getAbout: async () => "disponible",
    }),
    getMessageById: async (mid: string) => ({
      hasMedia: true,
      forward: async (a: string) => { control.reenviados.push({ id: mid, a }); },
      downloadMedia: async () => ({
        data: Buffer.from("medio falso").toString("base64"),
        mimetype: "image/jpeg",
      }),
    }),
    getLabels: async () => [{ id: "1", name: "Nuevo cliente", hexColor: "#ff0000" }],
  } as WebClient & Record<string, unknown>;

  (control as { cliente: WebClient }).cliente = cliente;
  return control;
}
