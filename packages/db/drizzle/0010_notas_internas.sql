-- Notas internas: lo que el equipo se dice SOBRE un chat, dentro del chat.
--
-- Viven en su propia tabla y no en `message` a propósito. Todo lo que hay en
-- `message` es algo que pasó por WhatsApp o que va a pasar —la cola de salida
-- lee de ahí—, y una nota mezclada con los mensajes estaría a un filtro
-- olvidado de salir hacia el cliente. Aquí no hay camino de la tabla a la red.
CREATE TABLE IF NOT EXISTS "internal_note" (
  "id"             text PRIMARY KEY,
  "org_id"         text NOT NULL REFERENCES "org"("id") ON DELETE CASCADE,
  "line_id"        text NOT NULL REFERENCES "line"("id") ON DELETE CASCADE,
  "chat_id"        text NOT NULL,
  -- Quién la escribió: una persona, o una integración con su clave. Si la
  -- cuenta se borra, la nota se queda —es historia del chat— sin autor.
  "author_user_id" text REFERENCES "app_user"("id") ON DELETE SET NULL,
  "author_key_id"  text,
  "body"           text NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Las de un chat, de la más nueva a la más vieja: es como se intercalan con
-- el hilo, que se pagina igual.
CREATE INDEX IF NOT EXISTS "internal_note_chat_idx"
  ON "internal_note" ("line_id", "chat_id", "created_at" DESC);
