# Omni — verdad de producto

## Qué es

Una pasarela de mensajería multicanal. Conduce WhatsApp por tres transportes
distintos (Baileys, la API oficial de Meta, whatsapp-web.js), más Telegram,
correo y un sandbox, todos detrás de un único puerto `ChannelDriver` con
capacidades declaradas. Encima hay una API REST, webhooks firmados, un panel
web, SDKs y una CLI.

**Mecanismo único:** lo que un transporte no sabe hacer se rechaza con un 422
que NOMBRA qué transporte sí lo hace. Nunca un 500, nunca un silencio.

## Quién lo usa y dónde

Darwin y su equipo, desde un portátil, durante jornadas largas, con el panel
abierto en una pestaña junto a otras diez. No es una app de móvil: es una
herramienta de escritorio que se mira muchas veces al día y que compite por
atención con el WhatsApp Web que ya tienen abierto al lado.

Esa escena manda dos cosas: **tema claro y oscuro según el sistema** —hay quien
trabaja de noche y quien no— y **densidad de escritorio**, no de móvil estirado.

## Qué hace la gente aquí

1. **Leer y responder conversaciones.** Es el 95% del uso. Texto, fotos,
   vídeos, audios, notas de voz grabadas, stickers y documentos, en chats
   individuales y en grupos.
2. **Enlazar y vigilar líneas.** Escanear un QR, ver si una línea sigue
   conectada, reconectarla.
3. **Administrar, de vez en cuando.** Claves de API, equipo, entregas de
   webhook, bitácora.

## Lo que no se puede tocar

- **Los acuses son información, no adorno.** Encolado, enviado, entregado y
  leído son estados distintos y el usuario los distingue a diario. Perderlos
  sería perder la respuesta a «¿le ha llegado?».
- **La dirección es un dato técnico, no un nombre.** Con el direccionamiento
  por LID de WhatsApp, un chat se identifica con quince cifras opacas. El
  nombre resuelto manda; la dirección vive en el detalle, pero no desaparece:
  hace falta para la API.
- **El aviso de riesgo de baneo** al enlazar una línea con un transporte no
  oficial.
- **Un secreto se enseña una vez.** Las claves de API no se pueden volver a
  mostrar.

## Compromisos de marca

Ninguno heredado: no hay logotipo ni paleta previa. Lo que sí hay es una
decisión del usuario (2026-10-04): **afordancias de WhatsApp Desktop con
identidad propia**, no un clon. El listón de oficio son WhatsApp Desktop y
Telegram Desktop para la mensajería, y herramientas tipo Linear para las
pantallas administrativas.
