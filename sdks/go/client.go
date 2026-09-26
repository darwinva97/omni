// Package omni es el cliente de Omni para Go.
//
// Solo net/http: nada que instalar más allá de esto. Una biblioteca de HTTP aquí
// sería peso que arrastra todo el que lo importe.
package omni

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client habla con la API de Omni.
type Client struct {
	baseURL    string
	apiKey     string
	http       *http.Client
	maxRetries int
}

// Option ajusta el cliente al construirlo.
type Option func(*Client)

// WithHTTPClient permite inyectar un transporte propio, y probar sin red.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithMaxRetries fija cuántas veces se reintenta un fallo PASAJERO.
func WithMaxRetries(n int) Option { return func(c *Client) { c.maxRetries = n } }

// New construye un cliente. baseURL sin barra final.
func New(baseURL, apiKey string, opts ...Option) *Client {
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		http:       &http.Client{Timeout: 30 * time.Second},
		maxRetries: 2,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// ---------------------------------------------------------------- tipos

type Line struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	Slug              string  `json:"slug"`
	ChannelKind       string  `json:"channelKind"`
	Address           *string `json:"address"`
	Status            string  `json:"status"`
	Enabled           bool    `json:"enabled"`
	SendRatePerMinute int     `json:"sendRatePerMinute"`
}

type Capability struct {
	Kind                  string   `json:"kind"`
	Network               string   `json:"network"`
	Risk                  string   `json:"risk"`
	LinkMethod            string   `json:"linkMethod"`
	ApproxMemoryMbPerLine int      `json:"approxMemoryMbPerLine"`
	Capabilities          []string `json:"capabilities"`
}

type Chat struct {
	Address       string  `json:"address"`
	Kind          string  `json:"kind"`
	Title         *string `json:"title"`
	LastMessageAt *string `json:"lastMessageAt"`
	UnreadCount   int     `json:"unreadCount"`
}

type Message struct {
	ID                string  `json:"id"`
	ProviderMessageID *string `json:"providerMessageId"`
	FromMe            bool    `json:"fromMe"`
	Kind              string  `json:"kind"`
	Body              *string `json:"body"`
	State             string  `json:"state"`
	Timestamp         string  `json:"timestamp"`
}

type Accepted struct {
	ClientMessageID string `json:"clientMessageId"`
	MessageID       string `json:"messageId"`
	State           string `json:"state"`
}

type LinkState struct {
	State       string `json:"state"`
	QR          string `json:"qr,omitempty"`
	PairingCode string `json:"pairingCode,omitempty"`
	Self        string `json:"self,omitempty"`
}

// MediaSource es una de tres formas: URL remota, clave ya subida, o base64.
// Se usan funciones y no un struct con tres campos para que sea imposible
// construir uno con dos a la vez.
type MediaSource map[string]any

func MediaURL(u string) MediaSource { return MediaSource{"url": u} }
func MediaKey(k string) MediaSource { return MediaSource{"storageKey": k} }
func MediaBase64(b, mime string) MediaSource {
	return MediaSource{"base64": b, "mimeType": mime}
}

// SendInput describe lo que se envía. Exactamente UN campo de contenido.
type SendInput struct {
	To              string         `json:"to"`
	ClientMessageID string         `json:"clientMessageId,omitempty"`
	Text            string         `json:"text,omitempty"`
	Image           MediaSource    `json:"image,omitempty"`
	Video           MediaSource    `json:"video,omitempty"`
	Audio           MediaSource    `json:"audio,omitempty"`
	Document        MediaSource    `json:"document,omitempty"`
	Sticker         MediaSource    `json:"sticker,omitempty"`
	Location        map[string]any `json:"location,omitempty"`
	Contact         map[string]any `json:"contact,omitempty"`
	Poll            map[string]any `json:"poll,omitempty"`
	Caption         string         `json:"caption,omitempty"`
	FileName        string         `json:"fileName,omitempty"`
	ReplyTo         string         `json:"replyTo,omitempty"`
	Mentions        []string       `json:"mentions,omitempty"`
	ViewOnce        bool           `json:"viewOnce,omitempty"`
	PTT             bool           `json:"ptt,omitempty"`
}

// ---------------------------------------------------------------- líneas

func (c *Client) ListLines(ctx context.Context) ([]Line, error) {
	return request[[]Line](ctx, c, http.MethodGet, "/v1/lines", nil, nil)
}

