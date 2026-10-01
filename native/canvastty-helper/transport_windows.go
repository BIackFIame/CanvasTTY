//go:build windows

package main

import (
	"errors"
	"io"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// Windows named-pipe client with overlapped I/O, so a read that waits for the gateway never blocks a write (a
// synchronous pipe handle serializes them). Only the standard library's syscall package is used.

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procCreateEventW        = kernel32.NewProc("CreateEventW")
	procGetOverlappedResult = kernel32.NewProc("GetOverlappedResult")
	procWaitNamedPipeW      = kernel32.NewProc("WaitNamedPipeW")
)

const (
	errorPipeBusy         syscall.Errno = 231
	errorBrokenPipe       syscall.Errno = 109
	errorPipeNotConnected syscall.Errno = 233
	errorOperationAborted syscall.Errno = 995
	fileFlagOverlapped                  = 0x40000000
	// SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the gateway may identify this client, never impersonate it.
	securitySqosIdentification = 0x00100000 | 0x00010000
)

type pipeConn struct {
	handle    syscall.Handle
	closeOnce sync.Once
	closed    chan struct{}
}

// dialEndpoint opens \\.\pipe\... like libuv: a busy pipe is waited for (up to 30 s) and retried.
func dialEndpoint(address string) (io.ReadWriteCloser, error) {
	name, err := syscall.UTF16PtrFromString(address)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil,
			syscall.OPEN_EXISTING, fileFlagOverlapped|securitySqosIdentification, 0)
		if err == nil {
			return &pipeConn{handle: handle, closed: make(chan struct{})}, nil
		}
		if !errors.Is(err, errorPipeBusy) || time.Now().After(deadline) {
			return nil, err
		}
		procWaitNamedPipeW.Call(uintptr(unsafe.Pointer(name)), uintptr(1000))
	}
}

func (c *pipeConn) overlapped(write bool, buffer []byte) (int, error) {
	select {
	case <-c.closed:
		return 0, io.ErrClosedPipe
	default:
	}
	event, _, callErr := procCreateEventW.Call(0, 1, 0, 0)
	if event == 0 {
		return 0, callErr
	}
	defer syscall.CloseHandle(syscall.Handle(event))
	var o syscall.Overlapped
	o.HEvent = syscall.Handle(event)
	var done uint32
	var err error
	if write {
		err = syscall.WriteFile(c.handle, buffer, &done, &o)
	} else {
		err = syscall.ReadFile(c.handle, buffer, &done, &o)
	}
	if errors.Is(err, syscall.ERROR_IO_PENDING) {
		ok, _, callErr := procGetOverlappedResult.Call(uintptr(c.handle), uintptr(unsafe.Pointer(&o)), uintptr(unsafe.Pointer(&done)), 1)
		if ok == 0 {
			err = callErr
		} else {
			err = nil
		}
	}
	if err != nil {
		if errors.Is(err, errorBrokenPipe) || errors.Is(err, errorPipeNotConnected) || errors.Is(err, errorOperationAborted) {
			return int(done), io.EOF
		}
		return int(done), err
	}
	if !write && done == 0 && len(buffer) > 0 {
		return 0, io.EOF
	}
	return int(done), nil
}

func (c *pipeConn) Read(buffer []byte) (int, error) { return c.overlapped(false, buffer) }

func (c *pipeConn) Write(buffer []byte) (int, error) {
	written := 0
	for written < len(buffer) {
		n, err := c.overlapped(true, buffer[written:])
		written += n
		if err != nil {
			return written, err
		}
	}
	return written, nil
}

func (c *pipeConn) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
		syscall.CancelIoEx(c.handle, nil)
		syscall.CloseHandle(c.handle)
	})
	return nil
}

// isLocalEndpoint is mcp-helper.mjs isLocalEndpoint on Windows.
func isLocalEndpoint(address string) bool {
	return address != "" && !strings.Contains(address, "\x00") && strings.HasPrefix(address, `\\.\pipe\`)
}
