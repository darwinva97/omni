/**
 * Error de la API, con el problema RFC 7807 ya desmenuzado.
 *
 * El `detail` es lo único accionable: "HTTP 422" obliga a quien integra a
 * adivinar, "el transporte whatsapp.cloud no soporta send.poll" no.
 */
export class OmniApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly problem: Record<string, unknown>;

  constructor(status: number, problem: Record<string, unknown>) {
    const detail = String(problem["detail"] ?? problem["title"] ?? `la API respondió ${status}`);
    super(detail);
    this.name = "OmniApiError";
    this.status = status;
    this.detail = detail;
    // El tipo es una URL cuyo último tramo es el código: se extrae para poder
    // ramificar sin analizar cadenas en cada sitio.
    this.code = String(problem["type"] ?? "").split("/").pop() || "unknown";
    this.problem = problem;
  }

  /** La capacidad que faltaba, cuando el fallo fue por eso. */
  get missingCapability(): string | null {
    return this.code === "capability_unsupported"
      ? String(this.problem["capability"] ?? "") || null
      : null;
  }

  /** Reintentar tiene sentido en un fallo pasajero, no en uno de permisos. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 503;
  }
}

export class OmniNetworkError extends Error {
  constructor(cause: unknown) {
    super(`no se pudo alcanzar la API: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "OmniNetworkError";
  }
}