func (c *Client) ConnectLine(ctx context.Context, lineID string) (*LinkState, error) {
	v, err := request[LinkState](ctx, c, http.MethodPost, "/v1/lines/"+esc(lineID)+"/connect", nil, nil)
	return &v, err
}

func (c *Client) LineStatus(ctx context.Context, lineID string) (*LinkState, error) {
	v, err := request[LinkState](ctx, c, http.MethodGet, "/v1/lines/"+esc(lineID)+"/status", nil, nil)
	return &v, err
}

func (c *Client) DisconnectLine(ctx context.Context, lineID string) error {
	_, err := request[map[string]any](ctx, c, http.MethodPost, "/v1/lines/"+esc(lineID)+"/disconnect", nil, nil)
	return err
}

func (c *Client) Capabilities(ctx context.Context) ([]Capability, error) {
	return request[[]Capability](ctx, c, http.MethodGet, "/v1/capabilities", nil, nil)
}

// Supports dice si un transporte sabe hacer algo, ANTES de intentarlo.
func (c *Client) Supports(ctx context.Context, channelKind, capability string) (bool, error) {
	caps, err := c.Capabilities(ctx)
	if err != nil {
		return false, err
	}
	for _, k := range caps {
		if k.Kind != channelKind {
			continue
		}
		for _, cap := range k.Capabilities {
			if cap == capability {
				return true, nil
			}
		}
		return false, nil
	}
	return false, nil
}

// ---------------------------------------------------------------- mensajes

// Send envía. Vuelve en cuanto la API acepta: el mensaje queda ENCOLADO, no
// entregado. Repetir el mismo ClientMessageID no duplica.
func (c *Client) Send(ctx context.Context, lineID string, in SendInput) (*Accepted, error) {
	v, err := request[Accepted](ctx, c, http.MethodPost, "/v1/lines/"+esc(lineID)+"/messages", in, nil)
	return &v, err
}

func (c *Client) ListChats(ctx context.Context, lineID string, limit int) ([]Chat, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return request[[]Chat](ctx, c, http.MethodGet, "/v1/lines/"+esc(lineID)+"/chats", nil, q)
}

func (c *Client) ListMessages(ctx context.Context, lineID, chat string, limit int, before string) ([]Message, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if before != "" {
		q.Set("before", before)
	}
	ruta := "/v1/lines/" + esc(lineID) + "/chats/" + esc(chat) + "/messages"
	return request[[]Message](ctx, c, http.MethodGet, ruta, nil, q)
}

// IterateMessages recorre el historial página a página, entregando cada mensaje
// al callback. Devolver false para detenerse.
//
// Es un callback y no un slice para no cargar meses de conversación en memoria:
// quien lo consume decide cuándo parar.
func (c *Client) IterateMessages(
	ctx context.Context, lineID, chat string, pageSize int, fn func(Message) bool,
) error {
	if pageSize <= 0 {
		pageSize = 100
	}
	before := ""
	for {
		pagina, err := c.ListMessages(ctx, lineID, chat, pageSize, before)
		if err != nil {
			return err
		}
		for _, m := range pagina {
			if !fn(m) {
				return nil
			}
		}
		if len(pagina) < pageSize {
			return nil
		}
		before = pagina[len(pagina)-1].Timestamp
	}
}

func (c *Client) EditMessage(ctx context.Context, lineID, chat, messageID, text string) error {
	ruta := "/v1/lines/" + esc(lineID) + "/chats/" + esc(chat) + "/messages/" + esc(messageID)
	_, err := request[map[string]any](ctx, c, http.MethodPatch, ruta, map[string]string{"text": text}, nil)
	return err
}

func (c *Client) DeleteMessage(ctx context.Context, lineID, chat, messageID string) error {
	ruta := "/v1/lines/" + esc(lineID) + "/chats/" + esc(chat) + "/messages/" + esc(messageID)
	_, err := request[map[string]any](ctx, c, http.MethodDelete, ruta, nil, nil)
	return err
}

func (c *Client) React(ctx context.Context, lineID, chat, messageID, emoji string) error {
	ruta := "/v1/lines/" + esc(lineID) + "/chats/" + esc(chat) + "/messages/" + esc(messageID) + "/reaction"
	_, err := request[map[string]any](ctx, c, http.MethodPost, ruta, map[string]string{"emoji": emoji}, nil)
	return err
}

