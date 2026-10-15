import { describe, it, expect } from "vitest";
import { asLineId, parseAddress, type EventEnvelope } from "@omni/shared";
import {
  BaileysDriver, ackToState, descifrarVoto, deterministicMessageId, encuestaDe, esVacio,
  citadoDe, descifrarEdicion, detallesDeMedio, extractMentions, extractSecretEdit, hostDeMedio, HOST_DE_MEDIOS, extractPollVote, extractReply, extractText,
  messageKind, toNewsletterMetadata,
} from "./driver.js";
import { createFakeSocket, type FakeSocketControl } from "./fake-socket.js";
import { generateMessageIDV2 } from "baileys";

const LINE = asLineId("l1");

async function conectado(): Promise<{ driver: BaileysDriver; fake: FakeSocketControl; eventos: EventEnvelope[] }> {
  const fake = createFakeSocket();
  const driver = new BaileysDriver({
    makeSocket: () => fake.socket,
    fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
    linkWaitMs: 0,
    reconnectBaseMs: 10,
  });
  const eventos: EventEnvelope[] = [];
  driver.subscribe((e) => void eventos.push(e));
  await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: { orgId: "org1" } });
  fake.emitConnection({ connection: "open" });
  await new Promise((r) => setTimeout(r, 20));
  return { driver, fake, eventos };
}

describe("acuses de WhatsApp", () => {
  it("traduce cada código a su estado", () => {
    expect(ackToState(1)).toBe("sent");
    expect(ackToState(2)).toBe("delivered");
    expect(ackToState(3)).toBe("read");
    expect(ackToState(4)).toBe("played");
    expect(ackToState(0)).toBe("failed");
  });

  it("un código desconocido no inventa un estado", () => {
    expect(ackToState(99)).toBeNull();
    expect(ackToState(null)).toBeNull();
    expect(ackToState(undefined)).toBeNull();
  });
});

describe("extracción de texto", () => {
  it("lee el texto simple", () => {
    expect(extractText({ conversation: "hola" })).toBe("hola");
  });

  it("lee el texto con formato, que va en otro campo", () => {
    // Asumir sólo `conversation` es el fallo más común al integrar: cualquier
    // mensaje con enlace o con formato llega por `extendedTextMessage`.
    expect(extractText({ extendedTextMessage: { text: "con *formato*" } })).toBe("con *formato*");
  });

  it("lee el pie de una imagen o un vídeo", () => {
    expect(extractText({ imageMessage: { caption: "mira esto" } })).toBe("mira esto");
    expect(extractText({ videoMessage: { caption: "vídeo" } })).toBe("vídeo");
  });

  it("un mensaje sin texto devuelve null, no cadena vacía", () => {
    expect(extractText({ stickerMessage: {} })).toBeNull();
    expect(extractText(null)).toBeNull();
  });

  it("desenvuelve el mensaje efímero, el de una vez y el documento con pie", () => {
    // Sin desenvolver, un PDF con texto o una foto de una sola vez llegaban
    // como «mensaje no compatible»: arriba solo estaba la caja.
    expect(extractText({ ephemeralMessage: { message: { conversation: "efímero" } } }))
      .toBe("efímero");
    expect(extractText({ viewOnceMessageV2: { message: { imageMessage: { caption: "una vez" } } } }))
      .toBe("una vez");
    expect(extractText({
      documentWithCaptionMessage: { message: { documentMessage: { caption: "el informe" } } },
    })).toBe("el informe");
  });

  it("lee el texto de una plantilla de empresa", () => {
    // Las manda cualquier negocio y el texto va varios niveles adentro: se
    // veían como mensajes vacíos.
    expect(extractText({
      templateMessage: { interactiveMessageTemplate: { body: { text: "Hola 👋" } } },
    })).toBe("Hola 👋");
    expect(extractText({
      templateMessage: { hydratedTemplate: { hydratedContentText: "tu pedido llegó" } },
    })).toBe("tu pedido llegó");
  });

  it("lee lo que contestó quien pulsó un botón", () => {
    expect(extractText({ buttonsResponseMessage: { selectedDisplayText: "Sí, continuar" } }))
      .toBe("Sí, continuar");
  });
});

