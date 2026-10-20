import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { loadConfig } from "./config.js";
import { buildContainer } from "./container.js";
import { createApp } from "./app.js";
import { registerWebSocketRoute } from "./routes/realtime.js";
import { RealtimeGateway } from "./realtime/gateway.js";

const config = loadConfig();
const container = await buildContainer(config);

/*
 * El orden importa: primero la app, luego el adaptador SOBRE ESA app, y solo
 * entonces la ruta del socket. Crear el adaptador con otra instancia lo deja
 * escuchando donde no es y el apretón de manos falla sin decir por qué.
 */
const app = createApp(container);
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const gateway = new RealtimeGateway(container.bus);
registerWebSocketRoute(app, container, gateway, upgradeWebSocket);

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  console.log(`omni api escuchando en http://${config.HOST}:${info.port}`);
  console.log(`  documentación  ${config.PUBLIC_URL}/docs`);
  console.log(`  contrato       ${config.PUBLIC_URL}/openapi.json`);
  console.log(`  tiempo real   ${config.PUBLIC_URL.replace(/^http/, "ws")}/v1/realtime/ws`);
  if (config.SANDBOX_ENABLED) {
    console.log("  sandbox ACTIVO: se puede probar sin teléfono y sin riesgo de baneo");
  }
});

injectWebSocket(server);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal}: cerrando…`);
  server.close();
  await gateway.cerrar();
  await container.shutdown();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
