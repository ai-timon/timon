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
 * On a kernel without Landlock (ABI < 2), the daemon writes a namespace
 * policy instead ("mechanism" "namespaces", see NAMESPACE MODE below): the
 * launcher then enters new user, mount and pid namespaces, makes every mount
 * read-only, replaces each refused folder by an empty read-only tmpfs, binds
 * back the granted paths, mounts a /proc of its own, and runs the command
 * under the same no_new_privs and seccomp filter. Two processes stay between
 * the daemon and the command there (this launcher, and the namespace's init):
 * they forward signals and the command's exit status.
 *
 * Usage
 *   timon-fence --policy FILE -- COMMAND [ARG...]
 *   timon-fence --probe      prints "landlock-abi=N seccomp=yes|no
 *                            userns=yes|no|unchecked", exits 0 when a fence
 *                            can be applied (Landlock, or namespaces when
 *                            Landlock is missing), 69 otherwise
 *   timon-fence --probe-namespaces   prints "userns=yes|no", exits 0 when the
 *                            namespace mode works here, whatever Landlock says
 *   timon-fence --version
 * FILE may be /dev/fd/N to read the policy from a pipe the caller passed.
 *
 * Policy format (version 1): a sequence of NUL-terminated strings, never text
 * lines, so that any path the kernel accepts can be written as is.
 *   "timon-fence/1"                 header, first string
 *   "ro" PATH                       read and execute beneath PATH
 *   "rw" PATH                       every handled right beneath PATH
 *   "unix-sockets" "deny"|"allow"   default deny
 *   "mechanism" "landlock"|"namespaces"   default landlock
 *   "hide" PATH                     namespaces only: PATH is replaced by an
 *                                   empty read-only folder (a file by
 *                                   /dev/null)
 * PATH is absolute. A PATH that does not exist (or that this process may not
 * open) at launch grants nothing and is skipped: the daemon enumerates paths
 * before the launch, and a file removed meanwhile must not stop the mission.
 * On a file rather than a directory, only file rights apply. An unknown
 * directive is a policy error: a newer daemon must not be half-understood.
 *
 * Exit codes, before the command runs (afterwards the code is the command's)
 *   64  usage error
 *   69  no fence on this kernel: Landlock missing or ABI < 2 for a Landlock
 *       policy, no unprivileged user namespace for a namespace policy, or no
 *       seccomp filter while Unix sockets are denied. The daemon reports it
 *       and decides whether the mission may run without the fence.
 *   71  the kernel refused a step it supports (unexpected)
 *   78  invalid policy (unreadable, malformed, unknown directive)
 *   127 the command could not be executed
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include <linux/audit.h>
#include <linux/capability.h>
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

/*
 * NAMESPACE MODE
 * --------------
 * Used when the kernel has no Landlock, from a policy the daemon wrote for
 * it. Landlock refuses what no rule grants; namespaces can only change what
 * a path shows. So the launcher builds the same view from the other side:
 *   - every mount is made read-only: the mission writes nowhere unless a
 *     "rw" path brings a writable copy back;
 *   - each "hide" folder is covered by an empty tmpfs, made read-only once
 *     the mount points of the paths granted beneath it exist (a file is
 *     covered by /dev/null);
 *   - each "ro" or "rw" path is bound back from the real file system, opened
 *     before anything was hidden, at that level. The daemon lists the paths
 *     shallow first, so a deeper entry always lands on top of its parent;
 *   - a /proc of the new pid namespace replaces the old one, and any other
 *     procfs mount is hidden: /proc/<pid>/root of a process outside would
 *     otherwise lead back to the real file system.
 * The command then runs as the same uid inside the user namespace, not as
 * its root: execve() leaves it no capability, so it can neither unmount nor
 * remount anything, and a namespace it creates itself receives these mounts
 * locked together (the kernel refuses to take them apart there).
 *
 * The command is not pid 1 of the new pid namespace: pid 1 ignores every
 * signal it has no handler for, so a CLI there would not end on SIGTERM. A
 * small init stays pid 1, forwards signals to the command, reaps orphans and
 * reports the command's wait status; when it exits, the kernel ends every
 * process left in the namespace. This launcher, the process the daemon
 * spawned, forwards signals to that init and ends the way the command ended.
 * If this launcher is killed outright, the init receives SIGKILL with it
 * (PR_SET_PDEATHSIG), and the whole namespace goes.
 */

#ifndef ST_NOATIME
#define ST_NOATIME 1024
#endif
#ifndef ST_NODIRATIME
#define ST_NODIRATIME 2048
#endif
#ifndef ST_RELATIME
#define ST_RELATIME 4096
#endif

/* Signals the daemon or a terminal sends to end or steer a mission. */
static const int FORWARDED[] = { SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2, SIGWINCH, SIGCONT };

static int write_file(const char *path, const char *data) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t len = strlen(data);
  ssize_t n = write(fd, data, len);
  int saved = errno;
  close(fd);
  errno = saved;
  return n == (ssize_t)len ? 0 : -1;
}

/* New user, mount and pid namespaces; the caller keeps its uid and gid. The
   pid namespace applies to the children forked afterwards. */
static int enter_namespaces(void) {
  uid_t uid = getuid();
  gid_t gid = getgid();
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID)) return -1;
  char map[64];
  /* Older kernels have no setgroups file: nothing to deny there. */
  if (write_file("/proc/self/setgroups", "deny") && errno != ENOENT) return -1;
  snprintf(map, sizeof map, "%lu %lu 1\n", (unsigned long)uid, (unsigned long)uid);
  if (write_file("/proc/self/uid_map", map)) return -1;
  snprintf(map, sizeof map, "%lu %lu 1\n", (unsigned long)gid, (unsigned long)gid);
  if (write_file("/proc/self/gid_map", map)) return -1;
  return 0;
}

