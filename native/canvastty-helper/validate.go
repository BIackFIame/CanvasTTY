package main

// The argument checks of tool-catalog.mjs validateToolArguments and orchestration-catalog.mjs
// validateOrchestrationArguments, run on the schemas generated from those files.

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
)

func toolDefinition(section, name string) *jsObject {
	tools, _ := catalogValue(section, "tools").([]any)
	for _, tool := range tools {
		if field(tool, "name") == name {
			return tool.(*jsObject)
		}
	}
	return nil
}

// validateToolArguments returns the error message, or ok.
func validateToolArguments(tool string, value any) (string, bool) {
	definition := toolDefinition("browser", tool)
	if definition == nil {
		return "Unsupported browser tool: " + jsSlice(tool, 80) + ".", false
	}
	if failure := validateSchema(field(definition, "inputSchema"), value, "arguments"); failure != "" {
		return failure, false
	}
	return "", true
}

func validateSchema(schema any, value any, path string) string {
	if oneOf, ok := field(schema, "oneOf").([]any); ok {
		for _, candidate := range oneOf {
			if validateSchema(candidate, value, path) == "" {
				return ""
			}
		}
		return path + " does not match an accepted shape."
	}
	number := func(key string) (float64, bool) {
		v, ok := field(schema, key).(float64)
		return v, ok
	}
	switch field(schema, "type") {
	case "object":
		object, ok := value.(*jsObject)
		if !ok {
			return path + " must be an object."
		}
		properties, _ := field(schema, "properties").(*jsObject)
		for _, key := range object.ordered() {
			if _, allowed := properties.get(key); !allowed {
				return path + "." + key + " is not allowed."
			}
		}
		required, _ := field(schema, "required").([]any)
		for _, key := range required {
			name, _ := key.(string)
			if _, present := object.get(name); !present {
				return path + "." + name + " is required."
			}
		}
		if properties != nil {
			for _, key := range properties.ordered() {
				item, present := object.get(key)
				if !present {
					continue
				}
				if failure := validateSchema(properties.values[key], item, path+"."+key); failure != "" {
					return failure
				}
			}
		}
		return ""
	case "array":
		items, ok := value.([]any)
		if !ok {
			return path + " must be an array."
		}
		if minimum, ok := number("minItems"); ok && float64(len(items)) < minimum {
			return path + " is too short."
		}
		if maximum, ok := number("maxItems"); ok && float64(len(items)) > maximum {
			return path + " is too long."
		}
		for index, item := range items {
			if failure := validateSchema(field(schema, "items"), item, path+"["+strconv.Itoa(index)+"]"); failure != "" {
				return failure
			}
		}
		return ""
	case "string":
		text, ok := value.(string)
		if !ok {
			return path + " must be a string."
		}
		length := float64(jsLength(text))
		if minimum, ok := number("minLength"); ok && length < minimum {
			return path + " is too short."
		}
		if maximum, ok := number("maxLength"); ok && length > maximum {
			return path + " is too long."
		}
		if enum, ok := field(schema, "enum").([]any); ok && !containsValue(enum, text) {
			return path + " is not an accepted value."
		}
		return ""
	case "integer", "number":
		f, ok := value.(float64)
		if !ok || !isFinite(f) {
			return path + " must be a finite number."
		}
		if field(schema, "type") == "integer" && !isInteger(f) {
			return path + " must be an integer."
		}
		if minimum, ok := number("minimum"); ok && f < minimum {
			return path + " is below the minimum."
		}
		if maximum, ok := number("maximum"); ok && f > maximum {
			return path + " is above the maximum."
		}
		return ""
	case "boolean":
		if _, ok := value.(bool); ok {
			return ""
		}
		return path + " must be a boolean."
	}
	return path + " uses an unsupported schema."
}

func containsValue(values []any, value any) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

// ---- orchestration ----

func coreOrchestrationTool(name string) bool {
	return toolDefinition("orchestration", name) != nil
}

var (
	pluginToolPattern     *regexp.Regexp
	pluginToolPatternOnce sync.Once
)

