-- Las claves de la sesión de WhatsApp, una fila por clave.
--
-- Antes iba TODA la sesión en un blob de auth_state (credenciales + claves de cada contacto y
-- grupo), y cada mensaje descifrado reescribía el blob entero: en un número con muchos grupos,
-- cientos de KB por mensaje. Ahora auth_state lleva sólo las credenciales y cada clave cambia
-- su fila. Selladas con la clave maestra, como el blob.
CREATE TABLE IF NOT EXISTS auth_key (
  line_id text NOT NULL REFERENCES line(id) ON DELETE CASCADE,
  type text NOT NULL,
  key_id text NOT NULL,
  sealed text NOT NULL,
  PRIMARY KEY (line_id, type, key_id)
);