describe("a qué responde un mensaje", () => {
  const cita = (message: unknown) => extractReply({ message } as never);

  it("lee el identificador, el autor y una copia del citado", () => {
    /*
     * WhatsApp manda la cita COMPLETA dentro del mensaje que responde. Es lo
     * que permite enseñarla cuando el original nunca pasó por aquí —de antes
     * de enlazar la línea— y por eso se guarda la copia, no solo el id.
     */
    expect(cita({
      extendedTextMessage: {
        text: "sí, eso",
        contextInfo: {
          stanzaId: "ABC123",
          participant: "51988777666@s.whatsapp.net",
          quotedMessage: { conversation: "¿lo tienes?" },
        },
      },
    })).toEqual({
      id: "ABC123",
      author: "51988777666@s.whatsapp.net",
      kind: "text",
      text: "¿lo tienes?",
    });
  });

  it("el contextInfo NO está arriba: vive dentro del nodo del contenido", () => {
    // Buscarlo en la raíz es el fallo evidente, y deja sin cita a todas las
    // respuestas a una foto o a un audio, que es la mitad de ellas.
    const c = cita({
      imageMessage: {
        caption: "mira",
        contextInfo: { stanzaId: "FOTO1", quotedMessage: { audioMessage: {} } },
      },
    });
    expect(c?.id).toBe("FOTO1");
    expect(c?.kind).toBe("audio");
    // Un audio no tiene texto, y eso NO es una cita vacía: el panel pone su
    // etiqueta. Por eso se devuelve `null` y no cadena vacía.
    expect(c?.text).toBeNull();
  });

  it("también dentro de un envoltorio", () => {
    expect(cita({
      ephemeralMessage: {
        message: {
          extendedTextMessage: {
            text: "ya va",
            contextInfo: { stanzaId: "EFI1", quotedMessage: { conversation: "¿y eso?" } },
          },
        },
      },
    })?.id).toBe("EFI1");
  });

  it("un mensaje que no responde a nada devuelve null", () => {
    expect(cita({ conversation: "hola" })).toBeNull();
    // Un `contextInfo` sin `stanzaId` no es una cita: lo llevan los mensajes
    // reenviados y los que mencionan a alguien.
    expect(cita({
      extendedTextMessage: { text: "@alguien", contextInfo: { mentionedJid: ["x@lid"] } },
    })).toBeNull();
    expect(cita(null)).toBeNull();
  });
});

describe("encuestas", () => {
  it("lee la pregunta, las opciones y el secreto que abre los votos", () => {
    const e = encuestaDe({
      message: {
        pollCreationMessageV3: {
          name: "¿Qué día?",
          options: [{ optionName: "Martes 20" }, { optionName: "Martes 27" }],
          selectableOptionsCount: 1,
        },
        messageContextInfo: { messageSecret: new Uint8Array(32).fill(7) },
      },
    } as never);
    expect(e?.question).toBe("¿Qué día?");
    expect(e?.options).toEqual(["Martes 20", "Martes 27"]);
    expect(e?.secret).toBe(Buffer.alloc(32, 7).toString("base64"));
    expect(e?.multiple).toBe(false);
  });

  it("cero opciones seleccionables significa VARIAS, no ninguna", () => {
    /*
     * Es lo que WhatsApp pone en una encuesta de opción múltiple. Leerlo como
     * «ninguna» enseñaría «una respuesta» justo donde se pueden marcar varias.
     */
    const e = encuestaDe({
      message: {
        pollCreationMessage: {
          name: "¿Qué prefieres?",
          options: [{ optionName: "A" }, { optionName: "B" }],
          selectableOptionsCount: 0,
        },
      },
    } as never);
    expect(e?.multiple).toBe(true);
  });

  it("un voto NO es un mensaje: sale por su propio camino", () => {
    /*
     * Es lo que llenó un grupo real de 143 burbujas de «mensaje no
     * compatible»: una encuesta y todo el equipo votando.
     */
    const v = extractPollVote({
      key: { id: "VOTO1", remoteJid: "120@g.us", participant: "51988777666@s.whatsapp.net" },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: {
            id: "ENCUESTA1", fromMe: false, remoteJid: "120@g.us",
            participant: "51900111222@s.whatsapp.net",
          },
          vote: { encPayload: new Uint8Array([1, 2, 3]), encIv: new Uint8Array([4, 5]) },
          senderTimestampMs: 1700000000000,
        },
      },
    } as never);
    expect(v?.poll.id).toBe("ENCUESTA1");
    // Las DOS direcciones: la clave de descifrado se deriva de ambas, y
    // confundirlas no da un error, da un voto que no abre.
    expect(v?.poll.author).toBe("51900111222@s.whatsapp.net");
    expect(v?.voter).toBe("51988777666@s.whatsapp.net");
    expect(v?.at).toBe(1700000000000);
  });

  it("un mensaje normal no es un voto", () => {
    expect(extractPollVote({ key: { id: "X" }, message: { conversation: "hola" } } as never))
      .toBeNull();
  });

  it("lee el secreto Y la copia releída de la base, que ya no son bytes", () => {
    /*
     * Esta prueba existe por un fallo real y caro.
     *
     * El nodo original se guarda tal cual, y al releerlo de JSON los bytes ya
     * son una cadena en base64. Codificarla otra vez daba una clave distinta y
     * un voto que no abría —sin ningún error que lo dijera—, y el motor lee el
     * secreto justamente de ahí.
     */
    const secreto = Buffer.alloc(32, 7).toString("base64");
    const releida = encuestaDe({
      message: {
        pollCreationMessageV3: { name: "¿Qué día?", options: [{ optionName: "A" }] },
        messageContextInfo: { messageSecret: secreto },
      },
    } as never);
    expect(releida?.secret).toBe(secreto);

    const voto = extractPollVote({
      key: { id: "V", remoteJid: "120@g.us", participant: "51988777666@s.whatsapp.net" },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { id: "E", participant: "51900111222@s.whatsapp.net" },
          vote: { encPayload: "AQID", encIv: "BAU=" },
        },
      },
    } as never);
    expect(voto?.vote.encPayload).toBe("AQID");
    expect(voto?.vote.encIv).toBe("BAU=");
  });

  it("descifrar un voto devuelve las opciones que se marcaron", async () => {
    /*
     * Ida y vuelta con el cifrado REAL de WhatsApp: se construye el voto con
     * las mismas primitivas que usa el teléfono y se comprueba que vuelve.
     * Una prueba contra un doble no diría nada: lo que falla aquí es la
     * derivación de la clave, y eso solo se ve cifrando de verdad.
     */
    const { createHash, createCipheriv, createHmac } = await import("node:crypto");
    const { proto } = await import("baileys");

    const pollId = "ENCUESTA1";
    const autor = "51900111222@s.whatsapp.net";
    const votante = "51988777666@s.whatsapp.net";
    const secreto = Buffer.alloc(32, 9);
    const opciones = ["Martes 20", "Martes 27", "Sede san Isidro"];
    const elegida = "Martes 27";

    const firma = Buffer.concat([
      Buffer.from(pollId), Buffer.from(autor), Buffer.from(votante),
      Buffer.from("Poll Vote"), Buffer.from([1]),
    ]);
    const key0 = createHmac("sha256", Buffer.alloc(32)).update(secreto).digest();
    const clave = createHmac("sha256", key0).update(firma).digest();

    const payload = proto.Message.PollVoteMessage.encode({
      selectedOptions: [createHash("sha256").update(elegida).digest()],
    }).finish();

    const iv = Buffer.alloc(12, 3);
    const cifrador = createCipheriv("aes-256-gcm", clave, iv);
    cifrador.setAAD(Buffer.from(`${pollId} ${votante}`));
    const cuerpo = Buffer.concat([
      cifrador.update(payload), cifrador.final(), cifrador.getAuthTag(),
    ]);

    /*
     * El voto y la encuesta pasan por JSON antes de abrirse, que es por donde
     * pasan de verdad: el motor los lee de la base. Si el ida y vuelta solo se
     * probara con los bytes en memoria, el fallo del doble codificado no
     * saldría aquí nunca.
     */
    const nodoEncuesta = JSON.parse(JSON.stringify({
      message: {
        pollCreationMessageV3: {
          name: "¿Qué día?", options: opciones.map((o) => ({ optionName: o })),
        },
        messageContextInfo: { messageSecret: secreto.toString("base64") },
      },
    }));
    const nodoVoto = JSON.parse(JSON.stringify({
      key: { id: "V", remoteJid: "120@g.us", participant: votante },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: { id: pollId, participant: autor },
          vote: { encPayload: cuerpo.toString("base64"), encIv: iv.toString("base64") },
        },
      },
    }));

    const e = encuestaDe(nodoEncuesta as never)!;
    const v = extractPollVote(nodoVoto as never)!;
    expect(descifrarVoto(
      v.vote,
      { pollId: v.poll.id, pollAuthor: v.poll.author, voter: v.voter, secret: e.secret! },
      e.options,
    )).toEqual([elegida]);
  });
});

