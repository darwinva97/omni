"""
Pruebas del cliente, sin red.

Se inyecta un `opener` falso: probar contra la API real es tarea de la prueba de
integración, aquí lo que se fija es la forma de las peticiones y el trato de los
errores.
"""

from __future__ import annotations

import io
import json
import time
import unittest
import urllib.error
from typing import Any

from omni import OmniApiError, OmniClient, OmniNetworkError, parse_webhook, verify_webhook
from omni.webhooks import WebhookRejected
import hashlib
import hmac


class RespuestaFalsa(io.BytesIO):
    def __enter__(self) -> "RespuestaFalsa":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class OpenerFalso:
    """Registra lo pedido y responde lo que se le diga."""

    def __init__(self, responder: Any) -> None:
        self.llamadas: list[dict[str, Any]] = []
        self._responder = responder

    def open(self, peticion: Any, timeout: float | None = None) -> Any:  # noqa: ARG002
        cuerpo = None
        if peticion.data:
            cuerpo = json.loads(peticion.data.decode("utf-8"))
        self.llamadas.append(
            {
                "url": peticion.full_url,
                "method": peticion.get_method(),
                "body": cuerpo,
                "headers": {k.lower(): v for k, v in peticion.header_items()},
            }
        )
        return self._responder(len(self.llamadas))


def ok(datos: Any) -> Any:
    return lambda _n: RespuestaFalsa(json.dumps({"data": datos}).encode("utf-8"))


def error_http(status: int, problema: dict[str, Any]) -> Any:
    def responder(_n: int) -> Any:
        raise urllib.error.HTTPError(
            "http://x", status, "err", {},  # type: ignore[arg-type]
            io.BytesIO(json.dumps(problema).encode("utf-8")),
        )

    return responder


def cliente(opener: OpenerFalso, reintentos: int = 0) -> OmniClient:
    return OmniClient("https://api.test", "omni_abc_secreto", max_retries=reintentos, opener=opener)


class TestPeticiones(unittest.TestCase):
    def test_desenvuelve_data(self) -> None:
        op = OpenerFalso(ok([{"id": "l1"}]))
        self.assertEqual(cliente(op).list_lines(), [{"id": "l1"}])

    def test_manda_credencial_y_tipo(self) -> None:
        op = OpenerFalso(ok({"clientMessageId": "c1"}))
        cliente(op).send("l1", "51988777666", text="hola")
        l = op.llamadas[0]
        self.assertEqual(l["headers"]["authorization"], "Bearer omni_abc_secreto")
        self.assertEqual(l["headers"]["content-type"], "application/json")
        self.assertEqual(l["body"], {"to": "51988777666", "text": "hola"})

    def test_omite_lo_no_indicado(self) -> None:
        # Mandar `null` en cada campo haría que la API rechazara el cuerpo por
        # tipo, en vez de tratarlo como ausente.
        op = OpenerFalso(ok({}))
        cliente(op).send("l1", "x", text="hola")
        self.assertNotIn("image", op.llamadas[0]["body"])
        self.assertNotIn("poll", op.llamadas[0]["body"])

    def test_escapa_direcciones_en_la_ruta(self) -> None:
        op = OpenerFalso(ok([]))
        cliente(op).list_messages("l1", "51988777666@s.whatsapp.net")
        self.assertIn("51988777666%40s.whatsapp.net", op.llamadas[0]["url"])

    def test_query_omite_los_vacios(self) -> None:
        op = OpenerFalso(ok([]))
        cliente(op).list_chats("l1")
        self.assertNotIn("?", op.llamadas[0]["url"])
        op2 = OpenerFalso(ok([]))
        cliente(op2).list_chats("l1", limit=10)
        self.assertIn("limit=10", op2.llamadas[0]["url"])


class TestErrores(unittest.TestCase):
    def test_desmenuza_el_problema(self) -> None:
        op = OpenerFalso(
            error_http(
                422,
                {
                    "type": "https://docs.omni.dev/errors/capability_unsupported",
                    "status": 422,
                    "detail": 'el transporte "whatsapp.cloud" no soporta "send.poll"',
                    "capability": "send.poll",
                },
            )
        )
        with self.assertRaises(OmniApiError) as ctx:
            cliente(op).send("l1", "x", text="y")
        err = ctx.exception
        self.assertEqual(err.code, "capability_unsupported")
        self.assertEqual(err.missing_capability, "send.poll")
        self.assertIn("send.poll", err.detail)

    def test_reintenta_lo_pasajero(self) -> None:
        estado = {"n": 0}

        def responder(n: int) -> Any:
            estado["n"] = n
            if n < 3:
                return error_http(503, {"detail": "ocupado"})(n)
            return RespuestaFalsa(json.dumps({"data": []}).encode("utf-8"))

        op = OpenerFalso(responder)
        c = OmniClient("https://api.test", "k", max_retries=3, opener=op)
        c._timeout = 1  # noqa: SLF001
        inicio = time.time()
        c.list_lines()
        self.assertEqual(estado["n"], 3)
        # No debe tardar de más: el backoff empieza en medio segundo.
        self.assertLess(time.time() - inicio, 5)

    def test_no_reintenta_lo_permanente(self) -> None:
        # Repetir un 403 no lo arregla.
        op = OpenerFalso(error_http(403, {"detail": "prohibido"}))
        with self.assertRaises(OmniApiError):
            OmniClient("https://api.test", "k", max_retries=3, opener=op).list_lines()
        self.assertEqual(len(op.llamadas), 1)

    def test_un_fallo_de_red_se_distingue(self) -> None:
        def responder(_n: int) -> Any:
            raise urllib.error.URLError("sin ruta al host")

        op = OpenerFalso(responder)
        with self.assertRaises(OmniNetworkError):
            cliente(op).list_lines()


