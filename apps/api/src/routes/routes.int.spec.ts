import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseAddress } from "@omni/shared";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

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

run("nombres de conversaciones", () => {
  it("aprende el nombre con el PRIMER mensaje de una conversación nueva", async () => {
    /*
     * El título vive en la fila de la conversación, que la crea la propia
     * ingesta. Aprender el nombre antes de crearla perdía justo el mensaje que
     * lo trae, y el nombre no aparecía hasta el segundo.
     */
    const chat = "51900777888@s.whatsapp.net";
    await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST",
      body: JSON.stringify({ from: "51900777888", text: "hola", pushName: "Grace Hopper" }),
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
    await new Promise((r) => setTimeout(r, 400));
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

    // Y con la firma tocada, no.
    const falsa = await app.request(ruta.replace(/signature=./, "signature=0"));
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
    expect(JSON.stringify(guardada)).not.toContain(data.apiKey.split("_")[2]!);
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
