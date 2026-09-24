import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, migrate, orgTable, lineTable, webhookEndpointTable, webhookDeliveryTable, messageTable, type DbHandle } from "@omni/db";
import { eq } from "drizzle-orm";
import { runMaintenance } from "./maintenance.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-mant";
const LINE = "line-mant";
let h: DbHandle;

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  h = createDatabase(URL_DB);
  await h.sql`DELETE FROM webhook_delivery WHERE org_id = ${ORG}`;
  await h.sql`DELETE FROM webhook_endpoint WHERE org_id = ${ORG}`;
  await h.sql`DELETE FROM message WHERE line_id = ${LINE}`;
  await h.sql`DELETE FROM line WHERE id = ${LINE}`;
  await h.sql`DELETE FROM org WHERE id = ${ORG}`;
  await h.db.insert(orgTable).values({ id: ORG, name: "M", slug: "m" });
  await h.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l",
  });
});
afterAll(async () => { await h?.close(); });

run("mantenimiento", () => {
  it("garantiza particiones por delante", async () => {
    // Quedarse sin partición es un fallo TOTAL de escritura un día 1 a las 00:00.
    const r = await runMaintenance(h.db, { mesesPorDelante: 6 });
    expect(r.particiones).toBeGreaterThanOrEqual(8);
  });

  it("purga el registro antiguo de entregas y conserva el reciente", async () => {
    await h.db.insert(webhookEndpointTable).values({
      id: "ep-mant", orgId: ORG, lineId: LINE, url: "https://x.test", secret: "s".repeat(20),
    });
    const viejo = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    await h.db.insert(webhookDeliveryTable).values([
      { id: "d-viejo", endpointId: "ep-mant", orgId: ORG, lineId: LINE, event: "message.received", payload: {}, createdAt: viejo },
      { id: "d-nuevo", endpointId: "ep-mant", orgId: ORG, lineId: LINE, event: "message.received", payload: {} },
    ]);

    const r = await runMaintenance(h.db, { diasDeEntregas: 30 });
    expect(r.entregasPurgadas).toBeGreaterThanOrEqual(1);
    const quedan = await h.db.select({ id: webhookDeliveryTable.id }).from(webhookDeliveryTable)
      .where(eq(webhookDeliveryTable.orgId, ORG));
    expect(quedan.map((d) => d.id)).toEqual(["d-nuevo"]);
  });

  it("desreferencia los medios cuya retención expiró, sin borrar el mensaje", async () => {
    // El mensaje se conserva: la auditoría necesita saber que hubo un adjunto.
    const ayer = new Date(Date.now() - 24 * 3600 * 1000);
    await h.db.insert(messageTable).values({
      id: "m-caducado", timestamp: new Date(), lineId: LINE, chatId: "c@s.whatsapp.net",
      senderAddress: "x@s.whatsapp.net", fromMe: false, kind: "image",
      mediaKey: "media/o/l/x.png", mediaMime: "image/png", mediaRetainUntil: ayer,
    });

    const r = await runMaintenance(h.db);
    expect(r.mediosCaducados).toBeGreaterThanOrEqual(1);

    const fila = await h.db.select().from(messageTable).where(eq(messageTable.id, "m-caducado"));
    expect(fila[0]!.mediaKey).toBeNull();
    expect(fila[0]!.kind).toBe("image");
  });

  it("es idempotente: correrlo dos veces no rompe nada", async () => {
    await expect(runMaintenance(h.db)).resolves.toBeDefined();
    await expect(runMaintenance(h.db)).resolves.toBeDefined();
  });
});
