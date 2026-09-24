# ADR-0001 · Un solo puerto para todos los canales

**Estado**: aceptada · **Fecha**: 2026-09-24

## Contexto

El objetivo incluye tres transportes hacia WhatsApp (Baileys, Cloud API,
whatsapp-web.js) y seis canales más. Son diez formas distintas de mandar un
mensaje, con capacidades que no coinciden.

## Decisión

Todo pasa por `ChannelDriver` (`packages/channels/src/port.ts`). Cada driver
declara un `ChannelDescriptor` con su conjunto de capacidades, su método de
enlace, su coste aproximado de memoria y su **perfil de riesgo**.

Una petición a una capacidad que ese driver no tiene se rechaza con **422**,
nombrando la capacidad, el transporte que la rechaza y los que sí la soportan.

## Por qué importa el modelo de capacidades

No es decoración. Las diferencias son reales e irreductibles:

- **Cloud API no ve grupos ni conversaciones personales.** Cubre mensajería de
  empresa, no el número por el que la gente habla de verdad.
- **whatsapp-web.js no puede rechazar llamadas**, y cuesta 300-500 MB por
  sesión frente a los 30-80 MB de Baileys.
- **Baileys no expone etiquetas de forma estable**, así que las nuestras son
  propias y viven en nuestra base de datos.

Una abstracción que ocultara esto estaría mintiendo: el usuario pediría una
encuesta por Cloud API y no pasaría nada, sin explicación.

## Consecuencias

- Todos los drivers corren **la misma batería de contrato**
  (`packages/channels/src/contract/suite.ts`). Sin ella, diez implementaciones
  del mismo puerto divergen en silencio.
- Añadir un canal es implementar una interfaz y pasar el contrato.
- El descriptor obliga a declarar el riesgo, y de ahí cuelga el aviso que el
  panel enseña antes de enlazar un número.
