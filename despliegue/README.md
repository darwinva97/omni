# Despliegue

Omni corre en el clúster **k3s** de bezenti, gestionado por **ArgoCD** desde
`darwinva97/bezenti-gitops` (`apps/omni`), en https://omni.bezenti.com.

```
push a main ─▶ CI (runner k3s-omni) ─▶ verde ─▶ k3s image: docker build del mismo commit
                                   │                (pnpm test dentro) ─▶ ghcr.io/darwinva97/omni:sha-xxxxxxx
                                   │             └▶ anota el tag en bezenti-gitops ─▶ ArgoCD lo despliega
                                   └▶ rojo ─▶ no se construye nada, no sale nada
```

**Solo sale lo que está en `main` con CI en verde.** No hace falta entrar en la
máquina. Volver a desplegar lo último de main sin un commit nuevo: *Actions →
k3s image → Run workflow*.

Reiniciar la API reconecta todas las líneas de WhatsApp: los cambios que tocan
la API conviene subirlos en horas tranquilas.

## Piezas

| Pieza | En k3s |
|---|---|
| API (`node apps/api/dist/main.js`) | Deployment `omni-api`, **1 réplica, `Recreate`**: dos procesos a la vez pelearían por las mismas sesiones de WhatsApp. Escucha en `0.0.0.0` (`HOST`). |
| Panel (`next start`) | Deployment `omni-web` |
| Postgres | `pg-shared` compartido, base y rol `omni`. Las migraciones se aplican al arrancar la API. |
| Medios | RustFS, bucket `omni-media`. Los bytes van por la red interna (`S3_ENDPOINT`); las URLs de descarga se firman contra `S3_PUBLIC_ENDPOINT` (`https://s3.bezenti.com`). |
| Secretos | OpenBao: `omni/master-key`, `omni/oidc`, `databases/pg-shared/omni`, `s3/omni` |
| Rutas | Un solo nombre: `/v1`, `/health`, `/docs`, `/openapi.json`, `/compat` y `/mcp` van a la API; el resto, al panel |

Una sola imagen sirve para las dos piezas; cambia el comando:

```bash
docker build -t omni .
docker run omni                                                        # API
docker run -w /app/apps/web omni node_modules/.bin/next start -p 4011  # panel
```

`OMNI_MASTER_KEY` cifra las credenciales de **todas** las líneas: perderla es
perder todas las sesiones. Vive en OpenBao (`omni/master-key`).

## Entrar

Dos formas, y cada instalación decide cuáles abre:

- **Con Keycloak** (OpenID Connect, realm `bezenti`, cliente `omni`): `OIDC_ISSUER_URL`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`. Entra quien tiene cuenta en Omni con el
  mismo correo, verificado en Keycloak, y está en un grupo de `OIDC_ALLOWED_GROUPS`.
- **Con correo y contraseña**: `PASSWORD_LOGIN_ENABLED`.

En bezenti **solo con Keycloak** (`PASSWORD_LOGIN_ENABLED=false`): ninguna cuenta
tiene contraseña.

- **Alta:** *Equipo → Invitar* con su rol, y se manda el enlace (`/unirse?codigo=…`).
  Quien lo abre acepta entrando con Keycloak.
- **Rol:** *Equipo → Cambiar*. Se aplica en su siguiente petición.
- **Quitar:** *Equipo → Quitar*. Sale al momento y no vuelve a entrar.
- **Baja en Keycloak:** desactivarla. Sale de Omni en `OIDC_RECHECK_MINUTES` (5)
  como mucho, porque la sesión se revalida con Keycloak; cerrar además sus sesiones
  en Keycloak la saca al instante (aviso por canal trasero a
  `http://omni-api.omni.svc:4010/v1/auth/oidc/backchannel-logout`).

Las sesiones de Keycloak duran `OIDC_SESSION_HOURS` (12).

## ffmpeg

Las notas de voz y los vídeos grabados en el navegador NO salen en el formato
que WhatsApp reproduce: Chrome graba audio en WebM/Opus y vídeo en VP8, y
WhatsApp quiere OGG/Opus y H.264. La conversión la hace `ffmpeg`, que va en la
imagen (`FFMPEG_PATH=/usr/bin/ffmpeg`).

El audio se cambia de envoltorio **sin recodificar** cuando ya viene en Opus:
es instantáneo y no pierde calidad. El vídeo sí hay que recodificarlo.

Si `ffmpeg` no está, la API lo avisa AL ARRANCAR y los envíos que necesiten
conversión se rechazan con el motivo, en vez de mandar algo que el destinatario
no puede abrir.
