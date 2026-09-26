"""
Verificación de la firma de un webhook.

La firma va sobre el CUERPO CRUDO. Es el error número uno al integrar webhooks
firmados: cualquier capa que parsee el JSON consume el flujo y deja sin nada que
hashear, así que hay que verificar ANTES de parsear.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

SIGNATURE_HEADER = "x-omni-signature"


class WebhookRejected(Exception):
    """La firma no vale. Nunca se debe procesar el cuerpo en ese caso."""


def verify_webhook(
    raw_body: str,
    signature_header: str | None,
    secret: str,
    *,
    tolerance_seconds: int = 300,
    now: float | None = None,
) -> tuple[bool, str]:
    """Devuelve ``(ok, motivo)``. El motivo solo es útil cuando ``ok`` es falso."""
    if not signature_header:
        return False, "falta la cabecera de firma"

    partes: dict[str, str] = {}
    for trozo in signature_header.split(","):
        clave, _, valor = trozo.partition("=")
        partes[clave.strip()] = valor

    try:
        marca = int(partes["t"])
        firma = partes["v1"]
    except (KeyError, ValueError):
        return False, "cabecera de firma malformada"

    instante = time.time() if now is None else now
    # La marca va DENTRO del hash: sin comprobarla, una entrega capturada se
    # puede reproducir indefinidamente.
    if abs(instante - marca) > tolerance_seconds:
        return False, "marca de tiempo fuera de ventana"

    esperada = hmac.new(
        secret.encode("utf-8"),
        f"{marca}.{raw_body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # Comparación en tiempo constante: `==` filtra información por el tiempo.
    if not hmac.compare_digest(firma, esperada):
        return False, "la firma no coincide"
    return True, ""


def parse_webhook(
    raw_body: str,
    signature_header: str | None,
    secret: str,
    **kwargs: Any,
) -> dict[str, Any]:
    """Verifica y parsea en un paso. Lanza si la firma no vale."""
    ok, motivo = verify_webhook(raw_body, signature_header, secret, **kwargs)
    if not ok:
        raise WebhookRejected(f"webhook rechazado: {motivo}")
    return json.loads(raw_body)
