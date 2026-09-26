package omni

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// servidor levanta un httptest con el manejador dado y devuelve un cliente
// apuntado a él. Probar contra un servidor de verdad —aunque sea local— cubre el
// transporte entero, no solo la lógica.
func servidor(t *testing.T, manejador http.HandlerFunc, opts ...Option) (*Client, *[]*http.Request) {
	t.Helper()
	var recibidas []*http.Request
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cuerpo, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(strings.NewReader(string(cuerpo)))
		copia := r.Clone(context.Background())
		copia.Body = io.NopCloser(strings.NewReader(string(cuerpo)))
		recibidas = append(recibidas, copia)
		manejador(w, r)
	}))
	t.Cleanup(s.Close)
	return New(s.URL, "omni_abc_secreto", append([]Option{WithMaxRetries(0)}, opts...)...), &recibidas
}

func responde(t *testing.T, w http.ResponseWriter, status int, cuerpo any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(cuerpo)
}

func TestDesenvuelveData(t *testing.T) {
	c, _ := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		responde(t, w, 200, map[string]any{"data": []map[string]any{{"id": "l1", "name": "Línea"}}})
	})
	lineas, err := c.ListLines(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(lineas) != 1 || lineas[0].ID != "l1" {
		t.Fatalf("inesperado: %+v", lineas)
	}
}

func TestMandaCredencialYTipo(t *testing.T) {
	c, recibidas := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		responde(t, w, 202, map[string]any{"data": map[string]any{"messageId": "m1", "state": "queued"}})
	})
	if _, err := c.Send(context.Background(), "l1", SendInput{To: "51988777666", Text: "hola"}); err != nil {
		t.Fatal(err)
	}
	r := (*recibidas)[0]
	if got := r.Header.Get("Authorization"); got != "Bearer omni_abc_secreto" {
		t.Fatalf("credencial: %q", got)
	}
	if got := r.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("tipo: %q", got)
	}
	cuerpo, _ := io.ReadAll(r.Body)
	// Los campos vacíos se OMITEN: mandarlos haría que la API los rechazara por
	// tipo en vez de tratarlos como ausentes.
	if strings.Contains(string(cuerpo), "image") || strings.Contains(string(cuerpo), "poll") {
		t.Fatalf("mandó campos vacíos: %s", cuerpo)
	}
}

func TestEscapaDireccionesEnLaRuta(t *testing.T) {
	c, recibidas := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		responde(t, w, 200, map[string]any{"data": []any{}})
	})
	if _, err := c.ListMessages(context.Background(), "l1", "51988777666@s.whatsapp.net", 0, ""); err != nil {
		t.Fatal(err)
	}
	ruta := (*recibidas)[0].URL.EscapedPath()
	if !strings.Contains(ruta, "%40") {
		t.Fatalf("no escapó la arroba: %s", ruta)
	}
}

func TestErrorDesmenuzado(t *testing.T) {
	c, _ := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		responde(t, w, 422, map[string]any{
			"type":       "https://docs.omni.dev/errors/capability_unsupported",
			"status":     422,
			"detail":     `el transporte "whatsapp.cloud" no soporta "send.poll"`,
			"capability": "send.poll",
		})
	})
	_, err := c.Send(context.Background(), "l1", SendInput{To: "x", Text: "y"})
	var fallo *APIError
	if !errors.As(err, &fallo) {
		t.Fatalf("no es APIError: %v", err)
	}
	if fallo.Code != "capability_unsupported" {
		t.Fatalf("código: %q", fallo.Code)
	}
	if fallo.MissingCapability() != "send.poll" {
		t.Fatalf("capacidad: %q", fallo.MissingCapability())
	}
	if fallo.Retryable() {
		t.Fatal("un 422 no debería reintentarse")
	}
}

func TestReintentaLoPasajeroYNoLoPermanente(t *testing.T) {
	var intentos int
	c, _ := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		intentos++
		if intentos < 3 {
			responde(t, w, 503, map[string]any{"detail": "ocupado"})
			return
		}
		responde(t, w, 200, map[string]any{"data": []any{}})
	}, WithMaxRetries(3))
	if _, err := c.ListLines(context.Background()); err != nil {
		t.Fatal(err)
	}
	if intentos != 3 {
		t.Fatalf("intentos: %d", intentos)
	}

	// Repetir un 403 no lo arregla.
	var permanentes int
	c2, _ := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		permanentes++
		responde(t, w, 403, map[string]any{"detail": "prohibido"})
	}, WithMaxRetries(3))
	if _, err := c2.ListLines(context.Background()); err == nil {
		t.Fatal("debería fallar")
	}
	if permanentes != 1 {
		t.Fatalf("reintentó un 403: %d veces", permanentes)
	}
}

func TestSupports(t *testing.T) {
	c, _ := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		responde(t, w, 200, map[string]any{"data": []map[string]any{
			{"kind": "whatsapp.cloud", "capabilities": []string{"send.text"}},
			{"kind": "whatsapp.baileys", "capabilities": []string{"send.text", "send.poll"}},
		}})
	})
	ctx := context.Background()
	for _, caso := range []struct {
		kind, cap string
		quiere    bool
	}{
		{"whatsapp.baileys", "send.poll", true},
		{"whatsapp.cloud", "send.poll", false},
		{"no.existe", "send.text", false},
	} {
		got, err := c.Supports(ctx, caso.kind, caso.cap)
		if err != nil {
			t.Fatal(err)
		}
		if got != caso.quiere {
			t.Fatalf("%s/%s: %v", caso.kind, caso.cap, got)
		}
	}
}

