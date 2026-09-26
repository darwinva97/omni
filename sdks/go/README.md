# SDK de Omni para Go

Solo `net/http`: no hay dependencias que traer.

```bash
go get github.com/darwinva97/omni/sdks/go
```

```go
import omni "github.com/darwinva97/omni/sdks/go"

c := omni.New("https://tu-servidor", os.Getenv("OMNI_API_KEY"))

// Consulta antes de intentar algo poco común
if ok, _ := c.Supports(ctx, "whatsapp.cloud", "send.poll"); ok { /* … */ }

c.Send(ctx, linea, omni.SendInput{
    To: "51988777666", Text: "hola", ClientMessageID: "pedido-42",
})

// Recorre meses de conversación sin cargarlos en memoria; devolver false detiene
c.IterateMessages(ctx, linea, chat, 100, func(m omni.Message) bool {
    fmt.Println(*m.Body)
    return true
})
```

Reintenta lo pasajero —429, 502, 503— y nunca lo que no lo es: repetir un 403 no
lo arregla. Los errores llegan desmenuzados:

```go
var fallo *omni.APIError
if errors.As(err, &fallo) {
    if cap := fallo.MissingCapability(); cap != "" {
        log.Printf("este transporte no soporta %s", cap)
    }
}
```

## Webhooks

La firma va sobre el **cuerpo crudo**. Verifica antes de parsear: cualquier capa
que lea el JSON consume el cuerpo y te deja sin nada que hashear.

```go
evento, err := omni.ParseWebhook(cuerpoCrudo, r.Header.Get(omni.SignatureHeader),
    secreto, omni.VerifyOptions{})
if errors.Is(err, omni.ErrWebhookRejected) {
    http.Error(w, "firma inválida", http.StatusUnauthorized)
    return
}
```

## Pruebas

```bash
cd sdks/go && go test ./...

# Contra un servidor real:
OMNI_URL=http://127.0.0.1:4010 OMNI_API_KEY=omni_... go test -run ContraApi ./...
```
