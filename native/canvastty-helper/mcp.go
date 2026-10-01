package main

// What the two stdio MCP helpers share: the JSON-RPC line loop on stdin/stdout, promise-like futures, and the error
// kinds the .mjs helpers distinguish. Where the JS helper would die (an exception outside any handler), this process
// exits 1 the same way, so an MCP client sees the same server.

import (
	_ "embed"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

//go:embed catalog.json
var catalogJSON []byte

var (
	catalogOnce sync.Once
	catalog     *jsObject
)

// catalogValue reads the tool catalogs generated from the .mjs sources (scripts/build-native-helpers.mjs).
func catalogValue(path ...string) any {
	catalogOnce.Do(func() {
		value, err := jsonParse(catalogJSON)
		if err != nil {
			panic("canvastty-helper: the embedded catalog is not JSON")
		}
		catalog = value.(*jsObject)
	})
	var value any = catalog
	for _, key := range path {
		value = field(value, key)
	}
	return value
}

func catalogString(path ...string) string {
	text, _ := catalogValue(path...).(string)
	return text
}

func catalogInt(path ...string) int {
	number, _ := catalogValue(path...).(float64)
	return int(number)
}

// ---- errors ----

// rpcError is JsonRpcError: an integer JSON-RPC code and its message.
type rpcError struct {
	code    int
	message string
}

func (e *rpcError) Error() string { return e.message }

// internalError is any other exception (a TypeError in JS): its message never reaches the browser helper's client.
type internalError struct{ message string }

func (e *internalError) Error() string { return e.message }

// ---- futures ----

type future struct {
	once  sync.Once
	done  chan struct{}
	value any
	err   error
}

func newFuture() *future { return &future{done: make(chan struct{})} }

func resolvedFuture(value any) *future {
	f := newFuture()
	f.resolve(value)
	return f
}

func rejectedFuture(err error) *future {
	f := newFuture()
	f.reject(err)
	return f
}

func (f *future) resolve(value any) {
	f.once.Do(func() {
		f.value = value
		close(f.done)
	})
}

func (f *future) reject(err error) {
	f.once.Do(func() {
		f.err = err
		close(f.done)
	})
}

func (f *future) wait() (any, error) {
	<-f.done
	return f.value, f.err
}

// ---- stdio loop ----

type mcpServer struct {
	maxBytes      int
	requestLimit  string // "Request exceeds 512KB"
	responseLimit string // "Response exceeds 512KB"
	errorResponse func(id any, err error) *jsObject
	// dispatch answers one request; a nil response writes nothing. It may block.
	dispatch func(request any) (*jsObject, error)
	// blocking names the methods that wait for the gateway; the others are answered in line order.
	blocking map[string]bool
	close    func()

	out      sync.Mutex
	inflight sync.WaitGroup
}

func response(id any, result any) *jsObject {
	return obj("jsonrpc", "2.0", "id", idOrNull(id), "result", result)
}

func idOrNull(id any) any {
	if id == nil || isUndefined(id) {
		return nil
	}
	return id
}

// writeMcp writes one message line, or an error of the same id when it is over the bound.
func (s *mcpServer) writeMcp(message *jsObject) {
	text, err := canonicalStringify(message)
	if err != nil {
		crash()
	}
	if len(text) > s.maxBytes {
		id, _ := message.get("id")
		fallback, err := canonicalStringify(s.errorResponse(id, &rpcError{code: -32603, message: s.responseLimit}))
		if err != nil {
			crash()
		}
		text = fallback
	}
	s.out.Lock()
	os.Stdout.WriteString(text + "\n")
	s.out.Unlock()
}

// crash is the JS helper's uncaught exception: the process ends with status 1.
func crash() {
	os.Exit(1)
}

func (s *mcpServer) run() int {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	go func() {
		<-signals
		s.close()
		os.Exit(0)
	}()
	requests := newLineReader(s.maxBytes, func() bool {
		s.writeMcp(s.errorResponse(nil, &rpcError{code: -32600, message: s.requestLimit}))
		return true
	})
	buffer := make([]byte, 64*1024)
	for {
		n, err := os.Stdin.Read(buffer)
		if n > 0 {
			lines, _ := requests.push(buffer[:n])
			for _, line := range lines {
				if len(line) == 0 {
					continue
				}
				request, err := jsonParse(line)
				if err != nil {
					s.writeMcp(s.errorResponse(nil, &rpcError{code: -32700, message: "Parse error"}))
					continue
				}
				s.inflight.Add(1)
				if method, _ := field(request, "method").(string); s.blocking[method] {
					go s.handle(request)
				} else {
					s.handle(request)
				}
			}
		}
		if err != nil {
			break
		}
	}
	// stdin ended: the client closes its gateway connection, and whatever that settles is still answered. Anything
	// left waiting can no longer finish (the JS process exits once its event loop is empty).
	s.close()
	finished := make(chan struct{})
	go func() {
		s.inflight.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(500 * time.Millisecond):
	}
	s.out.Lock()
	return 0
}

func (s *mcpServer) handle(request any) {
	defer s.inflight.Done()
	message, err := s.dispatch(request)
	if err == nil {
		if message != nil {
			s.writeMcp(message)
		}
		return
	}
	if request == nil {
		// `request.id` on null throws inside the rejection handler: an unhandled rejection ends the JS helper once
		// the answers already settled are written.
		s.inflight.Done()
		settled := make(chan struct{})
		go func() {
			s.inflight.Wait()
			close(settled)
		}()
		select {
		case <-settled:
		case <-time.After(50 * time.Millisecond):
		}
		crash()
	}
	if id := field(request, "id"); !isUndefined(id) {
		s.writeMcp(s.errorResponse(id, err))
	}
}

// requestShapeError is the dispatcher's first check: a JSON-RPC 2.0 object with a method.
func requestShapeError(request any) error {
	object, ok := request.(*jsObject)
	if !ok || field(object, "jsonrpc") != "2.0" {
		return &rpcError{code: -32600, message: "Invalid Request"}
	}
	if _, has := object.get("method"); !has {
		return &rpcError{code: -32600, message: "Invalid Request"}
	}
	return nil
}

// guardedTimer is setTimeout/clearTimeout under the owner's lock: once stopped, the callback never runs, even when
// it already fired and waits for the lock.
type guardedTimer struct {
	timer   *time.Timer
	stopped bool
}

func (t *guardedTimer) start(mu *sync.Mutex, delay time.Duration, callback func()) {
	t.timer = time.AfterFunc(delay, func() {
		mu.Lock()
		defer mu.Unlock()
		if t.stopped {
			return
		}
		t.stopped = true
		callback()
	})
}

// stop runs with the owner's lock held.
func (t *guardedTimer) stop() {
	t.stopped = true
	if t.timer != nil {
		t.timer.Stop()
	}
}
