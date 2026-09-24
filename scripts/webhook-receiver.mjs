/**
 * Receptor de webhooks de ejemplo. Verifica la firma exactamente como debe
 * hacerlo una integración real: sobre el cuerpo CRUDO, antes de parsear el JSON.
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";

const SECRET = process.env.WEBHOOK_SECRET ?? process.argv[2];
const PORT = Number(process.env.PORT ?? 4100);
const LOG = process.env.LOG ?? "/home/maka/projects/omni/.data/recibidos.log";

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // El cuerpo crudo: cualquier middleware que consuma el flujo deja sin nada
    // que hashear, y es el error número uno al integrar webhooks firmados.
    const raw = Buffer.concat(chunks).toString("utf8");
    const header = String(req.headers["x-omni-signature"] ?? "");
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
    const expected = createHmac("sha256", SECRET).update(`${parts.t}.${raw}`).digest("hex");
    const a = Buffer.from(parts.v1 ?? "", "utf8");
    const b = Buffer.from(expected, "utf8");
    const valido = a.length === b.length && timingSafeEqual(a, b);

    const { event, data } = JSON.parse(raw);
    const texto = data?.text ?? data?.state ?? data?.self ?? "";
    appendFileSync(LOG, `${valido ? "firma-ok " : "FIRMA-MAL"} ${event.padEnd(20)} ${JSON.stringify(texto)}\n`);
    res.writeHead(valido ? 200 : 401).end(valido ? "ok" : "firma inválida");
  });
}).listen(PORT, "127.0.0.1", () => console.log(`receptor escuchando en ${PORT}`));
