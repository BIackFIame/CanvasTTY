package main

import (
	"io"
	"sync"
)

// asyncSocket behaves like a node:net client socket for the long-lived MCP helpers: connecting happens in the
// background, writes never block the caller (they queue until connected, in order, like Node's writable buffer),
// and the owner learns of connect, data and the end of the connection through callbacks. After destroy() no
// callback runs.
type asyncSocket struct {
	mu        sync.Mutex
	conn      io.ReadWriteCloser
	queue     [][]byte
	connected bool
	destroyed bool
	wake      chan struct{}

	onConnect func()
	onData    func([]byte)
	onEnd     func()
}

func openSocket(address string, onConnect func(), onData func([]byte), onEnd func()) *asyncSocket {
	s := &asyncSocket{wake: make(chan struct{}, 1), onConnect: onConnect, onData: onData, onEnd: onEnd}
	go s.run(address)
	return s
}

func (s *asyncSocket) run(address string) {
	conn, err := dialEndpoint(address)
	s.mu.Lock()
	if s.destroyed {
		s.mu.Unlock()
		if conn != nil {
			conn.Close()
		}
		return
	}
	if err != nil {
		s.destroyed = true
		s.mu.Unlock()
		s.onEnd()
		return
	}
	s.conn = conn
	s.connected = true
	s.mu.Unlock()
	go s.writer()
	// Queued data goes out first, then the connect handler runs (Node flushes pending writes on connect before
	// emitting "connect").
	s.kick()
	s.onConnect()
	buffer := make([]byte, 64*1024)
	for {
		n, err := conn.Read(buffer)
		if n > 0 {
			chunk := append([]byte(nil), buffer[:n]...)
			if s.alive() {
				s.onData(chunk)
			}
		}
		if err != nil {
			break
		}
	}
	s.mu.Lock()
	wasAlive := !s.destroyed
	s.destroyed = true
	s.mu.Unlock()
	conn.Close()
	s.kick()
	if wasAlive {
		s.onEnd()
	}
}

func (s *asyncSocket) alive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.destroyed
}

func (s *asyncSocket) kick() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *asyncSocket) writer() {
	for range s.wake {
		for {
			s.mu.Lock()
			if s.destroyed || len(s.queue) == 0 {
				done := s.destroyed
				s.mu.Unlock()
				if done {
					return
				}
				break
			}
			next := s.queue[0]
			s.queue = s.queue[1:]
			conn := s.conn
			s.mu.Unlock()
			if _, err := conn.Write(next); err != nil {
				s.mu.Lock()
				wasAlive := !s.destroyed
				s.destroyed = true
				s.mu.Unlock()
				conn.Close()
				if wasAlive {
					s.onEnd()
				}
				return
			}
		}
	}
}

// write queues data; it reports false once the socket is destroyed (Node's socket.destroyed).
func (s *asyncSocket) write(data []byte) bool {
	s.mu.Lock()
	if s.destroyed {
		s.mu.Unlock()
		return false
	}
	s.queue = append(s.queue, data)
	connected := s.connected
	s.mu.Unlock()
	if connected {
		s.kick()
	}
	return true
}

func (s *asyncSocket) isDestroyed() bool {
	return !s.alive()
}

func (s *asyncSocket) destroy() {
	s.mu.Lock()
	if s.destroyed {
		s.mu.Unlock()
		return
	}
	s.destroyed = true
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
	s.kick()
}