// isPluginOrchestrationTool: `<pluginId>__<name>`, at most 64 characters, never a core tool name.
func isPluginOrchestrationTool(name string) bool {
	pluginToolPatternOnce.Do(func() {
		pluginToolPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?__[a-z][a-z0-9_]*$`)
	})
	return jsLength(name) <= catalogInt("orchestration", "maxPluginToolNameLength") &&
		!coreOrchestrationTool(name) && pluginToolPattern.MatchString(name)
}

func unknownProviderMessage(value any) string {
	shown := "that value"
	if text, ok := value.(string); ok {
		shown = jsonStringify(jsSlice(text, 32))
	}
	ids, _ := catalogValue("orchestration", "providerIds").([]any)
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i], _ = id.(string)
	}
	return "Unknown provider " + shown + ". Call list_providers to see which providers this CanvasTTY can launch; provider must be one of: " + strings.Join(names, ", ") + "."
}

// validateOrchestrationArguments returns the joined errors, or ok.
func validateOrchestrationArguments(tool string, args any) (string, bool) {
	definition := toolDefinition("orchestration", tool)
	if definition == nil {
		return "Unsupported orchestration tool: " + tool + ".", false
	}
	object, ok := args.(*jsObject)
	if !ok {
		return "Tool arguments must be an object.", false
	}
	schema := field(definition, "inputSchema")
	properties, _ := field(schema, "properties").(*jsObject)
	required, _ := field(schema, "required").([]any)
	var errors []string
	for _, key := range properties.ordered() {
		property := properties.values[key]
		candidate, present := object.get(key)
		if !present {
			if containsValue(required, key) {
				errors = append(errors, "Missing required argument: "+key+".")
			}
			continue
		}
		switch {
		case field(property, "type") == "string":
			text, ok := candidate.(string)
			if !ok {
				errors = append(errors, key+" must be a string.")
				continue
			}
			if enum, ok := field(property, "enum").([]any); ok && !containsValue(enum, text) {
				if key == "provider" {
					errors = append(errors, unknownProviderMessage(candidate))
				} else {
					errors = append(errors, key+" is not an accepted value.")
				}
				continue
			}
			minimum := 0.0
			if value, ok := field(property, "minLength").(float64); ok {
				minimum = value
			}
			if float64(jsLength(text)) < minimum {
				errors = append(errors, key+" is too short.")
			}
			if maximum, ok := field(property, "maxLength").(float64); ok && float64(jsLength(text)) > maximum {
				errors = append(errors, key+" is too long.")
			}
		case field(property, "type") == "boolean":
			if _, ok := candidate.(bool); !ok {
				errors = append(errors, key+" must be a boolean.")
			}
		case key == "launchOptions":
			if !validLaunchOptions(candidate, property) {
				errors = append(errors, key+" must map plugin ids to objects of text or true/false values.")
			} else if text, err := canonicalStringify(candidate); err == nil && len(text) > catalogInt("orchestration", "maxLaunchOptionsBytes") {
				errors = append(errors, key+" is too large.")
			}
		case field(property, "type") == "integer":
			if !isInteger(candidate) {
				errors = append(errors, key+" must be an integer.")
			} else if minimum, ok := field(property, "minimum").(float64); ok && candidate.(float64) < minimum {
				errors = append(errors, key+" is below the minimum.")
			} else if maximum, ok := field(property, "maximum").(float64); ok && candidate.(float64) > maximum {
				errors = append(errors, key+" is above the maximum.")
			}
		}
	}
	for _, key := range object.ordered() {
		if _, ok := properties.get(key); !ok {
			errors = append(errors, "Unexpected argument: "+key+".")
		}
	}
	if len(errors) > 0 {
		return strings.Join(errors, " "), false
	}
	return "", true
}

func validLaunchOptions(candidate any, property any) bool {
	plugins, ok := candidate.(*jsObject)
	if !ok {
		return false
	}
	if maximum, ok := field(property, "maxProperties").(float64); ok && float64(len(plugins.keys)) > maximum {
		return false
	}
	for _, key := range plugins.keys {
		values, ok := plugins.values[key].(*jsObject)
		if !ok {
			return false
		}
		for _, name := range values.keys {
			switch values.values[name].(type) {
			case string, bool:
			default:
				return false
			}
		}
	}
	return true
}