/* The flags of the mount at `path` a bind remount must repeat: inside a user
   namespace, a remount that drops nosuid, nodev, noexec or the atime policy
   of a mount inherited from outside is refused. */
static int locked_flags(const char *path, unsigned long *flags) {
  struct statvfs vfs;
  if (statvfs(path, &vfs)) return -1;
  unsigned long out = 0;
  if (vfs.f_flag & ST_NOSUID) out |= MS_NOSUID;
  if (vfs.f_flag & ST_NODEV) out |= MS_NODEV;
  if (vfs.f_flag & ST_NOEXEC) out |= MS_NOEXEC;
  if (vfs.f_flag & ST_NOATIME) out |= MS_NOATIME;
  if (vfs.f_flag & ST_NODIRATIME) out |= MS_NODIRATIME;
  if (vfs.f_flag & ST_RELATIME) out |= MS_RELATIME;
  *flags = out;
  return 0;
}

static int remount_with(const char *path, unsigned long flags, int readonly) {
  return mount(NULL, path, NULL, MS_REMOUNT | MS_BIND | flags | (readonly ? MS_RDONLY : 0), NULL);
}

static int remount_level(const char *path, int readonly) {
  unsigned long flags;
  if (locked_flags(path, &flags)) return -1;
  return remount_with(path, flags, readonly);
}

struct mount_entry {
  char *path;
  /* The per-mount flags mountinfo lists, read there rather than through
     statvfs(): a FUSE file system may refuse statfs to this namespace. */
  unsigned long flags;
  int was_rw;
  int is_proc;
};

/* The MS_ flags of a mountinfo option list ("rw,nosuid,nodev,relatime"). */
static unsigned long option_flags(const char *opts) {
  static const struct { const char *name; unsigned long flag; } known[] = {
    { "nosuid", MS_NOSUID }, { "nodev", MS_NODEV }, { "noexec", MS_NOEXEC },
    { "noatime", MS_NOATIME }, { "nodiratime", MS_NODIRATIME }, { "relatime", MS_RELATIME },
  };
  unsigned long flags = 0;
  for (const char *opt = opts; *opt;) {
    size_t len = strcspn(opt, ",");
    for (size_t i = 0; i < sizeof known / sizeof known[0]; i++) {
      if (strlen(known[i].name) == len && !strncmp(opt, known[i].name, len)) flags |= known[i].flag;
    }
    opt += len;
    if (*opt == ',') opt++;
  }
  return flags;
}

