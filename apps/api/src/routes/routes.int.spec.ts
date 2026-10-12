import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseAddress } from "@omni/shared";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey, secretoDe } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-rutas";
const LINE = "line-rutas";
const CHAT = "51988777666@s.whatsapp.net";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let adminKey: string;
let scopedKey: string;

const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** Ruta de ffmpeg para las pruebas. Instalado en el directorio del usuario. */
const FFMPEG = process.env["OMNI_FFMPEG"] ?? `${process.env["HOME"]}/.local/bin/ffmpeg`;

/** Fabrica un fichero de medio con ffmpeg, para no meter binarios en el repo. */
async function conFfmpeg(args: string[], nombre: string): Promise<Uint8Array> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "omni-fix-"));
  try {
    const destino = join(dir, nombre);
    await promisify(execFile)(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args, destino]);
    return new Uint8Array(await readFile(destino));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const t of ["message", "chat", "auth_state", "group_participant", "group_info", "contact"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM audit_event WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.sql`DELETE FROM omni_kv WHERE key LIKE ${'idem:' + LINE + ':%'}`.catch(() => {});
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Rutas", slug: "rutas" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });

  const a = await mintApiKey();
  adminKey = a.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-rutas-admin", orgId: ORG, name: "admin", prefix: a.prefix, secretHash: a.secretHash, role: "admin",
  });
  const s = await mintApiKey();
  scopedKey = s.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-rutas-chat", orgId: ORG, name: "agente", prefix: s.prefix, secretHash: s.secretHash,
    role: "operator", allowedLines: [LINE], allowedChats: [CHAT],
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "b".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-rutas",
      // Con ffmpeg de verdad: lo que graba un navegador se convierte aquí, y
      // probarlo con un doble no diría nada.
      FFMPEG_PATH: FFMPEG,
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);

  await call(`/v1/lines/${LINE}/connect`, { method: "POST" });
  await call(`/v1/sandbox/lines/${LINE}/scan`, { method: "POST", body: JSON.stringify({ phone: "51999888777" }) });
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

async function call(path: string, init: RequestInit = {}, key = adminKey): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
  });
}

const enc = encodeURIComponent;

run("rutas de mensajes y chats", () => {
  let providerId: string;

  it("envía y luego edita el mensaje", async () => {
    const sent = await j<{ data: { clientMessageId: string } }>(
      await call(`/v1/lines/${LINE}/messages`, {
        method: "POST", body: JSON.stringify({ to: CHAT, text: "original", clientMessageId: "r-1" }),
      }),
    );
    expect(sent.data.clientMessageId).toBe("r-1");
    providerId = `SBX-r-1`;

    await new Promise((r) => setTimeout(r, 400));
    const res = await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages/${providerId}`, {
      method: "PATCH", body: JSON.stringify({ text: "corregido" }),
    });
    expect(res.status).toBe(200);
  });

  it("reacciona y marca como leído", async () => {
    expect((await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages/${providerId}/reaction`, {
      method: "POST", body: JSON.stringify({ emoji: "👍" }),
    })).status).toBe(200);

    expect((await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/read`, {
      method: "POST", body: JSON.stringify({ messageIds: [providerId] }),
    })).status).toBe(200);
  });

  it("anuncia que se está escribiendo", async () => {
    const res = await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/presence`, {
      method: "POST", body: JSON.stringify({ presence: "composing" }),
    });
    expect(res.status).toBe(200);
  });

  it("borra el mensaje y lo marca, sin perder la fila", async () => {
    expect((await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages/${providerId}`, {
      method: "DELETE",
    })).status).toBe(200);
    const rows = await dbh.sql`
      SELECT deleted_at FROM message WHERE line_id = ${LINE} AND provider_message_id = ${providerId}`;
    expect(rows[0]!["deleted_at"]).not.toBeNull();
  });

  it("una clave acotada puede actuar en su chat pero no en otro", async () => {
    const dentro = await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/presence`, {
      method: "POST", body: JSON.stringify({ presence: "paused" }),
    }, scopedKey);
    expect(dentro.status).toBe(200);

    const fuera = await call(`/v1/lines/${LINE}/chats/${enc("51900000000@s.whatsapp.net")}/presence`, {
      method: "POST", body: JSON.stringify({ presence: "paused" }),
    }, scopedKey);
    expect(fuera.status).toBe(403);
  });
});

run("contactos", () => {
  it("comprueba si un número existe", async () => {
    const res = await call(`/v1/lines/${LINE}/contacts/${enc("51999000111@s.whatsapp.net")}/exists`);
    expect(res.status).toBe(200);
    expect((await j<{ data: { exists: boolean } }>(res)).data.exists).toBe(true);
  });

  it("bloquea y aparece en la lista", async () => {
    expect((await call(`/v1/lines/${LINE}/contacts/${enc(CHAT)}/block`, {
      method: "POST", body: JSON.stringify({ blocked: true }),
    })).status).toBe(200);

    const lista = await j<{ data: { address: string; blocked: boolean }[] }>(
      await call(`/v1/lines/${LINE}/contacts`),
    );
    expect(lista.data.find((c) => c.address === CHAT)?.blocked).toBe(true);
  });
});

run("grupos", () => {
  let grupo: string;

  it("crea un grupo con sus participantes", async () => {
    const res = await call(`/v1/lines/${LINE}/groups`, {
      method: "POST", body: JSON.stringify({ subject: "Equipo", participants: ["51988777666"] }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { address: string; participants: { role: string }[] } }>(res);
    grupo = data.address;
    expect(data.participants).toHaveLength(2);
    expect(data.participants[0]!.role).toBe("superadmin");
  });

  it("lee el grupo y lo refleja en la base", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}`);
    expect(res.status).toBe(200);
    const filas = await dbh.sql`SELECT subject, size FROM group_info WHERE line_id = ${LINE}`;
    expect(filas[0]!["subject"]).toBe("Equipo");
    expect(Number(filas[0]!["size"])).toBe(2);
  });

  it("informa por participante en vez de un sí o no global", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/participants`, {
      method: "POST",
      body: JSON.stringify({ action: "add", participants: ["51988777666", "51900000000"] }),
    });
    const { data } = await j<{ data: { ok: boolean; reason?: string }[] }>(res);
    expect(data[0]).toMatchObject({ ok: false, reason: "ya es miembro" });
    expect(data[1]).toMatchObject({ ok: true });
  });

  it("una clave acotada al grupo NO puede tocar quién pertenece", async () => {
    // Puede trabajar en el grupo; decidir sus miembros es otra cosa.
    const s = await mintApiKey();
    await dbh.db.insert(apiKeyTable).values({
      id: "k-rutas-grupo", orgId: ORG, name: "agente grupo", prefix: s.prefix,
      secretHash: s.secretHash, role: "operator", allowedLines: [LINE], allowedChats: [grupo],
    });
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/participants`, {
      method: "POST", body: JSON.stringify({ action: "remove", participants: ["51900000000"] }),
    }, s.plaintext);
    expect(res.status).toBe(403);
  });

  it("cambiar el asunto llega al transporte, no solo a nuestro espejo", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}`, {
      method: "PATCH", body: JSON.stringify({ subject: "Equipo nuevo", description: "otra cosa" }),
    });
    expect(res.status).toBe(200);

    // Lo que cuenta es lo que ve el transporte: escribir solo en nuestra tabla
    // enseñaría un asunto que el grupo real no tiene.
    const meta = await container.sandbox!.groupMetadata(LINE as never, parseAddress(grupo));
    expect(meta.subject).toBe("Equipo nuevo");
    expect(meta.description).toBe("otra cosa");

    const filas = await dbh.sql`SELECT subject FROM group_info WHERE address = ${grupo}`;
    expect(filas[0]?.["subject"]).toBe("Equipo nuevo");
  });

  it("da el código de invitación y lo rota cuando se pide", async () => {
    const primero = await j<{ data: { code: string; url: string } }>(
      await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/invite`));
    expect(primero.data.code).toBeTruthy();
    expect(primero.data.url).toContain(primero.data.code);

    // Leerlo dos veces da el mismo: leer no es rotar.
    const otra = await j<{ data: { code: string } }>(
      await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/invite`));
    expect(otra.data.code).toBe(primero.data.code);

    const rotado = await j<{ data: { code: string } }>(
      await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/invite`, { method: "POST" }));
    expect(rotado.data.code).not.toBe(primero.data.code);
  });

  it("salir del grupo lo hace en el transporte y luego lo olvida", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/leave`, { method: "POST" });
    expect(res.status).toBe(200);

    await expect(
      container.sandbox!.groupMetadata(LINE as never, parseAddress(grupo)),
    ).rejects.toThrow();

    const filas = await dbh.sql`SELECT 1 FROM group_info WHERE address = ${grupo}`;
    expect(filas).toHaveLength(0);
  });
});

