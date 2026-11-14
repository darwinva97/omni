-- Una persona limitada puede estarlo a NINGUNA línea ajena —solo a las que dé
-- de alta ella—, y con listas vacías eso no se distingue de «todas». Por eso
-- el límite pasa a ser explícito. Quien ya tenía listas queda limitado, como
-- estaba.
--
-- `can_create_lines` deja a una persona dar de alta líneas aunque su rol no lo
-- permita: la que cree será suya entera (un rol propio en `line_member`).
ALTER TABLE org_member ADD COLUMN restricted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE org_member ADD COLUMN can_create_lines boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE invitation ADD COLUMN restricted boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE invitation ADD COLUMN can_create_lines boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE org_member SET restricted = true
  WHERE allowed_lines <> '[]'::jsonb OR allowed_chats <> '[]'::jsonb;
--> statement-breakpoint
UPDATE invitation SET restricted = true
  WHERE allowed_lines <> '[]'::jsonb OR allowed_chats <> '[]'::jsonb;