struct mount_table {
  struct mount_entry *entries;
  size_t count;
};

/* Undoes the octal escapes of /proc/self/mountinfo (\040 for a space). */
static void unescape(char *s) {
  char *out = s;
  for (char *in = s; *in;) {
    if (in[0] == '\\' && in[1] >= '0' && in[1] <= '3' && in[2] >= '0' && in[2] <= '7' && in[3] >= '0' && in[3] <= '7') {
      *out++ = (char)(((in[1] - '0') << 6) | ((in[2] - '0') << 3) | (in[3] - '0'));
      in += 4;
    } else {
      *out++ = *in++;
    }
  }
  *out = '\0';
}

/* Every mount of this namespace, in the order the kernel lists them. */
static int read_mounts(struct mount_table *table) {
  size_t size = 0;
  int code = 0;
  char *text = read_policy("/proc/self/mountinfo", &size, &code);
  if (!text) return -1;
  char *grown = realloc(text, size + 1);
  if (!grown) { free(text); return -1; }
  text = grown;
  text[size] = '\0';
  table->entries = NULL;
  table->count = 0;
  for (char *line = text; line && *line;) {
    char *next = strchr(line, '\n');
    if (next) *next++ = '\0';
    /* id parent major:minor root mountpoint options [optional...] - fstype source super */
    char *fields[6] = { 0 };
    char *cursor = line;
    for (int i = 0; i < 6 && cursor; i++) {
      fields[i] = cursor;
      cursor = strchr(cursor, ' ');
      if (cursor) *cursor++ = '\0';
    }
    char *dash = cursor ? strstr(cursor, "- ") : NULL;
    if (fields[5] && dash) {
      char *fstype = dash + 2;
      char *end = strchr(fstype, ' ');
      if (end) *end = '\0';
      struct mount_entry *more = realloc(table->entries, (table->count + 1) * sizeof *more);
      if (!more) { free(text); return -1; }
      table->entries = more;
      unescape(fields[4]);
      char *path = strdup(fields[4]);
      if (!path) { free(text); return -1; }
      const char *opts = fields[5];
      table->entries[table->count++] = (struct mount_entry){
        .path = path,
        .flags = option_flags(opts),
        .was_rw = !strncmp(opts, "rw", 2) && (opts[2] == ',' || opts[2] == '\0'),
        .is_proc = !strcmp(fstype, "proc"),
      };
    }
    line = next;
  }
  free(text);
  return 0;
}

/* `path` is `root` or lies beneath it. */
static int beneath(const char *root, const char *path) {
  size_t len = strlen(root);
  if (len == 1 && root[0] == '/') return 1;
  return !strncmp(root, path, len) && (path[len] == '\0' || path[len] == '/');
}

/* A missing mount point, created where it can be: in a tmpfs this launcher
   put over a hidden folder. Elsewhere every mount is read-only by now, so
   the grant is skipped, which is the safe side. */
