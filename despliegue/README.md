# Despliegue

Omni corre en esta máquina como **tres servicios de usuario de systemd**, no
como procesos sueltos: así sobreviven a un reinicio sin que nadie los arranque
a mano. El `linger` del usuario `maka` ya está activo, que es lo que permite
que corran sin sesión abierta.

| Unidad | Qué es | Puerto |
|---|---|---|
| `omni-pg` | Clúster de Postgres propio, aparte del del sistema | 5440 |
| `omni-api` | API y motor de canales | 4010 |
| `omni-web` | Panel | 4011 |

```bash
systemctl --user status omni-api
systemctl --user restart omni-api omni-web
journalctl --user -u omni-api -f     # o .data/api.log
```

`omni-api` declara `Requires=omni-pg`, no solo `After`: el proceso se cae al
instante si no puede conectar, así que "arrancada" no basta, tiene que estar
**arriba**. Comprobado parando las dos y arrancando solo la API.

## Para desplegar un cambio

```bash
./scripts/despliegue.sh
```

**No reinicies los servicios a mano después de editar.** Corren `dist/`, y las
pruebas corren las fuentes: se puede escribir una protección, verla pasar las
pruebas y dejarla sin desplegar. Pasó con el limitador de intentos de inicio de
sesión, que estuvo escrito y probado mientras el servicio ya estaba expuesto
sin él.

## Lo público

`https://omni.bezenti.com` lo sirve Caddy desde `/etc/caddy/sites/omni.caddy`,
con un solo nombre para las dos piezas: `/v1/*`, `/health`, `/docs`,
`/openapi.json`, `/compat/*` y `/mcp` van a la API; el resto, al panel.

Lo que protege la puerta:

- El panel no enseña nada sin sesión: `/` redirige a `/entrar`.
- La API responde 401 sin clave.
- El inicio de sesión tiene freno por cuenta y por origen, en el KV —
  compartido entre nodos, no por proceso.
- El registro de la primera cuenta solo funciona mientras no exista ninguna
  organización, así que no se puede dar de alta nadie desde fuera.

La contraseña del panel está en `.data/panel-acceso.txt` (permisos 600, fuera
del control de versiones). La que traía el repositorio estaba en texto plano en
los scripts de siembra y se rotó antes de publicar nada.

## ffmpeg

Las notas de voz y los vídeos grabados en el navegador NO salen en el formato
que WhatsApp reproduce: Chrome graba audio en WebM/Opus y vídeo en VP8, y
WhatsApp quiere OGG/Opus y H.264. La conversión la hace `ffmpeg`, instalado en
`~/.local/bin/ffmpeg` (compilación estática, sin root) y apuntado por
`FFMPEG_PATH` en `.data/entorno`.

El audio se cambia de envoltorio **sin recodificar** cuando ya viene en Opus:
es instantáneo y no pierde calidad. El vídeo sí hay que recodificarlo.

Si `ffmpeg` no está, la API lo avisa AL ARRANCAR (en `.data/api.log`) y los
envíos que necesiten conversión se rechazan con el motivo, en vez de mandar
algo que el destinatario no puede abrir.
