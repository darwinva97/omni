-- La foto de perfil de una conversación.
--
-- Se guarda la CLAVE del almacén, no la URL: la que da WhatsApp caduca en
-- horas, y una URL caducada guardada en la base es una foto rota la semana que
-- viene. Va en `chat` y no en `contact` para que sirva igual a un grupo, que
-- también tiene foto y no tiene fila de contacto.
ALTER TABLE "chat" ADD COLUMN IF NOT EXISTS "avatar_key" text;
--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN IF NOT EXISTS "avatar_synced_at" timestamptz;
--> statement-breakpoint
-- Para encontrar rápido las que aún no tienen foto sin recorrerlas todas.
CREATE INDEX IF NOT EXISTS "chat_sin_avatar_idx"
  ON "chat" ("line_id") WHERE "avatar_key" IS NULL;
