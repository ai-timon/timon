/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) Timon
 *
 * timon-fence: confines a mission CLI with the Linux kernel, then exec()s it.
 *
 * The daemon puts this launcher last in a mission's launch chain
 * (`systemd-run --scope ... nice ionice timon-fence --policy F -- <cli>`).
 * It applies, in this order and irreversibly for the whole process tree:
 *   1. a Landlock ruleset (ABI 2 to 6) built from the policy: every path the
 *      mission may reach is listed, everything else is refused;
 *   2. PR_SET_NO_NEW_PRIVS, so no setuid binary can leave the fence;
 *   3. a seccomp filter: socket(AF_UNIX) and io_uring_setup() fail when Unix
 *      sockets are denied (D-Bus, systemd --user, ssh-agent, docker.sock and
 *      X11 run code outside the fence on request), ioctl(TIOCSTI/TIOCLINUX)
 *      always fails, every other call is allowed. socketpair() stays allowed:
 *      the stdio pipes of a Node child are socket pairs;
 *   4. execvp() of the command. The pid stays the CLI's: kill paths, the
 *      reaper and the resource scope see the process they started.
 * No dependency beyond the C library; built static (scripts in build.mjs).
 *
 * Usage
 *   timon-fence --policy FILE -- COMMAND [ARG...]
 *   timon-fence --probe      prints "landlock-abi=N seccomp=yes|no", exits 0
 *                            when a fence can be applied, 69 otherwise
 *   timon-fence --version
 * FILE may be /dev/fd/N to read the policy from a pipe the caller passed.
 *
 * Policy format (version 1): a sequence of NUL-terminated strings, never text
 * lines, so that any path the kernel accepts can be written as is.
 *   "timon-fence/1"                 header, first string
 *   "ro" PATH                       read and execute beneath PATH
 *   "rw" PATH                       every handled right beneath PATH
 *   "unix-sockets" "deny"|"allow"   default deny
 * PATH is absolute. A PATH that does not exist (or that this process may not
 * open) at launch grants nothing and is skipped: the daemon enumerates paths
 * before the launch, and a file removed meanwhile must not stop the mission.
 * On a file rather than a directory, only file rights apply. An unknown
 * directive is a policy error: a newer daemon must not be half-understood.
 *
 * Exit codes, before the command runs (afterwards the code is the command's)
 *   64  usage error
 *   69  no fence on this kernel: Landlock missing or ABI < 2, or no seccomp
 *       filter while Unix sockets are denied. The daemon, in "auto" mode,
 *       launches without the fence and reports it; in "enforce" it refuses.
 *   71  the kernel refused a step it supports (unexpected)
 *   78  invalid policy (unreadable, malformed, unknown directive)
 *   127 the command could not be executed
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#define FENCE_VERSION "1"
#define POLICY_HEADER "timon-fence/1"
#define POLICY_MAX_BYTES (16u * 1024u * 1024u)

#define EXIT_USAGE 64
#define EXIT_UNAVAILABLE 69
#define EXIT_OSERR 71
#define EXIT_POLICY 78
#define EXIT_EXEC 127

#if defined(__x86_64__)
#define FENCE_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define FENCE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "timon-fence supports x86_64 and aarch64 only"
#endif

/* The Landlock ABI is declared here rather than taken from <linux/landlock.h>:
   the build machine's headers may predate the ABI the target kernel offers,
   and the values below are a stable kernel interface. */
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif
#ifndef SYS_io_uring_setup
#define SYS_io_uring_setup 425
#endif

#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1

#define R(bit) (1ULL << (bit))
#define LL_EXECUTE R(0)
#define LL_WRITE_FILE R(1)
#define LL_READ_FILE R(2)
#define LL_READ_DIR R(3)
#define LL_REFER R(13)
#define LL_TRUNCATE R(14)
#define LL_IOCTL_DEV R(15)
#define LL_SCOPE_ABSTRACT_UNIX_SOCKET R(0)
#define LL_SCOPE_SIGNAL R(1)

struct ll_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

static const uint64_t FILE_RIGHTS = LL_EXECUTE | LL_WRITE_FILE | LL_READ_FILE | LL_TRUNCATE | LL_IOCTL_DEV;
static const uint64_t RO_RIGHTS = LL_EXECUTE | LL_READ_FILE | LL_READ_DIR;

static void fail(const char *what) {
  fprintf(stderr, "timon-fence: %s\n", what);
}

static void fail_errno(const char *what) {
  fprintf(stderr, "timon-fence: %s: %s\n", what, strerror(errno));
}

/* -1 when Landlock is absent or disabled. */
static int landlock_abi(void) {
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  return abi < 0 ? -1 : (int)abi;
}

static uint64_t handled_rights(int abi) {
  uint64_t all = R(13) - 1; /* ABI 1: bits 0 to 12 */
  if (abi >= 2) all |= LL_REFER;
  if (abi >= 3) all |= LL_TRUNCATE;
  if (abi >= 5) all |= LL_IOCTL_DEV;
  return all;
}

static int seccomp_available(void) {
  return prctl(PR_GET_SECCOMP, 0, 0, 0, 0) >= 0;
}

/*
 * The filter checks the architecture first: a 32-bit compat call carries
 * other syscall numbers, so it is killed rather than matched against ours.
 * On x86_64 the x32 numbering (bit 30 set) is refused for the same reason.
 * Arguments are compared on their low 32 bits, which is how the kernel reads
 * an int domain and an ioctl request: high bits cannot smuggle a value past.
 */
static int install_seccomp(int deny_unix) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FENCE_AUDIT_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000u, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
#endif
    /* ioctl: refuse the two requests that inject input into a terminal. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_ioctl, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TIOCSTI, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, TIOCLINUX, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    /* Reached by an allowed ioctl too: nr is no longer in the accumulator. */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, deny_unix ? SYS_socket : 0xffffffffu, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 3),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EACCES & SECCOMP_RET_DATA)),
    /* io_uring can create a socket without the socket() syscall. libuv and
       every runtime fall back to plain calls on ENOSYS. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, deny_unix ? SYS_io_uring_setup : 0xffffffffu, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = { .len = (unsigned short)(sizeof filter / sizeof filter[0]), .filter = filter };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog, 0, 0);
}

/* Reads the whole policy; NULL with *code set on failure. */
static char *read_policy(const char *path, size_t *size, int *code) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) { fail_errno("cannot open the policy"); *code = EXIT_POLICY; return NULL; }
  size_t cap = 65536, len = 0;
  char *buf = malloc(cap);
  if (!buf) { fail("out of memory"); close(fd); *code = EXIT_OSERR; return NULL; }
  for (;;) {
    if (len == cap) {
      if (cap >= POLICY_MAX_BYTES) { fail("policy too large"); free(buf); close(fd); *code = EXIT_POLICY; return NULL; }
      cap *= 2;
      char *grown = realloc(buf, cap);
      if (!grown) { fail("out of memory"); free(buf); close(fd); *code = EXIT_OSERR; return NULL; }
      buf = grown;
    }
    ssize_t n = read(fd, buf + len, cap - len);
    if (n < 0) {
      if (errno == EINTR) continue;
      fail_errno("cannot read the policy"); free(buf); close(fd); *code = EXIT_POLICY; return NULL;
    }
    if (n == 0) break;
    len += (size_t)n;
  }
  close(fd);
  *size = len;
  return buf;
}

