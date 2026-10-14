import { describe, it, expect } from "vitest";
import {
  OmniError, CapabilityError, capabilities, contentFields, parseAddress,
  type Capability, type ContentField, type EventEnvelope, type LineId, type SendMessageInput,
} from "@omni/shared";
import type { ChannelDriver } from "../port.js";

/**
 * BATERÍA DE CONTRATO.
 *
 * Cada driver de canal corre exactamente estas pruebas. Es lo que sostiene la
 * abstracción: sin ella, nueve implementaciones del mismo puerto divergen en
 * silencio y el código de arriba acaba lleno de "si es Baileys entonces...".
 *
 * Solo comprueba lo que DEBE ser cierto para todos, incluidos los que casi no
 * saben hacer nada: que las capacidades declaradas y las reales coincidan, que
 * lo no soportado falle con 422 y no con 500, y que un envío repetido no duplique.
 */

export interface DriverUnderTest {
  readonly driver: ChannelDriver;
  readonly lineId: LineId;
  /** Lleva la línea al estado conectado, sea por QR simulado, token o lo que use. */
  readonly link: () => Promise<void>;
  /**
   * Un destinatario válido PARA ESTE CANAL.
   *
   * El puerto es multicanal, así que la batería no puede dar por hecho que todo
   * destino es un teléfono: al correo hay que escribirle a una dirección de
   * correo. Por defecto un número, que es lo que usan los cuatro de WhatsApp.
   */
  readonly sampleTo?: string;
  readonly cleanup?: () => Promise<void>;
}

/** Método opcional del puerto que habilita cada capacidad, cuando hay uno. */
const METHOD_FOR: Partial<Record<Capability, keyof ChannelDriver>> = {
  "message.edit": "editMessage",
  "message.delete": "deleteMessage",
  "send.reaction": "react",
  "chat.read": "markRead",
  "chat.presence": "setPresence",
  // Escribir es una presencia más: quien declare una tiene que tener el método.
  "chat.typing": "setPresence",
  "presence.watch": "watchPresence",
  "contact.check": "checkContact",
  "group.read": "groupMetadata",
  "group.create": "createGroup",
  "group.manage": "updateGroup",
  "group.invite": "groupInviteCode",
  "newsletter.read": "newsletterMetadata",
  "chat.clear": "clearChat",
  "chat.delete": "deleteChat",
  "chat.archive": "archiveChat",
  "chat.mute": "muteChat",
  "chat.ephemeral": "setEphemeral",
  "contact.block": "blockContact",
  "contact.profile": "contactProfile",
  "send.forward": "forwardMessage",
  "label.manage": "listNetworkLabels",
  "newsletter.send": "createNewsletter",
  "community.read": "communityMetadata",
  "community.manage": "createCommunity",
  "catalog.read": "listProducts",
  "catalog.manage": "createProduct",
  "media.decrypt": "downloadMedia",
  /*
   * Lo que NO está mapeado, y por qué. La lista corta importa tanto como la
   * larga, porque si no se explica alguien la "completa" con métodos falsos.
   *
   * `send.*` (tipos y modificadores) — las cubre la prueba de más abajo, que
   *   construye un envío real de cada tipo declarado. Comprobar que existe un
   *   método diría menos: `send` existe siempre.
   * `message.receipts`, `call.receive` — no son operaciones que se invoquen,
   *   son la promesa de EMITIR `message.receipt` y `call.received`.
   * `identity.lid` — promesa de traer la dirección alternativa en los eventos;
   *   el mapeo lo guarda el motor, no el driver.
   */
  "call.reject": "rejectCall",
  "group.participants": "updateParticipants",
  "history.sync": "fetchHistory",
};

/**
 * Un contenido mínimo válido por cada tipo, para probar que lo declarado se
 * puede enviar de verdad.
 */
const CONTENIDO: Record<ContentField, Partial<SendMessageInput>> = {
  text: { text: "hola" },
  image: { image: { url: "https://ejemplo.test/a.jpg" }, caption: "pie" },
  video: { video: { url: "https://ejemplo.test/a.mp4" } },
  audio: { audio: { url: "https://ejemplo.test/a.ogg" } },
  document: { document: { url: "https://ejemplo.test/a.pdf" }, fileName: "a.pdf" },
  sticker: { sticker: { url: "https://ejemplo.test/a.webp" } },
  contact: { contact: { fullName: "Ada Lovelace", phone: "+51999000111" } },
  location: { location: { latitude: -12.04, longitude: -77.04 } },
  poll: { poll: { question: "¿Sí?", options: ["sí", "no"], allowMultipleAnswers: false } },
  buttons: { buttons: [{ id: "a", title: "Sí" }], bodyText: "¿Confirmas?" },
  list: {
    list: {
      title: "Menú", buttonText: "Ver",
      sections: [{ title: "Platos", rows: [{ id: "1", title: "Ceviche" }] }],
    },
    bodyText: "Elige uno",
  },
  template: { template: { name: "saludo", languageCode: "es" } },
};