class TestCapacidades(unittest.TestCase):
    def test_pregunta_antes_de_intentar(self) -> None:
        datos = [
            {"kind": "whatsapp.cloud", "capabilities": ["send.text"]},
            {"kind": "whatsapp.baileys", "capabilities": ["send.text", "send.poll"]},
        ]
        self.assertTrue(cliente(OpenerFalso(ok(datos))).supports("whatsapp.baileys", "send.poll"))
        self.assertFalse(cliente(OpenerFalso(ok(datos))).supports("whatsapp.cloud", "send.poll"))
        self.assertFalse(cliente(OpenerFalso(ok(datos))).supports("no.existe", "send.text"))


class TestPaginacion(unittest.TestCase):
    def test_recorre_sin_cargarlo_todo(self) -> None:
        def pagina(desde: int, n: int) -> list[dict[str, Any]]:
            return [
                {"id": f"m{desde + i}", "timestamp": f"2026-01-{(desde + i) % 28 + 1:02d}T00:00:00Z"}
                for i in range(n)
            ]

        def responder(n: int) -> Any:
            datos = pagina(0, 100) if n == 1 else pagina(100, 30)
            return RespuestaFalsa(json.dumps({"data": datos}).encode("utf-8"))

        op = OpenerFalso(responder)
        vistos = list(cliente(op).iterate_messages("l1", "chat@s.whatsapp.net"))
        self.assertEqual(len(vistos), 130)
        # La segunda página pide lo anterior a la última marca de la primera.
        self.assertIn("before=", op.llamadas[1]["url"])


class TestWebhooks(unittest.TestCase):
    secreto = "secreto-de-webhook"
    cuerpo = json.dumps({"event": "message.received", "lineId": "l1", "data": {"text": "hola"}})
    ahora = 1_800_000_000.0

    def firmar(self, t: int, secreto: str | None = None, cuerpo: str | None = None) -> str:
        c = cuerpo if cuerpo is not None else self.cuerpo
        s = secreto or self.secreto
        mac = hmac.new(s.encode(), f"{t}.{c}".encode(), hashlib.sha256).hexdigest()
        return f"t={t},v1={mac}"

    def test_acepta_la_valida(self) -> None:
        firma = self.firmar(int(self.ahora))
        self.assertEqual(verify_webhook(self.cuerpo, firma, self.secreto, now=self.ahora), (True, ""))

    def test_rechaza_otro_secreto_y_otro_cuerpo(self) -> None:
        t = int(self.ahora)
        self.assertFalse(verify_webhook(self.cuerpo, self.firmar(t, "otro"), self.secreto, now=self.ahora)[0])
        self.assertFalse(verify_webhook(self.cuerpo + " ", self.firmar(t), self.secreto, now=self.ahora)[0])

    def test_rechaza_una_entrega_reproducida(self) -> None:
        # La marca va dentro del hash justo para esto.
        firma = self.firmar(int(self.ahora))
        ok_, motivo = verify_webhook(self.cuerpo, firma, self.secreto, now=self.ahora + 600)
        self.assertFalse(ok_)
        self.assertEqual(motivo, "marca de tiempo fuera de ventana")

    def test_rechaza_cabeceras_malas(self) -> None:
        for cabecera in (None, "", "basura", "t=abc,v1=", "v1=solo"):
            self.assertFalse(verify_webhook(self.cuerpo, cabecera, self.secreto)[0], cabecera)

    def test_parse_verifica_antes_de_parsear(self) -> None:
        firma = self.firmar(int(self.ahora))
        evento = parse_webhook(self.cuerpo, firma, self.secreto, now=self.ahora)
        self.assertEqual(evento["event"], "message.received")
        with self.assertRaises(WebhookRejected):
            parse_webhook(self.cuerpo, "mala", self.secreto)


if __name__ == "__main__":
    unittest.main()