/* Next NUL-terminated string at *pos, or NULL when the buffer ends without
   one: a truncated policy is malformed, never read up to its last byte. */
static const char *next_field(const char *buf, size_t size, size_t *pos) {
  if (*pos >= size) return NULL;
  const char *start = buf + *pos;
  const char *end = memchr(start, '\0', size - *pos);
  if (!end) return NULL;
  *pos = (size_t)(end - buf) + 1;
  return start;
}

static int add_path_rule(int ruleset, const char *path, uint64_t want, uint64_t handled) {
  if (path[0] != '/') { fprintf(stderr, "timon-fence: policy path is not absolute: %s\n", path); return EXIT_POLICY; }
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT || errno == ENOTDIR || errno == EACCES || errno == ELOOP) return 0;
    fprintf(stderr, "timon-fence: cannot open %s: %s\n", path, strerror(errno));
    return EXIT_POLICY;
  }
  struct stat st;
  if (fstat(fd, &st)) { fail_errno("fstat"); close(fd); return EXIT_OSERR; }
  if (!S_ISDIR(st.st_mode)) want &= FILE_RIGHTS;
  struct ll_path_beneath_attr rule = { .allowed_access = want & handled, .parent_fd = fd };
  int code = 0;
  if (rule.allowed_access && syscall(SYS_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &rule, 0)) {
    fprintf(stderr, "timon-fence: cannot add a rule for %s: %s\n", path, strerror(errno));
    code = EXIT_OSERR;
  }
  close(fd);
  return code;
}