static int ensure_mount_point(const char *path, int dir) {
  struct stat st;
  if (!lstat(path, &st)) return 0;
  if (errno != ENOENT) return -1;
  char buf[PATH_MAX];
  size_t len = strlen(path);
  if (len >= sizeof buf) { errno = ENAMETOOLONG; return -1; }
  memcpy(buf, path, len + 1);
  for (char *slash = strchr(buf + 1, '/'); slash; slash = strchr(slash + 1, '/')) {
    *slash = '\0';
    if (mkdir(buf, 0755) && errno != EEXIST) return -1;
    *slash = '/';
  }
  if (dir) return mkdir(buf, 0755) && errno != EEXIST ? -1 : 0;
  int fd = open(buf, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
  if (fd < 0) return -1;
  close(fd);
  return 0;
}

struct ns_op {
  char kind; /* 'h' hide, 'r' read-only, 'w' read-write */
  const char *path;
  int fd;
  int dir;
};

#define MASK_OPTIONS "mode=0755,size=1m,nr_inodes=65536"

/* Builds the mission's view of the file system; 0, or an exit code. Runs as
   pid 1 of the new pid namespace, with every capability of the new user
   namespace. */
static int build_view(struct ns_op *ops, size_t count) {
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) { fail_errno("cannot make the mounts private"); return EXIT_OSERR; }
  struct mount_table table;
  if (read_mounts(&table)) { fail_errno("cannot read the mount table"); return EXIT_OSERR; }
  for (size_t i = 0; i < table.count; i++) {
    const char *path = table.entries[i].path;
    if (!remount_with(path, table.entries[i].flags, 1)) continue;
    int saved = errno;
    struct statvfs vfs;
    /* Unreachable from this namespace (overmounted, or a FUSE file system
       that refuses it): the mission cannot write there either. */
    if (statvfs(path, &vfs) && (errno == EACCES || errno == EPERM || errno == ENOENT || errno == ENOTDIR)) continue;
    errno = saved;
    if (errno == EACCES || errno == ENOENT || errno == ENOTDIR) continue;
    /* Kernel interfaces: their own permissions decide, and /proc is replaced below. */
    if (beneath("/proc", path) || beneath("/sys", path)) continue;
    fprintf(stderr, "timon-fence: cannot make %s read-only: %s\n", path, strerror(errno));
    return EXIT_OSERR;
  }

  char cwd[PATH_MAX];
  if (!getcwd(cwd, sizeof cwd)) strcpy(cwd, "/");
  for (size_t i = 0; i < count; i++) {
    ops[i].fd = -1;
    if (ops[i].kind == 'h') continue;
    int fd = open(ops[i].path, O_PATH | O_CLOEXEC);
    if (fd < 0) continue; /* missing at launch: it grants nothing */
    struct stat st;
    if (fstat(fd, &st)) { close(fd); continue; }
    ops[i].fd = fd;
    ops[i].dir = S_ISDIR(st.st_mode);
  }

  const char **masks = calloc(count + table.count + 1, sizeof *masks);
  size_t mask_count = 0;
  if (!masks) { fail("out of memory"); return EXIT_OSERR; }
  for (size_t i = 0; i < count; i++) {
    const char *path = ops[i].path;
    if (ops[i].kind == 'h') {
      struct stat st;
      if (stat(path, &st)) {
        if (errno == ENOENT || errno == ENOTDIR || errno == EACCES) continue;
        fprintf(stderr, "timon-fence: cannot hide %s: %s\n", path, strerror(errno));
        return EXIT_OSERR;
      }
      int failed = S_ISDIR(st.st_mode)
        ? mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, MASK_OPTIONS)
        : mount("/dev/null", path, NULL, MS_BIND, NULL);
      if (failed) { fprintf(stderr, "timon-fence: cannot hide %s: %s\n", path, strerror(errno)); return EXIT_OSERR; }
      if (S_ISDIR(st.st_mode)) masks[mask_count++] = path;
      continue;
    }
    if (ops[i].fd < 0) continue;
    if (ensure_mount_point(path, ops[i].dir)) continue;
    char source[64];
    snprintf(source, sizeof source, "/proc/self/fd/%d", ops[i].fd);
    if (mount(source, path, NULL, MS_BIND | MS_REC, NULL)) {
      fprintf(stderr, "timon-fence: cannot bind %s: %s\n", path, strerror(errno));
      return EXIT_OSERR;
    }
    close(ops[i].fd);
    ops[i].fd = -1;
    /* The copy is read-only like its source; a writable grant takes back the
       write right on it and on the mounts beneath it that had one. */
    if (ops[i].kind != 'w') continue;
    if (remount_level(path, 0)) { fprintf(stderr, "timon-fence: cannot make %s writable: %s\n", path, strerror(errno)); return EXIT_OSERR; }
    for (size_t m = 0; m < table.count; m++) {
      const struct mount_entry *entry = &table.entries[m];
      if (entry->was_rw && strcmp(entry->path, path) && beneath(path, entry->path)) (void)remount_with(entry->path, entry->flags, 0);
    }
  }
  for (size_t m = 0; m < table.count; m++) {
    const char *path = table.entries[m].path;
    if (!table.entries[m].is_proc || !strcmp(path, "/proc")) continue;
    if (!mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, MASK_OPTIONS)) { masks[mask_count++] = path; continue; }
    if (errno == ENOENT || errno == ENOTDIR || errno == EACCES) continue;
    fprintf(stderr, "timon-fence: cannot hide the procfs at %s: %s\n", path, strerror(errno));
    return EXIT_OSERR;
  }
  /* An empty folder the mission could write in is harmless, but says less. */
  while (mask_count > 0) (void)mount(NULL, masks[--mask_count], NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL);
  free(masks);
  if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL)) { fail_errno("cannot mount a /proc of the mission's own"); return EXIT_OSERR; }
  /* The working directory still points into the mounts as they were: enter
     it again through the new view, or fall back to the root. */
  if (chdir(cwd) && chdir("/")) { fail_errno("cannot enter a working directory"); return EXIT_OSERR; }
  return 0;
}

