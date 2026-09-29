package main

// `canvastty-helper mcp-orchestration`: src/agent-browser/orchestration-helper.mjs, the canvastty_agents stdio MCP
// server of orchestrators (and of sessions a plugin tool applies to). It authenticates to the OrchestrationGateway
// with the card's capability and connection id and forwards tool calls; after a dropped connection it reconnects with
// the rotated token.

import (
	"sync"
	"time"
)

const maxOrchestrationPayloadBytes = 128 * 1024

// orchestrationError is orchestration-helper.mjs BridgeError: the gateway's error payload as is.
type orchestrationError struct {
	payload any
	message string
}

func (e *orchestrationError) Error() string { return e.message }

func newOrchestrationError(payload any) *orchestrationError {
	message, _ := field(payload, "message").(string)
	return &orchestrationError{payload: payload, message: message}
}

func orchestrationUnavailable() *orchestrationError {
	return newOrchestrationError(obj(
		"code", "BRIDGE_UNAVAILABLE",
		"message", "CanvasTTY orchestration bridge is unavailable.",
		"retryable", true,
	))
}

type orchestrationIdentity struct {
	address, terminalSessionID, connectionID string
	capabilityToken                          any
}

type orchestrationClient struct {
	mu                 sync.Mutex
	identity           orchestrationIdentity
	connectTimeout     time.Duration
	socket             *asyncSocket
	lines              *lineReader
	pending            map[string]*future
	authenticated      *future
	authenticatedState bool
	heartbeats         []*time.Timer
	heartbeatID        int
	closed             bool
	reconnectToken     any
}

func newOrchestrationClient(identity orchestrationIdentity) *orchestrationClient {
	return &orchestrationClient{
		identity:       identity,
		connectTimeout: 10 * time.Second,
		lines:          newLineReader(maxOrchestrationPayloadBytes, func() bool { return false }),
		pending:        map[string]*future{},
	}
}

func (c *orchestrationClient) connect() *future {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return rejectedFuture(orchestrationUnavailable())
	}
	if c.authenticated != nil {
		return c.authenticated
	}
	c.authenticated = newFuture()
	c.openConnection()
	return c.authenticated
}

func (c *orchestrationClient) openConnection() {
	if c.closed || c.socket != nil {
		return
	}
	var socket *asyncSocket
	timeout := &guardedTimer{}
	onConnect := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		timeout.stop()
		text, _ := canonicalStringify(obj(
			"v", float64(browserProtocolVersion),
			"type", "authenticate",
			"connectionId", c.identity.connectionID,
			"terminalSessionId", c.identity.terminalSessionID,
			"capabilityToken", c.identity.capabilityToken,
		))
		socket.write([]byte(text + "\n"))
	}
	onData := func(chunk []byte) {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.handleData(socket, chunk)
	}
	onEnd := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.handleDisconnect(socket, orchestrationUnavailable())
	}
	socket = openSocket(c.identity.address, onConnect, onData, onEnd)
	c.socket = socket
	c.lines = newLineReader(maxOrchestrationPayloadBytes, func() bool { return false })
	timeout.start(&c.mu, c.connectTimeout, func() { c.handleDisconnect(socket, orchestrationUnavailable()) })
}

func (c *orchestrationClient) handleData(socket *asyncSocket, chunk []byte) {
	if socket != c.socket {
		return
	}
	lines, ok := c.lines.push(chunk)
	if !ok {
		// The gateway never sends a line over the limit: this peer is broken.
		c.handleDisconnect(socket, orchestrationUnavailable())
		return
	}
	for _, line := range lines {
		if len(line) == 0 {
			continue
		}
		message, err := jsonParse(line)
		if err != nil {
			continue
		}
		c.handleMessage(socket, message)
	}
}

