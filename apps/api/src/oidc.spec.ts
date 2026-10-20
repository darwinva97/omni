import { describe, it, expect, beforeAll } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import { destinoSeguro, identidadDesdeClaims, OidcClient, OidcError, pkceChallenge } from "./oidc.js";

const ISSUER = "https://idp.ejemplo.com/realms/r";
const CLIENT = "omni";

let privada: CryptoKey;
let ajena: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const par = await generateKeyPair("RS256");
  privada = par.privateKey;
  ajena = (await generateKeyPair("RS256")).privateKey;
  getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(par.publicKey)), kid: "k1", alg: "RS256" }] });
});

const firmar = (claims: Record<string, unknown>, opts: { key?: CryptoKey; iss?: string; aud?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? CLIENT)
    .setSubject("sub-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(opts.key ?? privada);

/** Proveedor de mentira: discovery y token endpoint, sin red. */
function proveedor(idToken: () => Promise<string>, visto: { body?: URLSearchParams } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/certs`,
      });
    }
    if (url === `${ISSUER}/token`) {
      visto.body = new URLSearchParams(String(init?.body));
      return Response.json({ id_token: await idToken() });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}

const cliente = (fetchImpl: typeof fetch, allowedGroups: string[] = []) => new OidcClient({
  issuer: ISSUER, clientId: CLIENT, clientSecret: "secreto", redirectUri: "https://omni.ejemplo.com/v1/auth/oidc/callback",
  displayName: "Keycloak", allowedGroups, groupsClaim: "groups",
}, { fetchImpl, getKey });

const persona = { email: "Ana@Ejemplo.com", email_verified: true, name: "Ana", nonce: "n-1", groups: ["admins"] };

describe("entrada OIDC", () => {
  it("canjea el código con PKCE y devuelve la identidad con el correo normalizado", async () => {
    const visto: { body?: URLSearchParams } = {};
    const id = await cliente(proveedor(() => firmar(persona), visto)).exchange("codigo", { verifier: "v-1", nonce: "n-1" });
    expect(id).toEqual({ subject: "sub-1", email: "ana@ejemplo.com", name: "Ana" });
    expect(visto.body?.get("code_verifier")).toBe("v-1");
    expect(visto.body?.get("grant_type")).toBe("authorization_code");
  });

  it("la URL de autorización lleva state, nonce y el reto PKCE S256, no el verificador", async () => {
    const url = new URL(await cliente(proveedor(() => firmar(persona))).authorizeUrl({ state: "s", nonce: "n", verifier: "v" }));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`);
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("nonce")).toBe("n");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge("v"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("verifier");
  });

  it("rechaza un token firmado con otra clave", async () => {
    // Sin comprobar la firma, cualquiera fabricaría un token con el correo del dueño.
    await expect(cliente(proveedor(() => firmar(persona, { key: ajena }))).exchange("c", { verifier: "v", nonce: "n-1" }))
      .rejects.toBeInstanceOf(OidcError);
  });

  it("rechaza un token emitido para otro cliente o por otro emisor", async () => {
    await expect(cliente(proveedor(() => firmar(persona, { aud: "otra-app" }))).exchange("c", { verifier: "v", nonce: "n-1" }))
      .rejects.toBeInstanceOf(OidcError);
    await expect(cliente(proveedor(() => firmar(persona, { iss: "https://otro" }))).exchange("c", { verifier: "v", nonce: "n-1" }))
      .rejects.toBeInstanceOf(OidcError);
  });

  it("rechaza un token de otro inicio de sesión (nonce distinto)", async () => {
    await expect(cliente(proveedor(() => firmar(persona))).exchange("c", { verifier: "v", nonce: "otro" }))
      .rejects.toMatchObject({ motivo: "sso" });
  });

  it("no acepta un correo sin verificar: es lo que une la cuenta del proveedor con la de Omni", () => {
    expect(() => identidadDesdeClaims({ ...persona, email_verified: false, sub: "s" }, { nonce: "n-1", allowedGroups: [], groupsClaim: "groups" }))
      .toThrow(expect.objectContaining({ motivo: "sso-correo" }));
    expect(() => identidadDesdeClaims({ ...persona, email: undefined, sub: "s" }, { nonce: "n-1", allowedGroups: [], groupsClaim: "groups" }))
      .toThrow(expect.objectContaining({ motivo: "sso-correo" }));
  });

  it("con grupos configurados, exige pertenecer a alguno (acepta la ruta completa de Keycloak)", () => {
    const esperado = { nonce: "n-1", allowedGroups: ["admins", "devs"], groupsClaim: "groups" };
    expect(identidadDesdeClaims({ ...persona, sub: "s", groups: ["/devs"] }, esperado).email).toBe("ana@ejemplo.com");
    expect(() => identidadDesdeClaims({ ...persona, sub: "s", groups: ["ventas"] }, esperado))
      .toThrow(expect.objectContaining({ motivo: "sso-grupo" }));
    expect(() => identidadDesdeClaims({ ...persona, sub: "s", groups: undefined }, esperado))
      .toThrow(expect.objectContaining({ motivo: "sso-grupo" }));
  });

  it("solo vuelve a rutas propias: no es un redirector abierto", () => {
    expect(destinoSeguro("/lineas/abc?x=1")).toBe("/lineas/abc?x=1");
    for (const malo of ["https://evil.com", "//evil.com", "/\\evil.com", "evil.com", "", undefined, null]) {
      expect(destinoSeguro(malo)).toBe("/");
    }
  });

  it("si el emisor anunciado no es el configurado, no sigue", async () => {
    const f = (async () => Response.json({ issuer: "https://suplantador", authorization_endpoint: "x", token_endpoint: "x", jwks_uri: "x" })) as unknown as typeof fetch;
    await expect(cliente(f).authorizeUrl({ state: "s", nonce: "n", verifier: "v" })).rejects.toThrow(/emisor/);
  });
});
