# Omni

Plataforma multicanal de mensajería: un solo puerto de canal para WhatsApp
(Baileys · Cloud API · whatsapp-web.js), Telegram, email, Instagram/Facebook,
SMS y chat web.

> **Antes de enlazar un número de WhatsApp, lee esto.**
> Los transportes `whatsapp.baileys` y `whatsapp.web` conducen clientes **no
> oficiales**. WhatsApp puede restringir o banear la cuenta, y ninguna calidad
> de código hace ese riesgo cero. Usa un número que puedas permitirte perder,
> nunca el personal ni el principal del negocio. Para entornos regulados
> (salud, finanzas, mensajería comercial a gran escala) usa el transporte
> `whatsapp.cloud`, que es la API oficial de Meta.

## Estado

En construcción. Ver `docs/` y el registro de decisiones.

## Desarrollo

```bash
pnpm install
pnpm test          # unitarias, sin red ni base de datos
pnpm test:contract # la misma batería contra cada driver de canal
pnpm test:int      # integración contra Postgres real
```