run("enviar de todo", () => {
  const CHAT_MEDIOS = "51900888999@s.whatsapp.net";

  /** Sube un fichero como lo haría el panel y devuelve su clave. */
  async function subir(nombre: string, tipo: string, texto: string): Promise<string> {
    const cuerpo = new FormData();
    cuerpo.append("file", new File([texto], nombre, { type: tipo }));
    cuerpo.append("lineId", LINE);
    const res = await app.request("/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
      body: cuerpo,
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { storageKey: string } }>(res);
    return data.storageKey;
  }

  /** Sube bytes de verdad; hace falta para lo que pasa por ffmpeg. */
  async function subirBytes(nombre: string, tipo: string, bytes: Uint8Array): Promise<string> {
    const cuerpo = new FormData();
    cuerpo.append("file", new File([new Blob([bytes as unknown as ArrayBuffer])], nombre, { type: tipo }));
    cuerpo.append("lineId", LINE);
    const res = await app.request("/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
      body: cuerpo,
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { storageKey: string } }>(res);
    return data.storageKey;
  }

  /** Un PNG ancho de verdad, para comprobar el relleno a 512×512. */
  async function fabricarPng(): Promise<Uint8Array> {
    return conFfmpeg(["-f", "lavfi", "-i", "testsrc=size=800x200:rate=1:duration=1",
                      "-frames:v", "1"], "x.png");
  }

  async function fabricarAudioWebm(): Promise<Uint8Array> {
    return conFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                      "-c:a", "libopus", "-f", "webm"], "x.webm");
  }

  const enviarCampo = (campo: string, storageKey: string, extra: Record<string, unknown> = {}) =>
    call(`/v1/lines/${LINE}/messages`, {
      method: "POST",
      body: JSON.stringify({
        to: CHAT_MEDIOS, [campo]: { storageKey },
        clientMessageId: `medio-${campo}-${Date.now()}`,
        ...extra,
      }),
    });

  it("envía foto, vídeo, audio, documento y sticker", async () => {
    const casos: { campo: string; nombre: string; tipo: string }[] = [
      { campo: "image", nombre: "foto.jpg", tipo: "image/jpeg" },
      { campo: "video", nombre: "clip.mp4", tipo: "video/mp4" },
      { campo: "audio", nombre: "nota.ogg", tipo: "audio/ogg" },
      { campo: "document", nombre: "factura.pdf", tipo: "application/pdf" },
      { campo: "sticker", nombre: "pegatina.webp", tipo: "image/webp" },
    ];

    for (const caso of casos) {
      const clave = await subir(caso.nombre, caso.tipo, `bytes de ${caso.campo}`);
      const res = await enviarCampo(caso.campo, clave, caso.campo === "document" ? { fileName: caso.nombre } : {});
      expect(res.status, `no se pudo enviar ${caso.campo}`).toBe(202);
    }

    // Y quedan guardados con su fichero, para poder repintarlos al recargar.
    const limite = Date.now() + 8000;
    for (;;) {
      const filas = await dbh.sql`
        SELECT kind FROM message
        WHERE line_id = ${LINE} AND chat_id = ${CHAT_MEDIOS} AND from_me = true
          AND media_key IS NOT NULL`;
      if (filas.length >= casos.length) break;
      if (Date.now() > limite) throw new Error(`solo ${filas.length} de ${casos.length} con fichero`);
      await new Promise((r) => setTimeout(r, 80));
    }
  });

  it("una imagen cualquiera se CONVIERTE en sticker de 512×512", async () => {
    /*
     * Un sticker tiene que ser WebP. Antes se rechazaba, y es mejor
     * convertirlo: lo que quiere quien manda una foto como sticker es que
     * salga, no leer un requisito de formato.
     *
     * Lo que no puede pasar es enviarlo tal cual: WhatsApp acepta el envío sin
     * error y entrega un cuadrado roto, un fallo que descubre el destinatario.
     */
    const png = await fabricarPng();
    const clave = await subirBytes("foto.png", "image/png", png);
    const res = await enviarCampo("sticker", clave);
    expect(res.status).toBe(202);

    const limite = Date.now() + 15000;
    for (;;) {
      const filas = await dbh.sql`
        SELECT media_mime FROM message
        WHERE line_id = ${LINE} AND chat_id = ${CHAT_MEDIOS}
          AND kind = 'sticker' AND from_me = true AND media_mime = 'image/webp'`;
      if (filas.length > 0) break;
      if (Date.now() > limite) throw new Error("el sticker no se convirtió a WebP");
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 40_000);

  it("una nota de voz grabada en el navegador se convierte a OGG/Opus", async () => {
    // Chrome graba WebM/Opus. El flujo es el bueno, el envoltorio no: así
    // llegaría una nota de voz que no suena.
    const webm = await fabricarAudioWebm();
    const clave = await subirBytes("nota.webm", "audio/webm;codecs=opus", webm);
    const res = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST",
      body: JSON.stringify({
        to: CHAT_MEDIOS, audio: { storageKey: clave }, ptt: true,
        clientMessageId: `nota-${Date.now()}`,
      }),
    });
    expect(res.status).toBe(202);

    const limite = Date.now() + 15000;
    for (;;) {
      const filas = await dbh.sql`
        SELECT media_mime FROM message
        WHERE line_id = ${LINE} AND chat_id = ${CHAT_MEDIOS}
          AND kind = 'audio' AND from_me = true AND media_mime = 'audio/ogg'`;
      if (filas.length > 0) break;
      if (Date.now() > limite) throw new Error("la nota no se convirtió a OGG");
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 40_000);

  it("un vídeo en el campo de la foto se rechaza", async () => {
    const clave = await subir("clip.mp4", "video/mp4", "vídeo");
    const res = await enviarCampo("image", clave);
    expect(res.status).toBe(422);
  });

  it("al aceptar un envío con fichero devuelve ya su URL firmada", async () => {
    /*
     * Sin esto, quien envía pinta el mensaje con un hueco de «descargando…»
     * que no se rellena nunca: el fichero ya está en el almacén, pero nadie le
     * ha dado una URL. Solo se veía tras recargar la página.
     */
    const clave = await subir("foto2.jpg", "image/jpeg", "bytes");
    const res = await enviarCampo("image", clave);
    expect(res.status).toBe(202);
    const { data } = await j<{ data: { media: { url: string; mimeType: string } | null } }>(res);
    expect(data.media).not.toBeNull();
    expect(data.media!.mimeType).toBe("image/jpeg");

    // Y la URL sirve de verdad, sin credencial.
    const ruta = data.media!.url.slice(data.media!.url.indexOf("/v1/media"));
    expect((await app.request(ruta)).status).toBe(200);
  });

  it("el medio enviado se devuelve en el listado con su URL", async () => {
    const { data } = await j<{ data: { fromMe: boolean; kind: string; media: { url: string } | null }[] }>(
      await call(`/v1/lines/${LINE}/chats/${enc(CHAT_MEDIOS)}/messages?limit=20`));
    const propios = data.filter((m) => m.fromMe && m.media);
    expect(propios.length).toBeGreaterThanOrEqual(5);
  });
});

