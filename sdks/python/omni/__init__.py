"""Cliente de Omni para Python. Solo biblioteca estándar."""

from .client import OmniClient
from .errors import OmniApiError, OmniNetworkError
from .webhooks import SIGNATURE_HEADER, WebhookRejected, parse_webhook, verify_webhook

__all__ = [
    "OmniClient",
    "OmniApiError",
    "OmniNetworkError",
    "SIGNATURE_HEADER",
    "WebhookRejected",
    "parse_webhook",
    "verify_webhook",
]
