"""Errores del cliente."""

from __future__ import annotations

from typing import Any


class OmniApiError(Exception):
    """
    Error de la API, con el problema RFC 7807 ya desmenuzado.

    El ``detail`` es lo único accionable: "HTTP 422" obliga a quien integra a
    adivinar, "el transporte whatsapp.cloud no soporta send.poll" no.
    """

    def __init__(self, status: int, problem: dict[str, Any]) -> None:
        self.status = status
        self.problem = problem
        self.detail: str = str(
            problem.get("detail") or problem.get("title") or f"la API respondió {status}"
        )
        # El tipo es una URL cuyo último tramo es el código: se extrae para poder
        # ramificar sin analizar cadenas en cada sitio.
        self.code: str = str(problem.get("type", "")).rsplit("/", 1)[-1] or "unknown"
        super().__init__(self.detail)

    @property
    def missing_capability(self) -> str | None:
        """La capacidad que faltaba, cuando el fallo fue por eso."""
        if self.code != "capability_unsupported":
            return None
        valor = self.problem.get("capability")
        return str(valor) if valor else None

    @property
    def retryable(self) -> bool:
        """Reintentar tiene sentido en un fallo pasajero, no en uno de permisos."""
        return self.status in (429, 502, 503)


class OmniNetworkError(Exception):
    """No se pudo alcanzar la API."""

    def __init__(self, cause: BaseException) -> None:
        super().__init__(f"no se pudo alcanzar la API: {cause}")
        self.cause = cause
