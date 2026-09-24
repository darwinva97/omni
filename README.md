# Omni

Plataforma multicanal de mensajería. Un solo puerto de canal para WhatsApp
(Baileys · Cloud API · whatsapp-web.js), Telegram, correo, Instagram/Facebook,
SMS y chat web.

---

## ⚠️ Antes de enlazar un número de WhatsApp

Los transportes `whatsapp.baileys` y `whatsapp.web` conducen clientes **no
oficiales**. Va contra los términos de WhatsApp y **la cuenta puede ser
restringida o baneada**; ninguna calidad de código hace ese riesgo cero.

- **Usa un número que puedas permitirte perder.** Nunca el personal ni el
  principal del negocio. Si lo despliegas para clientes, pásales el aviso.
- **No hagas envíos en frío.** Escribir por primera vez a una lista grande de
  desconocidos es la forma más fiable de que restrinjan el número.
- **Calienta los números nuevos** unos días antes de automatizarlos.
- **Mantén una vía alternativa** (SMS o correo) para lo crítico.
- **Para entornos regulados** —salud, finanzas, mensajería comercial a gran
  escala, usuarios en la UE— usa el transporte `whatsapp.cloud`, que es la API
  oficial de Meta, y trata los no oficiales como no aprobados.

El ritmo de envío por línea (`sendRatePerMinute`, 12 por defecto) y el proxy
por línea reducen el riesgo. No lo eliminan.

---

## Qué tiene hoy

| Pieza | Estado |
|---|---|
| Puerto `ChannelDriver` con capacidades declaradas | ✅ |
| Driver **sandbox**: WhatsApp simulado completo | ✅ |
| Cola con reintentos, backoff, partición y cola muerta (memoria · Postgres) | ✅ |
| Esquema de 37 tablas, `message` particionada por tiempo | ✅ |
| Permisos con dos ejes de alcance y denegación por defecto | ✅ |
| Webhooks firmados (HMAC-SHA256 con marca de tiempo), con reintentos y registro | ✅ |
| Motor: credenciales cifradas en BD, ritmo por línea, ingesta, acuses | ✅ |
| API HTTP `/v1` con OpenAPI 3.1 y documentación navegable | ✅ |
| Driver **Baileys**: WhatsApp real, contrastado contra sus servidores | ✅ |
| Medios: subida, descarga por URL firmada y envío de adjuntos | ✅ |
| Servidor **MCP** para agentes, con permisos por llamada | ✅ |
| **CLI** con guard de cobertura sobre la API | ✅ |
| Drivers Cloud API y whatsapp-web.js | ⏳ |
| SDKs y capas `/compat` | ⏳ |
| Multicanal (Telegram, correo, Meta, SMS, web) y CRM | ⏳ |

155 pruebas: unitarias, de contrato y de integración contra Postgres real.

## El sandbox

Un WhatsApp falso que implementa el puerto entero: **las mismas rutas y el
mismo código** que una línea real, contra una red simulada en memoria.

```bash
curl -X POST $API/v1/lines/$L/connect          -H "Authorization: Bearer $KEY"
curl -X POST $API/v1/sandbox/lines/$L/scan     -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -d '{"phone":"51999888777"}'
curl -X POST $API/v1/sandbox/lines/$L/inbound  -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -d '{"from":"51988777666","text":"hola"}'
```

Ese último comando hace que **tu manejador de webhooks reciba una entrega
firmada de verdad**. Es lo que permite correr una prueba de integración de
WhatsApp en CI, en cada push, sin teléfono y sin riesgo de baneo.

## La CLI

```bash
export OMNI_URL=http://127.0.0.1:4000
export OMNI_API_KEY=omni_...

omni ayuda
omni capacidades
omni enviar <linea> 51988777666 "hola" --id pedido-42
omni mensajes <linea> "51988777666@s.whatsapp.net"
omni linea:borrar <linea> --yes     # los destructivos exigen confirmación
```

`--json` en todo, para encadenar con `jq`. Códigos de salida con significado:
**0** correcto · **1** error de uso · **2** error del servicio · **3** falta
configuración. Una prueba rompe CI si una operación de la API se queda sin
comando, o si un comando apunta a una operación que ya no existe.

## Enviar

Un endpoint para todos los tipos, discriminado por el campo que rellenas:

```bash
curl -X POST $API/v1/lines/$L/messages -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"to":"51988777666","text":"hola","clientMessageId":"pedido-42"}'
```

Responde **202**: aceptado y encolado, todavía no entregado. Repetir el mismo
`clientMessageId` **no duplica** el mensaje.

## Webhooks

La firma va en `X-Omni-Signature` como `t=<epoch>,v1=<hmac-sha256>` sobre el
**cuerpo crudo**. Verifícala antes de parsear el JSON: cualquier middleware que
consuma el flujo te deja sin nada que hashear. Ver
[`scripts/webhook-receiver.mjs`](./scripts/webhook-receiver.mjs) para un
receptor completo.

Lista de eventos vacía significa **todos**. Cada intento de entrega queda en
`GET /v1/dispatches` con su código de respuesta, su error y su duración.

## Capacidades

```bash
curl $API/v1/capabilities
```

Cada transporte declara qué sabe hacer. Lo que no soporta se rechaza con **422
explicando cuál sí lo soporta** — nunca con un 500 ni en silencio. Cloud API no
ve grupos, whatsapp-web.js no rechaza llamadas y Baileys no expone etiquetas de
forma estable: la abstracción lo dice en vez de ocultarlo.

## Desarrollo

```bash
pnpm install
pnpm test           # unitarias: sin red ni base de datos
pnpm test:contract  # la misma batería contra cada driver y cada cola
pnpm test:int       # integración contra Postgres real
```

Las de integración necesitan `OMNI_TEST_DATABASE_URL`; sin ella se saltan en
vez de fallar.

### Postgres local sin tocar el del sistema

```bash
scripts/local-postgres.sh start     # clúster propio en el puerto 5440
pnpm db:migrate
```

### Arrancar

```bash
cp .env.example .env    # completa OMNI_MASTER_KEY
pnpm build
scripts/dev-api.sh
```

- Documentación: `http://127.0.0.1:4000/docs`
- Contrato: `http://127.0.0.1:4000/openapi.json`

> **`OMNI_MASTER_KEY` cifra las credenciales de todas las líneas. Perderla
> significa perder todas las sesiones.** Guárdala fuera de la base de datos.

## Arquitectura

Tres planos de proceso: **engine** (con estado, una conexión por línea) ·
**api** (sin estado, REST + OpenAPI) · **worker** (webhooks, automatizaciones).

El motor **no puede ser serverless**: mantiene una conexión permanente por línea
y dormirla equivale a un dispositivo nuevo ante WhatsApp. Escala repartiendo
líneas entre nodos, nunca replicando la misma línea.

Una sola variable decide la infraestructura: con `REDIS_URL` se usan colas y bus
distribuidos; sin ella, todo sobre Postgres. Ambos drivers pasan la misma
batería de contrato, así que el perfil barato no es un perfil peor.
