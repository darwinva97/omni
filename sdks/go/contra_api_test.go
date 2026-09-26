package omni_test

import (
	"context"
	"os"
	"testing"

	omni "github.com/darwinva97/omni/sdks/go"
)

// El SDK contra la API de verdad. Se salta sin OMNI_URL y OMNI_API_KEY: probar
// solo con dobles demuestra que el cliente es coherente consigo mismo, no que
// concuerde con el servidor.
func clienteReal(t *testing.T) (*omni.Client, string) {
	t.Helper()
	url, clave := os.Getenv("OMNI_URL"), os.Getenv("OMNI_API_KEY")
	if url == "" || clave == "" {
		t.Skip("hacen falta OMNI_URL y OMNI_API_KEY")
	}
	linea := os.Getenv("OMNI_LINE")
	if linea == "" {
		linea = "line-demo"
	}
	return omni.New(url, clave), linea
}

func TestContraApiListaLineas(t *testing.T) {
	c, linea := clienteReal(t)
	lineas, err := c.ListLines(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range lineas {
		if l.ID == linea {
			return
		}
	}
	t.Fatalf("no apareció %s entre %d líneas", linea, len(lineas))
}

func TestContraApiCapacidades(t *testing.T) {
	c, _ := clienteReal(t)
	ctx := context.Background()
	ok, err := c.Supports(ctx, "sandbox", "send.text")
	if err != nil || !ok {
		t.Fatalf("sandbox debería soportar texto: %v %v", ok, err)
	}
	// El transporte oficial NO ve grupos, y se puede consultar antes.
	ve, err := c.Supports(ctx, "whatsapp.cloud", "group.read")
	if err == nil && ve {
		t.Fatal("whatsapp.cloud no debería declarar que ve grupos")
	}
}

func TestContraApiEnviaYEsIdempotente(t *testing.T) {
	c, linea := clienteReal(t)
	ctx := context.Background()
	idem := "go-" + t.Name()
	a, err := c.Send(ctx, linea, omni.SendInput{
		To: "51988777666", Text: "desde Go", ClientMessageID: idem,
	})
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Send(ctx, linea, omni.SendInput{
		To: "51988777666", Text: "desde Go", ClientMessageID: idem,
	})
	if err != nil {
		t.Fatal(err)
	}
	if a.MessageID != b.MessageID {
		t.Fatalf("duplicó: %s vs %s", a.MessageID, b.MessageID)
	}
}

func TestContraApiErrorDesmenuzado(t *testing.T) {
	c, linea := clienteReal(t)
	// Sin campo de contenido: la API responde 422 explicando cuáles valen.
	_, err := c.Send(context.Background(), linea, omni.SendInput{To: "51988777666"})
	var fallo *omni.APIError
	if err == nil {
		t.Fatal("debería fallar")
	}
	if !errorAs(err, &fallo) || fallo.Status != 422 {
		t.Fatalf("esperaba un 422 desmenuzado, dio %v", err)
	}
}

func errorAs(err error, destino **omni.APIError) bool {
	if e, ok := err.(*omni.APIError); ok {
		*destino = e
		return true
	}
	return false
}