describe("sobres vacíos", () => {
  it("un sobre que solo lleva datos de cifrado o de contexto no es un mensaje", () => {
    /*
     * Son la mitad de los que aparecían en el hilo como «mensaje no
     * compatible». No ha pasado nada que contar: ni se publican.
     */
    const v = (message: unknown) => esVacio({ message } as never);
    expect(v({ messageContextInfo: {} })).toBe(true);
    expect(v({ senderKeyDistributionMessage: {} })).toBe(true);
    expect(v({ messageContextInfo: {}, senderKeyDistributionMessage: {} })).toBe(true);
    expect(v(null)).toBe(true);
    // La cabecera de un álbum y el registro de una llamada tampoco: lo que
    // cuentan llega por su lado —las fotos sueltas, el evento de llamada—.
    expect(v({ albumMessage: { expectedImageCount: 3 } })).toBe(true);
    expect(v({ call: { callKey: "x" } })).toBe(true);
  });

  it("pero uno con contenido al lado de esos datos sí lo es", () => {
    const v = (message: unknown) => esVacio({ message } as never);
    expect(v({ messageContextInfo: {}, conversation: "hola" })).toBe(false);
    expect(v({ ephemeralMessage: { message: { conversation: "hola" } } })).toBe(false);
  });
});

describe("tipo de mensaje", () => {
  it("reconoce los tipos habituales", () => {
    const k = (message: unknown) => messageKind({ message } as never);
    expect(k({ conversation: "x" })).toBe("text");
    expect(k({ extendedTextMessage: { text: "x" } })).toBe("text");
    expect(k({ imageMessage: {} })).toBe("image");
    expect(k({ audioMessage: {} })).toBe("audio");
    expect(k({ pollCreationMessageV3: {} })).toBe("poll");
    expect(k({ protocolMessage: {} })).toBe("system");
    expect(k(null)).toBe("unknown");
    expect(k({ algoNuevo: {} })).toBe("unknown");
  });

  it("clasifica lo que manda una empresa, en vez de darlo por ilegible", () => {
    const k = (message: unknown) => messageKind({ message } as never);
    expect(k({ templateMessage: {} })).toBe("template");
    expect(k({ interactiveMessage: {} })).toBe("template");
    expect(k({ buttonsMessage: {} })).toBe("buttons");
    expect(k({ listMessage: {} })).toBe("list");
    // Pulsar un botón es contestar: para el hilo, eso es texto.
    expect(k({ buttonsResponseMessage: {} })).toBe("text");
  });

  it("mira DENTRO del envoltorio, no la caja", () => {
    const k = (message: unknown) => messageKind({ message } as never);
    expect(k({ viewOnceMessageV2: { message: { imageMessage: {} } } })).toBe("image");
    expect(k({ documentWithCaptionMessage: { message: { documentMessage: {} } } }))
      .toBe("document");
    expect(k({ ephemeralMessage: { message: { audioMessage: {} } } })).toBe("audio");
  });
});

