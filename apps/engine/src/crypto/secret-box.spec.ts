import { describe, it, expect } from "vitest";
import { SecretBox, SecretBoxError, deriveKey, secretsEqual } from "./secret-box.js";

const MASTER = "a".repeat(64).replace(/a/g, "3"); // 64 hex válidos
const FRASE = "una frase larga de al menos treinta y dos caracteres";

describe("caja sellada de credenciales", () => {
  it("cierra y abre conservando los bytes", () => {
    const box = new SecretBox(MASTER);
    const secreto = new TextEncoder().encode("credenciales de la línea");
    expect(new TextDecoder().decode(box.open(box.seal(secreto)))).toBe("credenciales de la línea");
  });

  it("dos sellados del mismo contenido son distintos", () => {
    // Si fueran iguales, quien vea la base de datos sabría qué líneas comparten
    // credenciales sin necesitar la clave.
    const box = new SecretBox(MASTER);
    const plain = new TextEncoder().encode("igual");
    expect(box.seal(plain)).not.toBe(box.seal(plain));
  });

  it("una caja manipulada no se abre en vez de devolver basura", () => {
    const box = new SecretBox(MASTER);
    const sealed = box.seal(new TextEncoder().encode("intacto"));
    const parts = sealed.split(".");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("otra cosa").toString("base64url")].join(".");
    expect(() => box.open(tampered)).toThrow(SecretBoxError);
  });

  it("otra clave maestra no abre la caja", () => {
    const sealed = new SecretBox(MASTER).seal(new TextEncoder().encode("x"));
    expect(new SecretBox(FRASE).canOpen(sealed)).toBe(false);
  });

  it("rechaza una clave maestra débil explicando el riesgo", () => {
    expect(() => deriveKey("corta")).toThrow(/TODAS las sesiones/);
  });

  it("acepta tanto 64 hex como una frase larga", () => {
    expect(deriveKey(MASTER)).toHaveLength(32);
    expect(deriveKey(FRASE)).toHaveLength(32);
  });

  it("compara secretos en tiempo constante", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
  });
});
