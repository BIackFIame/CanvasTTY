package main

// JSON with the semantics of V8's JSON.parse / JSON.stringify, which the .mjs helpers use and the gateways re-check
// (the runtime gateway hashes JSON.stringify(JSON.parse(toolInput)) again). Values are:
//
//	nil, bool, float64, string, []any, *jsObject
//
// Strings are JavaScript strings kept as WTF-8: UTF-8 in which a lone UTF-16 surrogate is the 3-byte sequence of its
// code unit. A surrogate pair is always the 4-byte sequence of its code point, so equal JS strings are equal Go strings.
// Input bytes are first decoded the way Buffer#toString("utf8") does (every maximal invalid subpart is U+FFFD).

import (
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// jsObject keeps own properties in V8's order: array-index keys ascending, then the others in insertion order.
// A duplicate key keeps its first position and takes the last value, as JSON.parse does.
type jsObject struct {
	keys   []string
	values map[string]any
}

func newObject() *jsObject { return &jsObject{values: map[string]any{}} }

func (o *jsObject) set(key string, value any) {
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

func (o *jsObject) get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	value, ok := o.values[key]
	return value, ok
}

// ordered returns the keys in V8's own-property order (Object.keys, JSON.stringify).
func (o *jsObject) ordered() []string {
	var indexes []string
	var names []string
	for _, key := range o.keys {
		if isArrayIndex(key) {
			indexes = append(indexes, key)
		} else {
			names = append(names, key)
		}
	}
	if len(indexes) == 0 {
		return names
	}
	sort.Slice(indexes, func(i, j int) bool {
		a, _ := strconv.ParseUint(indexes[i], 10, 64)
		b, _ := strconv.ParseUint(indexes[j], 10, 64)
		return a < b
	})
	return append(indexes, names...)
}

func isArrayIndex(key string) bool {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return false
		}
	}
	value, err := strconv.ParseUint(key, 10, 64)
	return err == nil && value < 4294967295
}

// obj builds an object from key/value pairs in insertion order.
func obj(pairs ...any) *jsObject {
	o := newObject()
	for i := 0; i+1 < len(pairs); i += 2 {
		o.set(pairs[i].(string), pairs[i+1])
	}
	return o
}

// ---- decoding bytes as Buffer#toString("utf8") ----

func decodeUTF8(s []byte) string {
	valid := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			valid = false
			break
		}
	}
	if valid {
		return string(s)
	}
	out := make([]byte, 0, len(s)+8)
	n := len(s)
	for i := 0; i < n; {
		c := s[i]
		if c < 0x80 {
			out = append(out, c)
			i++
			continue
		}
		need := 0
		lo, hi := byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c >= 0xE0 && c <= 0xEF:
			need = 2
			if c == 0xE0 {
				lo = 0xA0
			}
			if c == 0xED {
				hi = 0x9F
			}
		case c >= 0xF0 && c <= 0xF4:
			need = 3
			if c == 0xF0 {
				lo = 0x90
			}
			if c == 0xF4 {
				hi = 0x8F
			}
		default:
			out = append(out, 0xEF, 0xBF, 0xBD)
			i++
			continue
		}
		j, k := i+1, 0
		for ; k < need && j < n; k, j = k+1, j+1 {
			if s[j] < lo || s[j] > hi {
				break
			}
			lo, hi = 0x80, 0xBF
		}
		if k == need {
			out = append(out, s[i:j]...)
		} else {
			out = append(out, 0xEF, 0xBF, 0xBD)
		}
		i = j
	}
	return string(out)
}

// decodedLength is len(decodeUTF8(s)) without building it.
func decodedLength(s []byte) int {
	return len(decodeUTF8(s))
}

// ---- JS string helpers over WTF-8 ----

func seqLen(c byte) int {
	switch {
	case c < 0x80:
		return 1
	case c < 0xE0:
		return 2
	case c < 0xF0:
		return 3
	}
	return 4
}