describe("identificador derivado", () => {
  it("la misma orden produce siempre el mismo identificador", () => {
    expect(deterministicMessageId("pedido-42")).toBe(deterministicMessageId("pedido-42"));
    expect(deterministicMessageId("pedido-42")).not.toBe(deterministicMessageId("pedido-43"));
  });

  it("tiene la MISMA forma que el que genera Baileys", () => {
    /*
     * Se compara contra el generador DE BAILEYS, no contra una longitud
     * escrita aquí a mano.
     *
     * La versión anterior de esta prueba afirmaba 28 dígitos hexadecimales
     * porque es lo que ponía el código, y el código estaba mal: Baileys usa
     * 18. Con la longitud equivocada el servidor de WhatsApp acepta el envío,
     * devuelve identificador y hasta manda acuses de lectura, y el mensaje no
     * aparece en NINGÚN cliente —ni en el teléfono de quien lo envía—. Una
     * prueba que repite lo que dice el código no comprueba nada.
     */
    const nuestro = deterministicMessageId("x");
    const deBaileys = generateMessageIDV2("51999888777@s.whatsapp.net");

    expect(nuestro).toHaveLength(deBaileys.length);
    expect(nuestro).toMatch(/^3EB0[0-9A-F]+$/);
    expect(deBaileys).toMatch(/^3EB0[0-9A-F]+$/);
  });
});

describe("driver de Baileys: conexión", () => {
  it("emite el QR y no se da por conectado hasta que abre", async () => {
    const fake = createFakeSocket();
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });

    fake.emitConnection({ qr: "QR-DE-PRUEBA" });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("awaiting-link");
    expect(eventos.some((e) => e.event === "session.qr")).toBe(true);

    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.status(LINE).state).toBe("connected");
  });

  it("ante una desvinculación NO reintenta: las credenciales ya no valen", async () => {
    const fake = createFakeSocket();
    let sockets = 0;
    const driver = new BaileysDriver({
      makeSocket: () => { sockets++; return fake.socket; },
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
    linkWaitMs: 0,
      reconnectBaseMs: 5,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });

    const boom = Object.assign(new Error("logged out"), { output: { statusCode: 401 } });
    fake.emitConnection({ connection: "close", lastDisconnect: { error: boom as Error } });
    await new Promise((r) => setTimeout(r, 60));

    expect(driver.status(LINE).state).toBe("logged-out");
    expect(eventos.some((e) => e.event === "session.logged_out")).toBe(true);
    expect(sockets, "reintentó pese a estar desvinculado").toBe(1);
  });

  it("ante una caída normal sí reintenta, con retardo creciente", async () => {
    const fake = createFakeSocket();
    let sockets = 0;
    const driver = new BaileysDriver({
      makeSocket: () => { sockets++; return fake.socket; },
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
    linkWaitMs: 0,
      reconnectBaseMs: 5, maxReconnectAttempts: 2,
    });
    await driver.connect({ lineId: LINE, credentials: null, saveCredentials: async () => {}, config: {} });
    const boom = Object.assign(new Error("caída"), { output: { statusCode: 500 } });
    fake.emitConnection({ connection: "close", lastDisconnect: { error: boom as Error } });
    await new Promise((r) => setTimeout(r, 80));
    expect(sockets).toBeGreaterThan(1);
  });
});

