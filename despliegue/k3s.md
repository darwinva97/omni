# Despliegue en k3s (rama `k3s`)

Instalación paralela a la de `omni.bezenti.com`, en el clúster k3s, gestionada
por ArgoCD desde `darwinva97/bezenti-gitops` (`apps/omni`). La de systemd sigue
igual: su CD solo mira `main`.

```
push a k3s ─▶ runner k3s-omni ─▶ docker build (con pnpm test) ─▶ ghcr.io/darwinva97/omni:sha-xxxxxxx
          └▶ actualiza el tag en bezenti-gitops ─▶ ArgoCD lo despliega
```

| Pieza | En k3s |
|---|---|
| API (`node apps/api/dist/main.js`) | Deployment `omni-api`, **1 réplica, `Recreate`**: dos procesos a la vez pelearían por las mismas sesiones de WhatsApp |
| Panel (`next start`) | Deployment `omni-web` |
| Postgres | `pg-shared` compartido, base y rol `omni` |
| Medios | RustFS, bucket `omni-media`. Los bytes van por la red interna (`S3_ENDPOINT`); las URLs de descarga se firman contra `S3_PUBLIC_ENDPOINT` |
| Secretos | OpenBao: `omni/master-key`, `databases/pg-shared/omni`, `s3/omni` |
| ffmpeg | En la imagen (`FFMPEG_PATH=/usr/bin/ffmpeg`) |

`OMNI_MASTER_KEY` de esta instalación es **propia**: no descifra las sesiones de
la otra. Para migrar líneas de una a otra hay que llevar la base y la misma llave.

Una sola imagen sirve para las dos piezas; cambia el comando:

```bash
docker build -t omni .
docker run omni                                                     # API
docker run -w /app/apps/web omni node_modules/.bin/next start -p 4011  # panel
```