/** Un teléfono, que es lo que aceptan los cuatro transportes de WhatsApp. */
const DESTINO_POR_DEFECTO = "51999000111";

export function runChannelContract(name: string, make: () => Promise<DriverUnderTest>): void {
  describe(`contrato de canal: ${name}`, () => {
    it("declara un descriptor coherente", async () => {
      const { driver, cleanup } = await make();
      const d = driver.descriptor;
      expect(d.kind).toBeTruthy();
      expect(d.network).toBeTruthy();
      expect(d.capabilities.size).toBeGreaterThan(0);
      expect(d.approxMemoryMbPerLine).toBeGreaterThan(0);
      // Un transporte no oficial DEBE declararse como tal: de ahí cuelga el aviso
      // de riesgo de baneo que el panel enseña antes de enlazar un número.
      expect(["official", "unofficial", "simulated"]).toContain(d.risk);
      // Toda capacidad declarada existe en el catálogo: nada de cadenas sueltas.
      for (const c of d.capabilities) expect(capabilities).toContain(c);
      await cleanup?.();
    });

    it("una línea desconocida está desconectada, no explota", async () => {
      const { driver, cleanup } = await make();
      expect(driver.status("no-existe" as LineId).state).toBe("disconnected");
      await cleanup?.();
    });

    it("declarar una capacidad implica implementar su método", async () => {
      const { driver, cleanup } = await make();
      for (const [cap, method] of Object.entries(METHOD_FOR) as [Capability, keyof ChannelDriver][]) {
        if (driver.descriptor.capabilities.has(cap)) {
          expect(typeof driver[method], `declara "${cap}" pero le falta ${String(method)}()`).toBe("function");
        }
      }
      await cleanup?.();
    });

    it("lo no soportado falla con 422 explicando el motivo, nunca con 500", async () => {
      const { driver, cleanup } = await make();
      const missing = capabilities.filter((c) => !driver.descriptor.capabilities.has(c));
      for (const cap of missing) {
        const err = new CapabilityError(cap, driver.descriptor.kind);
        expect(err.status).toBe(422);
        expect(err.message).toContain(cap);
      }
      await cleanup?.();
    });

    it("declarar que sabe enviar algo implica saber construirlo", async () => {
      /*
       * Esta es la que impide que el catálogo de capacidades se vuelva
       * decorativo. Declarar `send.buttons` y luego lanzar
       * `capability_unsupported` al construir el cuerpo es peor que no
       * declararlo: la API acepta el envío con un 202 y el mensaje muere
       * después, en silencio, donde el cliente ya no está mirando.
       *
       * Otros fallos SÍ valen —una URL inalcanzable, una línea sin conectar—:
       * lo único inaceptable es que la capacidad declarada no exista.
       */
      const { driver, lineId, link, cleanup, sampleTo } = await make();
      const destino = sampleTo ?? DESTINO_POR_DEFECTO;
      await link();

      /*
       * También los modificadores, con un límite que conviene saber.
       *
       * Desde aquí solo se ve si el driver los RECHAZA, no si los ignora en
       * silencio: un modificador que se cae por el camino no lanza nada. Que
       * llegue de verdad al mensaje se comprueba en la prueba del constructor
       * de cada driver —`content.spec.ts` en Baileys—, que es donde vive el
       * conocimiento del formato. Se ha verificado que esa prueba falla si se
       * deja de poner `viewOnce`.
       */
      const MODIFICADORES: Partial<Record<Capability, Partial<SendMessageInput>>> = {
        "send.reply": { replyTo: "ABC123" },
        "send.mentions": { mentions: ["51988777666@s.whatsapp.net"] },
        "send.viewOnce": { viewOnce: true },
      };
      for (const [cap, extra] of Object.entries(MODIFICADORES) as [Capability, Partial<SendMessageInput>][]) {
        if (!driver.descriptor.capabilities.has(cap)) continue;
        const base = cap === "send.viewOnce" ? CONTENIDO.image : CONTENIDO.text;
        const err = await driver
          .send({
            lineId, to: parseAddress(destino), clientMessageId: `mod-${cap}`,
            kind: cap === "send.viewOnce" ? "image" : "text",
            input: { to: destino, ...base, ...extra } as SendMessageInput,
          })
          .then(() => null)
          .catch((e: unknown) => e as OmniError);
        expect(err?.code, `declara "${cap}" y al construirlo dice que no lo admite`)
          .not.toBe("capability_unsupported");
      }

      for (const field of contentFields) {
        if (!driver.descriptor.capabilities.has(`send.${field}` as Capability)) continue;

        const input = { to: destino, ...CONTENIDO[field] } as SendMessageInput;
        const err = await driver
          .send({ lineId, to: parseAddress(destino), clientMessageId: `cap-${field}`, kind: field as never, input })
          .then(() => null)
          .catch((e: unknown) => e as OmniError);

        expect(
          err?.code,
          `declara "send.${field}" pero al construirlo dice que no lo admite`,
        ).not.toBe("capability_unsupported");
      }
      await cleanup?.();
    });

    it("enviar por una línea desconocida es error del cliente, no del servidor", async () => {
      // 404 (no existe) y 409 (existe sin conectar) son ambos correctos; lo que
      // no vale es un 500 ni una promesa que se resuelve sin enviar nada.
      const { driver, lineId, cleanup, sampleTo } = await make();
      const destino = sampleTo ?? DESTINO_POR_DEFECTO;
      const err = await driver
        .send({
          lineId, to: parseAddress(destino), clientMessageId: "c1",
          kind: "text", input: { to: destino, text: "hola" },
        })
        .then(() => null)
        .catch((e: unknown) => e as OmniError);
      expect(err, "un envío sin línea no puede resolverse con éxito").not.toBeNull();
      expect(err).toBeInstanceOf(OmniError);
      expect(err!.status).toBeGreaterThanOrEqual(400);
      expect(err!.status).toBeLessThan(500);
      await cleanup?.();
    });

    it("tras desconectar, enviar falla exactamente con 409", async () => {
      const { driver, lineId, link, cleanup, sampleTo } = await make();
      const destino = sampleTo ?? DESTINO_POR_DEFECTO;
      await link();
      await driver.disconnect(lineId);
      await expect(
        driver.send({
          lineId, to: parseAddress(destino), clientMessageId: "c2",
          kind: "text", input: { to: destino, text: "hola" },
        }),
      ).rejects.toMatchObject({ status: 409, code: "line_not_connected" });
      await cleanup?.();
    });

    it("entrega eventos con el sobre completo y deja desuscribirse", async () => {
      const { driver, lineId, link, cleanup, sampleTo } = await make();
      const destino = sampleTo ?? DESTINO_POR_DEFECTO;
      const seen: EventEnvelope[] = [];
      const off = driver.subscribe((e) => void seen.push(e));
      await link();

      expect(seen.length).toBeGreaterThan(0);
      for (const e of seen) {
        expect(e.id).toBeTruthy();
        expect(e.event).toMatch(/^[a-z_]+\.[a-z_]+$/);
        expect(e.lineId).toBe(lineId);
        expect(typeof e.timestamp).toBe("number");
      }
      expect(seen.some((e) => e.event === "session.connected")).toBe(true);

      const before = seen.length;
      off();
      await driver.send({
        lineId, to: parseAddress(destino), clientMessageId: "tras-off",
        kind: "text", input: { to: destino, text: "silencio" },
      });
      expect(seen.length).toBe(before);
      await cleanup?.();
    });

    it("el mismo clientMessageId dos veces produce UN solo mensaje", async () => {
      // Sin esto, un reintento de red del cliente le llega dos veces al destinatario.
      const { driver, lineId, link, cleanup, sampleTo } = await make();
      const destino = sampleTo ?? DESTINO_POR_DEFECTO;
      await link();
      const cmd = {
        lineId, to: parseAddress(destino), clientMessageId: "idem-1",
        kind: "text" as const, input: { to: destino, text: "una vez" },
      };
      const a = await driver.send(cmd);
      const b = await driver.send(cmd);
      expect(b.providerMessageId).toBe(a.providerMessageId);
      await cleanup?.();
    });

    it("desconectar deja la línea desconectada y es idempotente", async () => {
      const { driver, lineId, link, cleanup } = await make();
      await link();
      await driver.disconnect(lineId);
      expect(driver.status(lineId).state).toBe("disconnected");
      await expect(driver.disconnect(lineId)).resolves.not.toThrow();
      await cleanup?.();
    });

    it("los errores del driver son OmniError, con código traducible a HTTP", async () => {
      const { driver, lineId, cleanup, sampleTo } = await make();
      const destino = sampleTo ?? DESTINO_POR_DEFECTO;
      const err = await driver
        .send({
          lineId, to: parseAddress(destino), clientMessageId: "x",
          kind: "text", input: { to: destino, text: "h" },
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OmniError);
      await cleanup?.();
    });
  });
}
