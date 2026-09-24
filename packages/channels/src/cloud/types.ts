/**
 * Formas de la API de WhatsApp Cloud (Graph API de Meta).
 *
 * Se declaran aquí y no se importan de ningún SDK: Meta no publica tipos
 * oficiales para Node, y depender de un paquete de terceros para esto añade
 * una dependencia que hay que seguir cuando Meta cambie la versión de la API.
 */

export interface CloudSendResponse {
  messaging_product: "whatsapp";
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string; message_status?: string }[];
}

export interface CloudError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    error_data?: { messaging_product: string; details: string };
    fbtrace_id?: string;
  };
}

/** Un `POST` de Meta a nuestro webhook. Puede traer varios cambios a la vez. */
export interface CloudWebhookPayload {
  object: string;
  entry: {
    id: string;
    changes: {
      field: string;
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: { profile: { name: string }; wa_id: string }[];
        messages?: CloudInboundMessage[];
        statuses?: CloudStatus[];
        errors?: CloudError["error"][];
      };
    }[];
  }[];
}

export interface CloudInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  video?: { id: string; mime_type: string; caption?: string };
  audio?: { id: string; mime_type: string; voice?: boolean };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown[];
  reaction?: { message_id: string; emoji: string };
  context?: { from: string; id: string };
  errors?: CloudError["error"][];
}

export interface CloudStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: CloudError["error"][];
}
