import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress, type LineId } from "@omni/shared";
import { assertCapability, type ChannelDriver, type NewsletterMetadata } from "@omni/channels";
import { authorize, route as routeOf } from "@omni/core";
import { lineTable } from "@omni/db";
import { eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Canales (newsletters).
 *
 * Son de una sola dirección: el dueño publica y el resto lee. Por eso leer y
 * publicar son capacidades distintas, y casi ningún transporte tiene la
 * segunda: la API oficial no los ve, y whatsapp-web.js no los soporta de forma
 * estable. Cuando el transporte no puede, se dice con un 422 nombrando cuál sí.
 */
const NewsletterSchema = z.object({
  address: z.string(),
  name: z.string(),
  description: z.string().optional(),
  inviteCode: z.string().optional(),
  inviteUrl: z.string().optional(),
  subscribers: z.number().optional(),
  verified: z.boolean().optional(),
  role: z.enum(["owner", "admin", "subscriber", "guest"]).optional(),
  createdAt: z.number().optional(),
}).openapi("Newsletter");

const present = (m: NewsletterMetadata) => ({
  address: m.address.value,
  name: m.name,
  ...(m.description ? { description: m.description } : {}),
  ...(m.inviteCode
    ? { inviteCode: m.inviteCode, inviteUrl: `https://whatsapp.com/channel/${m.inviteCode}` }
    : {}),
  ...(m.subscribers !== undefined ? { subscribers: m.subscribers } : {}),
  ...(m.verified !== undefined ? { verified: m.verified } : {}),
  ...(m.role ? { role: m.role } : {}),
  ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
});

export function registerNewsletterRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const driverOf = async (lineId: string): Promise<ChannelDriver> => {
    const rows = await container.dbh.db
      .select({ kind: lineTable.channelKind })
      .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    if (!rows[0]) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
    return container.runtime.driverFor(rows[0].kind);
  };
  const Ok = z.object({ data: z.object({ ok: z.boolean() }) });

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/newsletters/{newsletterId}", tags: ["canales"],
      summary: "Datos de un canal",
      description:
        "El identificador puede ser una dirección `...@newsletter` o el código de " +
        "un enlace `whatsapp.com/channel/<código>`, que es como circulan de verdad.",
      request: { params: z.object({ lineId: z.string(), newsletterId: z.string() }) },
      responses: { 200: json(z.object({ data: NewsletterSchema }), "el canal"), ...errors },
    }),
    async (c) => {
      const { lineId, newsletterId } = c.req.valid("param");
      const crudo = decodeURIComponent(newsletterId);
      const esDireccion = crudo.includes("@");
      const chat = esDireccion ? parseAddress(crudo) : undefined;
      await authorize(c.get("principal"), routeOf("newsletter.read"), {
        lineId, ...(chat ? { chat } : {}),
      });
      const driver = await driverOf(lineId);
      assertCapability(driver, "newsletter.read");

      const meta = esDireccion
        ? await driver.newsletterMetadata!(lineId as LineId, chat!)
        : await driver.newsletterByInvite!(lineId as LineId, crudo);
      return c.json({ data: present(meta) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/newsletters/{newsletterId}/follow", tags: ["canales"],
      summary: "Seguir o dejar de seguir un canal",
      request: {
        params: z.object({ lineId: z.string(), newsletterId: z.string() }),
        ...body(z.object({ follow: z.boolean() })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, newsletterId } = c.req.valid("param");
      const { follow } = c.req.valid("json");
      const newsletter = parseAddress(decodeURIComponent(newsletterId));
      await authorize(c.get("principal"), routeOf("newsletter.follow"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "newsletter.read");

      if (follow) await driver.followNewsletter!(lineId as LineId, newsletter);
      else await driver.unfollowNewsletter!(lineId as LineId, newsletter);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/newsletters", tags: ["canales"],
      summary: "Crear un canal",
      description:
        "Necesita `newsletter.send`: crear un canal es poder publicar en él, y un " +
        "transporte que solo sabe leerlos no puede hacerlo.",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({
          name: z.string().min(1).max(100),
          description: z.string().max(2048).optional(),
        })),
      },
      responses: { 201: json(z.object({ data: NewsletterSchema }), "creado"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { name, description } = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("newsletter.create"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "newsletter.send");
      if (!driver.createNewsletter) {
        throw new OmniError("capability_unsupported", "este transporte no sabe crear canales");
      }
      const meta = await driver.createNewsletter(lineId as LineId, name, description);
      return c.json({ data: present(meta) }, 201);
    },
  );
}
