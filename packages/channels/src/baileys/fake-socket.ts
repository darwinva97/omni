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
  /** Lo que salió por `relayMessage`, ya como mensaje del protocolo. */
  readonly relayed: { jid: string; message: unknown; options?: unknown }[];
  readonly presence: { presence: string; jid: string }[];
  readonly read: string[][];
  readonly groupUpdates: { jid: string; subject?: string; description?: string }[];
  readonly groupLeaves: string[];
  readonly modificaciones: { jid: string; mod: Record<string, unknown> }[];
  readonly bloqueos: { jid: string; action: string }[];
  readonly enlaces: { grupo: string; comunidad: string; enlazado: boolean }[];
  readonly comunidadesDejadas: string[];
  readonly efimeros: { jid: string; segundos: number }[];
  readonly newsletterSeguidos: string[];
  readonly newsletterDejados: string[];
  nextMessageId: string;
  /** Si se define, `sendMessage` lanza este error. */
  failWith: Error | null;
}

export function createFakeSocket(
  user?: { id: string; name?: string; lid?: string },
): FakeSocketControl {
  const ev = new EventEmitter();
  ev.setMaxListeners(100);

  const control: FakeSocketControl = {
    sent: [],
    relayed: [],
    presence: [],
    read: [],
    groupUpdates: [],
    groupLeaves: [],
    modificaciones: [],
    bloqueos: [],
    enlaces: [],
    comunidadesDejadas: [],
    efimeros: [],
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
      // Se devuelve también el `message`: es lo que hay que conservar para
      // poder servir un reintento, y sin él la prueba no vería ese camino.
      return {
        key: { id, remoteJid: jid, fromMe: true },
        message: content,
        messageTimestamp: 1_800_000_000,
      };
    },
    relayMessage: async (jid: string, message: unknown, options?: { messageId?: string }) => {
      if (control.failWith) throw control.failWith;
      control.relayed.push({ jid, message, options });
      return options?.messageId ?? `FAKE-${String(++contador).padStart(4, "0")}`;
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
    updateBlockStatus: async (jid: string, action: string) => {
      control.bloqueos.push({ jid, action });
    },
    profilePictureUrl: async () => "https://falso.test/foto.jpg",
    fetchStatus: async () => [{ status: { status: "disponible" } }],
    getBusinessProfile: async () => undefined,
    groupToggleEphemeral: async (jid: string, segundos: number) => {
      control.efimeros.push({ jid, segundos });
    },
    communityMetadata: async (jid: string) => ({
      id: jid, subject: "Comunidad falsa", desc: "una comunidad de prueba",
      owner: "51999888777@s.whatsapp.net", size: 2,
      participants: [{ id: "51999888777@s.whatsapp.net", admin: "superadmin" }],
    }),
    communityFetchAllParticipating: async () => ({
      "200@g.us": { id: "200@g.us", subject: "Comunidad falsa", participants: [] },
    }),
    communityFetchLinkedGroups: async (jid: string) => ({
      communityJid: jid, isCommunity: true,
      linkedGroups: [
        { id: "120@g.us", subject: "Uno", creation: 1_700_000_000, owner: undefined, size: 3 },
      ],
    }),
    communityCreate: async (subject: string, body: string) => ({
      id: "201@g.us", subject, desc: body, participants: [],
    }),
    communityLinkGroup: async (grupo: string, comunidad: string) => {
      control.enlaces.push({ grupo, comunidad, enlazado: true });
    },
    communityUnlinkGroup: async (grupo: string, comunidad: string) => {
      control.enlaces.push({ grupo, comunidad, enlazado: false });
    },
    communityLeave: async (jid: string) => { control.comunidadesDejadas.push(jid); },
    getCatalog: async () => ({
      products: [{
        id: "p1", name: "Camiseta", description: "de algodón",
        price: 2500, currency: "PEN", retailerId: "SKU-1",
        imageUrls: { requested: "https://falso.test/p1.jpg" },
        reviewStatus: { whatsapp: "APPROVED" }, availability: "in stock",
      }],
      nextPageCursor: undefined,
    }),
    getCollections: async () => ({
      collections: [{
        id: "c1", name: "Verano", products: [], status: { status: "APPROVED", canAppeal: false },
      }],
    }),
    productCreate: async (create: Record<string, unknown>) => ({
      id: "p2", ...create, imageUrls: { requested: "https://falso.test/p2.jpg" },
      reviewStatus: { whatsapp: "PENDING" }, availability: "in stock",
    }),
    productUpdate: async (id: string, update: Record<string, unknown>) => ({
      id, ...update, imageUrls: {}, reviewStatus: { whatsapp: "PENDING" },
      availability: "in stock",
    }),
    productDelete: async (ids: string[]) => ({ deleted: ids.length }),
    getOrderDetails: async () => ({
      price: { currency: "PEN", total: 5000 },
      products: [{
        id: "p1", name: "Camiseta", quantity: 2, currency: "PEN", price: 2500,
        imageUrl: "https://falso.test/p1.jpg",
      }],
    }),
    newsletterCreate: async (name: string, description?: string) => ({
      id: "130@newsletter", name, description,
      invite: "CANALNUEVO1", subscribers: 0, verification: "UNVERIFIED",
      viewer_metadata: { role: "OWNER" },
    }),
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