func (c *orchestrationClient) handleMessage(socket *asyncSocket, message any) {
	if message == nil {
		// `message.type` on null throws in the socket's data handler: the JS helper dies.
		crash()
	}
	switch field(message, "type") {
	case "authenticated":
		token := field(message, "reconnectToken")
		if token == nil || isUndefined(token) {
			token = nil
		}
		c.reconnectToken = token
		c.authenticatedState = true
		interval := field(message, "heartbeatIntervalMs")
		if interval == nil || isUndefined(interval) {
			interval = 5_000.0
		}
		c.startHeartbeat(socket, nodeTimerDelay(interval))
		if c.authenticated != nil {
			c.authenticated.resolve(nil)
		}
	case "response":
		id, _ := field(message, "id").(string)
		pending, ok := c.pending[id]
		if !ok {
			return
		}
		delete(c.pending, id)
		if errorPayload := field(message, "error"); truthy(errorPayload) {
			pending.reject(newOrchestrationError(errorPayload))
		} else {
			result := field(message, "result")
			if result == nil || isUndefined(result) {
				result = newObject()
			}
			pending.resolve(result)
		}
	}
}

// nodeTimerDelay is how setInterval reads its delay: a number (or numeric text) from 1 to 2^31-1 ms, else 1 ms.
func nodeTimerDelay(value any) time.Duration {
	var delay float64
	switch v := value.(type) {
	case float64:
		delay = v
	case string:
		delay = jsToNumber(v)
	case bool:
		if v {
			delay = 1
		}
	default:
		delay = nan()
	}
	if !(delay >= 1 && delay <= 2147483647) {
		delay = 1
	}
	return time.Duration(delay * float64(time.Millisecond))
}

// startHeartbeat adds an interval; like the JS helper, a second "authenticated" adds a second one.
func (c *orchestrationClient) startHeartbeat(socket *asyncSocket, interval time.Duration) {
	id := c.heartbeatID
	var timer *time.Timer
	var tick func()
	tick = func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.heartbeatID != id {
			return
		}
		if c.socket == socket && !c.closed {
			text, _ := canonicalStringify(obj("v", float64(browserProtocolVersion), "type", "heartbeat", "timestamp", float64(time.Now().UnixMilli())))
			socket.write([]byte(text + "\n"))
		}
		timer.Reset(interval)
	}
	timer = time.AfterFunc(interval, tick)
	c.heartbeats = append(c.heartbeats, timer)
}

func (c *orchestrationClient) stopHeartbeats() {
	for _, timer := range c.heartbeats {
		timer.Stop()
	}
	c.heartbeats = nil
	c.heartbeatID++
}

func (c *orchestrationClient) handleDisconnect(socket *asyncSocket, err error) {
	if socket != c.socket || c.closed {
		return
	}
	c.socket = nil
	c.stopHeartbeats()
	for id, pending := range c.pending {
		pending.reject(err)
		delete(c.pending, id)
	}
	if !c.authenticatedState {
		if c.authenticated != nil {
			c.authenticated.reject(err)
		}
		return
	}
	// The bootstrap token is consumed; the rotated reconnect token keeps this helper usable after a socket drop.
	if truthy(c.reconnectToken) {
		c.identity.capabilityToken = c.reconnectToken
		time.AfterFunc(200*time.Millisecond, func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			if !c.closed && c.socket == nil {
				c.openConnection()
			}
		})
	}
}

func (c *orchestrationClient) request(message *jsObject, id string) (any, error) {
	if _, err := c.connect().wait(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.socket == nil {
		// `this.socket.write` on null: a TypeError rejects the request.
		c.mu.Unlock()
		return nil, &internalError{message: "Cannot read properties of null (reading 'write')"}
	}
	pending := newFuture()
	c.pending[id] = pending
	full := obj("v", float64(browserProtocolVersion))
	for _, key := range message.keys {
		full.set(key, message.values[key])
	}
	text, err := canonicalStringify(full)
	if err != nil {
		c.mu.Unlock()
		return nil, &internalError{message: err.Error()}
	}
	c.socket.write([]byte(text + "\n"))
	c.mu.Unlock()
	return pending.wait()
}

func (c *orchestrationClient) call(tool string, args any) (any, error) {
	id := "helper-" + randomUUID()
	return c.request(obj("type", "request", "id", id, "tool", tool, "arguments", args), id)
}

func (c *orchestrationClient) listTools() (any, error) {
	id := "helper-" + randomUUID()
	result, err := c.request(obj("type", "list_tools", "id", id), id)
	if err != nil {
		return nil, err
	}
	if tools, ok := field(result, "tools").([]any); ok {
		return tools, nil
	}
	return []any{}, nil
}

func (c *orchestrationClient) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.stopHeartbeats()
	if c.socket != nil {
		c.socket.destroy()
	}
	c.socket = nil
	for id, pending := range c.pending {
		pending.reject(orchestrationUnavailable())
		delete(c.pending, id)
	}
}

