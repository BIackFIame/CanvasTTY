// Executes the dependency's actual macOS spawn function with deterministic
// syscall doubles. No real descriptor, PTY, child process or account is opened.
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <set>
#include <signal.h>
#include <spawn.h>
#include <stdexcept>
#include <string>
#include <termios.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <vector>
#include <iostream>

#ifndef POSIX_SPAWN_CLOEXEC_DEFAULT
#define POSIX_SPAWN_CLOEXEC_DEFAULT 0x4000
#endif
#ifndef POSIX_SPAWN_SETSID
#define POSIX_SPAWN_SETSID 0x0400
#endif
#ifndef TIOCPTYGNAME
#define TIOCPTYGNAME 0x1234
#endif

struct State {
  std::set<int> fds;
  std::set<void*> actions;
  std::set<void*> attrs;
  std::map<std::string, int> calls;
  std::vector<int> dup_targets;
  std::string fail;
  int fail_at = 0;
  int failure_errno = EIO;
  bool injected = false;
} state;

static bool fail(const std::string& operation) {
  const int count = ++state.calls[operation];
  if (state.fail == operation && count == state.fail_at) {
    state.injected = true;
    errno = state.failure_errno;
    return true;
  }
  return false;
}
static int allocate() {
  int fd = 0;
  while (state.fds.count(fd)) ++fd;
  state.fds.insert(fd);
  return fd;
}
static int posix_error() {
  // POSIX spawn APIs return their error code directly; errno may be unrelated.
  errno = EDOM;
  return state.failure_errno;
}
static void require_fd(int fd) {
  if (!state.fds.count(fd)) throw std::runtime_error("using a closed/unowned FD");
}
static int fake_close(int fd) {
  if (fd == 99 || !state.fds.erase(fd)) throw std::runtime_error("foreign, invalid or double close");
  return 0;
}
static int fake_posix_openpt(int) { return fail("posix_openpt") ? -1 : allocate(); }
static int fake_grantpt(int fd) { require_fd(fd); return fail("grantpt") ? -1 : 0; }
static int fake_unlockpt(int fd) { require_fd(fd); return fail("unlockpt") ? -1 : 0; }
static int fake_open(const char*, int) { return fail("open") ? -1 : allocate(); }
static int fake_ioctl(int fd, unsigned long request, const void* argument) {
  require_fd(fd);
  if (fail("ioctl")) return -1;
  if (request == TIOCPTYGNAME) std::strcpy(static_cast<char*>(const_cast<void*>(argument)), "fake-slave");
  return 0;
}
static int fake_tcsetattr(int fd, int, const termios*) { require_fd(fd); return fail("tcsetattr") ? -1 : 0; }
static int fake_actions_init(posix_spawn_file_actions_t* value) {
  if (fail("actions_init")) return posix_error();
  if (!state.actions.insert(value).second) throw std::runtime_error("double actions initialization");
  return 0;
}
static void require_actions(const posix_spawn_file_actions_t* value) {
  if (!state.actions.count(const_cast<posix_spawn_file_actions_t*>(value))) throw std::runtime_error("uninitialized actions");
}
static int fake_actions_dup(posix_spawn_file_actions_t* value, int fd, int target) {
  require_actions(value); require_fd(fd);
  state.dup_targets.push_back(target);
  return fail("actions_dup") ? posix_error() : 0;
}
static int fake_actions_close(posix_spawn_file_actions_t* value, int fd) {
  require_actions(value); require_fd(fd); return fail("actions_close") ? posix_error() : 0;
}
static int fake_actions_destroy(posix_spawn_file_actions_t* value) {
  if (!state.actions.erase(value)) throw std::runtime_error("destroying uninitialized actions");
  return 0;
}
static int fake_attrs_init(posix_spawnattr_t* value) {
  if (fail("attrs_init")) return posix_error();
  if (!state.attrs.insert(value).second) throw std::runtime_error("double attrs initialization");
  return 0;
}
static void require_attrs(const posix_spawnattr_t* value) {
  if (!state.attrs.count(const_cast<posix_spawnattr_t*>(value))) throw std::runtime_error("uninitialized attrs");
}
static int fake_attrs_flags(posix_spawnattr_t* value, short) { require_attrs(value); return fail("attrs_flags") ? posix_error() : 0; }
static int fake_attrs_default(posix_spawnattr_t* value, const sigset_t*) { require_attrs(value); return fail("attrs_default") ? posix_error() : 0; }
static int fake_attrs_mask(posix_spawnattr_t* value, const sigset_t*) { require_attrs(value); return fail("attrs_mask") ? posix_error() : 0; }
static int fake_attrs_destroy(posix_spawnattr_t* value) {
  if (!state.attrs.erase(value)) throw std::runtime_error("destroying uninitialized attrs");
  return 0;
}
static int fake_spawn(pid_t* pid, const char*, const posix_spawn_file_actions_t* actions,
                      const posix_spawnattr_t* attrs, char* const*, char* const*) {
  require_actions(actions); require_attrs(attrs);
  if (fail("spawn")) return posix_error();
  *pid = 777;
  return 0;
}

