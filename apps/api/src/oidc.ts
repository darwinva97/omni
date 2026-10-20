import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * Entrada con un proveedor OpenID Connect (Keycloak, en la instalación de k3s).
 *
 * Flujo de código con PKCE, cliente confidencial. El proveedor solo dice QUIÉN
 * es la persona; a qué organización pertenece y con qué rol sigue decidiéndolo
 * Omni. Por eso no se da de alta a nadie: entra quien ya tiene cuenta (por
 * invitación o porque creó la organización), con el mismo correo.
 */

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly displayName: string;
  /** Si no está vacía, hace falta pertenecer a alguno de estos grupos del proveedor. */
  readonly allowedGroups: readonly string[];
  readonly groupsClaim: string;
}

interface Discovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

export interface OidcIdentity {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
  /** Sesión del proveedor (`sid`), para poder cerrar la nuestra cuando él la cierre. */
  readonly sessionId: string | null;
}

/** Motivo por el que no se deja entrar; el panel enseña un mensaje por cada uno. */
export type OidcRechazo =
  | "sso" | "sso-correo" | "sso-grupo" | "sso-sin-cuenta"
  | "sso-invitacion" | "sso-invitacion-correo";

const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";

export class OidcError extends Error {
  readonly motivo: OidcRechazo;
  constructor(motivo: OidcRechazo, detalle: string) {
    super(detalle);
    this.motivo = motivo;
  }
}

/** Aleatorio en base64url, para `state`, `nonce` y el verificador PKCE. */
export const aleatorio = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/**
 * A dónde volver tras entrar. Solo rutas propias: aceptar una URL completa
 * convertiría la entrada en un redirector abierto, útil para phishing con un
 * enlace que de verdad empieza por nuestro dominio.
 */
