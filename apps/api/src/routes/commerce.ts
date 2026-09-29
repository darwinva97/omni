import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress, type LineId } from "@omni/shared";
import {
  assertCapability,
  type ChannelDriver, type CommunityMetadata, type Product, type ProductInput,
} from "@omni/channels";
import { authorize, route as routeOf } from "@omni/core";
import { lineTable } from "@omni/db";
import { eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Comunidades y catálogo.
 *
 * Una comunidad es un grupo de GRUPOS: enlazar uno no es añadir un
 * participante, y por eso no cuelga de las rutas de grupos. El catálogo solo
 * existe en cuentas de empresa; donde no lo hay, la respuesta es 422 diciendo
 * qué transporte sí lo tiene, no una lista vacía que parezca un catálogo sin
 * productos.
 */
const CommunitySchema = z.object({
  address: z.string(),
  subject: z.string(),
  description: z.string().optional(),
  owner: z.string().optional(),
  linkedGroups: z.array(z.object({
    address: z.string(), subject: z.string(), size: z.number().optional(),
  })),
  size: z.number().optional(),
}).openapi("Community");

const ProductSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(),
  price: z.number(), currency: z.string(),
  retailerId: z.string().optional(), url: z.string().optional(),
  imageUrls: z.array(z.string()),
  hidden: z.boolean().optional(),
  availability: z.string().optional(),
  reviewStatus: z.string().optional(),
}).openapi("Product");

const ProductBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4096),
  /** En la unidad menor de la moneda: céntimos, no euros. */
  price: z.number().int().min(0),
  currency: z.string().length(3),
  imageUrls: z.array(z.string().url()).min(1).max(10),
  retailerId: z.string().max(100).optional(),
  url: z.string().url().optional(),
  hidden: z.boolean().optional(),
  originCountryCode: z.string().length(2).optional(),
});

const presentarComunidad = (c: CommunityMetadata) => ({
  address: c.address.value,
  subject: c.subject,
  ...(c.description ? { description: c.description } : {}),
  ...(c.owner ? { owner: c.owner.value } : {}),
  linkedGroups: c.linkedGroups.map((g) => ({
    address: g.address.value, subject: g.subject,
    ...(g.size !== undefined ? { size: g.size } : {}),
  })),
  ...(c.size !== undefined ? { size: c.size } : {}),
});

const presentarProducto = (p: Product) => ({
  id: p.id, name: p.name, description: p.description,
  price: p.price, currency: p.currency,
  ...(p.retailerId ? { retailerId: p.retailerId } : {}),
  ...(p.url ? { url: p.url } : {}),
  imageUrls: [...p.imageUrls],
  ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
  ...(p.availability ? { availability: p.availability } : {}),
  ...(p.reviewStatus ? { reviewStatus: p.reviewStatus } : {}),
});

