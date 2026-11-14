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

## Personas (2026-11-14)

Las personas del equipo tienen los MISMOS dos ejes, en `org_member` (y en
`invitation`, para que quien entra por invitación entre ya acotado). El
guardián no distingue: una persona acotada choca con las mismas paredes que
una clave igual de acotada, y la prueba de propiedad lo comprueba también
para ella.

Tres reglas propias de las personas:

- **Solo `agent` o `viewer`** admiten alcance. `agent` lee y escribe en sus
  chats; `viewer` solo los lee. Gestionar algo exige verlo entero, así que dar
  `manager` u `owner` a alguien acotado se rechaza (409) hasta quitarle el
  límite.
- **Unos chats exigen sus líneas.** Los chats se nombran por dirección; sin
  líneas, la persona vería la lista de todas las líneas de la organización.
- **Cambiar el acceso cierra sus sockets.** El billete fija el alcance al
  abrir el WebSocket; el cambio se avisa por el bus (`acceso:<org>`) para que
  todas las réplicas cierren las conexiones de esa persona, y el panel
  reconecta con el alcance nuevo. Vale también al cambiar el rol y al quitarla.

Con esto salieron fugas que ya tenían las claves acotadas y que se cerraron:
la bandeja (`GET /v1/conversations`) no filtraba por chats ni, sin `lineId`,
por líneas; los estados, los stickers y los listados de las capas de
compatibilidad tampoco filtraban; y `line.status` devolvía el QR de enlace a
quien solo tenía un chat, que podía escanearlo con su teléfono y quedarse la
línea. Ahora una credencial acotada que no puede enlazar no recibe el QR, ni
por HTTP ni por el socket.

`line.list` pasa a ser `chatSafe`: es un listado que se filtra, y negarlo
dejaba a quien tiene una línea sin forma de saber cuál es. Es la única ruta de
organización marcada así; hay una prueba que lo vigila.

## Líneas propias (2026-11-14)

Hace falta poder invitar a alguien que NO vea ninguna línea tuya pero dé de
alta las suyas. Con «vacío = todo» no se podía expresar, así que en las
personas el límite pasa a ser explícito (`restricted`): limitada, una lista de
líneas vacía es NINGUNA. Las claves de API no cambian.

`canCreateLines` deja a una persona dar de alta líneas aunque su rol no lo
permita (`line.create` lleva `ownCreate`, y el guardián la deja pasar antes
de mirar rol o límite: crear no abre nada ajeno). La línea creada queda con
un rol `owner` para ella en `line_member`, y una línea con rol propio es
ENTERA para esa persona: la ve aunque esté limitada, el límite por chats no
cuenta en ella, y ve su QR. Por eso `filterChats` exige ahora la línea, y el
billete del socket lleva sus líneas enteras.

Los roles por línea se cargan solo de las líneas de la organización activa:
hasta ahora ninguna ruta los creaba, y desde aquí sí.
