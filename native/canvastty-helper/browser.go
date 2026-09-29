package main

// `canvastty-helper mcp-browser`: src/agent-browser/mcp-helper.mjs, the canvastty_browser stdio MCP server. It
// authenticates to the AgentGateway with the one-time capability from its environment, keeps the connection alive
// with heartbeats, reconnects with the rotated token, and forwards validated tool calls.

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"sync"
	"time"
)

const (
	browserProtocolVersion    = 1
	defaultMCPProtocolVersion = "2025-06-18"
	maxBridgePayloadBytes     = 512 * 1024
)

var browserEnvKeys = []string{
	"CANVASTTY_AGENT_BROWSER_ADDRESS",
	"CANVASTTY_AGENT_ID",
	"CANVASTTY_AGENT_CONNECTION_ID",
	"CANVASTTY_TERMINAL_SESSION_ID",
	"CANVASTTY_AGENT_PROVIDER",
	"CANVASTTY_AGENT_CAPABILITY",
}

var browserProviders = []string{"claude", "codex", "qwen", "kimi", "opencode", "hermes"}

// bridgeError is BridgeClientError.
type bridgeError struct {
	code      string
	message   string
	retryable bool
}

func (e *bridgeError) Error() string { return e.message }

func (e *bridgeError) toJSON() *jsObject {
	return obj("code", e.code, "message", e.message, "retryable", e.retryable)
}

func newBridgeError(payload any) *bridgeError {
	err := &bridgeError{code: "BRIDGE_UNAVAILABLE", message: "CanvasTTY browser bridge failed."}
	if text, ok := field(payload, "message").(string); ok {
		err.message = text
	}
	if text, ok := field(payload, "code").(string); ok {
		err.code = text
	}
	err.retryable = truthy(field(payload, "retryable"))
	return err
}

func unavailableError() *bridgeError {
	return &bridgeError{code: "BRIDGE_UNAVAILABLE", message: "CanvasTTY agent browser gateway is unavailable.", retryable: true}
}

type browserIdentity struct {
	address, agentID, connectionID, terminalSessionID, provider string
	capabilityToken                                             any
}

type pendingCall struct {
	fut     *future
	timeout *time.Timer
	tool    string
	args    any
	sent    bool
}

type gatewayClient struct {
	mu                 sync.Mutex
	identity           *browserIdentity
	connectTimeout     time.Duration
	reconnectDelay     time.Duration
	maxReconnectDelay  time.Duration
	socket             *asyncSocket
	lines              *lineReader
	pending            map[string]*pendingCall
	order              []string
	authenticated      *future
	authenticatedOwned bool // resolveAuthenticated / rejectAuthenticated still set
	heartbeat          *time.Timer
	heartbeatID        int
	reconnectTimer     *time.Timer
	reconnectAttempts  int
	ready              bool
	closed             bool
}

func newGatewayClient(identity *browserIdentity) *gatewayClient {
	return &gatewayClient{
		identity:          identity,
		connectTimeout:    10 * time.Second,
		reconnectDelay:    100 * time.Millisecond,
		maxReconnectDelay: 2 * time.Second,
		lines:             newLineReader(maxBridgePayloadBytes, func() bool { return false }),
		pending:           map[string]*pendingCall{},
	}
}

func (c *gatewayClient) connect() *future {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connectLocked()
}

func (c *gatewayClient) connectLocked() *future {
	if c.closed {
		return rejectedFuture(unavailableError())
	}
	if c.ready {
		return resolvedFuture(nil)
	}
	if c.authenticated == nil {
		c.authenticated = newFuture()
		c.authenticatedOwned = true
	}
	if c.socket == nil && c.reconnectTimer == nil {
		c.openConnection()
	}
	return c.authenticated
}

