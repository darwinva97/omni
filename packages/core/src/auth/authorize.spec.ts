import { describe, it, expect } from "vitest";
import { parseAddress } from "@omni/shared";
import { authorize, filterChats, filterLines } from "./authorize.js";
import type { Principal } from "./principal.js";
import { ROUTES, route } from "./routes.js";
import { canGrantRole, roleHas } from "./rbac.js";

const CHAT_A = parseAddress("51999000111@s.whatsapp.net");
const CHAT_B = parseAddress("51988000222@s.whatsapp.net");
const GROUP = parseAddress("12036-999@g.us");

const key = (over: Partial<Extract<Principal, { kind: "api-key" }>> = {}): Principal => ({
  kind: "api-key", apiKeyId: "k1", orgId: "o1", keyRole: "operator",
  allowedLines: [], allowedChats: [], ...over,
});

const user = (role: "owner" | "manager" | "agent" | "viewer", lineRoles = new Map()): Principal => ({
  kind: "user", userId: "u1", orgId: "o1", orgRole: role, lineRoles,
});

const ok = (p: Promise<void>) => expect(p).resolves.toBeUndefined();
const denied = (p: Promise<void>, status: number) => expect(p).rejects.toMatchObject({ status });

describe("alcance por línea", () => {
  it("vacío significa TODAS, incluidas las que se creen después", async () => {
    await ok(authorize(key(), route("line.status"), { lineId: "cualquiera" }));
  });

  it("nombrar una línea fuera de alcance da 401, no 403", async () => {
    // 401 y no 403 a propósito: un 403 confirmaría que esa línea existe.
    await denied(
      authorize(key({ allowedLines: ["l1"] }), route("line.status"), { lineId: "l2" }),
      401,
    );
  });

  it("una clave limitada a líneas no opera sobre la organización", async () => {
    await denied(authorize(key({ allowedLines: ["l1"] }), route("apikey.list")), 403);
  });
});

describe("permisos por rol", () => {
  it("un viewer lee pero no envía", async () => {
    await ok(authorize(user("viewer"), route("message.list"), { lineId: "l1", chat: CHAT_A }));
    await denied(authorize(user("viewer"), route("message.send"), { lineId: "l1", chat: CHAT_A }), 403);
  });

  it("el rol de línea manda sobre el de organización", async () => {
    // Un manager de la organización entra como viewer en una línea concreta.
    const p = user("manager", new Map([["l1", "viewer" as const]]));
    await denied(authorize(p, route("message.send"), { lineId: "l1", chat: CHAT_A }), 403);
    await ok(authorize(p, route("message.send"), { lineId: "l2", chat: CHAT_A }));
  });

  it("solo el owner borra líneas", async () => {
    await denied(authorize(user("manager"), route("line.delete"), { lineId: "l1" }), 403);
    await ok(authorize(user("owner"), route("line.delete"), { lineId: "l1" }));
  });

  it("nadie otorga un rol por encima del suyo", () => {
    expect(canGrantRole("manager", "owner")).toBe(false);
    expect(canGrantRole("manager", "agent")).toBe(true);
    expect(canGrantRole("owner", "owner")).toBe(true);
  });
});

describe("alcance por chat: denegación por defecto", () => {
  const scoped = key({ allowedChats: [CHAT_A.value] });

  it("alcanza sus chats", async () => {
    await ok(authorize(scoped, route("message.send"), { lineId: "l1", chat: CHAT_A }));
  });

  it("no alcanza otros chats", async () => {
    await denied(authorize(scoped, route("message.send"), { lineId: "l1", chat: CHAT_B }), 403);
  });

  it("puede leer, renombrar y salir de un grupo suyo, pero no tocar quién pertenece", async () => {
    const g = key({ allowedChats: [GROUP.value] });
    await ok(authorize(g, route("group.update"), { lineId: "l1", chat: GROUP }));
    await ok(authorize(g, route("group.leave"), { lineId: "l1", chat: GROUP }));
    await denied(authorize(g, route("group.participants"), { lineId: "l1", chat: GROUP }), 403);
    await denied(authorize(g, route("group.invite"), { lineId: "l1", chat: GROUP }), 403);
  });

  it("PROPIEDAD: toda ruta no marcada chatSafe se deniega, también las futuras", async () => {
    // Esta prueba es el contrato del modelo: añadir una ruta sin marcarla la
    // deja cerrada sola. Nadie tiene que acordarse de mantener una lista negra.
    for (const r of Object.values(ROUTES)) {
      if (r.chatSafe === true) continue;
      await denied(authorize(scoped, r, { lineId: "l1", chat: CHAT_A }), 403);
    }
  });

  it("una ruta de chat sin chat indicado se deniega", async () => {
    await denied(authorize(scoped, route("message.send"), { lineId: "l1" }), 403);
  });

  it("no afecta a una clave sin alcance de chat", async () => {
    await ok(authorize(key(), route("group.participants"), { lineId: "l1", chat: GROUP }));
  });
});

describe("identidad LID en el alcance por chat", () => {
  const lid = parseAddress("46274715893950@lid");
  const scopedByPhone = key({ allowedChats: [CHAT_A.value] });

  it("un LID mapeado al teléfono permitido pasa", async () => {
    await ok(
      authorize(scopedByPhone, route("message.send"), { lineId: "l1", chat: lid }, {
        resolveIdentity: async () => [CHAT_A.value],
      }),
    );
  });

  it("un LID SIN mapeo se rechaza en vez de adivinarse", async () => {
    // Adivinar por los dígitos confundiría a dos personas distintas.
    await denied(
      authorize(scopedByPhone, route("message.send"), { lineId: "l1", chat: lid }, {
        resolveIdentity: async () => null,
      }),
      403,
    );
  });

  it("los dígitos de un LID no abren el chat del teléfono homónimo", async () => {
    const homonimo = parseAddress("51999000111@lid");
    await denied(
      authorize(scopedByPhone, route("message.send"), { lineId: "l1", chat: homonimo }, {
        resolveIdentity: async () => null,
      }),
      403,
    );
  });
});

describe("filtrado de listados", () => {
  it("las listas se filtran en vez de rechazarse", async () => {
    const scoped = key({ allowedChats: [CHAT_A.value] });
    const chats = [{ a: CHAT_A.value }, { a: CHAT_B.value }];
    expect(filterChats(scoped, chats, (c) => c.a)).toEqual([{ a: CHAT_A.value }]);
    // Listar chats sí está permitido: devuelve los suyos, no un error.
    await ok(authorize(scoped, route("chat.list"), { lineId: "l1" }));
  });

  it("filtra líneas y respeta que vacío es todas", () => {
    const lines = [{ id: "l1" }, { id: "l2" }];
    expect(filterLines(key({ allowedLines: ["l1"] }), lines, (l) => l.id)).toEqual([{ id: "l1" }]);
    expect(filterLines(key(), lines, (l) => l.id)).toEqual(lines);
  });
});

describe("coherencia del catálogo", () => {
  it("todo permiso citado por una ruta existe", () => {
    for (const r of Object.values(ROUTES)) {
      expect(typeof roleHas("owner", r.permission)).toBe("boolean");
    }
  });

  it("el identificador de cada ruta coincide con su clave", () => {
    for (const [k, r] of Object.entries(ROUTES)) expect(r.id).toBe(k);
  });
});
