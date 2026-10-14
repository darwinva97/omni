import { z } from "zod";

/**
 * Los canales que el sistema sabe conducir. Los tres primeros son transportes
 * distintos hacia la MISMA red (WhatsApp) y no son intercambiables: difieren en
 * qué saben hacer, cuánta memoria cuestan y qué riesgo de baneo acarrean.
 */
export const channelKinds = [
  "whatsapp.baileys",
  "whatsapp.cloud",
  "whatsapp.web",
  "telegram",
  "email",
  "meta.instagram",
  "meta.facebook",
  "sms",
  "webchat",
  "sandbox",
] as const;

export const ChannelKind = z.enum(channelKinds);
export type ChannelKind = z.infer<typeof ChannelKind>;

/** Familia a la que pertenece un canal: varios transportes comparten red. */
export const channelNetwork = (kind: ChannelKind): string =>
  kind.startsWith("whatsapp.") ? "whatsapp" : kind.startsWith("meta.") ? "meta" : kind;

/**
 * Catálogo de capacidades. Cada driver declara el subconjunto que implementa y
 * la API rechaza con 422 —nunca con 500 ni con silencio— lo que su driver no sabe hacer.
 *
 * Esto no es decorativo: Cloud API no ve grupos ni conversaciones personales,
 * whatsapp-web.js no puede rechazar llamadas, y Baileys no expone labels de forma
 * estable. Una abstracción que lo ocultara estaría mintiendo.
 */
export const capabilities = [
  // envío por tipo
  "send.text", "send.image", "send.video", "send.audio", "send.document",
  "send.sticker", "send.location", "send.contact", "send.poll",
  "send.reaction", "send.buttons", "send.list", "send.template",
  // modificadores del envío
  "send.reply", "send.mentions", "send.viewOnce", "send.forward",
  // ciclo de vida del mensaje
  "message.edit", "message.delete", "message.receipts",
  // chats
  "chat.read", "chat.presence", "chat.typing", "chat.archive", "chat.mute", "chat.ephemeral",
  "chat.clear", "chat.delete",
  /*
   * Ver cuándo escribe o está en línea la otra persona. No es lo mismo que
   * ANUNCIAR la propia presencia (`chat.presence`): exige ponerse en línea, y
   * mientras una cuenta está en línea el teléfono deja de recibir avisos.
   */
  "presence.watch",
  // grupos
  "group.read", "group.create", "group.manage", "group.invite", "group.participants",
  /*
   * Comunidades. Son grupos de grupos, con su propio anuncio y su propia
   * pertenencia, y NO se pueden tratar como un grupo más: enlazar un grupo a
   * una comunidad no es añadir un participante.
   */
  "community.read", "community.manage",
  // catálogo de WhatsApp Business
  "catalog.read", "catalog.manage",
  // contactos e identidad
  "contact.check", "contact.block", "contact.profile", "identity.lid",
  // llamadas
  "call.receive", "call.reject",
  // extras
  "label.manage", "newsletter.read", "newsletter.send", "history.sync", "media.decrypt",
] as const;

export const Capability = z.enum(capabilities);
export type Capability = z.infer<typeof Capability>;

export type CapabilitySet = ReadonlySet<Capability>;

export const capabilitySet = (...caps: readonly Capability[]): CapabilitySet => new Set(caps);

/** Cómo se enlaza una línea de este canal. Determina el flujo de alta en el panel. */
export const LinkMethod = z.enum(["qr", "pairing-code", "oauth", "api-key", "none"]);
export type LinkMethod = z.infer<typeof LinkMethod>;

/**
 * Perfil de riesgo del transporte, declarado para que el panel pueda advertir.
 * `unofficial` significa que conduce un cliente no oficial: la cuenta puede ser
 * restringida o baneada por WhatsApp y ninguna calidad de código evita ese riesgo.
 */
export const RiskProfile = z.enum(["official", "unofficial", "simulated"]);
export type RiskProfile = z.infer<typeof RiskProfile>;

export interface ChannelDescriptor {
  readonly kind: ChannelKind;
  readonly network: string;
  readonly linkMethod: LinkMethod;
  readonly risk: RiskProfile;
  readonly capabilities: CapabilitySet;
  /** Memoria aproximada por línea viva, en MB. Informativo, para planificar capacidad. */
  readonly approxMemoryMbPerLine: number;
}