func (c *gatewayClient) openConnection() {
	if c.closed || c.socket != nil {
		return
	}
	var socket *asyncSocket
	timeout := &guardedTimer{}
	onConnect := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		timeout.stop()
		if c.socket != socket || c.closed {
			return
		}
		if err := c.send(obj(
			"v", float64(browserProtocolVersion),
			"type", "authenticate",
			"agentId", c.identity.agentID,
			"connectionId", c.identity.connectionID,
			"terminalSessionId", c.identity.terminalSessionID,
			"provider", c.identity.provider,
			"capabilityToken", c.identity.capabilityToken,
		)); err != nil {
			c.handleDisconnect(socket)
		}
	}
	onData := func(chunk []byte) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.onData(socket, chunk)
	}
	onEnd := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		timeout.stop()
		c.handleDisconnect(socket)
	}
	socket = openSocket(c.identity.address, onConnect, onData, onEnd)
	c.socket = socket
	c.lines = newLineReader(maxBridgePayloadBytes, func() bool { return false })
	timeout.start(&c.mu, c.connectTimeout, func() { c.handleDisconnect(socket) })
}

// call forwards one tool call; an error is thrown synchronously (validation, a closed client).
func (c *gatewayClient) call(tool string, args any, id string) (*future, error) {
	if message, ok := validateToolArguments(tool, args); !ok {
		return nil, &bridgeError{code: "INVALID_REQUEST", message: message}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, unavailableError()
	}
	if existing, ok := c.pending[id]; ok {
		return existing.fut, nil
	}
	timeoutMs := 120_000.0
	if value, ok := field(args, "timeoutMs").(float64); ok {
		timeoutMs = value
	}
	timeoutMs = math.Min(125_000, timeoutMs+5_000)
	p := &pendingCall{fut: newFuture(), tool: tool, args: args}
	p.timeout = time.AfterFunc(time.Duration(timeoutMs)*time.Millisecond, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.pending[id] != p {
			return
		}
		c.deletePending(id)
		p.fut.reject(&bridgeError{code: "TIMEOUT", message: "Browser command timed out.", retryable: true})
	})
	// Registered before connecting: a cancellation in the same turn removes it before anything is sent.
	c.pending[id] = p
	c.order = append(c.order, id)
	authenticated := c.connectLocked()
	go func() {
		if _, err := authenticated.wait(); err != nil {
			c.mu.Lock()
			defer c.mu.Unlock()
			c.rejectPending(id, p, asBridgeError(err))
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		c.flushPending()
	}()
	return p.fut, nil
}

func asBridgeError(err error) error {
	if b, ok := err.(*bridgeError); ok {
		return b
	}
	return unavailableError()
}

func (c *gatewayClient) deletePending(id string) {
	delete(c.pending, id)
	for i, key := range c.order {
		if key == id {
			c.order = append(c.order[:i:i], c.order[i+1:]...)
			break
		}
	}
}

func (c *gatewayClient) cancel(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pending[id]
	if !ok {
		return
	}
	if p.sent {
		// The local cancellation still wins even if the gateway disconnected.
		_ = c.send(obj("v", float64(browserProtocolVersion), "type", "cancel", "id", id))
	}
	p.timeout.Stop()
	c.deletePending(id)
	p.fut.reject(&bridgeError{code: "CANCELED", message: "Browser command was canceled by the MCP client.", retryable: true})
}

func (c *gatewayClient) rejectPending(id string, p *pendingCall, err error) {
	if c.pending[id] != p {
		return
	}
	p.timeout.Stop()
	c.deletePending(id)
	p.fut.reject(err)
}

func (c *gatewayClient) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	err := unavailableError()
	c.closed = true
	c.ready = false
	c.rejectAuthenticated(err)
	c.authenticated = nil
	c.stopHeartbeat()
	if c.reconnectTimer != nil {
		c.reconnectTimer.Stop()
		c.reconnectTimer = nil
	}
	socket := c.socket
	c.socket = nil
	if socket != nil {
		socket.destroy()
	}
	c.failPending(err)
}

func (c *gatewayClient) rejectAuthenticated(err error) {
	if c.authenticatedOwned && c.authenticated != nil {
		c.authenticated.reject(err)
	}
	c.authenticatedOwned = false
}

