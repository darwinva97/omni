-- Conversaciones y automatizaciones.
--
-- Una conversación NO es un chat: un chat es la dirección con la que se habla,
-- y una conversación es un episodio de atención dentro de ella, con estado y
-- responsable. Una misma persona puede tener varias a lo largo del tiempo, y
-- confundirlas haría imposible decir cuántas se resolvieron.
CREATE TABLE IF NOT EXISTS "conversation" (
  "id"              text PRIMARY KEY,
  "org_id"          text NOT NULL REFERENCES "org"("id") ON DELETE CASCADE,
  "line_id"         text NOT NULL REFERENCES "line"("id") ON DELETE CASCADE,
  "chat_id"         text NOT NULL,
  "status"          text NOT NULL DEFAULT 'open',
  "priority"        text NOT NULL DEFAULT 'normal',
  "assignee_id"     text REFERENCES "app_user"("id") ON DELETE SET NULL,
  "subject"         text,
  "attributes"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "opened_at"       timestamptz NOT NULL DEFAULT now(),
  "last_message_at" timestamptz,
  "first_reply_at"  timestamptz,
  "resolved_at"     timestamptz,
  "snoozed_until"   timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Una sola conversación ABIERTA por chat. Dos abiertas a la vez repartirían
-- los mensajes de una misma persona entre dos expedientes.
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_abierta_idx"
  ON "conversation" ("line_id", "chat_id")
  WHERE "status" <> 'resolved';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_bandeja_idx"
  ON "conversation" ("org_id", "status", "last_message_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_asignado_idx"
  ON "conversation" ("assignee_id", "status") WHERE "assignee_id" IS NOT NULL;
--> statement-breakpoint

-- Reglas de automatización: disparador, condiciones y acciones.
CREATE TABLE IF NOT EXISTS "automation_rule" (
  "id"         text PRIMARY KEY,
  "org_id"     text NOT NULL REFERENCES "org"("id") ON DELETE CASCADE,
  "name"       text NOT NULL,
  "trigger"    text NOT NULL,
  "conditions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "actions"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Menor primero. Empate: por fecha de creación, para que el orden sea
  -- estable y dos ejecuciones den el mismo resultado.
  "priority"   integer NOT NULL DEFAULT 100,
  "enabled"    boolean NOT NULL DEFAULT false,
  -- Acota la regla a una línea. Nulo = todas las de la organización.
  "line_id"    text REFERENCES "line"("id") ON DELETE CASCADE,
  "created_by" text REFERENCES "app_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_rule_disparo_idx"
  ON "automation_rule" ("org_id", "trigger") WHERE "enabled";
--> statement-breakpoint

-- Cada disparo, con su resultado. Un fallo de automatización tiene que ser
-- VISIBLE: el modo de fallo de Evolution es que la regla deje de funcionar y
-- nadie se entere durante semanas.
CREATE TABLE IF NOT EXISTS "automation_run" (
  "id"          text PRIMARY KEY,
  "org_id"      text NOT NULL REFERENCES "org"("id") ON DELETE CASCADE,
  "rule_id"     text NOT NULL REFERENCES "automation_rule"("id") ON DELETE CASCADE,
  "line_id"     text,
  "target"      text,
  "event"       text NOT NULL,
  -- 'matched' | 'skipped' | 'failed'
  "outcome"     text NOT NULL,
  "reason"      text,
  "actions_run" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "duration_ms" integer,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_run_regla_idx"
  ON "automation_run" ("rule_id", "created_at" DESC);
--> statement-breakpoint
-- Para encontrar rápido lo que falló sin recorrer lo que salió bien.
CREATE INDEX IF NOT EXISTS "automation_run_fallos_idx"
  ON "automation_run" ("org_id", "created_at" DESC) WHERE "outcome" = 'failed';
