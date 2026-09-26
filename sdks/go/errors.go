package omni

import "fmt"

// APIError es un fallo devuelto por la API, con el problema RFC 7807 ya
// desmenuzado. Detail es lo único accionable: "HTTP 422" obliga a quien integra
// a adivinar, "el transporte whatsapp.cloud no soporta send.poll" no.
type APIError struct {
	Status  int
	Code    string
	Detail  string
	Problem map[string]any
}

func (e *APIError) Error() string { return e.Detail }

// MissingCapability devuelve la capacidad que faltaba, cuando el fallo fue por
// eso, y la cadena vacía en cualquier otro caso.
func (e *APIError) MissingCapability() string {
	if e.Code != "capability_unsupported" {
		return ""
	}
	if v, ok := e.Problem["capability"].(string); ok {
		return v
	}
	return ""
}

// Retryable indica si reintentar tiene sentido. Repetir un 403 no lo arregla.
func (e *APIError) Retryable() bool {
	return e.Status == 429 || e.Status == 502 || e.Status == 503
}

// NetworkError envuelve un fallo de transporte, para poder distinguirlo de una
// respuesta de error de la API.
type NetworkError struct{ Cause error }

func (e *NetworkError) Error() string {
	return fmt.Sprintf("no se pudo alcanzar la API: %v", e.Cause)
}

func (e *NetworkError) Unwrap() error { return e.Cause }
