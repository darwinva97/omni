-- La foto de perfil de un CONTACTO, no solo la de una conversación.
--
-- En un grupo, la foto de quien escribe va junto a su primera burbuja. Hasta
-- ahora la foto solo se guardaba en la fila de un chat, así que alguien con
-- quien no tienes conversación propia —casi todos, en un grupo grande— no la
-- tenía nunca. Mismo criterio que en `chat`: la clave del almacén, no la URL,
-- que caduca en horas.
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "avatar_key" text;
--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "avatar_synced_at" timestamptz;