static int usage(void) {
  fprintf(stderr, "usage: timon-fence --policy FILE -- COMMAND [ARG...]\n"
                  "       timon-fence --probe | --version\n");
  return EXIT_USAGE;
}

static int probe(void) {
  int abi = landlock_abi();
  int seccomp = seccomp_available();
  printf("landlock-abi=%d seccomp=%s\n", abi < 0 ? 0 : abi, seccomp ? "yes" : "no");
  return abi >= 2 && seccomp ? 0 : EXIT_UNAVAILABLE;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--probe")) return probe();
  if (argc == 2 && !strcmp(argv[1], "--version")) { printf("timon-fence %s\n", FENCE_VERSION); return 0; }
  if (argc < 5 || strcmp(argv[1], "--policy") || strcmp(argv[3], "--")) return usage();
  const char *policy_path = argv[2];
  char **command = argv + 4;

  int abi = landlock_abi();
  if (abi < 2) {
    fprintf(stderr, "timon-fence: Landlock ABI 2 or later is required (found %d)\n", abi < 0 ? 0 : abi);
    return EXIT_UNAVAILABLE;
  }
  uint64_t handled = handled_rights(abi);

  int code = 0;
  size_t size = 0;
  char *policy = read_policy(policy_path, &size, &code);
  if (!policy) return code;
  size_t pos = 0;
  const char *header = next_field(policy, size, &pos);
  if (!header || strcmp(header, POLICY_HEADER)) { fail("policy header missing or unsupported"); return EXIT_POLICY; }

  struct ll_ruleset_attr attr = { .handled_access_fs = handled, .handled_access_net = 0, .scoped = 0 };
  /* ABI 4 adds the network field, ABI 6 the scopes: an older kernel rejects a
     larger structure, so the size follows the ABI. */
  size_t attr_size = abi >= 6 ? sizeof attr : abi >= 4 ? 2 * sizeof(uint64_t) : sizeof(uint64_t);
  if (abi >= 6) attr.scoped = LL_SCOPE_SIGNAL;

  /* First pass: options only, so the ruleset knows its scopes before rules. */
  int deny_unix = 1;
  for (size_t scan = pos; scan < size;) {
    const char *key = next_field(policy, size, &scan);
    const char *value = next_field(policy, size, &scan);
    if (!key || !value) { fail("policy truncated"); return EXIT_POLICY; }
    if (!strcmp(key, "unix-sockets")) {
      if (!strcmp(value, "deny")) deny_unix = 1;
      else if (!strcmp(value, "allow")) deny_unix = 0;
      else { fprintf(stderr, "timon-fence: invalid unix-sockets value: %s\n", value); return EXIT_POLICY; }
    } else if (strcmp(key, "ro") && strcmp(key, "rw")) {
      fprintf(stderr, "timon-fence: unknown policy directive: %s\n", key);
      return EXIT_POLICY;
    }
  }
  if (deny_unix && abi >= 6) attr.scoped |= LL_SCOPE_ABSTRACT_UNIX_SOCKET;
  if (deny_unix && !seccomp_available()) { fail("seccomp filters are unavailable: Unix sockets cannot be denied"); return EXIT_UNAVAILABLE; }

  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, attr_size, 0);
  if (ruleset < 0) { fail_errno("cannot create the Landlock ruleset"); return EXIT_OSERR; }
  while (pos < size) {
    const char *key = next_field(policy, size, &pos);
    const char *value = next_field(policy, size, &pos);
    if (!strcmp(key, "ro")) code = add_path_rule(ruleset, value, RO_RIGHTS, handled);
    else if (!strcmp(key, "rw")) code = add_path_rule(ruleset, value, handled, handled);
    if (code) return code;
  }
  free(policy);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) { fail_errno("cannot set no_new_privs"); return EXIT_OSERR; }
  if (syscall(SYS_landlock_restrict_self, ruleset, 0)) { fail_errno("cannot apply the Landlock ruleset"); return EXIT_OSERR; }
  close(ruleset);
  /* EINVAL means a kernel without seccomp filters. With Unix sockets allowed
     the filter only guards terminal injection, which is not worth refusing
     the mission for; with them denied it is the fence itself. */
  if (install_seccomp(deny_unix) && (deny_unix || errno != EINVAL)) {
    int unavailable = errno == EINVAL;
    fail_errno("cannot install the seccomp filter");
    return unavailable ? EXIT_UNAVAILABLE : EXIT_OSERR;
  }

  execvp(command[0], command);
  fprintf(stderr, "timon-fence: cannot execute %s: %s\n", command[0], strerror(errno));
  return EXIT_EXEC;
}
