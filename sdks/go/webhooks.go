package omni

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// SignatureHeader es la cabecera donde viaja la firma.
const SignatureHeader = "X-Omni-Signature"

// ErrWebhookRejected se devuelve cuando la firma no vale. Nunca debe procesarse
// el cuerpo en ese caso.
var ErrWebhookRejected = errors.New("webhook rechazado")

// WebhookEvent es el sobre que llega a un receptor.
type WebhookEvent struct {
	Event     string          `json:"event"`
	LineID    string          `json:"lineId"`
	OrgID     string          `json:"orgId"`
	Timestamp int64           `json:"timestamp"`
	Data      json.RawMessage `json:"data"`
}

// VerifyOptions ajusta la verificación. El cero vale para el caso normal.
type VerifyOptions struct {
	ToleranceSeconds int
	Now              time.Time
}

// VerifyWebhook comprueba la firma sobre el CUERPO CRUDO.
//
// Es el error número uno al integrar webhooks firmados: cualquier capa que
// parsee el JSON consume el cuerpo y deja sin nada que hashear, así que hay que
// verificar ANTES de parsear.
func VerifyWebhook(rawBody, signatureHeader, secret string, opts VerifyOptions) error {
	if signatureHeader == "" {
		return fmt.Errorf("%w: falta la cabecera de firma", ErrWebhookRejected)
	}

	var marca int64
	var firma string
	for _, trozo := range strings.Split(signatureHeader, ",") {
		clave, valor, _ := strings.Cut(trozo, "=")
		switch strings.TrimSpace(clave) {
		case "t":
			n, err := strconv.ParseInt(valor, 10, 64)
			if err != nil {
				return fmt.Errorf("%w: cabecera de firma malformada", ErrWebhookRejected)
			}
			marca = n
		case "v1":
			firma = valor
		}
	}
	if marca == 0 || firma == "" {
		return fmt.Errorf("%w: cabecera de firma malformada", ErrWebhookRejected)
	}

	tolerancia := opts.ToleranceSeconds
	if tolerancia == 0 {
		tolerancia = 300
	}
	ahora := opts.Now
	if ahora.IsZero() {
		ahora = time.Now()
	}
	// La marca va DENTRO del hash: sin comprobarla, una entrega capturada se
	// puede reproducir indefinidamente.
	if math.Abs(float64(ahora.Unix()-marca)) > float64(tolerancia) {
		return fmt.Errorf("%w: marca de tiempo fuera de ventana", ErrWebhookRejected)
	}

	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", marca, rawBody)
	esperada := hex.EncodeToString(mac.Sum(nil))

	// Comparación en tiempo constante: `==` filtra información por el tiempo.
	if !hmac.Equal([]byte(firma), []byte(esperada)) {
		return fmt.Errorf("%w: la firma no coincide", ErrWebhookRejected)
	}
	return nil
}

// ParseWebhook verifica y parsea en un paso.
func ParseWebhook(rawBody, signatureHeader, secret string, opts VerifyOptions) (*WebhookEvent, error) {
	if err := VerifyWebhook(rawBody, signatureHeader, secret, opts); err != nil {
		return nil, err
	}
	var evento WebhookEvent
	if err := json.Unmarshal([]byte(rawBody), &evento); err != nil {
		return nil, fmt.Errorf("el cuerpo no es un evento válido: %w", err)
	}
	return &evento, nil
}