func TestIterateMessages(t *testing.T) {
	var paginas int
	c, recibidas := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		paginas++
		n := 100
		if paginas > 1 {
			n = 30
		}
		msgs := make([]map[string]any, n)
		for i := range msgs {
			msgs[i] = map[string]any{
				"id":        fmt.Sprintf("m%d", (paginas-1)*100+i),
				"timestamp": fmt.Sprintf("2026-01-%02dT00:00:00Z", i%28+1),
			}
		}
		responde(t, w, 200, map[string]any{"data": msgs})
	})

	var vistos int
	err := c.IterateMessages(context.Background(), "l1", "chat@s.whatsapp.net", 100, func(Message) bool {
		vistos++
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if vistos != 130 {
		t.Fatalf("vistos: %d", vistos)
	}
	// La segunda página pide lo anterior a la última marca de la primera.
	if !strings.Contains((*recibidas)[1].URL.RawQuery, "before=") {
		t.Fatalf("no paginó por cursor: %s", (*recibidas)[1].URL.RawQuery)
	}
}

func TestIterateSeDetieneCuandoSeLePide(t *testing.T) {
	c, _ := servidor(t, func(w http.ResponseWriter, _ *http.Request) {
		msgs := make([]map[string]any, 100)
		for i := range msgs {
			msgs[i] = map[string]any{"id": fmt.Sprintf("m%d", i), "timestamp": "2026-01-01T00:00:00Z"}
		}
		responde(t, w, 200, map[string]any{"data": msgs})
	})
	var vistos int
	// Sin esto, un historial de meses no se podría recorrer parcialmente.
	err := c.IterateMessages(context.Background(), "l1", "c", 100, func(Message) bool {
		vistos++
		return vistos < 5
	})
	if err != nil {
		t.Fatal(err)
	}
	if vistos != 5 {
		t.Fatalf("no paró cuando se le pidió: %d", vistos)
	}
}

func TestFalloDeRedSeDistingue(t *testing.T) {
	c := New("http://127.0.0.1:1", "k", WithMaxRetries(0),
		WithHTTPClient(&http.Client{Timeout: 200 * time.Millisecond}))
	_, err := c.ListLines(context.Background())
	var red *NetworkError
	if !errors.As(err, &red) {
		t.Fatalf("no es NetworkError: %v", err)
	}
}

// ---------------------------------------------------------------- webhooks

const secretoPrueba = "secreto-de-webhook"

func firmar(t *testing.T, marca int64, secreto, cuerpo string) string {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(secreto))
	fmt.Fprintf(mac, "%d.%s", marca, cuerpo)
	return fmt.Sprintf("t=%d,v1=%s", marca, hex.EncodeToString(mac.Sum(nil)))
}

func TestVerifyWebhook(t *testing.T) {
	cuerpo := `{"event":"message.received","lineId":"l1","data":{"text":"hola"}}`
	ahora := time.Unix(1800000000, 0)
	firma := firmar(t, ahora.Unix(), secretoPrueba, cuerpo)

	if err := VerifyWebhook(cuerpo, firma, secretoPrueba, VerifyOptions{Now: ahora}); err != nil {
		t.Fatalf("la válida se rechazó: %v", err)
	}

	casos := []struct {
		nombre, cuerpo, firma, secreto string
		ahora                          time.Time
	}{
		{"otro secreto", cuerpo, firmar(t, ahora.Unix(), "otro", cuerpo), secretoPrueba, ahora},
		{"otro cuerpo", cuerpo + " ", firma, secretoPrueba, ahora},
		{"reproducida", cuerpo, firma, secretoPrueba, ahora.Add(10 * time.Minute)},
		{"sin cabecera", cuerpo, "", secretoPrueba, ahora},
		{"malformada", cuerpo, "basura", secretoPrueba, ahora},
		{"sin v1", cuerpo, "t=1800000000", secretoPrueba, ahora},
	}
	for _, caso := range casos {
		err := VerifyWebhook(caso.cuerpo, caso.firma, caso.secreto, VerifyOptions{Now: caso.ahora})
		if !errors.Is(err, ErrWebhookRejected) {
			t.Fatalf("%s: debería rechazarse, dio %v", caso.nombre, err)
		}
	}
}

func TestParseWebhook(t *testing.T) {
	cuerpo := `{"event":"message.received","lineId":"l1","data":{"text":"hola"}}`
	ahora := time.Unix(1800000000, 0)
	evento, err := ParseWebhook(cuerpo, firmar(t, ahora.Unix(), secretoPrueba, cuerpo),
		secretoPrueba, VerifyOptions{Now: ahora})
	if err != nil {
		t.Fatal(err)
	}
	if evento.Event != "message.received" || evento.LineID != "l1" {
		t.Fatalf("inesperado: %+v", evento)
	}
	var datos struct{ Text string }
	if err := json.Unmarshal(evento.Data, &datos); err != nil || datos.Text != "hola" {
		t.Fatalf("datos: %v %+v", err, datos)
	}

	// Verifica ANTES de parsear: nunca se debe procesar un cuerpo sin firma.
	if _, err := ParseWebhook(cuerpo, "mala", secretoPrueba, VerifyOptions{}); !errors.Is(err, ErrWebhookRejected) {
		t.Fatalf("parseó sin verificar: %v", err)
	}
}