static void drop_capabilities(void) {
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2];
  memset(data, 0, sizeof data);
  (void)syscall(SYS_capset, &header, data);
}

/* Ends this process the way `status` says a child ended. */
static void end_like(int status) {
  if (WIFEXITED(status)) exit(WEXITSTATUS(status));
  if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    struct rlimit none = { 0, 0 };
    (void)setrlimit(RLIMIT_CORE, &none);
    signal(sig, SIG_DFL);
    sigset_t only;
    sigemptyset(&only);
    sigaddset(&only, sig);
    sigprocmask(SIG_UNBLOCK, &only, NULL);
    raise(sig);
    exit(128 + sig);
  }
  exit(EXIT_OSERR);
}

/* pid 1 of the namespace: forwards signals to the command, reaps every
   orphan, reports the command's wait status on `report`, then exits. */
static void run_init(pid_t command, int report, const sigset_t *watched) {
  for (;;) {
    siginfo_t info;
    int sig = sigwaitinfo(watched, &info);
    if (sig < 0) continue;
    if (sig != SIGCHLD) { kill(command, sig); continue; }
    for (;;) {
      int status;
      pid_t done = waitpid(-1, &status, WNOHANG);
      if (done <= 0) break;
      if (done != command) continue;
      ssize_t written = write(report, &status, sizeof status);
      (void)written;
      _exit(0);
    }
  }
}

static int run_namespaces(struct ns_op *ops, size_t count, int deny_unix, char **command) {
  sigset_t watched, previous;
  sigemptyset(&watched);
  for (size_t i = 0; i < sizeof FORWARDED / sizeof FORWARDED[0]; i++) sigaddset(&watched, FORWARDED[i]);
  sigaddset(&watched, SIGCHLD);
  /* Blocked before the first fork, so that no signal is lost or acted on
     before a process is there to forward it. */
  sigprocmask(SIG_BLOCK, &watched, &previous);

  if (enter_namespaces()) {
    int unavailable = errno == EPERM || errno == EACCES || errno == ENOSPC || errno == EINVAL || errno == ENOSYS || errno == EUSERS;
    fail_errno("cannot create the mission namespaces");
    return unavailable ? EXIT_UNAVAILABLE : EXIT_OSERR;
  }
  int report[2];
  if (pipe2(report, O_CLOEXEC)) { fail_errno("cannot create a pipe"); return EXIT_OSERR; }

  pid_t init = fork();
  if (init < 0) { fail_errno("cannot fork"); return EXIT_OSERR; }
  if (init == 0) {
    close(report[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0)) _exit(EXIT_OSERR);
    int code = build_view(ops, count);
    if (code) _exit(code);
    pid_t child = fork();
    if (child < 0) { fail_errno("cannot fork"); _exit(EXIT_OSERR); }
    if (child == 0) {
      sigprocmask(SIG_SETMASK, &previous, NULL);
      if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) { fail_errno("cannot set no_new_privs"); _exit(EXIT_OSERR); }
      if (install_seccomp(deny_unix) && (deny_unix || errno != EINVAL)) {
        int unavailable = errno == EINVAL;
        fail_errno("cannot install the seccomp filter");
        _exit(unavailable ? EXIT_UNAVAILABLE : EXIT_OSERR);
      }
      execvp(command[0], command);
      fprintf(stderr, "timon-fence: cannot execute %s: %s\n", command[0], strerror(errno));
      _exit(EXIT_EXEC);
    }
    drop_capabilities();
    prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
    run_init(child, report[1], &watched);
  }

  /* Holds every capability of the new user namespace: not to be traced. */
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  close(report[1]);
  for (;;) {
    siginfo_t info;
    int sig = sigwaitinfo(&watched, &info);
    if (sig < 0) continue;
    if (sig != SIGCHLD) { kill(init, sig); continue; }
    int status;
    pid_t done = waitpid(init, &status, WNOHANG);
    if (done != init) continue;
    int reported;
    /* The command's own status when the init reported it; otherwise the
       init's, which carries a setup failure's exit code. */
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0 && read(report[0], &reported, sizeof reported) == (ssize_t)sizeof reported) end_like(reported);
    end_like(status);
  }
}

