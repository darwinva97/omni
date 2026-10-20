# Migraciones

**Se escriben a mano.** `drizzle-kit generate` sirvió una vez, para el `0000`
inicial, y ese fichero está **curado**: `message` nace `PARTITION BY RANGE`, que
es SQL que ningún generador produce.

Como consecuencia aquí no hay `drizzle/meta/`, así que **`drizzle-kit generate`
no funciona de forma incremental**: al no tener diario, regenera el esquema
entero como un `0000` nuevo y pisa lo que hay. Si lo ejecutas por costumbre,
borra lo que genere.

Para añadir un cambio:

1. Toca el esquema en `src/schema/`, que es lo que usa Drizzle para construir
   las consultas con tipos.
2. Escribe a mano `drizzle/000N_lo-que-hace.sql`.
3. Aplícalo con `pnpm db:migrate`, que lleva la cuenta en `omni_migration`.

Las sentencias se separan con `--> statement-breakpoint` cuando hay varias, y
cada fichero se aplica **en una transacción**: o entra entero o no entra.

## Lo que ya está

| Fichero | Qué hace |
|---|---|
| `0000_init.sql` | Esquema completo. `message` particionada desde el principio. |
| `0001_partitions.sql` | Funciones que garantizan particiones mensuales por delante. |
| `0002_etiquetas_unicas.sql` | Nombre de etiqueta único por línea. |
| `0003_plugins.sql` | Plugins instalados, su manifiesto validado y su configuración. |
| `0004_crm.sql` | Conversaciones, embudos, automatizaciones, agentes y equipos. |
| `0005_identidad_contacto.sql` | Foto de perfil de cada conversación, como clave del almacén. |
| `0006_usuario_whatsapp.sql` | El @usuario de WhatsApp de cada contacto, para el orden de nombres. |
| `0007_foto_de_contacto.sql` | Foto de perfil también en el contacto, para quien escribe en un grupo. |
| `0008_destacados.sql` | Mensajes destacados, guardados en Omni y por persona. |
| `0009_respuestas_rapidas.sql` | Respuestas rápidas de la organización, con su atajo único. |
| `0010_notas_internas.sql` | Notas internas de un chat, en su propia tabla: nunca pasan por la cola de salida. |
| `0011_buscar_en_la_linea.sql` | Índice `(line_id, timestamp)` para buscar en todos los chats de una línea, de lo más nuevo atrás. |
| `0012_sesion_oidc.sql` | `oidc_subject` y `oidc_session_id` en `app_session`, para cerrar las sesiones que el proveedor OIDC da por cerradas. |
