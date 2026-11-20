import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("salud del panel", () => {
  it("responde 200 sin preguntar a la API", async () => {
    // Si dependiera de la API, un reinicio de la API haría que Kubernetes
    // reiniciara también el panel.
    const r = GET();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ ok: true });
  });
});
