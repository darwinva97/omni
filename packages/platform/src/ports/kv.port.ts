/** Almacén clave-valor con expiración. Soporta caché, cerrojos e idempotencia. */
export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Escribe solo si la clave NO existe. Devuelve `true` si ganó la carrera.
   * Es la primitiva sobre la que se construyen la idempotencia y los cerrojos
   * de propiedad de línea entre nodos del motor.
   */
  setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  increment(key: string, by?: number, ttlSeconds?: number): Promise<number>;
  close(): Promise<void>;
}