// jsLength is String#length: UTF-16 code units.
func jsLength(s string) int {
	units := 0
	for i := 0; i < len(s); {
		l := seqLen(s[i])
		if l == 4 {
			units += 2
		} else {
			units++
		}
		i += l
	}
	return units
}

// codeUnits returns the UTF-16 code units of a WTF-8 string.
func codeUnits(s string) []uint16 {
	units := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		l := seqLen(s[i])
		if i+l > len(s) {
			l = len(s) - i
		}
		cp := decodeSeq(s[i : i+l])
		if cp >= 0x10000 {
			r1, r2 := utf16.EncodeRune(rune(cp))
			units = append(units, uint16(r1), uint16(r2))
		} else {
			units = append(units, uint16(cp))
		}
		i += l
	}
	return units
}

func decodeSeq(b string) uint32 {
	switch len(b) {
	case 1:
		return uint32(b[0])
	case 2:
		return uint32(b[0]&0x1F)<<6 | uint32(b[1]&0x3F)
	case 3:
		return uint32(b[0]&0x0F)<<12 | uint32(b[1]&0x3F)<<6 | uint32(b[2]&0x3F)
	case 4:
		return uint32(b[0]&0x07)<<18 | uint32(b[1]&0x3F)<<12 | uint32(b[2]&0x3F)<<6 | uint32(b[3]&0x3F)
	}
	return 0xFFFD
}

func appendCodePoint(b []byte, cp uint32) []byte {
	switch {
	case cp < 0x80:
		return append(b, byte(cp))
	case cp < 0x800:
		return append(b, byte(0xC0|cp>>6), byte(0x80|cp&0x3F))
	case cp < 0x10000:
		return append(b, byte(0xE0|cp>>12), byte(0x80|(cp>>6)&0x3F), byte(0x80|cp&0x3F))
	}
	return append(b, byte(0xF0|cp>>18), byte(0x80|(cp>>12)&0x3F), byte(0x80|(cp>>6)&0x3F), byte(0x80|cp&0x3F))
}

// jsSlice is String#slice(0, limit): a surrogate pair cut in half leaves its high surrogate.
func jsSlice(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	units := 0
	for i := 0; i < len(s); {
		l := seqLen(s[i])
		u := 1
		if l == 4 {
			u = 2
		}
		if units+u > limit {
			if l == 4 && units+1 == limit {
				hi, _ := utf16.EncodeRune(rune(decodeSeq(s[i : i+4])))
				return string(appendCodePoint([]byte(s[:i]), uint32(hi)))
			}
			return s[:i]
		}
		units += u
		i += l
	}
	return s
}

// endsWithHighSurrogate is /[\uD800-\uDBFF]$/u.
func endsWithHighSurrogate(s string) bool {
	n := len(s)
	return n >= 3 && s[n-3] == 0xED && s[n-2] >= 0xA0 && s[n-2] <= 0xAF
}

// boundedText cuts at the limit without leaving a dangling high surrogate.
func boundedText(value string, limit int) string {
	text := jsSlice(value, limit)
	if endsWithHighSurrogate(text) {
		return text[:len(text)-3]
	}
	return text
}

// compareUnits orders by UTF-16 code unit, as `<` on JS strings does.
func compareUnits(a, b string) int {
	if isASCII(a) && isASCII(b) {
		return strings.Compare(a, b)
	}
	ua, ub := codeUnits(a), codeUnits(b)
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			if ua[i] < ub[i] {
				return -1
			}
			return 1
		}
	}
	return len(ua) - len(ub)
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// ---- JSON.parse ----

var errJSONSyntax = errors.New("invalid JSON")

// jsonParse is JSON.parse(bytes.toString("utf8")).
func jsonParse(raw []byte) (any, error) {
	return jsonParseString(decodeUTF8(raw))
}

