"""
Cliente de Omni.

Solo biblioteca estándar: nada que instalar más allá de esto. Una dependencia de
HTTP aquí sería peso que arrastra todo el que lo use, y `urllib` ya está.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from typing import Any

from .errors import OmniApiError, OmniNetworkError


class OmniClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 30.0,
        max_retries: int = 2,
        opener: Any | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        # Inyectable para poder probar sin red.
        self._opener = opener or urllib.request.build_opener()

    # ------------------------------------------------------------------ líneas

    def list_lines(self) -> list[dict[str, Any]]:
        return self._request("GET", "/v1/lines")

    def create_line(
        self,
        name: str,
        slug: str,
        channel_kind: str,
        *,
        address: str | None = None,
        send_rate_per_minute: int | None = None,
        driver_config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cuerpo: dict[str, Any] = {"name": name, "slug": slug, "channelKind": channel_kind}
        if address is not None:
            cuerpo["address"] = address
        if send_rate_per_minute is not None:
            cuerpo["sendRatePerMinute"] = send_rate_per_minute
        if driver_config is not None:
            cuerpo["driverConfig"] = driver_config
        return self._request("POST", "/v1/lines", cuerpo)

    def connect_line(self, line_id: str) -> dict[str, Any]:
        return self._request("POST", f"/v1/lines/{_e(line_id)}/connect")

    def line_status(self, line_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/lines/{_e(line_id)}/status")

    def disconnect_line(self, line_id: str) -> dict[str, Any]:
        return self._request("POST", f"/v1/lines/{_e(line_id)}/disconnect")

    def capabilities(self) -> list[dict[str, Any]]:
        return self._request("GET", "/v1/capabilities")

    def supports(self, channel_kind: str, capability: str) -> bool:
        """Si este transporte sabe hacer algo, ANTES de intentarlo."""
        for c in self.capabilities():
            if c.get("kind") == channel_kind:
                return capability in c.get("capabilities", [])
        return False

    # ------------------------------------------------------------------ mensajes

    def send(
        self,
        line_id: str,
        to: str,
        *,
        text: str | None = None,
        image: dict[str, Any] | None = None,
        video: dict[str, Any] | None = None,
        audio: dict[str, Any] | None = None,
        document: dict[str, Any] | None = None,
        sticker: dict[str, Any] | None = None,
        location: dict[str, Any] | None = None,
        contact: dict[str, Any] | None = None,
        poll: dict[str, Any] | None = None,
        caption: str | None = None,
        file_name: str | None = None,
        reply_to: str | None = None,
        mentions: list[str] | None = None,
        client_message_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Envía. Vuelve en cuanto la API acepta: el mensaje queda ENCOLADO, no
        entregado. Repetir el mismo ``client_message_id`` no duplica.
        """
        cuerpo: dict[str, Any] = {"to": to}
        for clave, valor in (
            ("text", text), ("image", image), ("video", video), ("audio", audio),
            ("document", document), ("sticker", sticker), ("location", location),
            ("contact", contact), ("poll", poll), ("caption", caption),
            ("fileName", file_name), ("replyTo", reply_to), ("mentions", mentions),
            ("clientMessageId", client_message_id),
        ):
            if valor is not None:
                cuerpo[clave] = valor
        return self._request("POST", f"/v1/lines/{_e(line_id)}/messages", cuerpo)

    def list_chats(self, line_id: str, *, limit: int | None = None) -> list[dict[str, Any]]:
        return self._request("GET", f"/v1/lines/{_e(line_id)}/chats", query={"limit": limit})

    def list_messages(
        self, line_id: str, chat: str, *, limit: int | None = None, before: str | None = None
    ) -> list[dict[str, Any]]:
        return self._request(
            "GET",
            f"/v1/lines/{_e(line_id)}/chats/{_e(chat)}/messages",
            query={"limit": limit, "before": before},
        )

    def iterate_messages(
        self, line_id: str, chat: str, *, page_size: int = 100
    ) -> Iterator[dict[str, Any]]:
        """
        Recorre el historial página a página.

        Es un generador para no cargar meses de conversación en memoria a la vez:
        quien lo consume decide cuándo parar.
        """
        before: str | None = None
        while True:
            pagina = self.list_messages(line_id, chat, limit=page_size, before=before)
            yield from pagina
            if len(pagina) < page_size:
                return
            before = pagina[-1]["timestamp"]

    def edit_message(self, line_id: str, chat: str, message_id: str, text: str) -> dict[str, Any]:
        return self._request(
            "PATCH",
            f"/v1/lines/{_e(line_id)}/chats/{_e(chat)}/messages/{_e(message_id)}",
            {"text": text},
        )

    def delete_message(self, line_id: str, chat: str, message_id: str) -> dict[str, Any]:
        return self._request(
            "DELETE", f"/v1/lines/{_e(line_id)}/chats/{_e(chat)}/messages/{_e(message_id)}"
        )

    def react(self, line_id: str, chat: str, message_id: str, emoji: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/lines/{_e(line_id)}/chats/{_e(chat)}/messages/{_e(message_id)}/reaction",
            {"emoji": emoji},
        )

    def mark_read(self, line_id: str, chat: str, message_ids: list[str]) -> dict[str, Any]:
        return self._request(
            "POST", f"/v1/lines/{_e(line_id)}/chats/{_e(chat)}/read", {"messageIds": message_ids}
        )

    def set_presence(self, line_id: str, chat: str, presence: str) -> dict[str, Any]:
        return self._request(
            "POST", f"/v1/lines/{_e(line_id)}/chats/{_e(chat)}/presence", {"presence": presence}
        )

    # ------------------------------------------------------------------ webhooks

    def create_webhook(
        self,
        url: str,
        *,
        events: list[str] | None = None,
        line_id: str | None = None,
        secret: str | None = None,
        filter: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cuerpo: dict[str, Any] = {"url": url, "events": events or [], "lineId": line_id}
        if secret is not None:
            cuerpo["secret"] = secret
        if filter is not None:
            cuerpo["filter"] = filter
        return self._request("POST", "/v1/webhooks", cuerpo)

    def list_dispatches(self, *, limit: int | None = None) -> list[dict[str, Any]]:
        return self._request("GET", "/v1/dispatches", query={"limit": limit})

    # ------------------------------------------------------------------ interno

    def _request(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        *,
        query: dict[str, Any] | None = None,
    ) -> Any:
        url = self._base + path
        limpia = {k: v for k, v in (query or {}).items() if v is not None}
        if limpia:
            url += "?" + urllib.parse.urlencode(limpia)

        datos = None if body is None else json.dumps(body).encode("utf-8")
        ultimo: BaseException | None = None

        for intento in range(self._max_retries + 1):
            peticion = urllib.request.Request(url, data=datos, method=method)
            peticion.add_header("authorization", f"Bearer {self._key}")
            if datos is not None:
                peticion.add_header("content-type", "application/json")

            try:
                with self._opener.open(peticion, timeout=self._timeout) as respuesta:
                    crudo = respuesta.read().decode("utf-8")
                    cuerpo = json.loads(crudo) if crudo else {}
                    return cuerpo.get("data", cuerpo) if isinstance(cuerpo, dict) else cuerpo
            except urllib.error.HTTPError as err:
                crudo = err.read().decode("utf-8")
                problema = json.loads(crudo) if crudo else {}
                fallo = OmniApiError(err.code, problema)
                # Solo se reintenta lo pasajero. Repetir un 403 no lo arregla y
                # multiplica el ruido en los registros de quien lo recibe.
                if fallo.retryable and intento < self._max_retries:
                    time.sleep(2**intento * 0.5)
                    ultimo = fallo
                    continue
                raise fallo from err
            except (urllib.error.URLError, TimeoutError, OSError) as err:
                ultimo = err
                if intento < self._max_retries:
                    time.sleep(2**intento * 0.5)
                    continue

        raise OmniNetworkError(ultimo or RuntimeError("sin detalle"))


def _e(valor: str) -> str:
    """Las direcciones llevan `@`: sin escapar, la ruta se parte donde no debe."""
    return urllib.parse.quote(valor, safe="")
