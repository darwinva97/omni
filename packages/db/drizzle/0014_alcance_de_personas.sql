-- Alcance por líneas y por chats para las PERSONAS, igual que ya lo tenían las
-- claves de API. Vacío significa todo, así que quien ya estaba en el equipo
-- sigue viendo lo mismo que antes.
--
-- Va en `org_member` y no en la cuenta: una persona puede estar en dos
-- organizaciones, y lo que le compartes tú no dice nada de lo que le comparte
-- otra. En `invitation` para que el alcance se fije al invitar y la persona
-- entre ya acotada, sin un rato viéndolo todo hasta que alguien lo ajuste.
ALTER TABLE org_member ADD COLUMN allowed_lines jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE org_member ADD COLUMN allowed_chats jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE invitation ADD COLUMN allowed_lines jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE invitation ADD COLUMN allowed_chats jsonb NOT NULL DEFAULT '[]'::jsonb;