func (c *gatewayClient) send(message *jsObject) error {
	if c.socket == nil || c.socket.isDestroyed() {
		return unavailableError()
	}
	text, err := canonicalStringify(message)
	if err != nil {
		return &internalError{message: "Canonical JSON cannot contain a non-finite number."}
	}
	if len(text) > maxBridgePayloadBytes {
		return &bridgeError{code: "PAYLOAD_TOO_LARGE", message: "Browser request exceeds 512KB."}
	}
	c.socket.write([]byte(text + "\n"))
	return nil
}

func (c *gatewayClient) onData(socket *asyncSocket, chunk []byte) {
	if c.closed || c.socket != socket {
		return
	}
	lines, ok := c.lines.push(chunk)
	if !ok {
		c.fail(&bridgeError{code: "PAYLOAD_TOO_LARGE", message: "Browser response exceeds 512KB."})
		return
	}
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}
		message, err := jsonParse(line)
		if err != nil {
			c.fail(&bridgeError{code: "INVALID_REQUEST", message: "CanvasTTY gateway returned invalid JSON."})
			return
		}
		c.onMessage(socket, message)
	}
}

func (c *gatewayClient) onMessage(socket *asyncSocket, message any) {
	if c.socket != socket || c.closed {
		return
	}
	if !isObjectLike(message) || field(message, "v") != float64(browserProtocolVersion) {
		c.fail(&bridgeError{code: "INVALID_REQUEST", message: "CanvasTTY gateway protocol mismatch."})
		return
	}
	switch field(message, "type") {
	case "authenticated":
		token, isString := field(message, "reconnectToken").(string)
		if c.ready || !isString || token == "" || jsLength(token) > 128 {
			c.fail(&bridgeError{code: "INVALID_REQUEST", message: "CanvasTTY gateway returned invalid authentication state."})
			return
		}
		interval := 5_000.0
		if value, ok := field(message, "heartbeatIntervalMs").(float64); ok && isFinite(value) {
			interval = value
		}
		interval = math.Max(1_000, math.Min(5_000, interval))
		c.identity.capabilityToken = token
		c.ready = true
		c.reconnectAttempts = 0
		if c.authenticatedOwned && c.authenticated != nil {
			c.authenticated.resolve(nil)
		}
		c.authenticatedOwned = false
		c.stopHeartbeat()
		c.startHeartbeat(socket, time.Duration(interval)*time.Millisecond)
		c.flushPending()
	case "response":
		id, _ := field(message, "id").(string)
		p, ok := c.pending[id]
		if !ok {
			return
		}
		p.timeout.Stop()
		c.deletePending(id)
		if errorPayload := field(message, "error"); truthy(errorPayload) {
			p.fut.reject(newBridgeError(errorPayload))
		} else {
			p.fut.resolve(field(message, "result"))
		}
	case "error":
		err := newBridgeError(field(message, "error"))
		if err.retryable {
			c.handleDisconnect(socket)
		} else {
			c.fail(err)
		}
	}
}

func (c *gatewayClient) startHeartbeat(socket *asyncSocket, interval time.Duration) {
	c.heartbeatID++
	id := c.heartbeatID
	var tick func()
	tick = func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.heartbeatID != id || c.heartbeat == nil {
			return
		}
		if err := c.send(obj("v", float64(browserProtocolVersion), "type", "heartbeat", "timestamp", float64(time.Now().UnixMilli()))); err != nil {
			c.handleDisconnect(socket)
			return
		}
		if c.heartbeatID == id && c.heartbeat != nil {
			c.heartbeat = time.AfterFunc(interval, tick)
		}
	}
	c.heartbeat = time.AfterFunc(interval, tick)
}

func (c *gatewayClient) stopHeartbeat() {
	if c.heartbeat != nil {
		c.heartbeat.Stop()
		c.heartbeat = nil
	}
	c.heartbeatID++
}

