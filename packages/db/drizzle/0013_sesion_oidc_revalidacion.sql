-- Revalidación de las sesiones abiertas con el proveedor OIDC.
--
-- Desactivar a alguien en el proveedor no siempre cierra sus sesiones allí
-- (Keycloak, por ejemplo, las deja vivas hasta que caducan), así que el aviso
-- por canal trasero no llega. Cada sesión guarda el refresh token del proveedor,
-- SELLADO con la clave maestra, y la API lo renueva cada pocos minutos: si el
-- proveedor lo rechaza, la sesión se cierra.
ALTER TABLE app_session ADD COLUMN oidc_refresh_token text;
--> statement-breakpoint
ALTER TABLE app_session ADD COLUMN oidc_checked_at timestamptz;
