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

/**
 * Plantilla aprobada previamente.
 *
 * Es la ÚNICA forma de escribir primero a alguien fuera de la ventana de 24
 * horas en la API oficial, así que no es un tipo de mensaje más: es la puerta
 * de entrada legítima a una conversación. Los transportes no oficiales no la
 * tienen, y ahí está media diferencia de riesgo entre unos y otros.
 */
export const TemplatePayload = z.object({
  name: z.string().min(1).max(512),
  /** Código de idioma tal cual lo aprobó Meta: `es`, `es_MX`, `en_US`. */
  languageCode: z.string().min(2).max(10),
  /** Valores para los `{{1}}`, `{{2}}`… del cuerpo, en orden. */
  bodyParameters: z.array(z.string().max(1024)).max(20).optional(),
  headerParameters: z.array(z.string().max(1024)).max(10).optional(),
  /** Un valor por botón de URL dinámica, en orden. */
  buttonParameters: z.array(z.string().max(1024)).max(10).optional(),
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
    template: TemplatePayload.optional(),
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
    /** Texto que acompaña a `buttons` o a `list`; su cuerpo, no un pie de foto. */
    bodyText: z.string().max(1024).optional(),
    footerText: z.string().max(60).optional(),
    /**
     * Manda un vídeo como GIF: en bucle, sin sonido y sin controles.
     *
     * WhatsApp NO envía ficheros GIF. Lo que enseña como «GIF» es un MP4 con
     * esta marca; mandar el .gif tal cual llega como un fichero que el
     * destinatario tiene que abrir aparte.
     */
    gifPlayback: z.boolean().optional(),
    /** Antepone un retardo simulando escritura. El motor lo respeta si el canal lo permite. */
    typingMs: z.number().int().min(0).max(30000).optional(),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInput>;

/** Los campos que deciden QUÉ se envía. Exactamente uno debe estar presente. */
export const contentFields = [
  "text", "image", "video", "audio", "document",
  "sticker", "contact", "location", "poll", "buttons", "list", "template",
] as const;
export type ContentField = (typeof contentFields)[number];

export const messageKinds = [
  "text", "image", "video", "audio", "document",
  "sticker", "contact", "location", "poll", "buttons", "list", "template",
  "reaction", "system", "unknown",
  /*
   * Un aviso dentro del hilo que no es de nadie en concreto: «fijó un
   * mensaje», «compartió el historial». Se guarda con su texto y se pinta
   * centrado, como el separador de día.
   */
  "notice",
  /*
   * Una llamada, en el hilo donde ocurrió: «Llamada de voz perdida». No la
   * escribe nadie; la arma el motor con los eventos `call.received`, y su
   * estado cambia mientras suena.
   */
  "call",
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