// jsonParseWithMaxNesting applies a caller-owned portable container-depth limit while preserving the default
// JSON.parse-compatible behavior for the other helper protocols.
func jsonParseWithMaxNesting(raw []byte, maxNesting int) (any, error) {
	return jsonParseStringWithMaxNesting(decodeUTF8(raw), maxNesting)
}

func jsonParseString(text string) (any, error) {
	return jsonParseStringWithMaxNesting(text, 0)
}

func jsonParseStringWithMaxNesting(text string, maxNesting int) (any, error) {
	p := &parser{s: text, maxNesting: maxNesting}
	p.ws()
	value, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.s) {
		return nil, errJSONSyntax
	}
	return value, nil
}

type parser struct {
	s          string
	i          int
	maxNesting int
}

func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value(depth int) (any, error) {
	if p.i >= len(p.s) {
		return nil, errJSONSyntax
	}
	switch c := p.s[p.i]; {
	case c == '{':
		if p.maxNesting > 0 && depth >= p.maxNesting {
			return nil, errJSONSyntax
		}
		p.i++
		o := newObject()
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			return o, nil
		}
		for {
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != '"' {
				return nil, errJSONSyntax
			}
			key, err := p.str()
			if err != nil {
				return nil, err
			}
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != ':' {
				return nil, errJSONSyntax
			}
			p.i++
			p.ws()
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			o.set(key, v)
			p.ws()
			if p.i >= len(p.s) {
				return nil, errJSONSyntax
			}
			if p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.s[p.i] == '}' {
				p.i++
				return o, nil
			}
			return nil, errJSONSyntax
		}
	case c == '[':
		if p.maxNesting > 0 && depth >= p.maxNesting {
			return nil, errJSONSyntax
		}
		p.i++
		a := []any{}
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return a, nil
		}
		for {
			p.ws()
			v, err := p.value(depth + 1)
			if err != nil {
				return nil, err
			}
			a = append(a, v)
			p.ws()
			if p.i >= len(p.s) {
				return nil, errJSONSyntax
			}
			if p.s[p.i] == ',' {
				p.i++
				continue
			}
			if p.s[p.i] == ']' {
				p.i++
				return a, nil
			}
			return nil, errJSONSyntax
		}
	case c == '"':
		return p.str()
	case c == 't':
		return p.literal("true", true)
	case c == 'f':
		return p.literal("false", false)
	case c == 'n':
		return p.literal("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, errJSONSyntax
}

func (p *parser) literal(word string, value any) (any, error) {
	if strings.HasPrefix(p.s[p.i:], word) {
		p.i += len(word)
		return value, nil
	}
	return nil, errJSONSyntax
}

func (p *parser) number() (any, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	if p.i >= len(p.s) {
		return nil, errJSONSyntax
	}
	if p.s[p.i] == '0' {
		p.i++
	} else if p.s[p.i] >= '1' && p.s[p.i] <= '9' {
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
	} else {
		return nil, errJSONSyntax
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		digits := p.i
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
		if p.i == digits {
			return nil, errJSONSyntax
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		digits := p.i
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
		}
		if p.i == digits {
			return nil, errJSONSyntax
		}
	}
	value, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return nil, errJSONSyntax
	}
	return value, nil
}

func (p *parser) hex4() (uint32, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	var v uint32
	for k := 0; k < 4; k++ {
		c := p.s[p.i+k]
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		v = v<<4 | uint32(d)
	}
	p.i += 4
	return v, true
}

