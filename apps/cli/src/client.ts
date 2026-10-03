import { OmniError } from "@omni/shared";

/**
 * Cliente HTTP mínimo, sin dependencias.
 *
 * La CLI se distribuye como un binario y cada dependencia es peso que viaja
 * con ella; `fetch` ya viene en Node.
 */
export interface ClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface Respuesta<T> {
  readonly status: number;
  readonly data: T;
}

export class OmniClient {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;

  constructor(opts: ClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#key = opts.apiKey;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeout = opts.timeoutMs ?? 30000;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<Respuesta<T>> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const res = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.#key}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.#timeout),
    });

    const texto = await res.text();
    const parsed: unknown = texto ? JSON.parse(texto) : {};

    if (!res.ok) {
      const problema = parsed as { detail?: string; title?: string };
      // El detalle del problema RFC 7807 es lo que el usuario necesita leer;
      // enseñarle "HTTP 422" a secas le obliga a adivinar.
      throw new OmniError(
        "upstream_failed",
        problema.detail ?? problema.title ?? `${method} ${path} respondió ${res.status}`,
        { status: res.status },
      );
    }
    return { status: res.status, data: (parsed as { data?: T }).data ?? (parsed as T) };
  }

  /**
   * Como `request`, pero con un cuerpo multipart.
   *
   * No se le pone `content-type`: lo tiene que poner `fetch` para incluir el
   * `boundary`, y fijarlo a mano rompe la subida sin decir por qué.
   */
  async requestForm<T>(method: string, path: string, form: FormData): Promise<Respuesta<T>> {
    const res = await this.#fetch(new URL(this.#base + path), {
      method,
      headers: { authorization: `Bearer ${this.#key}` },
      body: form,
      signal: AbortSignal.timeout(this.#timeout),
    });

    const texto = await res.text();
    const parsed: unknown = texto ? JSON.parse(texto) : {};
    if (!res.ok) {
      const problema = parsed as { detail?: string; title?: string };
      throw new OmniError(
        "upstream_failed",
        problema.detail ?? problema.title ?? `${method} ${path} respondió ${res.status}`,
        { status: res.status },
      );
    }
    return { status: res.status, data: (parsed as { data?: T }).data ?? (parsed as T) };
  }
}
