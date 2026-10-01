//go:build !windows

package main

import (
	"io"
	"net"
	"strings"
)

// dialEndpoint connects to a gateway's Unix socket, as net.createConnection(path) does.
func dialEndpoint(address string) (io.ReadWriteCloser, error) {
	return net.Dial("unix", address)
}

// isLocalEndpoint is mcp-helper.mjs isLocalEndpoint on a POSIX platform.
func isLocalEndpoint(address string) bool {
	return address != "" && !strings.Contains(address, "\x00") && strings.HasPrefix(address, "/")
}