func (c *Client) MarkRead(ctx context.Context, lineID, chat string, messageIDs []string) error {
	ruta := "/v1/lines/" + esc(lineID) + "/chats/" + esc(chat) + "/read"
	_, err := request[map[string]any](ctx, c, http.MethodPost, ruta, map[string][]string{"messageIds": messageIDs}, nil)
	return err
}

// ---------------------------------------------------------------- interno

func request[T any](
	ctx context.Context, c *Client, method, path string, body any, query url.Values,
) (T, error) {
	var cero T
	destino := c.baseURL + path
	if len(query) > 0 {
		destino += "?" + query.Encode()
	}

	var datos []byte
	if body != nil {
		var err error
		datos, err = json.Marshal(body)
		if err != nil {
			return cero, fmt.Errorf("no se pudo serializar el cuerpo: %w", err)
		}
	}

	var ultimo error
	for intento := 0; intento <= c.maxRetries; intento++ {
		var lector io.Reader
		if datos != nil {
			lector = bytes.NewReader(datos)
		}
		peticion, err := http.NewRequestWithContext(ctx, method, destino, lector)
		if err != nil {
			return cero, err
		}
		peticion.Header.Set("Authorization", "Bearer "+c.apiKey)
		if datos != nil {
			peticion.Header.Set("Content-Type", "application/json")
		}

		respuesta, err := c.http.Do(peticion)
		if err != nil {
			ultimo = err
			if intento < c.maxRetries {
				time.Sleep(time.Duration(1<<intento) * 500 * time.Millisecond)
				continue
			}
			break
		}

		crudo, _ := io.ReadAll(respuesta.Body)
		respuesta.Body.Close()

		if respuesta.StatusCode >= 400 {
			problema := map[string]any{}
			_ = json.Unmarshal(crudo, &problema)
			fallo := &APIError{
				Status:  respuesta.StatusCode,
				Detail:  detalleDe(problema, respuesta.StatusCode),
				Code:    codigoDe(problema),
				Problem: problema,
			}
			// Solo se reintenta lo pasajero. Repetir un 403 no lo arregla y
			// multiplica el ruido en los registros de quien lo recibe.
			if fallo.Retryable() && intento < c.maxRetries {
				ultimo = fallo
				time.Sleep(time.Duration(1<<intento) * 500 * time.Millisecond)
				continue
			}
			return cero, fallo
		}

		if len(crudo) == 0 {
			return cero, nil
		}
		var sobre struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(crudo, &sobre); err == nil && len(sobre.Data) > 0 {
			var valor T
			if err := json.Unmarshal(sobre.Data, &valor); err != nil {
				return cero, fmt.Errorf("respuesta inesperada: %w", err)
			}
			return valor, nil
		}
		var valor T
		if err := json.Unmarshal(crudo, &valor); err != nil {
			return cero, fmt.Errorf("respuesta inesperada: %w", err)
		}
		return valor, nil
	}

	if ultimo == nil {
		ultimo = fmt.Errorf("sin detalle")
	}
	return cero, &NetworkError{Cause: ultimo}
}

func detalleDe(p map[string]any, status int) string {
	for _, clave := range []string{"detail", "title"} {
		if v, ok := p[clave].(string); ok && v != "" {
			return v
		}
	}
	return fmt.Sprintf("la API respondió %d", status)
}

func codigoDe(p map[string]any) string {
	tipo, _ := p["type"].(string)
	if tipo == "" {
		return "unknown"
	}
	partes := strings.Split(tipo, "/")
	return partes[len(partes)-1]
}

// esc escapa un tramo de ruta con la misma regla que `encodeURIComponent` de
// JavaScript y `quote(safe="")` de Python.
//
// `url.PathEscape` NO vale: deja pasar la arroba, porque es legal en un tramo de
// ruta según la RFC. Pero entonces este SDK mandaría una ruta distinta a la de
// los otros dos para la misma dirección, y la API decodifica lo que recibe —así
// que la diferencia acabaría notándose el día que una dirección traiga un
// carácter que sí importe.
func esc(v string) string {
	const sinEscapar = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var b strings.Builder
	for _, octeto := range []byte(v) {
		if strings.IndexByte(sinEscapar, octeto) >= 0 {
			b.WriteByte(octeto)
		} else {
			fmt.Fprintf(&b, "%%%02X", octeto)
		}
	}
	return b.String()
}
