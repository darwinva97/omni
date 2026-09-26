-- Dos etiquetas con el mismo nombre en una línea serían indistinguibles en el
-- panel y en la API, así que el nombre es único por línea.
--
-- Antes de crear el índice se resuelven los duplicados que pudiera haber: el
-- índice fallaría y dejaría la migración a medias.
DELETE FROM label a USING label b
WHERE a.line_id = b.line_id AND a.name = b.name AND a.ctid > b.ctid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "label_line_name_idx" ON "label" ("line_id", "name");
