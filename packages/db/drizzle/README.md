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
