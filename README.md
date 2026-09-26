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
| **Identidad**: alta, sesión en cookie httpOnly, equipo e invitaciones | ✅ |
| Driver **Cloud API**: transporte OFICIAL, sin riesgo de baneo | ✅ |
| Driver **whatsapp-web.js**: menor riesgo de baneo, 400 MB por línea | ✅ |
| **SDK de TypeScript**, sin dependencias, probado contra la API real | ✅ |
| Tiempo real por **WebSocket** | ✅ |
| **Panel web**: conversación en vivo, líneas, claves, equipo, entregas y bitácora | ✅ |
| Capas **`/compat`**: WasenderAPI y Evolution API | ✅ |
| **SDK de Python**, solo biblioteca estándar, probado contra la API real | ✅ |
| SDK de Go | ⏳ |
| Fases 4-7: paridad extendida, plugins, multicanal, CRM | ⏳ |
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
export OMNI_URL=http://127.0.0.1:4010
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

## Migrar desde otro gateway

Cambiar la URL base, y nada más:

| Vienes de | Apunta a |
|---|---|
| WasenderAPI | `https://tu-servidor/compat/wasender` |
| Evolution API | `https://tu-servidor/compat/evolution` |

Se reproducen sus formas de petición y sus sobres de respuesta —inconsistencias
incluidas, porque el objetivo es que un cliente existente funcione sin tocarlo—
y no aparecen en el contrato OpenAPI: son clones de una interfaz ajena, no
parte de la nuestra. **Los permisos son los mismos que en `/v1`**: la
compatibilidad no es una puerta trasera.

## SDK de TypeScript

```ts
import { OmniClient, parseWebhook } from "@omni/sdk";

const omni = new OmniClient({ baseUrl: "https://tu-servidor", apiKey: process.env.OMNI_API_KEY! });

// Consulta antes de intentar algo poco común
if (await omni.supports("whatsapp.cloud", "send.poll")) { /* … */ }

await omni.send(lineId, { to: "51988777666", text: "hola", clientMessageId: "pedido-42" });

// Recorre meses de conversación sin cargarlos en memoria
for await (const m of omni.iterateMessages(lineId, chat)) { /* … */ }
```

Sin dependencias en tiempo de ejecución. Reintenta lo pasajero —un 429, un
502— y nunca lo que no lo es: repetir un 403 no lo arregla. Los errores llegan
desmenuzados (`err.missingCapability`, `err.code`), no como texto.

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

- Documentación: `http://127.0.0.1:4010/docs`
- Contrato: `http://127.0.0.1:4010/openapi.json`

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
