/**
 * Comprobación en vivo del tiempo real.
 *
 * Usa el WebSocket nativo de Node 22: sin dependencias, así que se puede
 * ejecutar desde cualquier sitio sin instalar nada.
 */
const base = process.env.OMNI_URL ?? "http://127.0.0.1:4010";
const key = process.env.OMNI_API_KEY;
const line = process.env.OMNI_LINE ?? "line-demo";
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

const { data } = await (await fetch(`${base}/v1/realtime/ticket`, { method: "POST", headers: H })).json();
console.log(`  billete emitido, caduca en ${data.expiresIn}s`);

const recibidos = [];
const ws = new WebSocket(`${base.replace("http", "ws")}${data.url}?ticket=${data.ticket}`);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("el apretón de manos del WebSocket falló"));
});
ws.onmessage = (e) => recibidos.push(JSON.parse(e.data));
await new Promise((r) => setTimeout(r, 300));

ws.send(JSON.stringify({ type: "subscribe", events: ["message.*", "session.*"] }));
await new Promise((r) => setTimeout(r, 300));

await fetch(`${base}/v1/lines/${line}/connect`, { method: "POST", headers: H });
await fetch(`${base}/v1/sandbox/lines/${line}/scan`, { method: "POST", headers: H, body: JSON.stringify({ phone: "51999888777" }) });
await fetch(`${base}/v1/sandbox/lines/${line}/inbound`, { method: "POST", headers: H, body: JSON.stringify({ from: "51988777666", text: "por WebSocket" }) });
await fetch(`${base}/v1/lines/${line}/messages`, { method: "POST", headers: H, body: JSON.stringify({ to: "51988777666", text: "respondo", clientMessageId: `ws-${Date.now()}` }) });
await new Promise((r) => setTimeout(r, 2000));

console.log("  llegados por el socket, en vivo:");
for (const m of recibidos) {
  const d = m.type === "event" ? `${m.event.padEnd(20)} ${JSON.stringify(m.data?.text ?? m.data?.state ?? "")}` : m.type;
  console.log(`    ${d}`);
}

const ws2 = new WebSocket(`${base.replace("http", "ws")}${data.url}?ticket=${data.ticket}`);
console.log("  reutilizar el billete:", await new Promise((res) => {
  ws2.onopen = () => res("ACEPTADO — mal");
  ws2.onerror = () => res("rechazado — bien");
  setTimeout(() => res("sin respuesta"), 3000);
}));
ws.close();
process.exit(0);