run("nombres de conversaciones", () => {
  it("aprende el nombre con el PRIMER mensaje de una conversación nueva", async () => {
    /*
     * El título vive en la fila de la conversación, que la crea la propia
     * ingesta. Aprender el nombre antes de crearla perdía justo el mensaje que
     * lo trae, y el nombre no aparecía hasta el segundo.
     */
    const chat = "51901000003@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST",
      body: JSON.stringify({ from: "51901000003", text: "hola", pushName: "Grace Hopper" }),
    });

    const limite = Date.now() + 6000;
    for (;;) {
      const { data } = await j<{ data: { displayName: string; address: string } }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
      if (data.displayName === "Grace Hopper") break;
      if (Date.now() > limite) throw new Error(`no aprendió el nombre: ${data.displayName}`);
      await new Promise((r) => setTimeout(r, 80));
    }
  });

  it("de un LID sin nombre enseña el TELÉFONO, no el número opaco", async () => {
    /*
     * Un LID son quince cifras que no se parecen a un teléfono. Enseñarlo solo
     * deja la conversación sin identificar; el teléfono, cuando lo sabemos,
     * sí se reconoce.
     */
    await container.runtime.publish("message.received", LINE, {
      key: {
        id: "SBX-nombre-lid", remoteJid: "555000777@lid",
        remoteJidAlt: "51900666777@s.whatsapp.net", fromMe: false,
      },
      kind: "text", text: "desde un lid", timestamp: Date.now(),
    });

    const limite = Date.now() + 6000;
    for (;;) {
      const res = await call(`/v1/lines/${LINE}/chats/${enc("555000777@lid")}`);
      if (res.status === 200) {
        const { data } = await j<{ data: { displayName: string; phone: string | null } }>(res);
        if (data.phone) {
          expect(data.displayName).toBe("+51900666777");
          break;
        }
      }
      if (Date.now() > limite) throw new Error("no resolvió el teléfono del LID");
      await new Promise((r) => setTimeout(r, 80));
    }
  });

  it("los estados se llaman Estados, no como el último que publicó", async () => {
    // En `status@broadcast` el remitente es quien publicó: usarlo como título
    // enseñaba el nombre de un contacto cualquiera donde debe decir "Estados".
    await container.runtime.publish("message.received", LINE, {
      key: { id: "SBX-estado-1", remoteJid: "status@broadcast", fromMe: false },
      pushName: "Quien Publicó",
      kind: "text", text: "un estado", timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 700));

    const res = await call(`/v1/lines/${LINE}/chats/${enc("status@broadcast")}`);
    if (res.status === 200) {
      const { data } = await j<{ data: { displayName: string } }>(res);
      expect(data.displayName).toBe("Estados");
    }
  });

  it("en un grupo, el nombre de quien habla NO se pone como título del grupo", async () => {
    // Poner el nombre del último que habló como título del grupo es el error
    // obvio y deja el grupo renombrándose solo con cada mensaje.
    const grupo = "120999@g.us";
    await container.runtime.publish("message.received", LINE, {
      key: {
        id: "SBX-grupo-1", remoteJid: grupo,
        participant: "51900555444@s.whatsapp.net", fromMe: false,
      },
      pushName: "Alan Turing",
      kind: "text", text: "hola grupo", timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 700));

    const res = await call(`/v1/lines/${LINE}/chats/${enc(grupo)}`);
    if (res.status === 200) {
      const { data } = await j<{ data: { displayName: string } }>(res);
      expect(data.displayName).not.toBe("Alan Turing");
    }

    // Pero sí se guarda como nombre del PARTICIPANTE.
    const filas = await dbh.sql`
      SELECT push_name FROM contact
      WHERE line_id = ${LINE} AND address = '51900555444@s.whatsapp.net'`;
    expect(filas[0]?.["push_name"]).toBe("Alan Turing");
  });
});

