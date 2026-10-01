package main

import "bytes"

// lineReader is src/agent-runtime/ndjson.mjs NdjsonLineReader: it cuts a byte stream into lines (empty ones
// included), never buffers more than maxLineBytes of one line, and checks the bound after every chunk it appends. A
// line over the bound, complete or not, is never returned: onOversize runs once for it (it may stop the caller by
// returning false) and the line's bytes up to the next newline are dropped.
type lineReader struct {
	max        int
	remainder  []byte
	skipping   bool
	onOversize func() bool
}

func newLineReader(max int, onOversize func() bool) *lineReader {
	return &lineReader{max: max, onOversize: onOversize}
}

// push returns the lines the chunk completes; ok is false when onOversize asked to stop (the JS reader's throw).
func (r *lineReader) push(chunk []byte) (lines [][]byte, ok bool) {
	buffer := chunk
	if r.skipping {
		newline := bytes.IndexByte(buffer, '\n')
		if newline < 0 {
			return nil, true
		}
		r.skipping = false
		buffer = buffer[newline+1:]
	}
	if len(r.remainder) > 0 {
		joined := make([]byte, 0, len(r.remainder)+len(buffer))
		joined = append(joined, r.remainder...)
		buffer = append(joined, buffer...)
	}
	r.remainder = nil
	start := 0
	for {
		newline := bytes.IndexByte(buffer[start:], '\n')
		if newline < 0 {
			break
		}
		line := buffer[start : start+newline]
		start += newline + 1
		if len(line) > r.max {
			if !r.onOversize() {
				return lines, false
			}
		} else {
			lines = append(lines, append([]byte(nil), line...))
		}
	}
	rest := buffer[start:]
	if len(rest) > r.max {
		r.skipping = true
		if !r.onOversize() {
			return lines, false
		}
	} else if len(rest) > 0 {
		r.remainder = append([]byte(nil), rest...)
	}
	return lines, true
}
