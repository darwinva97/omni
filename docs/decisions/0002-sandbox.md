# ADR-0002 · El sandbox va primero

**Estado**: aceptada · **Fecha**: 2026-09-24

## Decisión

El primer driver implementado no es Baileys: es `sandbox`, un WhatsApp
simulado que implementa el puerto **entero**, con las mismas rutas y el mismo
código aguas arriba.

## Por qué antes que el transporte real

1. **Desbloquea todo lo demás.** El esquema, la cola, los permisos, los
   webhooks y la API se construyeron y se probaron contra él.
2. **Hace posible probar en CI.** Un recorrido completo de WhatsApp —enlazar,
   recibir, verificar la firma del webhook, responder, comprobar el acuse— corre
   desatendido en cada push, sin teléfono.
3. **No arriesga ningún número.** Desarrollar contra una cuenta real significa
   exponerla a una restricción por hacer justo lo que hay que hacer al
   desarrollar: repetir, equivocarse y reintentar.
4. **Es determinista.** Reloj e identificadores inyectables: un test afirma
   valores exactos en vez de conformarse con "algo pasó".

El sandbox declara **todas** las capacidades a propósito, así que la batería de
contrato las ejercita todas y sirve de referencia de comportamiento para los
drivers reales.