func orchestrationErrorResponse(id any, err error) *jsObject {
	code := -32603
	message := "Internal error"
	switch e := err.(type) {
	case *rpcError:
		code = e.code
		message = e.message
	case *orchestrationError:
		message = e.message
	case *internalError:
		message = e.message
	}
	return obj("jsonrpc", "2.0", "id", idOrNull(id), "error", obj("code", float64(code), "message", message))
}

func orchestrationFailure(payload any) *jsObject {
	text, _ := canonicalStringify(obj("ok", false, "error", payload))
	return obj("content", []any{obj("type", "text", "text", text)}, "isError", true)
}

func orchestrationDispatcher(client *orchestrationClient) func(any) (*jsObject, error) {
	return func(request any) (*jsObject, error) {
		if err := requestShapeError(request); err != nil {
			return nil, err
		}
		id := field(request, "id")
		switch field(request, "method") {
		case "notifications/initialized":
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
				"serverInfo", obj("name", catalogString("orchestration", "serverName"), "version", "1.0.0"),
				"instructions", catalogString("orchestration", "instructions"),
			)), nil
		case "tools/list":
			// The host lists what this session sees; if it cannot answer, the core tools are listed as before.
			tools, err := client.listTools()
			if err != nil {
				tools = catalogValue("orchestration", "tools")
			}
			return response(id, obj("tools", tools)), nil
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
			// A malformed core call gets its reason here; the bridge would drop the whole connection over it.
			if coreOrchestrationTool(name) {
				if message, ok := validateOrchestrationArguments(name, args); !ok {
					return response(id, orchestrationFailure(obj("code", "INVALID_REQUEST", "message", message, "retryable", false))), nil
				}
			}
			result, err := client.call(name, args)
			if err == nil {
				if text, ok := field(result, "text").(string); ok && isPluginOrchestrationTool(name) {
					return response(id, obj("content", []any{obj("type", "text", "text", text)}, "isError", field(result, "isError") == true)), nil
				}
				if text, stringifyErr := canonicalStringify(result); stringifyErr == nil {
					return response(id, obj("content", []any{obj("type", "text", "text", text)}, "isError", false)), nil
				}
				err = &internalError{message: "Canonical JSON cannot contain a non-finite number."}
			}
			if bridge, ok := err.(*orchestrationError); ok {
				return response(id, orchestrationFailure(bridge.payload)), nil
			}
			return response(id, orchestrationFailure(orchestrationUnavailable().payload)), nil
		}
		if isUndefined(id) {
			return nil, nil
		}
		return nil, &rpcError{code: -32601, message: "Method not found"}
	}
}

func runOrchestrationMCP() int {
	keys := []string{
		"CANVASTTY_ORCHESTRATION_ADDRESS",
		"CANVASTTY_ORCHESTRATION_CAPABILITY",
		"CANVASTTY_TERMINAL_SESSION_ID",
		"CANVASTTY_ORCHESTRATION_CONNECTION_ID",
	}
	values := make([]string, len(keys))
	for i, key := range keys {
		value, ok := env(key)
		if !ok || value == "" || jsLength(value) > 8_192 {
			return 1
		}
		values[i] = value
	}
	client := newOrchestrationClient(orchestrationIdentity{
		address: values[0], capabilityToken: values[1], terminalSessionID: values[2], connectionID: values[3],
	})
	server := &mcpServer{
		maxBytes:      maxOrchestrationPayloadBytes,
		requestLimit:  "Request exceeds 128KB",
		responseLimit: "Response exceeds 128KB",
		errorResponse: orchestrationErrorResponse,
		dispatch:      orchestrationDispatcher(client),
		blocking:      map[string]bool{"initialize": true, "tools/call": true, "tools/list": true},
		close:         client.close,
	}
	return server.run()
}
