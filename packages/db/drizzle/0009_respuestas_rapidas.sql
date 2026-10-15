-- Respuestas rápidas: textos guardados de la organización con un atajo.
--
-- Escribir «/precios» al principio del campo ofrece el texto guardado, que se
-- puede retocar antes de enviar. Son de la ORGANIZACIÓN y no de cada persona:
-- la tarifa o el horario se escriben una vez y los dice igual todo el equipo.
--
-- El atajo se guarda sin la barra y en minúsculas, y es único por
-- organización: dos «/precios» harían que el mismo atajo dijera dos cosas.
CREATE TABLE IF NOT EXISTS "quick_reply" (
  "id"         text PRIMARY KEY,
  "org_id"     text NOT NULL REFERENCES "org"("id") ON DELETE CASCADE,
  "shortcut"   text NOT NULL,
  "text"       text NOT NULL,
  "created_by" text REFERENCES "app_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quick_reply_org_shortcut_idx" ON "quick_reply" ("org_id", "shortcut");
