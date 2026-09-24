/**
 * Bus de publicación/suscripción para abanicar eventos entre procesos.
 * Sustituye al `EventEmitter` en proceso, que ataba el tiempo real a una sola
 * instancia y hacía imposible escalar la API.
 */
export interface Bus {
  publish<T>(topic: string, payload: T): Promise<void>;
  subscribe<T>(topic: string, handler: (payload: T) => void | Promise<void>): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