run("lo escrito desde el teléfono", () => {
  const CHAT_TEL = "51900777111@s.whatsapp.net";

  it("un mensaje enviado desde la app aparece en la conversación", async () => {
    /*
     * Llega como eco con `fromMe` y antes se tiraba: la conversación en el
     * panel se quedaba con la mitad, sin lo que el propio usuario había
     * contestado desde el móvil.
     */
    await container.runtime.publish("message.sent", LINE, {
      key: { id: "SBX-tel-1", remoteJid: CHAT_TEL, fromMe: true },
      kind: "text", text: "escrito desde el teléfono", timestamp: Date.now(),
    });

    const limite = Date.now() + 6000;
    for (;;) {
      const { data } = await j<{ data: { body: string | null; fromMe: boolean; state: string }[] }>(
        await call(`/v1/lines/${LINE}/chats/${enc(CHAT_TEL)}/messages?limit=10`));
      const m = data.find((x) => x.body === "escrito desde el teléfono");
      if (m) {
        expect(m.fromMe).toBe(true);
        // Ya salió: nace enviado, no en cola.
        expect(m.state).toBe("sent");
        return;
      }
      if (Date.now() > limite) throw new Error("no apareció lo escrito desde el teléfono");
      await new Promise((r) => setTimeout(r, 80));
    }
  });

  it("no suma pendientes y además los pone a cero", async () => {
    // Escribir desde el teléfono significa que ya has leído esa conversación.
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51900777111", text: "te escribo" }),
    });
    const limite = Date.now() + 6000;
    for (;;) {
      const { data } = await j<{ data: { unreadCount: number } }>(
        await call(`/v1/lines/${LINE}/chats/${enc(CHAT_TEL)}`));
      if (data.unreadCount > 0) break;
      if (Date.now() > limite) throw new Error("no llegó a tener pendientes");
      await new Promise((r) => setTimeout(r, 80));
    }

    await container.runtime.publish("message.sent", LINE, {
      key: { id: "SBX-tel-2", remoteJid: CHAT_TEL, fromMe: true },
      kind: "text", text: "contesto desde el móvil", timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 700));

    const { data } = await j<{ data: { unreadCount: number } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(CHAT_TEL)}`));
    expect(data.unreadCount).toBe(0);
  });

  it("el eco de lo que enviamos NOSOTROS no se duplica", async () => {
    /*
     * Nuestro envío ya tiene fila desde que se encola. Sin reconocer el eco,
     * cada mensaje del panel aparecería dos veces.
     */
    await call(`/v1/lines/${LINE}/messages`, {
      method: "POST",
      body: JSON.stringify({ to: CHAT_TEL, text: "desde el panel", clientMessageId: "eco-1" }),
    });
    await new Promise((r) => setTimeout(r, 800));

    await container.runtime.publish("message.sent", LINE, {
      key: { id: "SBX-eco-1", remoteJid: CHAT_TEL, fromMe: true },
      clientMessageId: "eco-1",
      kind: "text", text: "desde el panel", timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 700));

    const filas = await dbh.sql`
      SELECT count(*)::int AS n FROM message
      WHERE line_id = ${LINE} AND chat_id = ${CHAT_TEL} AND body = 'desde el panel'`;
    expect(filas[0]?.["n"]).toBe(1);
  });
});

run("borrar una línea", () => {
  it("deja de aparecer en el listado", async () => {
    /*
     * El borrado es blando —la bitácora necesita saber qué línea mandó qué—
     * pero eso es cosa de la base. Una línea borrada que sigue en la lista es
     * un borrado que no funciona.
     */
    const creada = await j<{ data: { id: string } }>(
      await call("/v1/lines", {
        method: "POST",
        body: JSON.stringify({ name: "Para borrar", slug: `borrar-${Date.now()}`, channelKind: "sandbox" }),
      }));

    const antes = await j<{ data: { id: string }[] }>(await call("/v1/lines"));
    expect(antes.data.map((l) => l.id)).toContain(creada.data.id);

    expect((await call(`/v1/lines/${creada.data.id}`, { method: "DELETE" })).status).toBe(200);

    const despues = await j<{ data: { id: string }[] }>(await call("/v1/lines"));
    expect(despues.data.map((l) => l.id)).not.toContain(creada.data.id);
  });
});

run("reacciones y stickers", () => {
  const CHAT_R = "51900888111@s.whatsapp.net";

  it("una reacción recibida se guarda y vuelve con el mensaje", async () => {
    /*
     * La tabla existía desde el principio y no la escribía nadie: las
     * reacciones llegaban, se publicaban por el socket y se perdían al
     * recargar la página.
     */
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51900888111", text: "reacciona a esto" }),
    });
    const limite = Date.now() + 6000;
    let id = "";
    for (;;) {
      const filas = await dbh.sql`
        SELECT provider_message_id FROM message
        WHERE line_id = ${LINE} AND chat_id = ${CHAT_R} ORDER BY timestamp DESC LIMIT 1`;
      if (filas[0]?.["provider_message_id"]) { id = String(filas[0]["provider_message_id"]); break; }
      if (Date.now() > limite) throw new Error("el mensaje no llegó");
      await new Promise((r) => setTimeout(r, 80));
    }

    await container.runtime.publish("message.reaction", LINE, {
      key: { id, remoteJid: CHAT_R, fromMe: false, participant: CHAT_R },
      emoji: "👍",
    });
    await new Promise((r) => setTimeout(r, 600));

    const { data } = await j<{ data: { providerMessageId: string | null; reacciones: { emoji: string; cuantas: number }[] }[] }>(
      await call(`/v1/lines/${LINE}/chats/${enc(CHAT_R)}/messages?limit=10`));
    const m = data.find((x) => x.providerMessageId === id)!;
    expect(m.reacciones).toEqual([{ emoji: "👍", cuantas: 1, mia: false }]);
  });

  it("un emoji vacío RETIRA la reacción en vez de guardar una vacía", async () => {
    // Es como lo expresa WhatsApp. Guardar la cadena vacía obligaría a
    // filtrarla en cada consulta y a pintar un globo sin emoji.
    const filas = await dbh.sql`
      SELECT provider_message_id FROM message
      WHERE line_id = ${LINE} AND chat_id = ${CHAT_R} ORDER BY timestamp DESC LIMIT 1`;
    const id = String(filas[0]!["provider_message_id"]);

    await container.runtime.publish("message.reaction", LINE, {
      key: { id, remoteJid: CHAT_R, fromMe: false, participant: CHAT_R },
      emoji: "",
    });
    await new Promise((r) => setTimeout(r, 600));

    const quedan = await dbh.sql`
      SELECT 1 FROM reaction WHERE line_id = ${LINE} AND provider_message_id = ${id}`;
    expect(quedan).toHaveLength(0);
  });

  it("los stickers vistos se ofrecen agrupados, no repetidos", async () => {
    const { data } = await j<{ data: { storageKey: string; url: string }[] }>(
      await call(`/v1/lines/${LINE}/stickers`));
    const claves = data.map((s) => s.storageKey);
    expect(new Set(claves).size).toBe(claves.length);
  });
});

run("estados y no leídos", () => {
  it("los estados NO salen entre las conversaciones", async () => {
    /*
     * Llegan todos a la misma dirección, así que como conversación no
     * significan nada: colados en la lista ponían «Estados» con el nombre del
     * último que publicó, que no es de nadie.
     */
    await container.runtime.publish("message.received", LINE, {
      key: { id: "SBX-est-1", remoteJid: "status@broadcast", fromMe: false },
      pushName: "Quien publica", kind: "text", text: "un estado", timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 700));

    const { data } = await j<{ data: { address: string }[] }>(
      await call(`/v1/lines/${LINE}/chats?limit=200`));
    expect(data.map((c) => c.address)).not.toContain("status@broadcast");
  });

  it("pero sí en su propia vista, agrupados por quién publicó", async () => {
    const { data } = await j<{ data: { address: string; items: unknown[] }[] }>(
      await call(`/v1/lines/${LINE}/statuses`));
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]!.items.length).toBeGreaterThan(0);
  });

  it("abrir una conversación pone su contador a cero", async () => {
    // Sin esto, el globo de no leídos se quedaba puesto mientras uno está
    // leyendo justo esa conversación.
    const chat = "51900111999@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51900111999", text: "uno" }),
    });
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51900111999", text: "dos" }),
    });

    const limite = Date.now() + 6000;
    for (;;) {
      const { data } = await j<{ data: { unreadCount: number } }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
      if (data.unreadCount > 0) break;
      if (Date.now() > limite) throw new Error("no llegó a tener pendientes");
      await new Promise((r) => setTimeout(r, 80));
    }

    const res = await call(`/v1/lines/${LINE}/chats/${enc(chat)}/read`, {
      method: "POST", body: "{}",
    });
    expect(res.status).toBe(200);

    const { data } = await j<{ data: { unreadCount: number } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
    expect(data.unreadCount).toBe(0);
  });
});

run("eliminar una conversación", () => {
  const CHAT_BORRAR = "51901000002@s.whatsapp.net";

  it("por defecto se quita solo de aquí, y en la red sigue", async () => {
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000002", text: "hola" }),
    });
    await esperarChat(CHAT_BORRAR, true);

    const res = await call(`/v1/lines/${LINE}/chats/${enc(CHAT_BORRAR)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await esperarChat(CHAT_BORRAR, false);

    // En el transporte la conversación sigue: «quitar de aquí» no la toca.
    expect(container.sandbox!.thread(LINE as never, CHAT_BORRAR).length).toBeGreaterThan(0);
  });

  it("con scope=network desaparece TAMBIÉN del transporte", async () => {
    /*
     * Es la diferencia que la gente quiere cuando dice «eliminar»: que no
     * aparezca. Vaciar deja el chat en la lista sin mensajes; esto lo quita.
     */
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000002", text: "otra vez" }),
    });
    await esperarChat(CHAT_BORRAR, true);

    const res = await call(
      `/v1/lines/${LINE}/chats/${enc(CHAT_BORRAR)}?scope=network`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await esperarChat(CHAT_BORRAR, false);
    expect(container.sandbox!.thread(LINE as never, CHAT_BORRAR)).toHaveLength(0);
  });

  async function esperarChat(chat: string, debeExistir: boolean): Promise<void> {
    const limite = Date.now() + 6000;
    for (;;) {
      const res = await call(`/v1/lines/${LINE}/chats/${enc(chat)}`);
      if ((res.status === 200) === debeExistir) return;
      if (Date.now() > limite) {
        throw new Error(`la conversación ${debeExistir ? "no apareció" : "no se fue"}`);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }
});