export function registerCommerceRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const driverOf = async (lineId: string): Promise<ChannelDriver> => {
    const rows = await container.dbh.db
      .select({ kind: lineTable.channelKind })
      .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    if (!rows[0]) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
    return container.runtime.driverFor(rows[0].kind);
  };
  const Ok = z.object({ data: z.object({ ok: z.boolean() }) });
  const lineParam = z.object({ lineId: z.string() });

  // ------------------------------------------------------------ comunidades

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/communities", tags: ["comunidades"],
      summary: "Comunidades a las que pertenece la línea, con sus grupos",
      request: { params: lineParam },
      responses: { 200: json(z.object({ data: z.array(CommunitySchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("community.read"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "community.read");
      const todas = await driver.listCommunities!(lineId as LineId);
      return c.json({ data: todas.map(presentarComunidad) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/communities/{communityId}", tags: ["comunidades"],
      summary: "Datos de una comunidad y los grupos que cuelgan de ella",
      request: { params: lineParam.extend({ communityId: z.string() }) },
      responses: { 200: json(z.object({ data: CommunitySchema }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId, communityId } = c.req.valid("param");
      const comunidad = parseAddress(decodeURIComponent(communityId));
      await authorize(c.get("principal"), routeOf("community.read"), { lineId, chat: comunidad });
      const driver = await driverOf(lineId);
      assertCapability(driver, "community.read");
      const meta = await driver.communityMetadata!(lineId as LineId, comunidad);
      return c.json({ data: presentarComunidad(meta) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/communities", tags: ["comunidades"],
      summary: "Crear una comunidad",
      request: {
        params: lineParam,
        ...body(z.object({
          subject: z.string().min(1).max(100),
          description: z.string().max(2048).default(""),
        })),
      },
      responses: { 201: json(z.object({ data: CommunitySchema }), "creada"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { subject, description } = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("community.manage"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "community.manage");
      const meta = await driver.createCommunity!(lineId as LineId, subject, description);
      return c.json({ data: presentarComunidad(meta) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/communities/{communityId}/groups", tags: ["comunidades"],
      summary: "Enlazar o desenlazar un grupo de una comunidad",
      description:
        "Enlazar NO es añadir un participante: son dos pertenencias distintas " +
        "que se cambian por separado. Desenlazar deja el grupo en pie.",
      request: {
        params: lineParam.extend({ communityId: z.string() }),
        ...body(z.object({ groupId: z.string().min(1), linked: z.boolean().default(true) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, communityId } = c.req.valid("param");
      const { groupId, linked } = c.req.valid("json");
      const comunidad = parseAddress(decodeURIComponent(communityId));
      const grupo = parseAddress(groupId);
      await authorize(c.get("principal"), routeOf("community.manage"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "community.manage");
      if (linked) await driver.linkGroupToCommunity!(lineId as LineId, grupo, comunidad);
      else await driver.unlinkGroupFromCommunity!(lineId as LineId, grupo, comunidad);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/communities/{communityId}/leave", tags: ["comunidades"],
      summary: "Salir de una comunidad",
      description: "No disuelve los grupos enlazados: siguen existiendo por su cuenta.",
      request: { params: lineParam.extend({ communityId: z.string() }) },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, communityId } = c.req.valid("param");
      const comunidad = parseAddress(decodeURIComponent(communityId));
      await authorize(c.get("principal"), routeOf("community.manage"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "community.manage");
      await driver.leaveCommunity!(lineId as LineId, comunidad);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  // ------------------------------------------------------------ catálogo

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/products", tags: ["catálogo"],
      summary: "Catálogo de la línea, o el de otra cuenta de empresa",
      description:
        "`of` lee el catálogo de OTRO número; sin él, el propio. Los precios van " +
        "en la unidad menor de la moneda: 2500 son 25,00.",
      request: {
        params: lineParam,
        query: z.object({
          of: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(ProductSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { of, limit } = c.req.valid("query");
      await authorize(c.get("principal"), routeOf("catalog.read"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "catalog.read");
      const productos = await driver.listProducts!(
        lineId as LineId, of ? parseAddress(of) : null, limit,
      );
      return c.json({ data: productos.map(presentarProducto) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/collections", tags: ["catálogo"],
      summary: "Colecciones del catálogo",
      request: {
        params: lineParam,
        query: z.object({
          of: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          id: z.string(), name: z.string(),
          products: z.array(ProductSchema), status: z.string().optional(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { of, limit } = c.req.valid("query");
      await authorize(c.get("principal"), routeOf("catalog.read"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "catalog.read");
      const colecciones = await driver.listCollections!(
        lineId as LineId, of ? parseAddress(of) : null, limit,
      );
      return c.json({ data: colecciones.map((col) => ({
        id: col.id, name: col.name,
        products: col.products.map(presentarProducto),
        ...(col.status ? { status: col.status } : {}),
      })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/products", tags: ["catálogo"],
      summary: "Publicar un producto",
      description:
        "Nace PENDIENTE de revisión y no se ve hasta que WhatsApp lo aprueba. " +
        "Editarlo vuelve a mandarlo a revisión.",
      request: { params: lineParam, ...body(ProductBody) },
      responses: { 201: json(z.object({ data: ProductSchema }), "creado"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const input = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("catalog.manage"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "catalog.manage");
      const producto = await driver.createProduct!(lineId as LineId, input as ProductInput);
      return c.json({ data: presentarProducto(producto) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "put", path: "/v1/lines/{lineId}/products/{productId}", tags: ["catálogo"],
      summary: "Reemplazar un producto; vuelve a revisión",
      request: {
        params: lineParam.extend({ productId: z.string() }),
        ...body(ProductBody),
      },
      responses: { 200: json(z.object({ data: ProductSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId, productId } = c.req.valid("param");
      const input = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("catalog.manage"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "catalog.manage");
      const producto = await driver.updateProduct!(
        lineId as LineId, decodeURIComponent(productId), input as ProductInput,
      );
      return c.json({ data: presentarProducto(producto) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/products/{productId}", tags: ["catálogo"],
      summary: "Retirar un producto del catálogo",
      request: { params: lineParam.extend({ productId: z.string() }) },
      responses: {
        200: json(z.object({ data: z.object({ deleted: z.number() }) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, productId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("catalog.manage"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "catalog.manage");
      const borrados = await driver.deleteProducts!(lineId as LineId, [decodeURIComponent(productId)]);
      if (borrados === 0) throw new OmniError("not_found", "ese producto no existe en el catálogo");
      return c.json({ data: { deleted: borrados } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/orders/{orderId}", tags: ["catálogo"],
      summary: "Detalle de un pedido",
      description:
        "El testigo viene DENTRO del mensaje del pedido y es de un solo uso: sin " +
        "él no hay forma de leerlo, ni siquiera siendo su destinatario.",
      request: {
        params: lineParam.extend({ orderId: z.string() }),
        query: z.object({ token: z.string().min(1) }),
      },
      responses: {
        200: json(z.object({ data: z.object({
          currency: z.string(), total: z.number(),
          products: z.array(z.object({
            id: z.string(), name: z.string(), quantity: z.number(),
            price: z.number(), currency: z.string(), imageUrl: z.string().optional(),
          })),
        }) }), "el pedido"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, orderId } = c.req.valid("param");
      const { token } = c.req.valid("query");
      await authorize(c.get("principal"), routeOf("catalog.read"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "catalog.read");
      const pedido = await driver.orderDetails!(
        lineId as LineId, decodeURIComponent(orderId), token,
      );
      return c.json({ data: {
        currency: pedido.currency, total: pedido.total,
        products: pedido.products.map((p) => ({
          id: p.id, name: p.name, quantity: p.quantity,
          price: p.price, currency: p.currency,
          ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
        })),
      } }, 200);
    },
  );
}
