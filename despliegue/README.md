# Despliegue

Omni corre en el clúster **k3s** de bezenti en Contabo, gestionado por **ArgoCD** desde
`darwinva97/infra-contabo` (`manifiestos/omni`), en https://omni.bezenti.com.

El repositorio principal está en **Forgejo**: https://forgejo.bezenti.com/bezenti/omni
(privado, tras Cloudflare Access). `github.com/darwinva97/omni` es un **espejo de solo
lectura** que Forgejo actualiza en cada push: las PR se abren en Forgejo.

```
push a main ─▶ CI (Forgejo Actions, .forgejo/workflows/ci.yml) ─▶ verde ─▶ imagen: docker build del mismo commit
                                   │                (pnpm test dentro) ─▶ forgejo.bezenti.com/bezenti/omni:sha-xxxxxxx
                                   │             └▶ desplegar: anota el tag en infra-contabo ─▶ ArgoCD lo despliega
                                   └▶ rojo ─▶ no se construye nada, no sale nada
```

**Solo sale lo que está en `main` con CI en verde.** No hace falta entrar en la
máquina. Volver a desplegar lo último de main sin un commit nuevo: *Actions → CI →
Run workflow*.

El CI corre en el runner de la organización `bezenti` (`ci-nodo2`, dentro del
clúster; ver la sección «Forgejo: repos, CI y registro» del README de infra-contabo).
Secretos: `REGISTRY_TOKEN` (organización; sube la imagen) e `INFRA_DEPLOY_KEY` (este
repo; escribe en infra-contabo). El clúster descarga la imagen con el Secret
`forgejo-pull`.

Clonar o subir desde fuera: `git clone https://forgejo.bezenti.com/bezenti/omni.git`
con tu usuario y un **token de aplicación** de Forgejo como contraseña (*Configuración →
Aplicaciones*, permiso `write:repository`): las cuentas de Keycloak no tienen contraseña.

Reiniciar la API reconecta todas las líneas de WhatsApp: los cambios que tocan
la API conviene subirlos en horas tranquilas.

## Piezas

| Pieza | En k3s |
|---|---|
| API (`node apps/api/dist/main.js`) | Deployment `omni-api`, **1 réplica, `Recreate`**: dos procesos a la vez pelearían por las mismas sesiones de WhatsApp. Escucha en `0.0.0.0` (`HOST`). |
| Panel (`next start`) | Deployment `omni-web` |
| Postgres | Instancia compartida de aplicaciones `datos/pg-apps`, base y rol `omni` (Secret `pg-omni`). Las migraciones se aplican al arrancar la API. |
| Medios | Garage, bucket `omni-media`. Los bytes van por la red interna (`S3_ENDPOINT`); las URLs de descarga se firman contra `S3_PUBLIC_ENDPOINT` (`https://s3.bezenti.com`). |
| Secretos | Secrets de Kubernetes generados en el clúster: `omni-master` (clave maestra), `omni-oidc`, `pg-omni`, `omni-s3` |
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