run("los dos nombres de un contacto", () => {
  const CHAT_NOMBRES = "51900333444@s.whatsapp.net";

  it("el que TÚ guardaste gana al que esa persona se puso", async () => {
    /*
     * Los dos se guardan y los dos valen: el tuyo manda al enseñarlo porque
     * lo elegiste para reconocerla, y el suyo es el recambio cuando no la
     * tienes en la agenda. Pisar uno con el otro perdería información.
     */
    await container.runtime.publish("message.received", LINE, {
      key: { id: "SBX-nom-1", remoteJid: CHAT_NOMBRES, fromMe: false },
      pushName: "Como se llama él",
      kind: "text", text: "hola", timestamp: Date.now(),
    });
    await esperarNombre(CHAT_NOMBRES, "Como se llama él");

    await container.runtime.publish("contact.updated", LINE, {
      address: CHAT_NOMBRES,
      savedName: "Como lo guardé yo",
      pushName: "Como se llama él",
    });
    await esperarNombre(CHAT_NOMBRES, "Como lo guardé yo");

    // Y el suyo sigue ahí: la ficha los enseña por separado.
    const { data } = await j<{ data: { savedName: string; pushName: string } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(CHAT_NOMBRES)}`));
    expect(data.savedName).toBe("Como lo guardé yo");
    expect(data.pushName).toBe("Como se llama él");
  });

  it("un evento con solo el nombre propio NO borra el que guardaste", async () => {
    // Es lo que pasa cada vez que alguien se renombra: llega su nombre nuevo y
    // nada más. Si pisara, perderías tu agenda sin tocar nada.
    await container.runtime.publish("contact.updated", LINE, {
      address: CHAT_NOMBRES,
      pushName: "Nombre nuevo suyo",
    });
    await new Promise((r) => setTimeout(r, 600));

    const { data } = await j<{ data: { displayName: string; savedName: string; pushName: string } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(CHAT_NOMBRES)}`));
    expect(data.savedName).toBe("Como lo guardé yo");
    expect(data.pushName).toBe("Nombre nuevo suyo");
    expect(data.displayName).toBe("Como lo guardé yo");
  });

  async function esperarNombre(chat: string, esperado: string): Promise<void> {
    const limite = Date.now() + 6000;
    for (;;) {
      const res = await call(`/v1/lines/${LINE}/chats/${enc(chat)}`);
      if (res.status === 200) {
        const { data } = await j<{ data: { displayName: string } }>(res);
        if (data.displayName === esperado) return;
      }
      if (Date.now() > limite) throw new Error(`el nombre no llegó a ser «${esperado}»`);
      await new Promise((r) => setTimeout(r, 80));
    }
  }
});

run("reintento de envíos", () => {
  it("un mensaje entregado NO se puede reintentar", async () => {
    // Reintentar uno entregado sería mandarlo dos veces al destinatario.
    await call(`/v1/lines/${LINE}/messages`, {
      method: "POST",
      body: JSON.stringify({ to: CHAT, text: "va bien", clientMessageId: "ok-1" }),
    });
    await new Promise((r) => setTimeout(r, 500));
    const res = await call(`/v1/lines/${LINE}/messages/m-ok-1/resend`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await j<{ detail: string }>(res)).detail).toContain("failed");
  });

  it("uno que falló se reencola con el MISMO identificador de cliente", async () => {
    await call(`/v1/lines/${LINE}/messages`, {
      method: "POST",
      body: JSON.stringify({ to: CHAT, text: "falló", clientMessageId: "fallido-1" }),
    });
    /*
     * Se espera a que el envío TERMINE, no un tiempo fijo.
     *
     * Con 400 ms a ojo, en una máquina cargada el acuse del sandbox llegaba
     * después de marcarlo como fallido y lo pisaba: la prueba fallaba una de
     * cada pocas veces sin que el código tuviera nada mal.
     */
    const limite = Date.now() + 6000;
    for (;;) {
      const [f] = await dbh.sql<{ state: string }[]>`
        SELECT state FROM message WHERE line_id = ${LINE} AND client_message_id = 'fallido-1'`;
      if (f?.state === "read") break;
      if (Date.now() > limite) throw new Error(`el envío no terminó (${f?.state ?? "sin fila"})`);
      await new Promise((r) => setTimeout(r, 60));
    }
    await dbh.sql`
      UPDATE message SET state = 'failed', failure_reason = 'prueba'
      WHERE line_id = ${LINE} AND client_message_id = 'fallido-1'`;

    const res = await call(`/v1/lines/${LINE}/messages/m-fallido-1/resend`, { method: "POST" });
    expect(res.status).toBe(202);
    const { data } = await j<{ data: { clientMessageId: string } }>(res);
    // El mismo: si el anterior llegó a salir, la idempotencia lo detiene.
    expect(data.clientMessageId).toBe("fallido-1");

    const filas = await dbh.sql`
      SELECT state, failure_reason FROM message
      WHERE line_id = ${LINE} AND client_message_id = 'fallido-1'`;
    expect(filas[0]?.["failure_reason"]).toBeNull();
  });

  it("un mensaje que no existe es 404", async () => {
    expect((await call(`/v1/lines/${LINE}/messages/no-existe/resend`, { method: "POST" })).status)
      .toBe(404);
  });
});

