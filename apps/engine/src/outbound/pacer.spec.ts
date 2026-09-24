import { describe, it, expect } from "vitest";
import { MemoryKv } from "@omni/platform";
import { SendPacer } from "./pacer.js";

describe("marcapasos de envío", () => {
  const harness = (rate: number) => {
    let now = 1_000_000;
    const slept: number[] = [];
    const pacer = new SendPacer(new MemoryKv(), {
      now: () => now,
      sleep: async (ms) => { slept.push(ms); now += ms; },
    });
    return { pacer, slept, advance: (ms: number) => { now += ms; }, rate };
  };

  it("el primer envío no espera", async () => {
    const h = harness(12);
    expect(await h.pacer.pace("l1", 12)).toBe(0);
  });

  it("espacia los envíos al ritmo configurado", async () => {
    // 12 por minuto = uno cada 5 segundos.
    const h = harness(12);
    await h.pacer.pace("l1", 12);
    expect(await h.pacer.pace("l1", 12)).toBe(5000);
    expect(await h.pacer.pace("l1", 12)).toBe(5000);
  });

  it("no espera si ya pasó el intervalo", async () => {
    const h = harness(12);
    await h.pacer.pace("l1", 12);
    h.advance(9000);
    expect(await h.pacer.pace("l1", 12)).toBe(0);
  });

  it("cada línea lleva su propio ritmo", async () => {
    const h = harness(12);
    await h.pacer.pace("l1", 12);
    expect(await h.pacer.pace("l2", 12)).toBe(0);
  });

  it("ritmo cero o negativo desactiva la espera", async () => {
    const h = harness(0);
    await h.pacer.pace("l1", 0);
    expect(await h.pacer.pace("l1", 0)).toBe(0);
  });

  it("un ritmo alto espacia menos", async () => {
    const h = harness(60);
    await h.pacer.pace("l1", 60);
    expect(await h.pacer.pace("l1", 60)).toBe(1000);
  });
});
