-- Buscar en todos los chats de una línea, de lo más nuevo a lo más viejo.
--
-- La búsqueda dentro de un chat ya tenía su índice, `(line_id, chat_id,
-- timestamp)`. La de toda la línea no: sin éste, para devolver los veinte
-- resultados más recientes Postgres ordenaba ANTES todos los mensajes de la
-- línea. Con él los recorre ya ordenados y para en cuanto junta veinte.
--
-- Lo que no hace: saltarse los que no coinciden. Para eso haría falta un
-- índice de trigramas, que pide instalar `pg_trgm`, y la búsqueda se escribió
-- con `translate` justo para no depender de extensiones. Con el volumen de
-- hoy no hace falta; si algún día sí, va en una migración propia.
--
-- Sobre la tabla particionada: Postgres lo crea en cada partición, y las
-- nuevas que abre `omni_ensure_message_partitions` lo heredan solas.
CREATE INDEX IF NOT EXISTS "message_linea_tiempo_idx"
  ON "message" ("line_id", "timestamp" DESC);