func (c *gatewayClient) flushPending() {
	if !c.ready || c.closed {
		return
	}
	for _, id := range append([]string(nil), c.order...) {
		p, ok := c.pending[id]
		if !ok || p.sent {
			continue
		}
		p.sent = true
		if err := c.send(obj(
			"v", float64(browserProtocolVersion),
			"type", "request",
			"id", id,
			"tool", p.tool,
			"arguments", p.args,
		)); err != nil {
			p.sent = false
			c.handleDisconnect(c.socket)
			return
		}
	}
}

func (c *gatewayClient) handleDisconnect(socket *asyncSocket) {
	if c.closed || socket == nil || c.socket != socket {
		return
	}
	wasReady := c.ready
	c.socket = nil
	c.ready = false
	c.lines = newLineReader(maxBridgePayloadBytes, func() bool { return false })
	c.stopHeartbeat()
	socket.destroy()
	for _, p := range c.pending {
		p.sent = false
	}
	if wasReady {
		c.authenticated = nil
		c.authenticatedOwned = false
	}
	c.scheduleReconnect()
}

func (c *gatewayClient) scheduleReconnect() {
	if c.closed || c.socket != nil || c.reconnectTimer != nil {
		return
	}
	base := c.reconnectDelay
	maximum := c.maxReconnectDelay
	if maximum < base {
		maximum = base
	}
	attempts := c.reconnectAttempts
	if attempts > 5 {
		attempts = 5
	}
	delay := base * time.Duration(1<<attempts)
	if delay > maximum {
		delay = maximum
	}
	c.reconnectAttempts++
	var timer *time.Timer
	timer = time.AfterFunc(delay, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.reconnectTimer != timer {
			return
		}
		c.reconnectTimer = nil
		c.openConnection()
	})
	c.reconnectTimer = timer
}

func (c *gatewayClient) fail(err *bridgeError) {
	if c.closed {
		return
	}
	c.closed = true
	c.ready = false
	c.rejectAuthenticated(err)
	c.authenticated = nil
	c.stopHeartbeat()
	if c.reconnectTimer != nil {
		c.reconnectTimer.Stop()
		c.reconnectTimer = nil
	}
	socket := c.socket
	c.socket = nil
	if socket != nil {
		socket.destroy()
	}
	c.failPending(err)
}

func (c *gatewayClient) failPending(err error) {
	for _, p := range c.pending {
		p.timeout.Stop()
		p.fut.reject(err)
	}
	c.pending = map[string]*pendingCall{}
	c.order = nil
}

// ---- tool results ----

func formatToolResult(result any) (*jsObject, error) {
	if !isObjectLike(result) {
		// The JS helper passes a plain object here, not a BridgeClientError, so the generic failure is what shows.
		return errorToolResult(&internalError{message: "Browser returned no result."}), nil
	}
	content := []any{}
	screenshot := screenshotContent(field(result, "data"))
	if screenshot != nil {
		content = append(content, screenshot)
	}
	if resource := artifactContent(field(result, "data")); resource != nil {
		content = append(content, resource)
	}
	text, err := canonicalStringify(summarizeResult(result, screenshot != nil))
	if err != nil {
		return nil, &internalError{message: err.Error()}
	}
	content = append(content, obj("type", "text", "text", text))
	return obj("content", content, "isError", field(result, "ok") != true), nil
}

// spread is `{ ...value }` for a parsed value.
func spread(value any) *jsObject {
	out := newObject()
	switch v := value.(type) {
	case *jsObject:
		for _, key := range v.ordered() {
			out.set(key, v.values[key])
		}
	case []any:
		for i, item := range v {
			out.set(jsNumber(float64(i)), item)
		}
	case string:
		units := codeUnits(v)
		for i := range units {
			out.set(jsNumber(float64(i)), string(appendCodePoint(nil, uint32(units[i]))))
		}
	}
	return out
}

const imagePlaceholder = "<returned as MCP image content>"

