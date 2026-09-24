import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError } from "@omni/shared";
import type { CloudDriver, CloudWebhookPayload } from "@omni/channels";
import { lineTable } from "@omni/db";
import { eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json } from "./shared.js";

/**
 * Entrada de los webhooks de Meta.
 *
 * Es la diferencia de fondo del transporte oficial: no hay socket, Meta empuja
 * aquí. La ruta va SIN credencial nuestra —Meta no la tiene— y se autentica
 * con la firma del cuerpo usando el secreto de la app.
 */
export function registerCloudWebhookRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const driverDe = async (lineId: string): Promise<CloudDriver> => {
    const filas = await container.dbh.db
      .select({ kind: lineTable.channelKind })
      .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    if (!filas[0]) throw new OmniError("not_found", "no encontrado");
    if (filas[0].kind !== "whatsapp.cloud") {
      throw new OmniError("not_found", "no encontrado");
    }
    return container.runtime.driverFor("whatsapp.cloud") as CloudDriver;
  };

  /**
   * Meta comprueba la URL antes de empezar a empujar: manda un `hub.challenge`
   * que hay que devolver tal cual, en texto plano.
   */
  app.openapi(
    createRoute({
      method: "get", path: "/v1/channels/cloud/{lineId}/webhook", tags: ["whatsapp cloud"],
      summary: "Verificación de la URL por parte de Meta",
      request: {
        params: z.object({ lineId: z.string() }),
        query: z.object({
          "hub.mode": z.string().optional(),
          "hub.verify_token": z.string().optional(),
          "hub.challenge": z.string().optional(),
        }),
      },
      responses: {
        200: { description: "el reto, en texto plano", content: { "text/plain": { schema: z.string() } } },
        403: errors[403],
      },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const q = c.req.valid("query");

      const filas = await container.dbh.db
        .select({ cfg: lineTable.driverConfig })
        .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
      const esperado = filas[0]?.cfg?.["verifyToken"];

      if (q["hub.mode"] !== "subscribe" || !esperado || q["hub.verify_token"] !== esperado) {
        throw new OmniError("forbidden", "verificación rechazada");
      }
      return c.text(q["hub.challenge"] ?? "", 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/channels/cloud/{lineId}/webhook", tags: ["whatsapp cloud"],
      summary: "Entrada de eventos empujados por Meta",
      description:
        "No lleva credencial nuestra: se autentica con `X-Hub-Signature-256`, que " +
        "Meta calcula con el secreto de la app. Sin esa comprobación, quien " +
        "conozca la URL puede inventar mensajes entrantes en nombre de tus clientes.",
      request: { params: z.object({ lineId: z.string() }) },
      responses: {
        200: json(z.object({ data: z.object({ procesados: z.number() }) }), "recibido"),
        403: errors[403],
        404: errors[404],
      },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const driver = await driverDe(lineId);

      // El cuerpo CRUDO: volver a serializar el JSON cambiaría el hash.
      const crudo = await c.req.text();
      const firma = c.req.header("x-hub-signature-256");
      if (!driver.verifyWebhookSignature(lineId, crudo, firma)) {
        throw new OmniError("forbidden", "firma de Meta inválida");
      }

      const payload = JSON.parse(crudo) as CloudWebhookPayload;
      const procesados = await driver.ingestWebhook(lineId, payload);

      // Meta reintenta si no respondemos rápido, y un reintento duplica los
      // mensajes: se acusa enseguida y el trabajo pesado ya va por la cola.
      return c.json({ data: { procesados } }, 200);
    },
  );
}
