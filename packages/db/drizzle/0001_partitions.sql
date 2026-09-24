-- Gestión de particiones mensuales de `message`.
--
-- Se hace desde el día uno y no "más adelante" porque convertir una tabla
-- normal en particionada obliga a reescribirla entera: con datos dentro, eso
-- es una ventana de mantenimiento que nadie quiere.

CREATE OR REPLACE FUNCTION omni_ensure_message_partition(target date)
RETURNS text AS $$
DECLARE
  start_at date := date_trunc('month', target)::date;
  end_at   date := (date_trunc('month', target) + interval '1 month')::date;
  part     text := 'message_' || to_char(start_at, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF message FOR VALUES FROM (%L) TO (%L)',
      part, start_at, end_at);
  END IF;
  RETURN part;
END;
$$ LANGUAGE plpgsql;

-- Crea las particiones de una ventana alrededor de hoy. El worker la llama a
-- diario para que siempre haya meses por delante.
CREATE OR REPLACE FUNCTION omni_ensure_message_partitions(months_back int DEFAULT 1, months_ahead int DEFAULT 3)
RETURNS void AS $$
DECLARE
  m int;
BEGIN
  FOR m IN -months_back..months_ahead LOOP
    PERFORM omni_ensure_message_partition((current_date + (m || ' month')::interval)::date);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT omni_ensure_message_partitions(1, 3);
