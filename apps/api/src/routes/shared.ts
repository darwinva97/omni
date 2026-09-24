import { z } from "@hono/zod-openapi";
import type { Principal } from "@omni/core";
import type { Container } from "../container.js";

export type ApiEnv = { Variables: { principal: Principal; container: Container } };

export const ProblemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number(), detail: z.string(),
}).openapi("Problem");

const problemContent = (description: string) => ({
  description, content: { "application/problem+json": { schema: ProblemSchema } },
});

/** Respuestas de error comunes a todas las rutas autenticadas. */
export const errors = {
  400: problemContent("petición inválida"),
  401: problemContent("sin autenticar"),
  403: problemContent("prohibido"),
  404: problemContent("no encontrado"),
  409: problemContent("conflicto de estado"),
  422: problemContent("no soportado por el transporte, o cuerpo inválido"),
};

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } }, description,
});

export const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