#define posix_openpt fake_posix_openpt
#define grantpt fake_grantpt
#define unlockpt fake_unlockpt
#define open fake_open
#define ioctl fake_ioctl
#define tcsetattr fake_tcsetattr
#define close fake_close
#define posix_spawn_file_actions_init fake_actions_init
#define posix_spawn_file_actions_adddup2 fake_actions_dup
#define posix_spawn_file_actions_addclose fake_actions_close
#define posix_spawn_file_actions_destroy fake_actions_destroy
#define posix_spawnattr_init fake_attrs_init
#define posix_spawnattr_setflags fake_attrs_flags
#define posix_spawnattr_setsigdefault fake_attrs_default
#define posix_spawnattr_setsigmask fake_attrs_mask
#define posix_spawnattr_destroy fake_attrs_destroy
#define posix_spawn fake_spawn
#include "pty-spawn-under-test.inc"

static std::map<std::string, int> run(int mask, const std::string& operation = "", int nth = 0, int error = EIO) {
  state = State{};
  state.fds.insert(99); // A foreign descriptor must NEVER be closed.
  for (int fd = 0; fd < 3; ++fd) if (!(mask & (1 << fd))) state.fds.insert(fd);
  const auto before = state.fds;
  state.fail = operation;
  state.fail_at = nth;
  state.failure_errno = error;
  char helper[] = "fake-helper", cwd[] = "fake-cwd", command[] = "fake-command";
  char* argv[] = { helper, cwd, command, nullptr };
  char* env[] = { nullptr };
  termios term{};
  winsize size{};
  int master = -1, result = -1;
  pid_t pid = -1;
  pty_posix_spawn(argv, env, &term, &size, &master, &pid, &result);
  const bool success = !state.injected || (operation == "spawn" && error == EINTR);
  if (success) {
    if (result != 0 || pid != 777 || master < 3 || !state.fds.count(master)) throw std::runtime_error("lost successful master ownership");
    if (state.dup_targets != std::vector<int>({ 0, 1, 2 })) throw std::runtime_error("incorrect child stdio mapping");
    fake_close(master); // Only the returned master belongs to the JS caller.
  } else if (result != error || master != -1 || pid != -1) {
    throw std::runtime_error("failed spawn returned stale FD/PID or lost its errno: " + operation);
  }
  if (state.fds != before) throw std::runtime_error("descriptor leak, including closed stdio: mask=" + std::to_string(mask) + " operation=" + operation);
  if (!state.actions.empty() || !state.attrs.empty()) throw std::runtime_error("spawn object leak");
  return state.calls;
}

int main() {
  try {
    int cases = 0;
    const std::vector<std::string> operations = {
      "posix_openpt", "grantpt", "unlockpt", "ioctl", "open", "tcsetattr", "actions_init",
      "actions_dup", "actions_close", "attrs_init", "attrs_flags", "attrs_default", "attrs_mask", "spawn"
    };
    for (int mask = 0; mask < 8; ++mask) {
      const auto counts = run(mask);
      ++cases;
      for (const auto& operation : operations) {
        const auto count = counts.find(operation);
        if (count == counts.end()) throw std::runtime_error("untested syscall: " + operation);
        for (int nth = 1; nth <= count->second; ++nth) { run(mask, operation, nth); ++cases; }
      }
      run(mask, "spawn", 1, EINTR);
      ++cases;
      for (int i = 0; i < 500; ++i) { run(mask); ++cases; }
    }
    std::cout << "NATIVE_FD_OWNERSHIP_CASES " << cases << std::endl;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
}
