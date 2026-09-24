import type { Capability, ChannelKind } from "./channels.js";

/**
 * Errores del dominio, con el código que la API traduce a RFC 7807.
 * El código HTTP viaja con el error para que ninguna capa tenga que adivinarlo.
 */
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "capability_unsupported"
  | "line_not_connected"
  | "quota_exceeded"
  | "rate_limited"
  | "identity_unresolved"
  | "upstream_failed"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  capability_unsupported: 422,
  line_not_connected: 409,
  quota_exceeded: 402,
  rate_limited: 429,
  identity_unresolved: 422,
  upstream_failed: 502,
  internal: 500,
};

export class OmniError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OmniError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toProblem(instance?: string): Record<string, unknown> {
    return {
      type: `https://docs.omni.dev/errors/${this.code}`,
      title: this.code.replace(/_/g, " "),
      status: this.status,
      detail: this.message,
      ...(instance ? { instance } : {}),
      ...this.details,
    };
  }
}

/**
 * El error que hace honesta a la abstracción de canales: cuando se pide algo que
 * ESTE driver no sabe hacer, se dice cuál es la capacidad, qué driver la rechaza
 * y —cuando lo hay— qué transporte sí la tiene.
 */
export class CapabilityError extends OmniError {
  constructor(capability: Capability, kind: ChannelKind, alternatives: readonly ChannelKind[] = []) {
    super(
      "capability_unsupported",
      `el transporte "${kind}" no soporta "${capability}"` +
        (alternatives.length > 0 ? `; sí lo soportan: ${alternatives.join(", ")}` : ""),
      { capability, channelKind: kind, ...(alternatives.length > 0 ? { alternatives } : {}) },
    );
    this.name = "CapabilityError";
  }
}

/** Un LID sin mapear se rechaza; adivinar el teléfono sería inventar una identidad. */
export class IdentityUnresolvedError extends OmniError {
  constructor(address: string) {
    super("identity_unresolved", `no hay mapeo conocido para "${address}"; no se adivina`, { address });
    this.name = "IdentityUnresolvedError";
  }
}