describe("driver de Baileys: ingesta", () => {
  it("un mensaje entrante sale como message.received con su texto y tipo", async () => {
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "ABC", remoteJid: "51988777666@s.whatsapp.net", fromMe: false },
        message: { extendedTextMessage: { text: "hola con formato" } },
        pushName: "Ada", messageTimestamp: 1_800_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const recibido = eventos.find((e) => e.event === "message.received")!;
    const data = recibido.data as { text: string; kind: string; pushName: string };
    expect(data.text).toBe("hola con formato");
    expect(data.kind).toBe("text");
    expect(data.pushName).toBe("Ada");
  });

  it("un mensaje propio sale como message.sent, no como recibido", async () => {
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{ key: { id: "X", remoteJid: "51988777666@s.whatsapp.net", fromMe: true }, message: { conversation: "mío" } }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "message.sent")).toBe(true);
    expect(eventos.some((e) => e.event === "message.received")).toBe(false);
  });

  it("ignora los mensajes que no son notificaciones nuevas", async () => {
    // `append` es historial que llega al sincronizar: tratarlo como entrante
    // dispararía respuestas automáticas a conversaciones de hace meses.
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.upsert", {
      type: "append",
      messages: [{ key: { id: "VIEJO", remoteJid: "x@s.whatsapp.net", fromMe: false }, message: { conversation: "antiguo" } }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "message.received")).toBe(false);
  });

  it("traduce los acuses a recibos", async () => {
    const { fake, eventos } = await conectado();
    fake.emitRaw("messages.update", [
      { key: { id: "ABC", remoteJid: "x@s.whatsapp.net", fromMe: true }, update: { status: 3 } },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const recibo = eventos.find((e) => e.event === "message.receipt")!;
    expect((recibo.data as { state: string }).state).toBe("read");
  });

  it("una llamada entrante se publica y se puede rechazar", async () => {
    const { driver, fake, eventos } = await conectado();
    fake.emitRaw("call", [{ id: "CALL1", from: "51988777666@s.whatsapp.net", status: "offer" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(eventos.some((e) => e.event === "call.received")).toBe(true);
    await expect(driver.rejectCall(LINE, "CALL1", { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" }))
      .resolves.not.toThrow();
  });
});

describe("driver de Baileys: acciones", () => {
  it("el retardo de escritura anuncia y luego pausa", async () => {
    const { driver, fake } = await conectado();
    await driver.send({
      lineId: LINE, to: { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
      clientMessageId: "t1", kind: "text",
      input: { to: "51988777666", text: "hola", typingMs: 10 },
    });
    expect(fake.presence.map((p) => p.presence)).toEqual(["composing", "paused"]);
  });

  it("comprueba si un número existe", async () => {
    const { driver } = await conectado();
    const si = await driver.checkContact(LINE, { kind: "pn", local: "51999000111", value: "51999000111@s.whatsapp.net" });
    expect(si.exists).toBe(true);
    const no = await driver.checkContact(LINE, { kind: "pn", local: "10000000", value: "10000000@s.whatsapp.net" });
    expect(no.exists).toBe(false);
  });

  it("informa por participante al gestionar un grupo", async () => {
    const { driver } = await conectado();
    const res = await driver.updateParticipants(
      LINE, { kind: "group", local: "120", value: "120@g.us" },
      [
        { kind: "pn", local: "51988777666", value: "51988777666@s.whatsapp.net" },
        { kind: "pn", local: "51900000000", value: "51900000000@s.whatsapp.net" },
      ],
      "add",
    );
    expect(res[0]!.ok).toBe(true);
    expect(res[1]!.ok).toBe(false);
    expect(res[1]!.reason).toContain("403");
  });

  it("lee los datos de un grupo con sus roles", async () => {
    const { driver } = await conectado();
    const meta = await driver.groupMetadata(LINE, { kind: "group", local: "120", value: "120@g.us" });
    expect(meta.subject).toBe("Grupo falso");
    expect(meta.participants[0]!.role).toBe("superadmin");
    expect(meta.participants[1]!.role).toBe("member");
  });
});

describe("capacidades declaradas", () => {
  it("NO declara lo que el núcleo oficial no sabe hacer", async () => {
    // Declararlas haría que la API aceptara peticiones que no llegan a ninguna
    // parte. Es preferible un 422 honesto.
    const { driver } = await conectado();
    expect(driver.descriptor.capabilities.has("send.buttons")).toBe(false);
    expect(driver.descriptor.capabilities.has("send.list")).toBe(false);
    expect(driver.descriptor.capabilities.has("label.manage")).toBe(false);
  });

  it("se declara como transporte NO oficial", () => {
    const driver = new BaileysDriver();
    expect(driver.descriptor.risk).toBe("unofficial");
  });
});

describe("reintentos que pide el destinatario", () => {
  it("conserva lo enviado para poder servir el reintento", async () => {
    /*
     * Cuando un dispositivo no consigue descifrar un mensaje pide un
     * REINTENTO, y Baileys nos lo reclama por `getMessage`. Devolver
     * `undefined` —lo que se hacía— significa «no lo tengo»: ese dispositivo
     * se queda sin el mensaje y no hay ningún error por nuestra parte.
     */
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    let opciones: Record<string, unknown> = {};
    const driver = new BaileysDriver({
      makeSocket: (o) => { opciones = o as Record<string, unknown>; return fake.socket; },
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      // Sin espera: el enlace lo simula `emitConnection` justo después.
      linkWaitMs: 0,
    });
    const line = asLineId("l-retry");
    await driver.connect({
      lineId: line, credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    const receipt = await driver.send({
      lineId: line, to: parseAddress("51988777666"), clientMessageId: "r-1",
      kind: "text", input: { to: "51988777666", text: "hola" },
    });

    const getMessage = opciones["getMessage"] as (k: { id: string }) => Promise<unknown>;
    expect(typeof getMessage).toBe("function");
    expect(await getMessage({ id: receipt.providerMessageId })).toBeDefined();
    // Y de uno que no es nuestro, no se inventa nada.
    expect(await getMessage({ id: "NO-ES-NUESTRO" })).toBeUndefined();
  });
});

describe("reconocer el mensaje propio cuando vuelve", () => {
  it("el eco y el acuse llevan el identificador que pusimos nosotros", async () => {
    /*
     * WhatsApp devuelve SU identificador, y lo que vuelve por los eventos solo
     * lleva ese. Sin este puente, quien envió no reconoce su propio mensaje al
     * volver: el panel dejaba las notas de voz en «queued» para siempre,
     * porque emparejaba por el texto y un audio no tiene.
     */
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    const line = asLineId("l-eco");
    await driver.connect({
      lineId: line, credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    const receipt = await driver.send({
      lineId: line, to: parseAddress("51988777666"), clientMessageId: "mio-1",
      kind: "audio", input: { to: "51988777666", audio: { url: "https://x.test/a.ogg" }, ptt: true },
      // El motor resuelve los bytes antes de llegar al driver.
      media: { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" },
    });

    // El eco que manda WhatsApp de nuestro propio mensaje.
    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: receipt.providerMessageId, remoteJid: "51988777666@s.whatsapp.net", fromMe: true },
        message: { audioMessage: {} }, messageTimestamp: 1_800_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const eco = eventos.find((e) => e.event === "message.sent");
    expect(eco).toBeDefined();
    expect((eco!.data as { clientMessageId?: string }).clientMessageId).toBe("mio-1");

    // Y el acuse, que es lo que saca el mensaje de «queued».
    fake.emitRaw("message-receipt.update", [{
      key: { id: receipt.providerMessageId, remoteJid: "51988777666@s.whatsapp.net", fromMe: true },
      receipt: { readTimestamp: 1_800_000_050 },
    }]);
    await new Promise((r) => setTimeout(r, 20));

    const acuse = eventos.find((e) => e.event === "message.receipt");
    expect((acuse!.data as { clientMessageId?: string }).clientMessageId).toBe("mio-1");
  });

  it("de un mensaje AJENO no se inventa un identificador propio", async () => {
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({
      lineId: asLineId("l-ajeno"), credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{
        key: { id: "AJENO1", remoteJid: "51988777666@s.whatsapp.net", fromMe: false },
        message: { conversation: "hola" }, messageTimestamp: 1_800_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const recibido = eventos.find((e) => e.event === "message.received")!;
    expect((recibido.data as { clientMessageId?: string }).clientMessageId).toBeUndefined();
  });
});

describe("lo escrito desde otro dispositivo", () => {
  it("un mensaje propio con type `append` SÍ se ingiere", async () => {
    /*
     * Es lo que uno escribe desde el teléfono con el panel abierto: para el
     * servidor no es una notificación, es un mensaje que se añade a una
     * conversación que ya tienes. Descartarlo dejaba el panel sin la mitad de
     * la conversación, y se descartaba.
     */
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({
      lineId: asLineId("l-append"), credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    fake.emitRaw("messages.upsert", {
      type: "append",
      messages: [{
        key: { id: "DESDE-EL-MOVIL", remoteJid: "51988777666@s.whatsapp.net", fromMe: true },
        message: { conversation: "escrito desde el teléfono" },
        messageTimestamp: 1_800_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    const enviado = eventos.find((e) => e.event === "message.sent");
    expect(enviado).toBeDefined();
    expect((enviado!.data as { text: string }).text).toBe("escrito desde el teléfono");
  });

  it("pero un mensaje AJENO con `append` no: es relleno de historial", async () => {
    /*
     * WhatsApp usa ese tipo también para rellenar huecos. Tragarlo entero
     * reingeriría conversaciones viejas como si acabaran de llegar: subirían
     * en la lista y se marcarían sin leer.
     */
    const fake = createFakeSocket({ id: "51999888777:1@s.whatsapp.net" });
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });
    const eventos: EventEnvelope[] = [];
    driver.subscribe((e) => void eventos.push(e));
    await driver.connect({
      lineId: asLineId("l-append-2"), credentials: null, saveCredentials: async () => {},
      config: { orgId: "org1" },
    });
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 10));

    fake.emitRaw("messages.upsert", {
      type: "append",
      messages: [{
        key: { id: "VIEJO", remoteJid: "51988777666@s.whatsapp.net", fromMe: false },
        message: { conversation: "de hace meses" },
        messageTimestamp: 1_700_000_000,
      }],
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(eventos.some((e) => e.event === "message.received")).toBe(false);
  });
});

describe("metadatos de un canal", () => {
  it("lee la respuesta CRUDA que da Baileys al consultar un canal existente", () => {
    /*
     * Es la forma real de `newsletterMetadata`, copiada de lo que devuelve el
     * servidor. Solo se leía la forma plana —la de CREAR un canal— y todo
     * canal existente salía con el nombre vacío.
     */
    const m = toNewsletterMetadata({
      id: "120363233417321714@newsletter",
      thread_metadata: {
        name: { text: "Noticias del barrio" },
        description: { text: "Lo que pasa cerca" },
        invite: "0029VaAbCd",
        subscribers_count: "1532",
        verification: "VERIFIED",
        creation_time: "1700000000",
      },
      viewer_metadata: { role: "SUBSCRIBER" },
    } as never);
    expect(m.name).toBe("Noticias del barrio");
    expect(m.description).toBe("Lo que pasa cerca");
    expect(m.inviteCode).toBe("0029VaAbCd");
    expect(m.subscribers).toBe(1532);
    expect(m.verified).toBe(true);
    expect(m.role).toBe("subscriber");
    expect(m.createdAt).toBe(1700000000 * 1000);
  });

  it("y sigue leyendo la plana, la de crear un canal", () => {
    const m = toNewsletterMetadata({
      id: "1@newsletter", name: "Nuevo", subscribers: 0, creation_time: 1700000000,
    });
    expect(m.name).toBe("Nuevo");
    expect(m.subscribers).toBe(0);
  });

  it("acepta el nombre como cadena, que es lo que dicen los tipos de Baileys", () => {
    expect(toNewsletterMetadata({
      id: "2@newsletter", thread_metadata: { name: "Como cadena" },
    } as never).name).toBe("Como cadena");
  });
});

describe("a quién menciona un mensaje", () => {
  const de = (message: unknown) => extractMentions({ message } as never);

  it("lee las direcciones mencionadas del nodo del contenido", () => {
    /*
     * El texto solo trae `@120238196658384`; quién es ese número viene aquí.
     * Nunca se había leído: 110 mensajes con menciones y ninguna guardada.
     */
    expect(de({
      extendedTextMessage: {
        text: "@120238196658384 porfa",
        contextInfo: { mentionedJid: ["120238196658384@lid"] },
      },
    })).toEqual(["120238196658384@lid"]);
  });

  it("también en el pie de una foto y dentro de un envoltorio", () => {
    expect(de({
      ephemeralMessage: {
        message: {
          imageMessage: {
            caption: "mira @51952631806",
            contextInfo: { mentionedJid: ["51952631806@s.whatsapp.net"] },
          },
        },
      },
    })).toEqual(["51952631806@s.whatsapp.net"]);
  });

  it("sin menciones, lista vacía; y no repite ni acepta basura", () => {
    expect(de({ conversation: "hola" })).toEqual([]);
    expect(de({
      extendedTextMessage: {
        text: "x", contextInfo: { mentionedJid: ["1@lid", "1@lid", 42, "sin-arroba"] },
      },
    })).toEqual(["1@lid"]);
  });
});

describe("lo que hace falta para citar un fichero", () => {
  it("un audio: duración, sin imagen", () => {
    expect(detallesDeMedio({ audioMessage: { seconds: 15, ptt: false, mimetype: "audio/ogg" } }))
      .toEqual({ thumb: null, seconds: 15, ptt: false, fileName: null });
  });

  it("una nota de voz se distingue de un fichero de audio", () => {
    expect(detallesDeMedio({ audioMessage: { seconds: 4, ptt: true } }).ptt).toBe(true);
  });

  it("una foto trae su miniatura, en bytes o ya en base64 al releerla", () => {
    expect(detallesDeMedio({ imageMessage: { jpegThumbnail: new Uint8Array([1, 2, 3]) } }).thumb)
      .toBe("AQID");
    expect(detallesDeMedio({ imageMessage: { jpegThumbnail: "AQID" } }).thumb).toBe("AQID");
  });

  it("un documento, su nombre; y dentro de un envoltorio también", () => {
    expect(detallesDeMedio({
      documentWithCaptionMessage: { message: { documentMessage: { fileName: "Constancia.pdf" } } },
    }).fileName).toBe("Constancia.pdf");
  });

  it("la copia del citado que viaja dentro de la respuesta", () => {
    const citado = citadoDe({
      extendedTextMessage: {
        text: "XDDDD",
        contextInfo: { stanzaId: "A", quotedMessage: { audioMessage: { seconds: 15 } } },
      },
    });
    expect(detallesDeMedio(citado).seconds).toBe(15);
  });
});

describe("de qué servidor bajar un fichero", () => {
  it("un servidor de relleno sin ruta NO se usa: es lo que dejaba 106 stickers sin bajar", () => {
    expect(hostDeMedio("https://a.whatsapp.net")).toBe(HOST_DE_MEDIOS);
    expect(hostDeMedio("https://a.whatsapp.net/")).toBe(HOST_DE_MEDIOS);
  });

  it("una URL completa de WhatsApp sí, con su servidor", () => {
    expect(hostDeMedio("https://mmg.whatsapp.net/v/t62.15575-24/1_n.enc?ccb=11-4"))
      .toBe("mmg.whatsapp.net");
    expect(hostDeMedio("https://media-lim1-1.cdn.whatsapp.net/v/t62/1_n.enc"))
      .toBe("media-lim1-1.cdn.whatsapp.net");
  });

  it("nada que no sea de WhatsApp, ni sin https, ni basura", () => {
    expect(hostDeMedio("https://evil.example/v/t62/1_n.enc")).toBe(HOST_DE_MEDIOS);
    expect(hostDeMedio("https://whatsapp.net.evil.example/v/1")).toBe(HOST_DE_MEDIOS);
    expect(hostDeMedio("http://mmg.whatsapp.net/v/1")).toBe(HOST_DE_MEDIOS);
    expect(hostDeMedio("no es una url")).toBe(HOST_DE_MEDIOS);
    expect(hostDeMedio(null)).toBe(HOST_DE_MEDIOS);
  });
});

describe("ediciones cifradas", () => {
  /*
   * Una edición REAL, sacada de un grupo, con el secreto de su mensaje
   * original. La receta se dedujo de 50 ediciones reales: si cambiara, esta
   * prueba es la que lo diría —el GCM no abre con una clave casi buena—.
   */
  const REAL = {"id": "3EB01DDC7B8BD21BAACE51", "author": "13061666689054@lid", "secret": "lGoYh9lNLOd82l33ZR+b2CCCHrbrMqqePxigZIgBTPQ=", "encPayload": "KlRxAT2oYUrX1GWa7iyw/Akw46K2T5jNttsqu7FxbH1DGS8qHGfMv9aM1J2n1MHxYHd1dCbI1YAhZ/UMbrpCnNdIK29HERjvAG3hfegllrXjegm76N5SpUm/ViiRiwauZgEbgiH+n/9btHyhQV8+jbN9uphCD5p3wpnITmS3Ice1TtsO8MLc3aKzD3pw71EHPNB+UqbnRYCZLDsL490b9Z12Yn9DBJaCNvo=", "encIv": "ZkRYE4iWgYoXkLhh"};

  it("abre la edición y devuelve el texto nuevo", () => {
    const r = descifrarEdicion(
      { encPayload: REAL.encPayload, encIv: REAL.encIv },
      { messageId: REAL.id, author: REAL.author, secret: REAL.secret },
    );
    expect(r.text).toBe("ya tuvimos un vecino regidor q al mes presumia su camioneta");
    // La fecha de la edición, como número de verdad: venía como `Long` de
    // protobuf y salía NaN, que hacía fallar el guardado de toda edición real.
    expect(Number.isFinite(r.editedAt)).toBe(true);
    expect(r.editedAt).toBeGreaterThan(1_700_000_000_000);
  });

  it("con otra dirección no abre: lanza, no inventa", () => {
    expect(() => descifrarEdicion(
      { encPayload: REAL.encPayload, encIv: REAL.encIv },
      { messageId: REAL.id, author: "51900000000@s.whatsapp.net", secret: REAL.secret },
    )).toThrow();
  });

  it("una edición no es un mensaje: sale como cambio del original", () => {
    const e = extractSecretEdit({
      key: { id: "EDIT1", remoteJid: "120@g.us", participant: REAL.author, fromMe: false },
      messageTimestamp: 1700000000,
      message: {
        messageContextInfo: {},
        secretEncryptedMessage: {
          targetMessageKey: { id: REAL.id, fromMe: true, remoteJid: "120@g.us" },
          encPayload: REAL.encPayload, encIv: REAL.encIv, secretEncType: "MESSAGE_EDIT",
        },
      },
    } as never);
    expect(e?.key).toMatchObject({ id: REAL.id, remoteJid: "120@g.us" });
    expect(e?.author).toBe(REAL.author);
    expect(e?.cifrado.tipo).toBe("MESSAGE_EDIT");
  });

  it("la dirección del sobre TAL CUAL va primero, aunque traiga el teléfono", () => {
    // Con el teléfono primero —lo que hace `getKeyAuthor`— 23 de 50 ediciones
    // reales no abrían.
    const e = extractSecretEdit({
      key: { id: "E", remoteJid: "120@g.us", participant: "43276124028961@lid",
        participantAlt: "51926611850@s.whatsapp.net", fromMe: false },
      message: { secretEncryptedMessage: {
        targetMessageKey: { id: "O" }, encPayload: "AA==", encIv: "AA==", secretEncType: 2,
      } },
    } as never);
    expect(e?.author).toBe("43276124028961@lid");
    expect(e?.alternativas).toContain("51926611850@s.whatsapp.net");
  });

  it("lo editado desde el propio teléfono: nuestro participante, sin dispositivo", () => {
    const e = extractSecretEdit({
      key: { id: "E", remoteJid: "120@g.us", participant: "137237811437725@lid", fromMe: true },
      message: { secretEncryptedMessage: {
        targetMessageKey: { id: "O", fromMe: true }, encPayload: "AA==", encIv: "AA==",
        secretEncType: "MESSAGE_EDIT",
      } },
    } as never, "51936854713:25@s.whatsapp.net");
    expect(e?.author).toBe("137237811437725@lid");
    expect(e?.alternativas).toContain("51936854713@s.whatsapp.net");
  });

  it("un mensaje normal no es una edición", () => {
    expect(extractSecretEdit({ key: { id: "X", remoteJid: "a@lid" }, message: { conversation: "hola" } } as never))
      .toBeNull();
  });

  it("fijar un mensaje y compartir el historial son avisos con su texto", () => {
    const k = (message: unknown) => messageKind({ message } as never);
    expect(k({ pinInChatMessage: { type: "PIN_FOR_ALL" } })).toBe("notice");
    expect(extractText({ pinInChatMessage: { type: "PIN_FOR_ALL" } })).toBe("fijó un mensaje");
    expect(extractText({ pinInChatMessage: { type: 2 } })).toBe("dejó de fijar un mensaje");
    expect(k({ messageHistoryNotice: {} })).toBe("notice");
    expect(esVacio({ message: { messageContextInfo: {}, messageHistoryBundle: {} } } as never)).toBe(true);
  });
});

describe("reenviar", () => {
  it("abre el sobre guardado y reenvía el mensaje de Baileys que va dentro", async () => {
    const { driver, fake } = await conectado();
    // Así está en `message.raw`: el sobre del evento, con el mensaje dentro.
    const original = {
      key: { remoteJid: "51988777666@s.whatsapp.net", fromMe: false, id: "ORIG1" },
      message: { conversation: "el catálogo" },
    };
    await driver.forwardMessage(
      LINE,
      {
        chat: parseAddress("51988777666@s.whatsapp.net"), providerMessageId: "ORIG1",
        raw: { key: original.key, kind: "text", text: "el catálogo", raw: original },
      },
      parseAddress("51977666555@s.whatsapp.net"),
    );
    const ultimo = fake.sent.at(-1)!;
    expect(ultimo.jid).toBe("51977666555@s.whatsapp.net");
    expect((ultimo.content as { forward: unknown }).forward).toEqual(original);
  });

  it("sin el original lo dice, y nombra quién sí sabe reenviarlo", async () => {
    const { driver } = await conectado();
    await expect(driver.forwardMessage(
      LINE,
      { chat: parseAddress("51988777666@s.whatsapp.net"), providerMessageId: "MIO1" },
      parseAddress("51977666555@s.whatsapp.net"),
    )).rejects.toThrow(/whatsapp\.web/);
  });
});
