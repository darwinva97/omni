"""
El SDK contra la API de verdad.

Se salta si no hay `OMNI_URL` y `OMNI_API_KEY`: probar solo con dobles demuestra
que el cliente es coherente consigo mismo, no que concuerde con el servidor.
"""

from __future__ import annotations

import os
import time
import unittest
import uuid

from omni import OmniApiError, OmniClient

URL = os.environ.get("OMNI_URL")
CLAVE = os.environ.get("OMNI_API_KEY")
LINEA = os.environ.get("OMNI_LINE", "line-demo")


@unittest.skipUnless(URL and CLAVE, "hacen falta OMNI_URL y OMNI_API_KEY")
class TestContraApi(unittest.TestCase):
    cliente: OmniClient

    @classmethod
    def setUpClass(cls) -> None:
        cls.cliente = OmniClient(URL or "", CLAVE or "")

    def test_lista_lineas(self) -> None:
        ids = [l["id"] for l in self.cliente.list_lines()]
        self.assertIn(LINEA, ids)

    def test_capacidades_y_supports(self) -> None:
        caps = self.cliente.capabilities()
        self.assertGreater(len(caps), 0)
        kinds = {c["kind"] for c in caps}
        self.assertIn("sandbox", kinds)
        self.assertTrue(self.cliente.supports("sandbox", "send.text"))
        # El transporte oficial NO ve grupos, y el SDK lo puede consultar antes.
        if "whatsapp.cloud" in kinds:
            self.assertFalse(self.cliente.supports("whatsapp.cloud", "group.read"))

    def test_envia_y_es_idempotente(self) -> None:
        idem = f"py-{uuid.uuid4()}"
        a = self.cliente.send(LINEA, "51988777666", text="desde Python", client_message_id=idem)
        b = self.cliente.send(LINEA, "51988777666", text="desde Python", client_message_id=idem)
        self.assertEqual(a["messageId"], b["messageId"])
        self.assertEqual(a["state"], "queued")

    def test_lee_la_conversacion(self) -> None:
        time.sleep(1)
        mensajes = self.cliente.list_messages(LINEA, "51988777666@s.whatsapp.net", limit=5)
        self.assertGreater(len(mensajes), 0)
        self.assertIn("state", mensajes[0])

    def test_un_error_llega_desmenuzado(self) -> None:
        with self.assertRaises(OmniApiError) as ctx:
            # Sin campo de contenido: la API responde 422 explicando cuáles valen.
            self.cliente.send(LINEA, "51988777666")
        self.assertEqual(ctx.exception.status, 422)
        self.assertGreater(len(ctx.exception.detail), 10)


if __name__ == "__main__":
    unittest.main()