export function destinoSeguro(next: string | undefined | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

/**
 * Comprueba lo que el token dice de la persona, una vez verificada la firma.
 *
 * El correo verificado no es un detalle: es lo que une la cuenta de Keycloak
 * con la de Omni. Si valiera uno sin verificar, cualquiera que pudiera escribir
 * su correo en el proveedor entraría como otra persona.
 */
export function identidadDesdeClaims(
  claims: JWTPayload & Record<string, unknown>,
  esperado: { nonce: string; allowedGroups: readonly string[]; groupsClaim: string },
): OidcIdentity {
  if (claims.nonce !== esperado.nonce) {
    throw new OidcError("sso", "el nonce del token no corresponde a este inicio de sesión");
  }
  const email = typeof claims["email"] === "string" ? claims["email"].trim().toLowerCase() : "";
  if (!email) throw new OidcError("sso-correo", "el proveedor no envió el correo");
  if (claims["email_verified"] !== true) {
    throw new OidcError("sso-correo", "el correo no está verificado en el proveedor");
  }
  if (esperado.allowedGroups.length > 0) {
    const raw = claims[esperado.groupsClaim];
    const grupos = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string") : [];
    // Keycloak puede mandar la ruta completa ("/admins"); se comparan los nombres.
    const nombres = grupos.map((g) => g.replace(/^\//, ""));
    if (!esperado.allowedGroups.some((g) => nombres.includes(g))) {
      throw new OidcError("sso-grupo", "no pertenece a ningún grupo con acceso");
    }
  }
  const name =
    (typeof claims["name"] === "string" && claims["name"].trim()) ||
    (typeof claims["preferred_username"] === "string" && claims["preferred_username"]) ||
    email;
  if (typeof claims.sub !== "string" || !claims.sub) throw new OidcError("sso", "token sin sujeto");
  const sid = typeof claims["sid"] === "string" && claims["sid"] ? claims["sid"] : null;
  return { subject: claims.sub, email, name, sessionId: sid };
}

/**
 * Comprueba un aviso de cierre de sesión (OIDC Back-Channel Logout 1.0) ya
 * verificado en firma, emisor y audiencia. Es un token, pero NO de identidad:
 * lleva el evento de cierre y nunca `nonce`, así que un id_token robado no
 * sirve para cerrar sesiones ajenas ni para lo contrario.
 */
export function cierreDesdeClaims(claims: JWTPayload & Record<string, unknown>): { subject: string | null; sessionId: string | null } {
  const events = claims["events"];
  if (!events || typeof events !== "object" || !(BACKCHANNEL_EVENT in events)) {
    throw new Error("el token no es un aviso de cierre de sesión");
  }
  if ("nonce" in claims) throw new Error("un aviso de cierre de sesión no lleva nonce");
  const subject = typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  const sessionId = typeof claims["sid"] === "string" && claims["sid"] ? claims["sid"] : null;
  if (!subject && !sessionId) throw new Error("el aviso no dice qué sesión cerrar");
  return { subject, sessionId };
}

export class OidcClient {
  readonly config: OidcConfig;
  readonly #fetch: typeof fetch;
  readonly #getKey: JWTVerifyGetKey | undefined;
  #discovery: Promise<Discovery> | null = null;
  #jwks: JWTVerifyGetKey | null = null;

  constructor(config: OidcConfig, opts: { fetchImpl?: typeof fetch; getKey?: JWTVerifyGetKey } = {}) {
    this.config = config;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#getKey = opts.getKey;
  }

  /** Se pide una vez; si falla, se reintenta en la siguiente entrada en vez de quedar roto. */
  discovery(): Promise<Discovery> {
    this.#discovery ??= (async () => {
      const url = `${this.config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
      const res = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`descubrimiento OIDC respondió ${res.status}`);
      const d = (await res.json()) as Discovery;
      if (d.issuer !== this.config.issuer.replace(/\/$/, "")) {
        throw new Error(`el emisor anunciado (${d.issuer}) no es el configurado`);
      }
      return d;
    })().catch((err: unknown) => {
      this.#discovery = null;
      throw err;
    });
    return this.#discovery;
  }

  async authorizeUrl(t: { state: string; nonce: string; verifier: string }): Promise<string> {
    const d = await this.discovery();
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: "openid profile email",
      state: t.state,
      nonce: t.nonce,
      code_challenge: pkceChallenge(t.verifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  /** Canjea el código y devuelve la identidad, con la firma del token comprobada. */
  async exchange(code: string, t: { verifier: string; nonce: string }): Promise<OidcIdentity> {
    const d = await this.discovery();
    const res = await this.#fetch(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code_verifier: t.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new OidcError("sso", `el proveedor rechazó el código (${res.status})`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new OidcError("sso", "el proveedor no devolvió id_token");

    const { payload } = await jwtVerify(tokens.id_token, await this.#claves(), {
      issuer: d.issuer,
      audience: this.config.clientId,
    }).catch((err: unknown) => {
      throw new OidcError("sso", `id_token no válido: ${(err as Error).message}`);
    });
    return identidadDesdeClaims(payload as JWTPayload & Record<string, unknown>, {
      nonce: t.nonce,
      allowedGroups: this.config.allowedGroups,
      groupsClaim: this.config.groupsClaim,
    });
  }

  /** Verifica el `logout_token` que el proveedor manda al cerrar una sesión. */
  async verifyLogoutToken(token: string): Promise<{ subject: string | null; sessionId: string | null }> {
    const d = await this.discovery();
    const { payload } = await jwtVerify(token, await this.#claves(), {
      issuer: d.issuer,
      audience: this.config.clientId,
      // Un aviso viejo no debe poder reproducirse para siempre.
      maxTokenAge: "10m",
    });
    return cierreDesdeClaims(payload as JWTPayload & Record<string, unknown>);
  }

  async #claves(): Promise<JWTVerifyGetKey> {
    if (!this.#jwks) {
      const d = await this.discovery();
      this.#jwks = this.#getKey ?? createRemoteJWKSet(new URL(d.jwks_uri));
    }
    return this.#jwks;
  }
}