func (p *parser) str() (string, error) {
	p.i++
	var out []byte
	run := p.i
	for p.i < len(p.s) {
		c := p.s[p.i]
		if c == '"' {
			if out == nil {
				s := p.s[run:p.i]
				p.i++
				return s, nil
			}
			out = append(out, p.s[run:p.i]...)
			p.i++
			return string(out), nil
		}
		if c < 0x20 {
			return "", errJSONSyntax
		}
		if c != '\\' {
			p.i++
			continue
		}
		out = append(out, p.s[run:p.i]...)
		p.i++
		if p.i >= len(p.s) {
			return "", errJSONSyntax
		}
		e := p.s[p.i]
		p.i++
		switch e {
		case '"', '\\', '/':
			out = append(out, e)
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case 'u':
			cp, ok := p.hex4()
			if !ok {
				return "", errJSONSyntax
			}
			// A high surrogate escape directly followed by a low surrogate escape is one code point.
			if cp >= 0xD800 && cp <= 0xDBFF && p.i+6 <= len(p.s) && p.s[p.i] == '\\' && p.s[p.i+1] == 'u' {
				save := p.i
				p.i += 2
				lo, ok := p.hex4()
				if ok && lo >= 0xDC00 && lo <= 0xDFFF {
					cp = 0x10000 + (cp-0xD800)<<10 + (lo - 0xDC00)
				} else {
					p.i = save
				}
			}
			out = appendCodePoint(out, cp)
		default:
			return "", errJSONSyntax
		}
		run = p.i
	}
	return "", errJSONSyntax
}

// ---- JSON.stringify ----

// appendQuoted is JSON.stringify(string): well-formed, lone surrogates as \udXXX.
func appendQuoted(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < 0x80 {
			switch c {
			case '"':
				b = append(b, '\\', '"')
			case '\\':
				b = append(b, '\\', '\\')
			case '\b':
				b = append(b, '\\', 'b')
			case '\f':
				b = append(b, '\\', 'f')
			case '\n':
				b = append(b, '\\', 'n')
			case '\r':
				b = append(b, '\\', 'r')
			case '\t':
				b = append(b, '\\', 't')
			default:
				if c < 0x20 {
					b = append(b, '\\', 'u', '0', '0', hexDigit(c>>4), hexDigit(c&0xF))
				} else {
					b = append(b, c)
				}
			}
			i++
			continue
		}
		l := seqLen(c)
		if i+l > len(s) {
			l = len(s) - i
		}
		if l == 3 && c == 0xED && s[i+1] >= 0xA0 {
			cp := decodeSeq(s[i : i+3])
			b = append(b, '\\', 'u', hexDigit(byte(cp>>12)), hexDigit(byte(cp>>8&0xF)), hexDigit(byte(cp>>4&0xF)), hexDigit(byte(cp&0xF)))
		} else {
			b = append(b, s[i:i+l]...)
		}
		i += l
	}
	return append(b, '"')
}

func hexDigit(v byte) byte {
	return "0123456789abcdef"[v&0xF]
}