/* Whether this kernel lets an unprivileged process build the namespace view:
   the whole chain is tried in a throwaway child, since a security module
   (AppArmor on Ubuntu 24.04) may allow the namespace and refuse its mounts. */
static int userns_available(void) {
  pid_t child = fork();
  if (child < 0) return 0;
  if (child == 0) {
    int devnull = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (devnull >= 0) dup2(devnull, STDERR_FILENO);
    if (enter_namespaces()) _exit(1);
    pid_t init = fork();
    if (init < 0) _exit(1);
    if (init == 0) {
      struct stat st;
      const char *scratch = !stat("/tmp", &st) && S_ISDIR(st.st_mode) ? "/tmp" : "/";
      if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) _exit(1);
      if (remount_level("/", 1)) _exit(1);
      if (mount("tmpfs", scratch, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, MASK_OPTIONS)) _exit(1);
      if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL)) _exit(1);
      _exit(0);
    }
    int status;
    if (waitpid(init, &status, 0) != init) _exit(1);
    _exit(WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 1);
  }
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 0;
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static int usage(void) {
  fprintf(stderr, "usage: timon-fence --policy FILE -- COMMAND [ARG...]\n"
                  "       timon-fence --probe | --probe-namespaces | --version\n");
  return EXIT_USAGE;
}

