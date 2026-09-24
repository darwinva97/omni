/**
 * Siembra una organización, una línea de sandbox y una clave de administración.
 * Es el camino más corto entre un repositorio recién clonado y un mensaje enviado.
 */
import { createDatabase, lineTable, orgTable, apiKeyTable, migrate } from "@omni/db";
import { mintApiKey } from "../keys.js";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("falta DATABASE_URL");

await migrate(url);
const { db, close } = createDatabase(url);

const orgId = process.env["SEED_ORG"] ?? "org-demo";
const lineId = process.env["SEED_LINE"] ?? "line-demo";

await db.insert(orgTable).values({ id: orgId, name: "Demo", slug: "demo" }).onConflictDoNothing();
await db.insert(lineTable).values({
  id: lineId, orgId, channelKind: "sandbox", name: "Línea de demostración",
  slug: "demo", address: "51999888777@s.whatsapp.net", sendRatePerMinute: 600,
}).onConflictDoNothing();

const key = await mintApiKey();
await db.insert(apiKeyTable).values({
  id: `k-${key.prefix}`, orgId, name: "clave de demostración",
  prefix: key.prefix, secretHash: key.secretHash, role: "admin",
});

console.log(JSON.stringify({ orgId, lineId, apiKey: key.plaintext }, null, 2));
await close();