run("medios entrantes e identidad", () => {
  it("una foto que llega se descarga, se guarda y se puede descargar", async () => {
    /*
     * WhatsApp no manda el fichero: manda una referencia cifrada. Sin
     * descargarla, una foto que llega es una fila en la base y ninguna forma
     * de ver la foto, que es lo que pasaba antes.
     */
    const chat = "51900222333@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST",
      body: JSON.stringify({ from: "51900222333", text: "mira esto", kind: "image" }),
    });

    const limite = Date.now() + 8000;
    let fila: Record<string, unknown> | undefined;
    for (;;) {
      const filas = await dbh.sql`
        SELECT media_key, media_mime, media_size, failure_reason
        FROM message WHERE line_id = ${LINE} AND chat_id = ${chat}`;
      fila = filas[0];
      if (fila?.["media_key"]) break;
      if (Date.now() > limite) {
        throw new Error(`el medio no se guardó: ${JSON.stringify(fila ?? null)}`);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(fila["media_mime"]).toBe("image/jpeg");
    expect(Number(fila["media_size"])).toBeGreaterThan(0);
    expect(fila["failure_reason"]).toBeNull();
  });

  it("el listado devuelve el medio con una URL firmada que sirve de verdad", async () => {
    /*
     * El fichero estaba en disco y la API no lo exponía: el panel pintaba la
     * palabra "image" en cursiva. Sin la URL aquí no hay nada que enseñar.
     */
    const chat = "51900222333@s.whatsapp.net";
    const limite = Date.now() + 8000;
    let medio: { url: string; mimeType: string } | null = null;
    for (;;) {
      const { data } = await j<{ data: { kind: string; media: { url: string; mimeType: string } | null }[] }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages?limit=20`));
      medio = data.find((m) => m.kind === "image")?.media ?? null;
      if (medio) break;
      if (Date.now() > limite) throw new Error("el listado no trae el medio");
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(medio.mimeType).toBe("image/jpeg");

    // La URL lleva su propia credencial: la firma y la caducidad. Tiene que
    // servir el fichero SIN cabecera de autorización, que es lo que permite
    // pegarla en un `<img>`.
    const ruta = medio.url.slice(medio.url.indexOf("/v1/media"));
    const res = await app.request(ruta);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");

    /*
     * Y con la firma tocada, no.
     *
     * Se sustituye la firma ENTERA, no su primer carácter: cambiarlo por un
     * «0» dejaba la firma intacta una de cada dieciséis veces, y la prueba
     * fallaba sola sin que nada estuviera roto.
     */
    const falsa = await app.request(ruta.replace(/signature=[^&]*/, "signature=invalida"));
    expect(falsa.status).toBe(403);
  });

  it("un mensaje de texto no encola ninguna descarga", async () => {
    // Encolar un trabajo por cada mensaje de texto llenaría la cola de nada.
    const antes = await dbh.sql`SELECT count(*)::int AS n FROM omni_job WHERE queue = 'inbound-media'`;
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51900222333", text: "solo texto" }),
    });
    await new Promise((r) => setTimeout(r, 500));
    const despues = await dbh.sql`SELECT count(*)::int AS n FROM omni_job WHERE queue = 'inbound-media'`;
    expect(despues[0]?.["n"]).toBe(antes[0]?.["n"]);
  });

  it("de un LID sin mapear decimos que NO lo sabemos, no lo adivinamos", async () => {
    /*
     * Adivinar el teléfono por los dígitos del LID confundiría a dos personas
     * distintas. `null` significa "no lo sabemos", que es la verdad.
     */
    const { data } = await j<{ data: { phone: string | null; kind: string } }>(
      await call(`/v1/lines/${LINE}/identity/${enc("555000111@lid")}`));
    expect(data.kind).toBe("lid");
    expect(data.phone).toBeNull();
  });

  it("aprende el mapeo LID↔teléfono de lo que trae el mensaje", async () => {
    // Es la ÚNICA vez que WhatsApp lo dice; si no se guarda aquí, ese LID no
    // se puede atar a nadie nunca más.
    await container.runtime.publish("message.received", LINE, {
      key: {
        id: "SBX-lid-1",
        remoteJid: "555000999@lid",
        remoteJidAlt: "51900444555@s.whatsapp.net",
        fromMe: false,
      },
      kind: "text", text: "hola desde un lid", timestamp: Date.now(),
    });

    const limite = Date.now() + 5000;
    for (;;) {
      const res = await j<{ data: { phone: string | null } }>(
        await call(`/v1/lines/${LINE}/identity/${enc("555000999@lid")}`));
      if (res.data.phone === "51900444555@s.whatsapp.net") break;
      if (Date.now() > limite) throw new Error("no aprendió el mapeo");
      await new Promise((r) => setTimeout(r, 80));
    }

    // Y al revés: del teléfono al LID.
    const inverso = await j<{ data: { lid: string | null } }>(
      await call(`/v1/lines/${LINE}/identity/${enc("51900444555@s.whatsapp.net")}`));
    expect(inverso.data.lid).toBe("555000999@lid");
  });
});

run("organización y limpieza", () => {
  it("dice de qué organización es la credencial, con sus líneas por canal", async () => {
    const { data } = await j<{ data: { slug: string; lines: number; linesByChannel: Record<string, number> } }>(
      await call("/v1/org"));
    expect(data.slug).toBe("rutas");
    expect(data.lines).toBeGreaterThan(0);
    expect(data.linesByChannel["sandbox"]).toBeGreaterThan(0);
  });

  /** Espera a que la ingesta —que es asíncrona— haya creado la conversación. */
  async function esperarChat(chat: string): Promise<void> {
    await esperar(
      async () => (await call(`/v1/lines/${LINE}/chats/${enc(chat)}`)).status === 200,
      `la conversación ${chat} apareció`,
    );
  }

  async function esperarValor<T>(dame: () => Promise<T | null>, que: string): Promise<T> {
    const limite = Date.now() + 6000;
    for (;;) {
      const v = await dame();
      if (v !== null) return v;
      if (Date.now() > limite) throw new Error(`no se cumplió: ${que}`);
      await new Promise((r) => setTimeout(r, 70));
    }
  }

  async function esperar(cumple: () => Promise<boolean>, que: string): Promise<void> {
    const limite = Date.now() + 6000;
    for (;;) {
      if (await cumple()) return;
      if (Date.now() > limite) throw new Error(`no se cumplió: ${que}`);
      await new Promise((r) => setTimeout(r, 70));
    }
  }

  it("una mención en un grupo sale con el nombre, en el hilo, en el adelanto y en vivo", async () => {
    /*
     * WhatsApp manda `@120238196658384` en el texto y la dirección aparte. El
     * caso difícil, y el real: la persona mencionada por su LID está en la
     * agenda bajo su TELÉFONO, y solo el mapa de identidad las une.
     */
    const grupo = "120363000000000777@g.us";
    const quienEscribe = "220000000000001@lid";
    const mencionada = "220000000000002@lid";
    const suTelefono = "51911222333@s.whatsapp.net";
    const desconocida = "220000000000003@lid";

    await dbh.sql`
      INSERT INTO identity_map (line_id, lid, phone)
      VALUES (${LINE}, ${mencionada}, ${suTelefono})
      ON CONFLICT DO NOTHING`;
    // En la agenda, bajo el teléfono: «Raquel». Y el suyo propio, «Nadkym».
    await container.runtime.publish("contact.updated", LINE, {
      address: suTelefono, savedName: "Raquel", pushName: null,
    });
    await container.runtime.publish("contact.updated", LINE, {
      address: mencionada, savedName: null, pushName: "Nadkym",
    });
    // Quien escribe solo tiene @usuario.
    await container.runtime.publish("contact.updated", LINE, {
      address: quienEscribe, savedName: null, pushName: null, username: "andre.v",
    });

    const vivos: Record<string, unknown>[] = [];
    container.runtime.onEvent((e) => {
      if (e.event === "message.received") vivos.push(e.data as Record<string, unknown>);
    });

    await container.runtime.publish("message.received", LINE, {
      key: { id: "MENCION-1", remoteJid: grupo, participant: quienEscribe },
      kind: "text", timestamp: Date.now(),
      text: "@220000000000002 me yapeas? y @220000000000003 también, y en @2024 no",
      mentions: [mencionada, desconocida],
    });

    type M = {
      providerMessageId: string | null; senderName: string | null;
      mentions: { token: string; name: string }[];
    };
    const m = await esperarValor(async () => {
      const { data } = await j<{ data: M[] }>(
        await call(`/v1/lines/${LINE}/chats/${enc(grupo)}/messages?limit=5`));
      return data.find((x) => x.providerMessageId === "MENCION-1") ?? null;
    }, "el mensaje con mención se guardó");

    // El de tu agenda gana al suyo, aunque esté guardado bajo la otra dirección.
    expect(m.mentions.find((x) => x.token === "220000000000002")?.name).toBe("Raquel");
    // Mencionada por WhatsApp pero sin nombre ni número: el id, SIN `+`.
    expect(m.mentions.find((x) => x.token === "220000000000003")?.name)
      .toBe("220000000000003");
    // `@2024` no estaba entre las mencionadas y no es nadie: se queda como está.
    expect(m.mentions.find((x) => x.token === "2024")).toBeUndefined();
    // Quien escribe: sin agenda ni nombre propio, su @usuario.
    expect(m.senderName).toBe("@andre.v");

    // El adelanto de la lista, en texto plano, con los nombres puestos.
    const { data: chat } = await j<{ data: { ultimo: string } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(grupo)}`));
    expect(chat.ultimo).toContain("@Raquel me yapeas?");
    expect(chat.ultimo).not.toContain("@220000000000002");

    // Y en vivo: el evento sale con los nombres, el texto intacto.
    const vivo = vivos.find((d) => (d["key"] as { id?: string })?.id === "MENCION-1");
    expect(vivo?.["text"]).toContain("@220000000000002");
    expect((vivo?.["mentionNames"] as Record<string, string>)["220000000000002"]).toBe("Raquel");
    expect(vivo?.["senderName"]).toBe("@andre.v");
  });

  it("los votos de una encuesta se cuentan, y no aparecen como mensajes", async () => {
    /*
     * El camino completo y con cifrado REAL, que es la única forma de probar
     * esto: la clave se deriva de la encuesta, de quién la creó y de quién
     * vota, y equivocarse en cualquiera de los tres no da un error —da un voto
     * que no abre—. Un doble no habría detectado nada.
     *
     * El motor lee el secreto de la base, donde los bytes ya son una cadena en
     * base64. Esa relectura es donde estaba el fallo que costó 143 votos
     * reales, y por eso la prueba pasa por ahí y no por memoria.
     */
    const { createHash, createCipheriv, createHmac } = await import("node:crypto");

    const chat = "51901000020@s.whatsapp.net";
    const pollId = "ENCUESTA-INT";
    const autor = chat;
    const votante = "51901000021@s.whatsapp.net";
    const secreto = Buffer.alloc(32, 11);
    const opciones = ["Martes 20", "Martes 27"];

    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000020", text: "va encuesta" }),
    });
    await esperarChat(chat);

    await container.runtime.publish("message.received", LINE, {
      key: { id: pollId, remoteJid: chat, participant: autor },
      kind: "poll", text: null, timestamp: Date.now(),
      raw: {
        message: {
          pollCreationMessageV3: {
            name: "¿Qué día?",
            options: opciones.map((o) => ({ optionName: o })),
            selectableOptionsCount: 1,
          },
          // Como queda en la base al releerlo: una cadena, no bytes.
          messageContextInfo: { messageSecret: secreto.toString("base64") },
        },
      },
    });
    await esperar(async () => {
      const { data } = await j<{ data: { providerMessageId: string | null }[] }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages?limit=20`));
      return data.some((m) => m.providerMessageId === pollId);
    }, "la encuesta se guardó");

    const cifrar = (opcion: string, quien: string): { encPayload: string; encIv: string } => {
      const firma = Buffer.concat([
        Buffer.from(pollId), Buffer.from(autor), Buffer.from(quien),
        Buffer.from("Poll Vote"), Buffer.from([1]),
      ]);
      const key0 = createHmac("sha256", Buffer.alloc(32)).update(secreto).digest();
      const clave = createHmac("sha256", key0).update(firma).digest();
      /*
       * `PollVoteMessage` a mano: campo 1, `repeated bytes selectedOptions`.
       * Escrito aquí y no con el codificador de Baileys para que la prueba no
       * dependa del transporte —esta app no lo conoce— y para que compruebe el
       * formato de verdad en vez de comprobar que una librería se entiende
       * consigo misma.
       */
      const hash = createHash("sha256").update(opcion).digest();
      const payload = Buffer.concat([Buffer.from([0x0a, hash.length]), hash]);
      const iv = Buffer.alloc(12, 5);
      const c = createCipheriv("aes-256-gcm", clave, iv);
      c.setAAD(Buffer.from(`${pollId}\u0000${quien}`));
      const cuerpo = Buffer.concat([c.update(payload), c.final(), c.getAuthTag()]);
      return { encPayload: cuerpo.toString("base64"), encIv: iv.toString("base64") };
    };

    await container.runtime.publish("poll.vote", LINE, {
      poll: { id: pollId, author: autor }, voter: votante,
      vote: cifrar("Martes 27", votante), at: Date.now(),
    });

    const encuesta = await esperarValor(async () => {
      const { data } = await j<{
        data: {
          providerMessageId: string | null;
          poll: {
            question: string; totalVotes: number;
            options: { name: string; votes: number }[];
          } | null;
        }[];
      }>(await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages?limit=20`));
      const m = data.find((x) => x.providerMessageId === pollId);
      return m?.poll && m.poll.totalVotes > 0 ? m.poll : null;
    }, "el voto se contó");

    expect(encuesta.question).toBe("¿Qué día?");
    expect(encuesta.totalVotes).toBe(1);
    expect(encuesta.options.find((o) => o.name === "Martes 27")?.votes).toBe(1);
    expect(encuesta.options.find((o) => o.name === "Martes 20")?.votes).toBe(0);

    // Y el voto NO está en el hilo: es lo que llenaba la conversación.
    const { data: hilo } = await j<{ data: { kind: string }[] }>(
      await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages?limit=20`));
    expect(hilo.filter((m) => m.kind === "unknown")).toHaveLength(0);
  });

  it("una respuesta llega con su cita RESUELTA: quién y qué decía", async () => {
    /*
     * La cita viene resuelta desde la API y no como un identificador suelto a
     * propósito: pintarla obliga a saber quién escribió el original y qué
     * decía, y dejar eso al cliente es una petición por burbuja citada.
     */
    const chat = "51901000010@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000010", text: "¿lo tienes?" }),
    });
    await esperarChat(chat);

    const [fila] = await dbh.sql<{ provider_message_id: string }[]>`
      SELECT provider_message_id FROM message
      WHERE line_id = ${LINE} AND chat_id = ${chat} AND from_me = false
      ORDER BY timestamp DESC LIMIT 1`;
    const original = fila!.provider_message_id;

    await container.runtime.publish("message.received", LINE, {
      key: { id: "RESP-1", remoteJid: chat },
      kind: "text", text: "sí, aquí está", timestamp: Date.now(),
      replyTo: { id: original, author: chat, kind: "text", text: "¿lo tienes?" },
    });

    await esperar(async () => {
      const { data } = await j<{ data: { providerMessageId: string | null }[] }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages?limit=10`));
      return data.some((m) => m.providerMessageId === "RESP-1");
    }, "la respuesta se guardó");

    const { data } = await j<{
      data: {
        providerMessageId: string | null;
        replyTo: { id: string; body: string | null; disponible: boolean } | null;
      }[];
    }>(await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages?limit=10`));

    const respuesta = data.find((m) => m.providerMessageId === "RESP-1");
    expect(respuesta?.replyTo).not.toBeNull();
    expect(respuesta!.replyTo!.id).toBe(original);
    expect(respuesta!.replyTo!.body).toBe("¿lo tienes?");
    // Está en nuestra base, así que el panel puede saltar a ella.
    expect(respuesta!.replyTo!.disponible).toBe(true);

    // Y lo que no responde a nada no se inventa una cita.
    const suelto = data.find((m) => m.providerMessageId === original);
    expect(suelto?.replyTo).toBeNull();
  });

  it("la cita de un mensaje que no tenemos se enseña igual, pero sin salto", async () => {
    /*
     * Pasa con todo lo anterior al enlace de la línea. WhatsApp mete una copia
     * del citado dentro del mensaje que responde, y es la única forma de
     * enseñar esa cita. Lo que no se puede es saltar al original, y eso se
     * dice con `disponible: false` en vez de ofrecer un salto a ninguna parte.
     */
    const chat = "51901000011@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000011", text: "hola" }),
    });
    await esperarChat(chat);

    await container.runtime.publish("message.received", LINE, {
      key: { id: "RESP-2", remoteJid: chat },
      kind: "text", text: "sobre lo de ayer", timestamp: Date.now(),
      replyTo: {
        id: "NUNCA-ESTUVO-AQUI", author: chat, kind: "image", text: "el plano",
      },
    });

    const cita = await esperarValor(async () => {
      const { data } = await j<{
        data: {
          providerMessageId: string | null;
          replyTo: { kind: string; body: string | null; disponible: boolean } | null;
        }[];
      }>(await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages?limit=10`));
      return data.find((m) => m.providerMessageId === "RESP-2")?.replyTo ?? null;
    }, "la cita de copia llegó");

    expect(cita.body).toBe("el plano");
    expect(cita.kind).toBe("image");
    expect(cita.disponible).toBe(false);
  });

  it("silenciar una conversación se guarda AQUÍ, no solo en el transporte", async () => {
    /*
     * Antes solo se le decía a WhatsApp. El panel no sabía que estaba
     * silenciada hasta que volviera el evento de chat, y mientras tanto seguía
     * sonando por ella: justo en el momento en que alguien acaba de pedir que
     * se calle.
     */
    const chat = "51901000001@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000001", text: "ruidoso" }),
    });
    await esperarChat(chat);

    const hasta = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    const res = await call(`/v1/lines/${LINE}/chats/${enc(chat)}/mute`, {
      method: "POST", body: JSON.stringify({ until: hasta }),
    });
    expect(res.status).toBe(200);

    const { data } = await j<{ data: { mutedUntil: string | null } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
    expect(data.mutedUntil).not.toBeNull();
    expect(new Date(data.mutedUntil!).getTime()).toBe(new Date(hasta).getTime());

    // Y reactivar la devuelve a sonar.
    await call(`/v1/lines/${LINE}/chats/${enc(chat)}/mute`, {
      method: "POST", body: JSON.stringify({ until: null }),
    });
    const { data: tras } = await j<{ data: { mutedUntil: string | null } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
    expect(tras.mutedUntil).toBeNull();
  });

  it("lo que se silencia desde el teléfono también calla aquí", async () => {
    const chat = "51901000002@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000002", text: "hola" }),
    });
    await esperarChat(chat);

    const hasta = Date.now() + 7 * 24 * 3600 * 1000;
    await container.runtime.publish("chat.updated", LINE, {
      chat, mutedUntil: hasta, archived: true,
    });

    const limite = Date.now() + 6000;
    for (;;) {
      const { data } = await j<{ data: { mutedUntil: string | null; archived: boolean } }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
      if (data.mutedUntil !== null) {
        expect(new Date(data.mutedUntil).getTime()).toBe(hasta);
        expect(data.archived).toBe(true);
        break;
      }
      if (Date.now() > limite) throw new Error("el silencio del teléfono no llegó a la base");
      await new Promise((r) => setTimeout(r, 60));
    }
  });

  it("una actualización de chat NO borra lo que no menciona", async () => {
    /*
     * WhatsApp manda solo los campos que cambiaron. Tomar los ausentes por
     * nulos hacía que archivar desde el teléfono desilenciara la conversación
     * de paso, sin que nadie lo hubiera pedido.
     */
    const chat = "51901000003@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51901000003", text: "hola" }),
    });
    await esperarChat(chat);

    const hasta = Date.now() + 8 * 3600 * 1000;
    await container.runtime.publish("chat.updated", LINE, { chat, mutedUntil: hasta });
    await esperar(async () => {
      const { data } = await j<{ data: { mutedUntil: string | null } }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
      return data.mutedUntil !== null;
    }, "el silencio se guardó");

    // Un cambio que solo habla de archivado no puede tocar el silencio.
    await container.runtime.publish("chat.updated", LINE, { chat, archived: true });
    await esperar(async () => {
      const { data } = await j<{ data: { archived: boolean } }>(
        await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
      return data.archived;
    }, "el archivado se guardó");

    const { data } = await j<{ data: { mutedUntil: string | null } }>(
      await call(`/v1/lines/${LINE}/chats/${enc(chat)}`));
    expect(data.mutedUntil).not.toBeNull();
  });

  it("vaciar una conversación la vacía en el transporte y borra nuestra copia", async () => {
    const chat = "51900111222@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51900111222", text: "uno" }),
    });
    // La ingesta es asíncrona; se espera a que la fila exista antes de borrarla.
    const limite = Date.now() + 6000;
    for (;;) {
      const filas = await dbh.sql`
        SELECT 1 FROM message WHERE line_id = ${LINE} AND chat_id = ${chat}`;
      if (filas.length > 0) break;
      if (Date.now() > limite) throw new Error("el mensaje no llegó a la base");
      await new Promise((r) => setTimeout(r, 60));
    }

    const res = await call(`/v1/lines/${LINE}/chats/${enc(chat)}/messages`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const { data } = await j<{ data: { deleted: number } }>(res);
    expect(data.deleted).toBeGreaterThan(0);

    const quedan = await dbh.sql`
      SELECT 1 FROM message WHERE line_id = ${LINE} AND chat_id = ${chat}`;
    expect(quedan).toHaveLength(0);
    expect(container.sandbox!.thread(LINE as never, chat)).toHaveLength(0);
  });
});

