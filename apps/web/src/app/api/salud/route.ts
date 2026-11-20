/**
 * ¿Está vivo el panel? Para las sondas de Kubernetes.
 *
 * NO pregunta a la API a propósito. Las sondas apuntaban a `/`, que lo primero
 * que hace es pedirle a la API quién eres: con la API reiniciándose, el panel
 * contestaba 500 y Kubernetes lo daba por muerto —y acababa reiniciándolo—
 * aunque él estuviera perfectamente. Un reinicio de la API no es motivo para
 * reiniciar también el panel; que la API esté caída se ve en la suya.
 */
export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
