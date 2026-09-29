import { EventEmitter } from "node:events";
import type { WASocket } from "baileys";

/**
 * Socket de Baileys falso.
 *
 * Existe para poder correr la batería de contrato contra el driver real sin un
 * teléfono y sin abrir un socket a WhatsApp. No simula el protocolo: simula la
 * SUPERFICIE que el driver usa, que es lo que hay que fijar para que un cambio
 * en el driver no rompa el contrato en silencio.
 *
 * Lo que NO puede hacer es validar el protocolo. Eso sigue necesitando un
 * número real y una comprobación manual antes de cada versión.
 */
export interface FakeSocketControl {
  readonly socket: WASocket;
  /** Empuja una actualización de conexión, como haría Baileys. */
  emitConnection(update: { connection?: string; qr?: string; lastDisconnect?: { error?: Error } }): void;
  emitRaw(event: string, payload: unknown): void;
  /** Todo lo enviado, para poder afirmar sobre ello. */
  readonly sent: { jid: string; content: unknown; options?: unknown }[];
  readonly presence: { presence: string; jid: string }[];
  readonly read: string[][];
  readonly groupUpdates: { jid: string; subject?: string; description?: string }[];
  readonly groupLeaves: string[];
  readonly modificaciones: { jid: string; mod: Record<string, unknown> }[];
  readonly newsletterSeguidos: string[];
  readonly newsletterDejados: string[];
  nextMessageId: string;
  /** Si se define, `sendMessage` lanza este error. */
  failWith: Error | null;
}

export function createFakeSocket(user?: { id: string; name?: string }): FakeSocketControl {
  const ev = new EventEmitter();
  ev.setMaxListeners(100);

  const control: FakeSocketControl = {
    sent: [],
    presence: [],
    read: [],
    groupUpdates: [],
    groupLeaves: [],
    modificaciones: [],
    newsletterSeguidos: [],
    newsletterDejados: [],
    nextMessageId: "FAKE-0001",
    failWith: null,
    socket: null as unknown as WASocket,
    emitConnection: (update) => ev.emit("connection.update", update),
    emitRaw: (event, payload) => ev.emit(event, payload),
  };

  let contador = 0;

  const socket = {
    ev: {
      on: (e: string, h: (...a: unknown[]) => void) => ev.on(e, h),
      off: (e: string, h: (...a: unknown[]) => void) => ev.off(e, h),
      emit: (e: string, p: unknown) => ev.emit(e, p),
      removeAllListeners: () => ev.removeAllListeners(),
    },
    user: user ?? { id: "51999888777:1@s.whatsapp.net", name: "Prueba" },
    authState: { creds: {}, keys: {} },
    end: () => { ev.removeAllListeners(); },
    sendMessage: async (jid: string, content: unknown, options?: unknown) => {
      if (control.failWith) throw control.failWith;
      control.sent.push({ jid, content, options });
      const id = control.nextMessageId === "FAKE-0001"
        ? `FAKE-${String(++contador).padStart(4, "0")}`
        : control.nextMessageId;
      return { key: { id, remoteJid: jid, fromMe: true }, messageTimestamp: 1_800_000_000 };
    },
    sendPresenceUpdate: async (presence: string, jid: string) => {
      control.presence.push({ presence, jid });
    },
    readMessages: async (keys: { id: string }[]) => {
      control.read.push(keys.map((k) => k.id));
    },
    onWhatsApp: async (numero: string) =>
      numero.startsWith("5199") ? [{ exists: true, jid: `${numero}@s.whatsapp.net` }] : [],
    groupMetadata: async (jid: string) => ({
      id: jid, subject: "Grupo falso", owner: "51999888777@s.whatsapp.net",
      creation: 1_700_000_000,
      participants: [
        { id: "51999888777@s.whatsapp.net", admin: "superadmin" },
        { id: "51988777666@s.whatsapp.net", admin: null },
      ],
    }),
    groupFetchAllParticipating: async () => ({
      "120@g.us": {
        id: "120@g.us", subject: "Uno", participants: [{ id: "51999888777@s.whatsapp.net", admin: null }],
      },
    }),
    groupCreate: async (subject: string, participants: string[]) => ({
      id: "121@g.us", subject,
      participants: participants.map((p) => ({ id: p, admin: null })),
    }),
    groupParticipantsUpdate: async (_jid: string, participants: string[]) =>
      participants.map((p, i) => ({ jid: p, status: i === 0 ? "200" : "403" })),
    groupUpdateSubject: async (jid: string, subject: string) => {
      control.groupUpdates.push({ jid, subject });
    },
    groupUpdateDescription: async (jid: string, description: string) => {
      control.groupUpdates.push({ jid, description });
    },
    groupLeave: async (jid: string) => { control.groupLeaves.push(jid); },
    groupInviteCode: async () => "ABCD1234EFGH",
    groupRevokeInvite: async () => "NUEVO5678CODE",
    groupAcceptInvite: async () => "122@g.us",
    chatModify: async (mod: Record<string, unknown>, jid: string) => {
      control.modificaciones.push({ jid, mod });
    },
    newsletterMetadata: async (tipo: string, clave: string) => ({
      id: tipo === "invite" ? "120@newsletter" : clave,
      name: "Canal falso", description: "un canal de prueba",
      invite: "CANALFALSO1", subscribers: 42, verification: "VERIFIED",
      creation_time: 1_700_000_000,
      viewer_metadata: { role: "SUBSCRIBER" },
    }),
    newsletterFollow: async (jid: string) => { control.newsletterSeguidos.push(jid); },
    newsletterUnfollow: async (jid: string) => { control.newsletterDejados.push(jid); },
    rejectCall: async () => {},
    fetchMessageHistory: async () => "ok",
  };

  (control as { socket: WASocket }).socket = socket as unknown as WASocket;
  return control;
}
