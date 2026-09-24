import { z } from "zod";

/**
 * Envío polimórfico: UN comando para todos los tipos de mensaje, discriminado
 * por el campo que se rellena. Es el diseño de crafter y envejece mucho mejor
 * que veinte endpoints, porque añadir un tipo es añadir un campo opcional.
 */

export const LocationPayload = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().max(200).optional(),
  address: z.string().max(400).optional(),
});

export const ContactPayload = z.object({
  fullName: z.string().min(1).max(200),
  phone: z.string().min(3).max(30),
  organization: z.string().max(200).optional(),
  email: z.string().email().optional(),
});

export const PollPayload = z.object({
  question: z.string().min(1).max(255),
  options: z.array(z.string().min(1).max(100)).min(2).max(12),
  allowMultipleAnswers: z.boolean().default(false),
});

export const ButtonPayload = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(64),
});

export const ListSectionPayload = z.object({
  title: z.string().min(1).max(64),
  rows: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().min(1).max(64),
        description: z.string().max(128).optional(),
      }),
    )
    .min(1)
    .max(10),
});

/** Una fuente de medio: URL remota, clave ya subida a nuestro almacén, o bytes en base64. */
export const MediaSource = z.union([
  z.object({ url: z.string().url() }),
  z.object({ storageKey: z.string().min(1) }),
  z.object({ base64: z.string().min(1), mimeType: z.string().min(1) }),
]);

export const SendMessageInput = z
  .object({
    to: z.string().min(1),
    /** Idempotencia de extremo a extremo: reenviar con el mismo valor NO duplica. */
    clientMessageId: z.string().min(1).max(128).optional(),

    text: z.string().max(65536).optional(),
    image: MediaSource.optional(),
    video: MediaSource.optional(),
    audio: MediaSource.optional(),
    document: MediaSource.optional(),
    sticker: MediaSource.optional(),
    contact: ContactPayload.optional(),
    location: LocationPayload.optional(),
    poll: PollPayload.optional(),
    buttons: z.array(ButtonPayload).min(1).max(3).optional(),
    list: z
      .object({
        title: z.string().min(1).max(64),
        buttonText: z.string().min(1).max(20),
        sections: z.array(ListSectionPayload).min(1).max(10),
      })
      .optional(),

    // modificadores
    caption: z.string().max(4096).optional(),
    fileName: z.string().max(255).optional(),
    replyTo: z.string().max(128).optional(),
    mentions: z.array(z.string()).max(64).optional(),
    viewOnce: z.boolean().optional(),
    ptt: z.boolean().optional(),
    /** Antepone un retardo simulando escritura. El motor lo respeta si el canal lo permite. */
    typingMs: z.number().int().min(0).max(30000).optional(),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInput>;

/** Los campos que deciden QUÉ se envía. Exactamente uno debe estar presente. */
export const contentFields = [
  "text", "image", "video", "audio", "document",
  "sticker", "contact", "location", "poll", "buttons", "list",
] as const;
export type ContentField = (typeof contentFields)[number];

export const messageKinds = [
  "text", "image", "video", "audio", "document",
  "sticker", "contact", "location", "poll", "buttons", "list",
  "reaction", "system", "unknown",
] as const;
export const MessageKind = z.enum(messageKinds);
export type MessageKind = z.infer<typeof MessageKind>;

/** Qué tipo de contenido lleva la orden, o el error que explica por qué no es válida. */
export function resolveContent(
  input: SendMessageInput,
): { ok: true; field: ContentField } | { ok: false; reason: string } {
  const present = contentFields.filter((f) => input[f] !== undefined);
  if (present.length === 0) {
    return { ok: false, reason: `hace falta uno de: ${contentFields.join(", ")}` };
  }
  if (present.length > 1) {
    return { ok: false, reason: `solo uno a la vez, llegaron: ${present.join(", ")}` };
  }
  return { ok: true, field: present[0]! };
}

/** Estados por los que pasa un mensaje saliente. El orden importa: nunca retrocede. */
export const deliveryStates = ["queued", "sent", "delivered", "read", "played", "failed"] as const;
export const DeliveryState = z.enum(deliveryStates);
export type DeliveryState = z.infer<typeof DeliveryState>;

const RANK: Record<string, number> = {
  queued: 0, sent: 1, delivered: 2, read: 3, played: 4, failed: 99,
};

/**
 * Un acuse nunca retrocede: WhatsApp reenvía recibos desordenados y aplicarlos
 * tal cual haría que un mensaje leído volviera a "entregado".
 */
export function advanceState(current: DeliveryState, incoming: DeliveryState): DeliveryState {
  if (current === "failed") return "failed";
  return (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : current;
}
