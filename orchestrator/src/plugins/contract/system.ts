/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `host/machine.ts`, which re-exports it (TODO #512, volet 3).
export type LinuxRelease = {
  /** `ID` of `/etc/os-release`, e.g. `ubuntu`, `debian`, `fedora`. */
  id: string | null;
  /** `ID_LIKE`, split — a derived distro says here what it derives from. */
  idLike: string[];
  /** Human name (`PRETTY_NAME`), for the screen only. */
  prettyName: string | null;
  packageManager: PackageManager | null;
};

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk' | 'brew' | 'winget';

/** Supervisors Timon can install the daemon into. `null` = none available. */
export type SupervisorKind = 'systemd-user' | 'launchd' | 'windows' | null;

// Moved from `resources.ts`, which re-exports it (TODO #512, volet 3).
export type ResourceHealth = {
  guardEnabled: boolean;
  systemd: boolean;
  profile: ResourceProfile;
  limits: ProfileLimits;
  /** Profile actually pushed to systemd (may differ if applying it failed). */
  appliedProfile: ResourceProfile | null;
  service: CgroupStats;
  missions: CgroupStats;
  /** Scopes of the missions currently alive. */
  scopes: string[];
  loadavg: [number, number, number];
  cpuCount: number;
};

export type CgroupStats = {
  unit: string;
  /** null = unit inactive (or cgroup unreadable): nothing runs in it. */
  memoryCurrent: number | null;
  memoryHigh: number | null;
  memoryMax: number | null;
  /** CPU quota in % of one core (1600 = 16 cores), null = unlimited. */
  cpuQuotaPct: number | null;
  cpuWeight: number | null;
  /** Cgroup path relative to /sys/fs/cgroup, null if the unit is inactive. */
  controlGroup: string | null;
  /** Cumulative counters of memory.events (high/max crossings, OOM). */
  events: { high: number; max: number; oom: number; oomKill: number } | null;
  /** `some avg10` of memory.pressure, in %: the very measure systemd-oomd
   *  reads. null if the cgroup is unreadable. */
  pressureSomeAvg10: number | null;
};

export type ProfileLimits = {
  profile: ResourceProfile;
  /** COLLECTIVE CPU quota of the slice, in % of one core (400 = 4 cores). */
  cpuQuotaPct: number;
  /** COLLECTIVE memory ceiling of the slice, in GB. The slice's only memory
   *  limit: no soft threshold, see the 19/09 pitfall at the top of `resources.ts`. */
  memMaxGb: number;
  /** PER-MISSION memory ceiling actually applied, in GB (may be
   *  fractional: it is `missionMemMaxMiB` / 1024). */
  missionMemMaxGb: number;
  /** The same ceiling in MiB — the value written to `MemoryMax=`. Always
   *  STRICTLY below `memMaxGb`, see `missionMemCapMiB()`. */
  missionMemMaxMiB: number;
  /** Value of `TIMON_MISSION_MEM_MAX_GB`: a maximum, not a target. */
  missionMemConfiguredGb: number;
  nice: number;
  /** ionice class: 1=realtime, 2=best-effort, 3=idle. */
  ioniceClass: number;
  maxLive: number;
  maxParallel: number;
};

export type ResourceProfile = 'day' | 'night';

// Moved from `doctor.ts`, which re-exports it (TODO #512, volet 3).
export type DoctorReport = {
  platform: NodeJS.Platform;
  /**
   * The home directory of the account the daemon runs as. Onboarding writes its
   * example project path from it, in this machine's own notation: a Windows
   * user was being shown `~/webdev`, a path they would never type.
   */
  home: string;
  profile: string;
  edition: string;
  timonHome: string;
  configFile: { path: string; present: boolean };
  binaries: BinaryReport[];
  /** Whether the user is signed in, for the providers that can tell (C4). */
  auth: ProviderAuthReport[];
  /** Providers reached with an API key through the CLI of another one. */
  apiKeyProviders: Array<{ id: string; label: string; brand: string; via: string; viaLabel: string }>;
  systemd: boolean;
  /**
   * The supervisor available on this machine (step 5.7.1). Distinct from
   * `config.daemon.supervisor`, which is what the config ASKS for: onboarding
   * no longer offers a choice, the machine dictates the answer. `null` = no
   * supervisor Timon knows how to install into (a Linux without systemd), or
   * a Windows account whose task Windows never started (TODO #342).
   */
  supervisor: SupervisorKind;
  /** Distribution and package manager; `null` off Linux or without os-release. */
  linux: LinuxRelease | null;
  docker: { present: boolean; usable: boolean; detail: string };
  display: string | null;
  /**
   * Mission isolation: whether the kernel fences a mission launched now
   * (`host/fence.ts`, `resources.ts` `hostFenceStatus`), and what a launch does
   * when it cannot. `tampered` is apart from `unsupported` on purpose: the
   * release ships a launcher that is gone, not executable, replaced or unable
   * to run, a sign the package was altered.
   *
   * `launcher` and `maskedPaths` describe the older systemd masking (audit
   * finding #4), which a `--scope` launcher never emits: they only matter
   * while no fence applies.
   */
  missionIsolation: {
    /** `host.isolation.filesystem`, verbatim. */
    configured: 'auto' | 'enforce' | 'off';
    /**
     * The mechanism that fences a mission launched now; `none` when missions
     * run unfenced. `namespaces` is the Linux launcher on a kernel without Landlock.
     */
    mechanism: 'landlock' | 'seatbelt' | 'namespaces' | 'none';
    /** Landlock ABI of the kernel, 0 when unknown, absent or not Landlock. */
    abi: number;
    /** `true` only when a mission launched now runs inside the fence. */
    enforced: boolean;
    state: 'ready' | 'unsupported' | 'tampered' | 'off';
    /** What a mission launch does today: `unfenced` warns, `refused` is `enforce` without a fence. */
    launch: 'fenced' | 'unfenced' | 'refused';
    /** Why missions are not fenced, in English; null when they are. */
    reason: string | null;
    /** The diagnostic line, in English: what holds and, when nothing does, what a mission can reach. */
    message: string;
    /** What the fence leaves open on this machine and configuration, one English line each; empty when unfenced. */
    gaps: string[];
    /** `host.isolation.unixSockets`, the default every exception departs from. */
    unixSockets: 'deny' | 'allow';
    /** Agents and projects with a fence exception (`host.isolation.exceptions`). */
    exceptions: { agents: string[]; projects: string[] };
    /** Unit kind missions are wrapped in; `null` when the host declares none. */
    launcher: string | null;
    /** Paths the systemd masking policy would hide. Non-zero and unfenced = inert. */
    maskedPaths: number;
  };
  /**
   * Free space on the filesystem of `timonHome` (TIM-0109): a full or failing
   * disk stops the database, and the daemon with it. `null` when the OS
   * cannot tell. A warning, never a blocker.
   */
  storage: { path: string; freeBytes: number | null; low: boolean };
  /**
   * The cross-project orchestrator seat (TIM-0142): who holds it, and who may
   * take it when nobody does. `null` while the first-run wizard is pending
   * or before any agent exists, when an empty seat is expected. A warning,
   * never a blocker. Optional: reports built before it existed lack it.
   */
  mainSeat?: { holder: string | null; empty: boolean; candidates: string[] } | null;
  capabilities: string[];
  /**
   * Bundled modules this machine's capabilities switch off or reduce, one
   * line each (`requires` / `recommends` in `kernel/catalog.ts`). Read from
   * the catalogue, not from the live daemon: a forced module or a licence
   * can still change the outcome.
   */
  modules: string[];
  /** What prevents TIMON from working at all. */
  blockers: string[];
  ok: boolean;
};

export type BinaryReport = {
  name: string;
  /** Set for the AI CLIs of the product's own providers (C1). */
  provider?: BinaryProvider;
  /** Resolved path, `null` if not found. */
  path: string | null;
  ok: boolean;
  /** Comes from `config.host.binaries` rather than PATH. */
  pinned: boolean;
  attemptedPaths?: string[];
  error?: string;
  /** Found, yet unable to run: a Node CLI on a machine where no node is reachable. */
  warning?: string;
  /**
   * What would install it HERE, `null` when we know of no command for this
   * machine. Present even when the binary is found: the onboarding screen
   * shows it for what is missing, and a diagnostic that only computes it on
   * failure is a diagnostic nobody can test on a healthy machine.
   */
  installCommand: string | null;
};

/** The provider behind an AI CLI, as the first-run screen shows it. */
export type BinaryProvider = {
  /** Profile id of the provider. */
  id: string;
  /** Short name on its card. */
  label: string;
  /** Logo key. */
  brand: string | null;
  /** Place among the cards. */
  order: number;
  /** Offered first when no CLI is installed. */
  suggested: boolean;
  /** A fresh install may seed its main agent on it. */
  seedsMainAgent: boolean;
};

export type ProviderAuthReport = {
  /** Profile id of the provider. */
  provider: string;
  /** The binary it runs, as `binaries` names it. */
  binary: string;
  ok: boolean;
  detail: string;
  signInCommand: string | null;
  /** Where the credentials were looked for, when the provider says. */
  path: string | null;
  /** Where the credentials were found, when the provider says. */
  source: 'file' | 'environment' | null;
};

// Moved from `daemon-memory.ts`, which re-exports it (TODO #512, volet 3).
export type DaemonMemory = {
  /** V8 heap in use, and the ceiling after which the process aborts (SIGABRT). */
  heapUsedMb: number;
  heapLimitMb: number;
  /** What the OS charges the process: heap + native + buffers. */
  rssMb: number;
  externalMb: number;
  /** SSE streams open vs bus subscribers: a gap means a subscriber leaks. */
  sse: { clients: number; busEventListeners: number };
};

export type PluginSystemHealth = {
  ok: true;
  service: string;
  /** Digest of the data directory, as the public probe gives it. */
  instance: string;
  liveMissions: number;
  resources: ResourceHealth;
  daemon: DaemonMemory;
};

/** The doctor report of this machine; `desktop` is true when the desktop shell runs the daemon. */
export type PluginDoctorReport = DoctorReport & { desktop: boolean };

/** `daemon`: the daemon's own log. `desktop`: the desktop shell's. The prompts log is never offered. */
export type PluginLogKind = 'daemon' | 'desktop';

export type PluginLogsOptions = {
  kind?: PluginLogKind;
  /** 1 to 1000, default 100. */
  lines?: number;
};