func summarizeResult(result any, hasImage bool) any {
	data := field(result, "data")
	if !hasImage || !truthy(data) || !isObjectLike(data) {
		return result
	}
	copied := spread(data)
	image := field(copied, "image")
	if truthy(image) && isObjectLike(image) {
		next := spread(image)
		if _, ok := field(image, "data").(string); ok {
			next.set("data", imagePlaceholder)
		}
		if _, ok := field(image, "base64").(string); ok {
			next.set("base64", imagePlaceholder)
		}
		copied.set("image", next)
	} else if _, ok := field(copied, "mimeType").(string); ok {
		if _, ok := field(copied, "data").(string); ok {
			copied.set("data", imagePlaceholder)
		}
		if _, ok := field(copied, "base64").(string); ok {
			copied.set("base64", imagePlaceholder)
		}
	}
	summary := spread(result)
	summary.set("data", copied)
	return summary
}

func screenshotContent(data any) *jsObject {
	if !truthy(data) || !isObjectLike(data) {
		return nil
	}
	image := data
	if nested := field(data, "image"); truthy(nested) && isObjectLike(nested) {
		image = nested
	}
	encoded, isString := field(image, "data").(string)
	if !isString {
		encoded, isString = field(image, "base64").(string)
	}
	mimeType, _ := field(image, "mimeType").(string)
	if (mimeType != "image/png" && mimeType != "image/jpeg" && mimeType != "image/webp") || !isString {
		return nil
	}
	if len(encoded) > 470_000 {
		return nil
	}
	return obj("type", "image", "data", encoded, "mimeType", mimeType)
}

func artifactContent(data any) *jsObject {
	var artifact any
	if truthy(data) && isObjectLike(data) {
		artifact = field(data, "artifact")
	}
	if !truthy(artifact) || !isObjectLike(artifact) {
		return nil
	}
	uri, ok := field(artifact, "uri").(string)
	if !ok {
		return nil
	}
	name, ok := field(artifact, "name").(string)
	if !ok {
		name = "CanvasTTY browser artifact"
	}
	out := obj("type", "resource_link", "uri", uri, "name", name)
	if mimeType, ok := field(artifact, "mimeType").(string); ok {
		out.set("mimeType", mimeType)
	}
	if size, ok := field(artifact, "size").(float64); ok && isInteger(size) && math.Abs(size) <= 9007199254740991 && size >= 0 {
		out.set("size", size)
	}
	return out
}

func errorToolResult(err error) *jsObject {
	payload := obj("code", "BRIDGE_UNAVAILABLE", "message", "CanvasTTY browser bridge failed.", "retryable", true)
	if b, ok := err.(*bridgeError); ok {
		payload = b.toJSON()
	}
	text, _ := canonicalStringify(obj("ok", false, "error", payload))
	return obj("content", []any{obj("type", "text", "text", text)}, "isError", true)
}

// ---- dispatcher ----

func browserErrorResponse(id any, err error) *jsObject {
	code := -32603
	message := "Internal error"
	switch e := err.(type) {
	case *bridgeError:
		message = "CanvasTTY browser: " + e.code + ": " + e.message
	case *rpcError:
		code = e.code
		message = e.message
	}
	return obj("jsonrpc", "2.0", "id", idOrNull(id), "error", obj("code", float64(code), "message", message))
}

func mcpRequestKey(value any) (any, error) {
	switch value.(type) {
	case string, float64, nil:
		text, err := canonicalStringify(value)
		if err != nil {
			return nil, &internalError{message: err.Error()}
		}
		return text, nil
	}
	return nil, nil
}

func bridgeRequestIDFor(mcpID any, tool string, args any) (string, error) {
	payload, err := canonicalStringify(obj("mcpId", idOrNull(mcpID), "tool", tool, "args", args))
	if err != nil {
		return "", &internalError{message: err.Error()}
	}
	sum := sha256.Sum256([]byte(payload))
	return "mcp:" + hex.EncodeToString(sum[:]), nil
}

