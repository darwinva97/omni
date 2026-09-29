import type { Condition, Rule, RuleContext } from "@omni/shared";

/**
 * Evaluación de condiciones. Pura: sin base de datos, sin red, sin reloj
 * propio —la hora sale del contexto— para que sea reproducible.
 */

const texto = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

const valorDe = (c: RuleContext, field: Condition["field"]): unknown => {
  switch (field) {
    case "text": return c.text ?? null;
    case "from": return c.from ?? null;
    case "chat": return c.chat ?? c.target;
    case "chatKind": return c.chatKind ?? null;
    case "labels": return c.labels ?? [];
    case "status": return c.status ?? null;
    case "priority": return c.priority ?? null;
    case "assignee": return c.assignee ?? null;
    case "lineId": return c.lineId;
    case "hour": return c.at.getHours();
    case "weekday": return c.at.getDay();
    // Inalcanzable con el tipo actual; está para que añadir un campo nuevo al
    // catálogo no compile hasta que se le dé valor aquí.
    default: return null;
  }
};

/** Resultado con motivo: sirve para explicar en el panel por qué no saltó. */
export interface Evaluacion {
  readonly ok: boolean;
  readonly motivo?: string;
}

export function evaluarCondicion(c: Condition, ctx: RuleContext): boolean {
  const actual = valorDe(ctx, c.field);
  const lista = Array.isArray(actual) ? (actual as string[]) : null;

  const norm = (s: string): string => (c.caseSensitive ? s : s.toLowerCase());
  const izq = norm(texto(actual));
  const der = Array.isArray(c.value) ? c.value.map(norm) : norm(texto(c.value));

  switch (c.op) {
    case "is_empty":
      return lista ? lista.length === 0 : izq.length === 0;
    case "is_not_empty":
      return lista ? lista.length > 0 : izq.length > 0;
    case "equals":
      return izq === der;
    case "not_equals":
      return izq !== der;
    case "contains":
      // Sobre una lista, "contiene" es pertenencia, no subcadena: buscar
      // "vip" como subcadena encontraría también la etiqueta "vip-antiguo".
      return lista ? lista.map(norm).includes(der as string) : izq.includes(der as string);
    case "not_contains":
      return lista ? !lista.map(norm).includes(der as string) : !izq.includes(der as string);
    case "starts_with":
      return izq.startsWith(der as string);
    case "ends_with":
      return izq.endsWith(der as string);
    case "matches":
      try {
        return new RegExp(texto(c.value), c.caseSensitive ? "" : "i").test(texto(actual));
      } catch {
        // Una expresión regular inválida NO hace saltar la regla: fallar
        // cerrado es lo correcto cuando la condición no se puede decidir.
        return false;
      }
    case "in":
      return Array.isArray(der) ? der.includes(izq) : false;
    case "not_in":
      return Array.isArray(der) ? !der.includes(izq) : true;
    case "gte":
      return Number(actual) >= Number(c.value);
    case "lte":
      return Number(actual) <= Number(c.value);
  }
}

/** Una regla salta si es de este disparo, de esta línea, y cumple TODAS sus condiciones. */
export function evaluarRegla(regla: Rule, ctx: RuleContext): Evaluacion {
  if (!regla.enabled) return { ok: false, motivo: "la regla está apagada" };
  if (regla.trigger !== ctx.event) return { ok: false, motivo: "otro disparador" };
  if (regla.lineId !== null && regla.lineId !== ctx.lineId) {
    return { ok: false, motivo: "la regla está acotada a otra línea" };
  }
  for (const [i, c] of regla.conditions.entries()) {
    if (!evaluarCondicion(c, ctx)) {
      return { ok: false, motivo: `no cumple la condición ${i + 1} (${c.field} ${c.op})` };
    }
  }
  return { ok: true };
}

/**
 * Ordena las reglas como se van a ejecutar.
 *
 * Menor prioridad primero y, en empate, la más antigua. El desempate importa:
 * sin él, dos reglas con la misma prioridad se ejecutarían en el orden en que
 * la base las devuelva, que puede cambiar entre consultas.
 */
export function ordenarReglas(reglas: readonly Rule[]): Rule[] {
  return [...reglas].sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}