run("canales", () => {
  let canal: string;
  let codigo: string;

  it("crea un canal y lo devuelve con su enlace", async () => {
    const res = await call(`/v1/lines/${LINE}/newsletters`, {
      method: "POST", body: JSON.stringify({ name: "Avisos", description: "solo lo importante" }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { address: string; inviteCode: string; inviteUrl: string; role: string } }>(res);
    expect(data.address).toContain("@newsletter");
    expect(data.role).toBe("owner");
    expect(data.inviteUrl).toContain(data.inviteCode);
    canal = data.address;
    codigo = data.inviteCode;
  });

  it("se puede leer por dirección o por el código del enlace", async () => {
    // Los canales circulan como enlaces, no como direcciones: aceptar solo la
    // dirección obligaría a todo el mundo a traducir a mano.
    const porDireccion = await j<{ data: { name: string } }>(
      await call(`/v1/lines/${LINE}/newsletters/${enc(canal)}`));
    expect(porDireccion.data.name).toBe("Avisos");

    const porCodigo = await j<{ data: { address: string } }>(
      await call(`/v1/lines/${LINE}/newsletters/${enc(codigo)}`));
    expect(porCodigo.data.address).toBe(canal);
  });

  it("un canal que no existe es 404, no un 500", async () => {
    const res = await call(`/v1/lines/${LINE}/newsletters/${enc("999999@newsletter")}`);
    expect(res.status).toBe(404);
  });

  it("seguir y dejar de seguir cambia el papel y la cuenta", async () => {
    // Uno AJENO: del propio se es dueño, no seguidor.
    const otro = await j<{ data: { address: string } }>(
      await call(`/v1/sandbox/lines/${LINE}/newsletters`, {
        method: "POST", body: JSON.stringify({ name: "Ajeno" }),
      }));

    await call(`/v1/lines/${LINE}/newsletters/${enc(otro.data.address)}/follow`, {
      method: "POST", body: JSON.stringify({ follow: true }),
    });
    const seguido = await j<{ data: { role: string; subscribers: number } }>(
      await call(`/v1/lines/${LINE}/newsletters/${enc(otro.data.address)}`));
    expect(seguido.data.role).toBe("subscriber");

    await call(`/v1/lines/${LINE}/newsletters/${enc(otro.data.address)}/follow`, {
      method: "POST", body: JSON.stringify({ follow: false }),
    });
    const dejado = await j<{ data: { role: string; subscribers: number } }>(
      await call(`/v1/lines/${LINE}/newsletters/${enc(otro.data.address)}`));
    expect(dejado.data.role).toBe("guest");
    expect(dejado.data.subscribers).toBe(seguido.data.subscribers - 1);
  });
});

run("administración de líneas y credenciales", () => {
  it("crea una línea y rechaza el identificador repetido", async () => {
    const res = await call("/v1/lines", {
      method: "POST",
      body: JSON.stringify({ name: "Otra", slug: "otra", channelKind: "sandbox", sendRatePerMinute: 30 }),
    });
    expect(res.status).toBe(201);
    const repetida = await call("/v1/lines", {
      method: "POST", body: JSON.stringify({ name: "Otra", slug: "otra", channelKind: "sandbox" }),
    });
    expect(repetida.status).toBe(409);
  });

  it("cambia el ritmo de envío de una línea", async () => {
    const res = await call(`/v1/lines/${LINE}`, {
      method: "PATCH", body: JSON.stringify({ sendRatePerMinute: 20 }),
    });
    expect((await j<{ data: { sendRatePerMinute: number } }>(res)).data.sendRatePerMinute).toBe(20);
    await call(`/v1/lines/${LINE}`, { method: "PATCH", body: JSON.stringify({ sendRatePerMinute: 6000 }) });
  });

  it("acuña una clave, la enseña una vez y luego solo su prefijo", async () => {
    const res = await call("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "integración", role: "operator", allowedChats: [CHAT] }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { apiKey: string; id: string; prefix: string } }>(res);
    expect(data.apiKey).toMatch(/^omni_[0-9a-f]+_/);

    const lista = await j<{ data: { id: string; prefix: string }[] }>(await call("/v1/api-keys"));
    const guardada = lista.data.find((k) => k.id === data.id)!;
    expect(guardada.prefix).toBe(data.prefix);
    // El secreto se saca con el analizador: es base64url, lleva guiones bajos,
    // y partir por el separador devuelve un fragmento que sí aparece en
    // cualquier JSON. Esta prueba fallaba sola por eso.
    expect(JSON.stringify(guardada)).not.toContain(secretoDe(data.apiKey)!);
  });

  it("no deja revocar la última clave de administración viva", async () => {
    const res = await call("/v1/api-keys/k-rutas-admin", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await j<{ detail: string }>(res)).detail).toMatch(/última clave de administración/);
  });

  it("la bitácora registra lo que se ha hecho", async () => {
    const res = await call("/v1/audit");
    const { data } = await j<{ data: { action: string }[] }>(res);
    expect(data.map((e) => e.action)).toContain("line.create");
    expect(data.map((e) => e.action)).toContain("apikey.create");
  });

  it("una clave acotada a chats no llega a la administración", async () => {
    expect((await call("/v1/api-keys", {}, scopedKey)).status).toBe(403);
    expect((await call("/v1/audit", {}, scopedKey)).status).toBe(403);
  });
});