// jsNumber is Number#toString(10), the form JSON.stringify writes for a finite number.
func jsNumber(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if f == 0 {
		return "0"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f < 0 {
		return "-" + jsNumber(-f)
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddddde±XX, shortest round trip
	mant, expText, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expText)
	k := len(digits)
	n := exp + 1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	abs := n - 1
	if abs < 0 {
		abs = -abs
	}
	if k == 1 {
		return digits + "e" + sign + strconv.Itoa(abs)
	}
	return digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(abs)
}

// jsonStringify is JSON.stringify(value) for parsed values (V8 key order, non-finite numbers as null).
func jsonStringify(value any) string {
	return string(appendJSON(nil, value))
}

func appendJSON(b []byte, value any) []byte {
	switch v := value.(type) {
	case nil:
		return append(b, "null"...)
	case bool:
		if v {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return append(b, "null"...)
		}
		return append(b, jsNumber(v)...)
	case int:
		return append(b, jsNumber(float64(v))...)
	case string:
		return appendQuoted(b, v)
	case rawJSON:
		return append(b, v...)
	case []any:
		b = append(b, '[')
		for i, item := range v {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendJSON(b, item)
		}
		return append(b, ']')
	case *jsObject:
		b = append(b, '{')
		first := true
		for _, key := range v.ordered() {
			item := v.values[key]
			if _, skip := item.(undefinedValue); skip {
				continue
			}
			if !first {
				b = append(b, ',')
			}
			first = false
			b = appendQuoted(b, key)
			b = append(b, ':')
			b = appendJSON(b, item)
		}
		return append(b, '}')
	}
	return append(b, "null"...)
}

// rawJSON is text already serialized by JSON.stringify, embedded as is.
type rawJSON string

// undefinedValue is a property JSON.stringify leaves out.
type undefinedValue struct{}

var errCanonical = errors.New("canonical JSON cannot contain this value")

// canonicalStringify is tool-catalog.mjs canonicalStringify (strict): keys sorted by UTF-16 code unit, no whitespace;
// a non-finite number is an error.
func canonicalStringify(value any) (string, error) {
	b, err := appendCanonical(nil, value)
	return string(b), err
}

func appendCanonical(b []byte, value any) ([]byte, error) {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, errCanonical
		}
		return append(b, jsNumber(v)...), nil
	case []any:
		b = append(b, '[')
		for i, item := range v {
			if i > 0 {
				b = append(b, ',')
			}
			var err error
			if b, err = appendCanonical(b, item); err != nil {
				return nil, err
			}
		}
		return append(b, ']'), nil
	case *jsObject:
		keys := append([]string(nil), v.keys...)
		sort.SliceStable(keys, func(i, j int) bool { return compareUnits(keys[i], keys[j]) < 0 })
		b = append(b, '{')
		first := true
		for _, key := range keys {
			item := v.values[key]
			if _, skip := item.(undefinedValue); skip {
				continue
			}
			if !first {
				b = append(b, ',')
			}
			first = false
			b = appendQuoted(b, key)
			b = append(b, ':')
			var err error
			if b, err = appendCanonical(b, item); err != nil {
				return nil, err
			}
		}
		return append(b, '}'), nil
	}
	return appendJSON(b, value), nil
}

// ---- JS value helpers ----

// truthy is JavaScript truthiness of a parsed value.
func truthy(value any) bool {
	switch v := value.(type) {
	case nil, undefinedValue:
		return false
	case bool:
		return v
	case float64:
		return v != 0 && !math.IsNaN(v)
	case string:
		return v != ""
	}
	return true
}

// field is `value?.[key]` for a parsed value (only objects have own data properties here).
func field(value any, key string) any {
	if o, ok := value.(*jsObject); ok {
		if v, ok := o.get(key); ok {
			return v
		}
	}
	return undefinedValue{}
}

func isUndefined(value any) bool {
	_, ok := value.(undefinedValue)
	return ok
}

func isPlainObject(value any) bool {
	_, ok := value.(*jsObject)
	return ok
}

// isObjectLike is `value && typeof value === "object"`.
func isObjectLike(value any) bool {
	switch value.(type) {
	case *jsObject, []any:
		return true
	}
	return false
}

func isInteger(value any) bool {
	f, ok := value.(float64)
	return ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f)
}

// jsToNumber is Number(string) (StringToNumber).
func jsToNumber(s string) float64 {
	t := strings.TrimFunc(s, isJSWhitespace)
	if t == "" {
		return 0
	}
	if len(t) > 2 && t[0] == '0' {
		base := 0
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			var v float64
			for _, c := range t[2:] {
				d := digitValue(c)
				if d < 0 || d >= base {
					return math.NaN()
				}
				v = v*float64(base) + float64(d)
			}
			return v
		}
	}
	body := t
	if body[0] == '+' || body[0] == '-' {
		body = body[1:]
	}
	if body == "Infinity" {
		if t[0] == '-' {
			return math.Inf(-1)
		}
		return math.Inf(1)
	}
	if !decimalLiteral(body) {
		return math.NaN()
	}
	v, err := strconv.ParseFloat(t, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return v
}

func digitValue(c rune) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'z':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'Z':
		return int(c-'A') + 10
	}
	return -1
}

// decimalLiteral is StrUnsignedDecimalLiteral without Infinity.
func decimalLiteral(s string) bool {
	i, digits := 0, 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		exp := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if i == exp {
			return false
		}
	}
	return i == len(s)
}

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}
