-- Plugins instalados y su configuración.
--
-- El manifiesto se guarda tal cual se validó al instalar: si el fichero del
-- disco cambia, lo que manda es lo que se aceptó, no lo que hay ahora.
CREATE TABLE IF NOT EXISTS "plugin" (
  "id"           text PRIMARY KEY,
  "org_id"       text NOT NULL REFERENCES "org"("id") ON DELETE CASCADE,
  "plugin_id"    text NOT NULL,
  "version"      text NOT NULL,
  "manifest"     jsonb NOT NULL,
  "directory"    text NOT NULL,
  "config"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled"      boolean NOT NULL DEFAULT false,
  "status"       text NOT NULL DEFAULT 'parado',
  "last_error"   text,
  "installed_by" text REFERENCES "app_user"("id") ON DELETE SET NULL,
  "installed_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Un plugin por organización: dos copias del mismo con configuraciones
-- distintas serían indistinguibles en el panel y se pisarían el prefijo del KV.
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_org_plugin_idx" ON "plugin" ("org_id", "plugin_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_enabled_idx" ON "plugin" ("org_id") WHERE "enabled";