static int probe(void) {
  int abi = landlock_abi();
  int seccomp = seccomp_available();
  /* Only asked when Landlock is missing: on every other machine it would
     create a namespace at each launch for nothing (and an audit line where a
     security module watches them). */
  int userns = abi >= 2 ? -1 : userns_available();
  printf("landlock-abi=%d seccomp=%s userns=%s\n", abi < 0 ? 0 : abi, seccomp ? "yes" : "no",
         userns < 0 ? "unchecked" : userns ? "yes" : "no");
  return seccomp && (abi >= 2 || userns > 0) ? 0 : EXIT_UNAVAILABLE;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--probe")) return probe();
  if (argc == 2 && !strcmp(argv[1], "--probe-namespaces")) {
    int userns = userns_available();
    printf("userns=%s\n", userns ? "yes" : "no");
    return userns ? 0 : EXIT_UNAVAILABLE;
  }
  if (argc == 2 && !strcmp(argv[1], "--version")) { printf("timon-fence %s\n", FENCE_VERSION); return 0; }
  if (argc < 5 || strcmp(argv[1], "--policy") || strcmp(argv[3], "--")) return usage();
  const char *policy_path = argv[2];
  char **command = argv + 4;

  int code = 0;
  size_t size = 0;
  char *policy = read_policy(policy_path, &size, &code);
  if (!policy) return code;
  size_t pos = 0;
  const char *header = next_field(policy, size, &pos);
  if (!header || strcmp(header, POLICY_HEADER)) { fail("policy header missing or unsupported"); return EXIT_POLICY; }

  /* First pass: options only, so the ruleset knows its scopes before rules. */
  int deny_unix = 1;
  int namespaces = 0;
  int hides = 0;
  size_t paths = 0;
  for (size_t scan = pos; scan < size;) {
    const char *key = next_field(policy, size, &scan);
    const char *value = next_field(policy, size, &scan);
    if (!key || !value) { fail("policy truncated"); return EXIT_POLICY; }
    if (!strcmp(key, "unix-sockets")) {
      if (!strcmp(value, "deny")) deny_unix = 1;
      else if (!strcmp(value, "allow")) deny_unix = 0;
      else { fprintf(stderr, "timon-fence: invalid unix-sockets value: %s\n", value); return EXIT_POLICY; }
    } else if (!strcmp(key, "mechanism")) {
      if (!strcmp(value, "namespaces")) namespaces = 1;
      else if (!strcmp(value, "landlock")) namespaces = 0;
      else { fprintf(stderr, "timon-fence: invalid mechanism: %s\n", value); return EXIT_POLICY; }
    } else if (!strcmp(key, "hide")) {
      hides++;
      paths++;
    } else if (!strcmp(key, "ro") || !strcmp(key, "rw")) {
      paths++;
    } else {
      fprintf(stderr, "timon-fence: unknown policy directive: %s\n", key);
      return EXIT_POLICY;
    }
  }
  /* Landlock refuses what it does not grant: a "hide" there means a policy
     written for the other mechanism. */
  if (hides && !namespaces) { fail("hide is a namespace directive"); return EXIT_POLICY; }
  if (deny_unix && !seccomp_available()) { fail("seccomp filters are unavailable: Unix sockets cannot be denied"); return EXIT_UNAVAILABLE; }

  if (namespaces) {
    struct ns_op *ops = calloc(paths + 1, sizeof *ops);
    if (!ops) { fail("out of memory"); return EXIT_OSERR; }
    size_t count = 0;
    while (pos < size) {
      const char *key = next_field(policy, size, &pos);
      const char *value = next_field(policy, size, &pos);
      char kind = !strcmp(key, "hide") ? 'h' : !strcmp(key, "ro") ? 'r' : !strcmp(key, "rw") ? 'w' : 0;
      if (!kind) continue;
      if (value[0] != '/') { fprintf(stderr, "timon-fence: policy path is not absolute: %s\n", value); return EXIT_POLICY; }
      /* The root is read-only already. Anything mounted on it would leave this
         process's root under the new mount, which the kernel reads as a
         chroot; hiding it or opening it whole is not a policy at all. */
      if (!strcmp(value, "/")) {
        if (kind == 'r') continue;
        fail("the root can only be read-only in a namespace policy");
        return EXIT_POLICY;
      }
      ops[count++] = (struct ns_op){ .kind = kind, .path = value, .fd = -1, .dir = 0 };
    }
    return run_namespaces(ops, count, deny_unix, command);
  }

  int abi = landlock_abi();
  if (abi < 2) {
    fprintf(stderr, "timon-fence: Landlock ABI 2 or later is required (found %d)\n", abi < 0 ? 0 : abi);
    return EXIT_UNAVAILABLE;
  }
  uint64_t handled = handled_rights(abi);

  struct ll_ruleset_attr attr = { .handled_access_fs = handled, .handled_access_net = 0, .scoped = 0 };
  /* ABI 4 adds the network field, ABI 6 the scopes: an older kernel rejects a
     larger structure, so the size follows the ABI. */
  size_t attr_size = abi >= 6 ? sizeof attr : abi >= 4 ? 2 * sizeof(uint64_t) : sizeof(uint64_t);
  if (abi >= 6) attr.scoped = LL_SCOPE_SIGNAL;
  if (deny_unix && abi >= 6) attr.scoped |= LL_SCOPE_ABSTRACT_UNIX_SOCKET;

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
