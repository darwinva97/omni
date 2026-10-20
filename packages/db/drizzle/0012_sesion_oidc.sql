-- Sesiones abiertas con un proveedor OpenID Connect: de quién (sub) y de qué
-- sesión del proveedor (sid) vienen. Con eso, cuando el proveedor avisa de que
-- cerró una sesión (back-channel logout), se cierran las nuestras que nacieron
-- de ella, en vez de esperar a que caduquen. Nulas en las de contraseña.
ALTER TABLE app_session ADD COLUMN oidc_subject text;
--> statement-breakpoint
ALTER TABLE app_session ADD COLUMN oidc_session_id text;
--> statement-breakpoint
CREATE INDEX app_session_oidc_session_idx ON app_session (oidc_session_id) WHERE oidc_session_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX app_session_oidc_subject_idx ON app_session (oidc_subject) WHERE oidc_subject IS NOT NULL;
