//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

var (
	procCreateNamedPipeW    = kernel32.NewProc("CreateNamedPipeW")
	procConnectNamedPipe    = kernel32.NewProc("ConnectNamedPipe")
	procDisconnectNamedPipe = kernel32.NewProc("DisconnectNamedPipe")
)

// pipeServer makes a byte-mode named pipe like the CanvasTTY pipe host and accepts one client synchronously.
func pipeServer(t *testing.T, name string) syscall.Handle {
	t.Helper()
	path, _ := syscall.UTF16PtrFromString(name)
	const pipeAccessDuplex = 0x3
	const pipeRejectRemote = 0x8
	handle, _, err := procCreateNamedPipeW.Call(uintptr(unsafe.Pointer(path)), pipeAccessDuplex, pipeRejectRemote, 1, 65536, 65536, 0, 0)
	if syscall.Handle(handle) == syscall.InvalidHandle {
		t.Fatalf("CreateNamedPipeW: %v", err)
	}
	return syscall.Handle(handle)
}

// A read that waits for the gateway must not block a write on the same connection (a synchronous pipe handle would).
func TestPipeReadDoesNotBlockWrite(t *testing.T) {
	name := fmt.Sprintf(`\\.\pipe\canvastty-helper-test-%d`, os.Getpid())
	server := pipeServer(t, name)
	defer syscall.CloseHandle(server)
	accepted := make(chan struct{})
	go func() {
		procConnectNamedPipe.Call(uintptr(server), 0)
		close(accepted)
	}()
	conn, err := dialEndpoint(name)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-accepted
	readDone := make(chan string, 1)
	go func() {
		buffer := make([]byte, 64)
		n, _ := conn.Read(buffer)
		readDone <- string(buffer[:n])
	}()
	time.Sleep(100 * time.Millisecond)
	writeDone := make(chan error, 1)
	go func() {
		_, err := conn.Write([]byte("request\n"))
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			t.Fatalf("write: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a pending read blocked the write")
	}
	buffer := make([]byte, 64)
	var n uint32
	if err := syscall.ReadFile(server, buffer, &n, nil); err != nil || string(buffer[:n]) != "request\n" {
		t.Fatalf("server read %q, %v", buffer[:n], err)
	}
	if err := syscall.WriteFile(server, []byte("answer\n"), &n, nil); err != nil {
		t.Fatalf("server write: %v", err)
	}
	select {
	case got := <-readDone:
		if got != "answer\n" {
			t.Fatalf("client read %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the client never read the answer")
	}
	// Close cancels a pending read; the server's end then reads as EOF.
	pending := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 8))
		pending <- err
	}()
	time.Sleep(50 * time.Millisecond)
	conn.Close()
	select {
	case err := <-pending:
		if err == nil {
			t.Fatal("a read after close succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("close did not cancel the pending read")
	}
	procDisconnectNamedPipe.Call(uintptr(server))
}

func TestLocalEndpointOnWindows(t *testing.T) {
	for address, want := range map[string]bool{`\\.\pipe\x`: true, `C:\x`: false, "": false, "/tmp/x": false, "\\\\.\\pipe\\a\x00": false} {
		if got := isLocalEndpoint(address); got != want {
			t.Errorf("isLocalEndpoint(%q) = %v", address, got)
		}
	}
}
