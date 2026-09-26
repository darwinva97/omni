# SDK de Omni para Python

Solo biblioteca estándar: no hay nada que instalar aparte de esto.

```bash
pip install git+https://github.com/darwinva97/omni.git#subdirectory=sdks/python
```

```python
from omni import OmniClient, OmniApiError, parse_webhook

omni = OmniClient("https://tu-servidor", os.environ["OMNI_API_KEY"])

# Consulta antes de intentar algo poco común
if omni.supports("whatsapp.cloud", "send.poll"):
    ...

omni.send(linea, "51988777666", text="hola", client_message_id="pedido-42")

# Recorre meses de conversación sin cargarlos en memoria
for m in omni.iterate_messages(linea, chat):
    ...
```

Reintenta lo pasajero —429, 502, 503— y nunca lo que no lo es: repetir un 403 no
lo arregla. Los errores llegan desmenuzados:

```python
try:
    omni.send(linea, destino, poll={"question": "¿?", "options": ["a", "b"]})
except OmniApiError as err:
    if err.missing_capability:
        print(f"este transporte no soporta {err.missing_capability}")
```

## Webhooks

La firma va sobre el **cuerpo crudo**. Verifica antes de parsear: cualquier capa
que lea el JSON consume el flujo y te deja sin nada que hashear.

```python
ok, motivo = verify_webhook(cuerpo_crudo, cabecera_firma, secreto)
# o, en un paso:
evento = parse_webhook(cuerpo_crudo, cabecera_firma, secreto)
```

## Pruebas

```bash
cd sdks/python && python -m unittest discover -s tests

# Contra un servidor real:
OMNI_URL=http://127.0.0.1:4010 OMNI_API_KEY=omni_... python -m unittest discover -s tests
```
