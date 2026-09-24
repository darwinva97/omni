# ADR-0003 · Denegación por defecto en el alcance por chat

**Estado**: aceptada · **Fecha**: 2026-09-24

## Decisión

Cada credencial tiene dos ejes de alcance independientes: `allowedLines` y
`allowedChats`. Vacío significa "todas", incluidas las que se creen después.

Cuando una clave está acotada a chats, **toda ruta que no esté marcada
explícitamente `chatSafe` la rechaza con 403** — también las que se añadan en
versiones futuras. La negativa es el defecto.

## Por qué así y no con una lista de exclusión

Una lista negra hay que mantenerla. Alguien añade una ruta, olvida incluirla, y
esa ruta queda abierta a claves que no deberían alcanzarla. Con el defecto
invertido, olvidarse significa quedarse corto, no pasarse.

Hay una prueba que recorre el catálogo entero y comprueba la propiedad
(`packages/core/src/auth/authorize.spec.ts`).

## Qué puede una clave acotada

Dentro de sus chats: leer, enviar, responder, editar, borrar, reaccionar,
marcar leído, archivar, renombrar un grupo y salirse, bloquear un contacto.

Lo que **no** puede, ni dentro de sus chats: decidir quién pertenece a un grupo
—añadir, quitar, promover, degradar, invitaciones, enlaces— ni gestionar claves,
ni ver la organización.

Esto permite apuntar un agente de IA a una cuenta compartida dándole solo los
grupos que le tocan.

## Identidad

Un contacto permitido por teléfono también vale por su `@lid`, pero **solo si la
tabla de mapeo lo confirma**. Un `@lid` sin mapeo se rechaza: adivinar a partir
de los dígitos confundiría a dos personas distintas. `555000111@lid` y
`555000111@s.whatsapp.net` no son la misma persona.

## Orden de comprobación

Línea (→ **401**) antes que permiso (→ 403) antes que chat (→ 403). El 401 de
línea es deliberado: un 403 confirmaría que esa línea existe.
