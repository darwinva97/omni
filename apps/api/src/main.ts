import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { buildContainer } from "./container.js";
import { createApp } from "./app.js";

const config = loadConfig();
const container = await buildContainer(config);
const app = createApp(container);

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`omni api escuchando en http://127.0.0.1:${info.port}`);
  console.log(`  documentación  http://127.0.0.1:${info.port}/docs`);
  console.log(`  contrato       http://127.0.0.1:${info.port}/openapi.json`);
  if (config.SANDBOX_ENABLED) {
    console.log("  sandbox ACTIVO: se puede probar sin teléfono y sin riesgo de baneo");
  }
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal}: cerrando…`);
  server.close();
  await container.shutdown();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
