package main

// `canvastty-helper permission-gate pretool`: src/agent-runtime/permission-gate.mjs, the decision hook of Claude Code,
// Codex and Qwen Code (PreToolUse). It asks the RuntimeGateway about one tool call and prints what the CLI reads.
// With CANVASTTY_RUNTIME_FAIL_CLOSED=1 every way the check can fail is the CLI's deny JSON with FAIL_CLOSED_MESSAGE;
// without it such a call gets nothing. Every answer exits 0.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
)

const failClosedMessage = "CanvasTTY safety check unavailable: this tool call was not run. Retry it, or ask the person how to proceed."

type gateDecision struct {
	behavior    string
	message     string
	unavailable bool
}

type gateIdentity struct {
	address, terminalSessionID, provider, capability string
}

func runPermissionGate(args []string) int {
	if len(args) < 1 || args[0] != "pretool" {
		return 0
	}
	failClosed := envEquals(envDecisionFailClosed, "1")
	output := decideGate(failClosed)
	if output != nil {
		os.Stdout.Write(append([]byte(jsonStringify(output)), '\n'))
	}
	return 0
}

func decideGate(failClosed bool) *jsObject {
	unavailable := func() *jsObject {
		if failClosed {
			return unavailableOutput()
		}
		return nil
	}
	identity := gateIdentityFromEnv()
	raw, over := readStdinBounded(maxHookInputBytes)
	if identity == nil || over {
		return unavailable()
	}
	input, err := jsonParse(raw)
	if err != nil {
		return unavailable()
	}
	message, requestID := buildPermissionRequest(input, identity)
	if message == nil {
		return unavailable()
	}
	decision := exchangeDecision(identity.address, message, requestID)
	if decision == nil {
		return unavailable()
	}
	// The gateway itself failed and asks the person: Claude Code can ask, Codex and Qwen Code cannot.
	if decision.unavailable && decision.behavior == "ask" && identity.provider != "claude" {
		return unavailable()
	}
	return hookOutput(identity.provider, decision)
}

func unavailableOutput() *jsObject {
	return hookOutput("claude", &gateDecision{behavior: "deny", message: failClosedMessage})
}

func gateIdentityFromEnv() *gateIdentity {
	identity := &gateIdentity{}
	identity.address, _ = env(envRuntimeAddress)
	identity.terminalSessionID, _ = env(envRuntimeTerminalSessionID)
	identity.provider, _ = env(envRuntimeProvider)
	identity.capability, _ = env(envRuntimeCapability)
	if identity.address == "" || identity.terminalSessionID == "" || identity.provider == "" || identity.capability == "" {
		return nil
	}
	return identity
}

// buildPermissionRequest is permission-gate.mjs buildRequest: the tool input whole when its JSON fits the bound,
// otherwise a bounded preview and the sha256 of the whole input, marked truncated.
func buildPermissionRequest(input any, identity *gateIdentity) (*jsObject, string) {
	object, ok := input.(*jsObject)
	if !ok {
		return nil, ""
	}
	name, ok := field(object, "tool_name").(string)
	if !ok || name == "" {
		return nil, ""
	}
	toolName := jsSlice(name, gateToolNameChars)
	var toolInput any = field(object, "tool_input")
	if isUndefined(toolInput) {
		toolInput = nil
	}
	json := jsonStringify(toolInput)
	sum := sha256.Sum256([]byte(json))
	var cwd any
	if text, ok := field(object, "cwd").(string); ok && text != "" && jsLength(text) <= 4_096 {
		cwd = text
	}
	requestID := randomUUID()
	base := func() *jsObject {
		return obj(
			"v", float64(runtimeProtocolVersion),
			"type", "permission_request",
			"terminalSessionId", identity.terminalSessionID,
			"provider", identity.provider,
			"capabilityToken", identity.capability,
			"requestId", requestID,
			"toolName", toolName,
			"toolInputSha256", hex.EncodeToString(sum[:]),
			"cwd", cwd,
		)
	}
	message := base()
	if len(json) <= gateToolInputBytes {
		message.set("toolInput", rawJSON(json))
		message.set("toolInputPreview", nil)
		message.set("truncated", false)
	} else {
		message.set("toolInput", nil)
		message.set("toolInputPreview", boundedText(json, gateToolInputPreview))
		message.set("truncated", true)
	}
	if len(jsonStringify(message))+1 <= maxRuntimeMessageBytes {
		return message, requestID
	}
	// Multi-byte text can outgrow the wire cap: send the smaller, truncated form.
	message = base()
	message.set("toolInput", nil)
	message.set("toolInputPreview", boundedText(json, 2_048))
	message.set("truncated", true)
	return message, requestID
}

func exchangeDecision(address string, message *jsObject, requestID string) *gateDecision {
	payload := append([]byte(jsonStringify(message)), '\n')
	line, ok := exchangeLine(address, payload, helperDeadline())
	if !ok {
		return nil
	}
	value, err := jsonParse(line)
	if err != nil {
		return nil
	}
	return parseDecision(value, requestID)
}

func parseDecision(value any, requestID string) *gateDecision {
	if !isObjectLike(value) || field(value, "v") != float64(runtimeProtocolVersion) ||
		field(value, "type") != "permission_decision" || field(value, "requestId") != requestID {
		return nil
	}
	behavior, _ := field(value, "behavior").(string)
	switch behavior {
	case "allow", "deny", "ask", "none":
	default:
		return nil
	}
	message := ""
	if text, ok := field(value, "message").(string); ok {
		message = cleanMessage(text)
	}
	return &gateDecision{behavior: behavior, message: message, unavailable: field(value, "unavailable") == true}
}

// hookOutput is what the CLI reads on stdout, or nil to print nothing. Only Claude Code takes ask and allow.
func hookOutput(provider string, decision *gateDecision) *jsObject {
	if decision == nil || decision.behavior == "none" {
		return nil
	}
	output := func(behavior, reason string) *jsObject {
		return obj("hookSpecificOutput", obj(
			"hookEventName", "PreToolUse",
			"permissionDecision", behavior,
			"permissionDecisionReason", reason,
		))
	}
	if decision.behavior == "deny" {
		return output("deny", orText(decision.message, "CanvasTTY blocked this tool call. Ask the person how to proceed."))
	}
	if provider != "claude" {
		if decision.behavior != "ask" {
			return nil
		}
		return output("deny", orText(decision.message, "CanvasTTY could not check this tool call in time.")+
			" This agent cannot ask the person from here, so it was not run; tell the person what you want to do and let them decide.")
	}
	fallback := "Allowed by a CanvasTTY plugin the person trusts to allow."
	if decision.behavior == "ask" {
		fallback = "CanvasTTY asks the person about this tool call."
	}
	return output(decision.behavior, orText(decision.message, fallback))
}

func orText(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// cleanMessage replaces control characters (except \t and \n) with spaces and bounds the text.
func cleanMessage(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c <= 0x08 || (c >= 0x0B && c <= 0x1F) || c == 0x7F {
			b.WriteByte(' ')
		} else {
			b.WriteByte(c)
		}
	}
	return boundedText(b.String(), gateMessageChars)
}

func randomUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0F | 0x40
	b[8] = b[8]&0x3F | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
