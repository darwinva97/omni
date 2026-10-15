-- Mensajes destacados: la estrella de WhatsApp, guardada en Omni.
--
-- En Omni y no en el teléfono a propósito. WhatsApp la sincroniza por el
-- estado de la aplicación, que ni la API oficial ni whatsapp-web.js exponen, y
-- Baileys solo a medias: guardada aquí funciona igual en todos los
-- transportes. Y es POR PERSONA, como en WhatsApp, donde la estrella es de
-- cada cuenta: lo que Ana marca para acordarse no le aparece destacado a
-- Bruno. Por eso la clave lleva quién la puso (una persona del panel o una
-- clave de API, que no es nadie más que sí misma).
--
-- No hay clave foránea al mensaje: `message` está particionada por tiempo y
-- su clave primaria es (id, timestamp). `message_at` es esa segunda mitad, y
-- deja buscar el mensaje en su partición sin recorrerlas todas.
CREATE TABLE IF NOT EXISTS "starred_message" (
  "owner_kind" text NOT NULL,
  "owner_id"   text NOT NULL,
  "line_id"    text NOT NULL REFERENCES "line"("id") ON DELETE CASCADE,
  "chat_id"    text NOT NULL,
  "message_id" text NOT NULL,
  "message_at" timestamptz NOT NULL,
  "starred_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_kind", "owner_id", "line_id", "message_id")
);
--> statement-breakpoint
-- Lo que pide la ficha: los destacados de UNA conversación, los últimos primero.
CREATE INDEX IF NOT EXISTS "starred_message_chat_idx"
  ON "starred_message" ("owner_kind", "owner_id", "line_id", "chat_id", "starred_at" DESC);