func browserDispatcher(client *gatewayClient) func(any) (*jsObject, error) {
	var activeMu sync.Mutex
	active := map[string]string{}
	return func(request any) (*jsObject, error) {
		if err := requestShapeError(request); err != nil {
			return nil, err
		}
		id := field(request, "id")
		switch field(request, "method") {
		case "notifications/initialized":
			return nil, nil
		case "notifications/cancelled":
			key, err := mcpRequestKey(field(field(request, "params"), "requestId"))
			if err != nil {
				return nil, err
			}
			if key != nil {
				activeMu.Lock()
				bridgeID, ok := active[key.(string)]
				activeMu.Unlock()
				if ok && bridgeID != "" {
					client.cancel(bridgeID)
				}
			}
			return nil, nil
		case "ping":
			return response(id, newObject()), nil
		case "initialize":
			if _, err := client.connect().wait(); err != nil {
				return nil, err
			}
			return response(id, obj(
				"protocolVersion", defaultMCPProtocolVersion,
				"capabilities", obj("tools", obj("listChanged", false)),
				"serverInfo", obj("name", catalogString("browser", "serverName"), "version", "1.0.0"),
				"instructions", catalogString("browser", "instructions"),
			)), nil
		case "tools/list":
			return response(id, obj("tools", catalogValue("browser", "tools"))), nil
		case "tools/call":
			if isUndefined(id) {
				return nil, &rpcError{code: -32600, message: "Tool calls require a request id"}
			}
			params := field(request, "params")
			name, isString := field(params, "name").(string)
			if !truthy(params) || !isObjectLike(params) || !isString {
				return nil, &rpcError{code: -32602, message: "Invalid tool parameters"}
			}
			args := field(params, "arguments")
			if args == nil || isUndefined(args) {
				args = newObject()
			}
			key, err := mcpRequestKey(id)
			if err != nil {
				return nil, err
			}
			bridgeID, err := bridgeRequestIDFor(id, name, args)
			if err != nil {
				return nil, err
			}
			if key != nil {
				activeMu.Lock()
				active[key.(string)] = bridgeID
				activeMu.Unlock()
			}
			defer func() {
				if key != nil {
					activeMu.Lock()
					if active[key.(string)] == bridgeID {
						delete(active, key.(string))
					}
					activeMu.Unlock()
				}
			}()
			fut, err := client.call(name, args, bridgeID)
			if err != nil {
				return response(id, errorToolResult(err)), nil
			}
			result, err := fut.wait()
			if err != nil {
				return response(id, errorToolResult(err)), nil
			}
			formatted, err := formatToolResult(result)
			if err != nil {
				return response(id, errorToolResult(err)), nil
			}
			return response(id, formatted), nil
		}
		if isUndefined(id) {
			return nil, nil
		}
		return nil, &rpcError{code: -32601, message: "Method not found"}
	}
}

func runBrowserMCP() int {
	identity, ok := readBrowserIdentity()
	if !ok {
		return 1
	}
	client := newGatewayClient(identity)
	server := &mcpServer{
		maxBytes:      maxBridgePayloadBytes,
		requestLimit:  "Request exceeds 512KB",
		responseLimit: "Response exceeds 512KB",
		errorResponse: browserErrorResponse,
		dispatch:      browserDispatcher(client),
		blocking:      map[string]bool{"initialize": true, "tools/call": true},
		close:         client.close,
	}
	return server.run()
}

func readBrowserIdentity() (*browserIdentity, bool) {
	values := make([]string, len(browserEnvKeys))
	for i, key := range browserEnvKeys {
		value, ok := env(key)
		if !ok || value == "" || jsLength(value) > 8_192 {
			return nil, false
		}
		values[i] = value
	}
	identity := &browserIdentity{
		address: values[0], agentID: values[1], connectionID: values[2], terminalSessionID: values[3],
		provider: values[4], capabilityToken: values[5],
	}
	if !isLocalEndpoint(identity.address) {
		return nil, false
	}
	for _, provider := range browserProviders {
		if provider == identity.provider {
			return identity, true
		}
	}
	return nil, false
}
