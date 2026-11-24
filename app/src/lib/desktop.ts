declare global {
  interface Window {
    timonDesktop?: {
      setupRestartPending?: () => Promise<boolean>;
      restartAfterSetup: () => Promise<void>;
      /** End of a first setup: the service takes the embedded daemon's place, then the window opens `route`. Absent from an older desktop. */
      handOverToService?: (route: string) => Promise<string>;
      selectDirectory?: (defaultPath?: string) => Promise<string | null>;
      /** Native picker for a plugin folder or a `.tgz`/`.zip` archive (TODO #332, #345); absent before 0.1.5. */
      selectPluginSource?: (kind: 'folder' | 'archive') => Promise<string | null>;
      /** Native picker for a backend CLI binary (TODO #413); absent from an older desktop. */
      selectExecutable?: (defaultPath?: string) => Promise<string | null>;
      revealPath?: (request: { agentId: string; path: string }) => Promise<unknown>;
      /** Absent from a desktop older than 0.1.5. */
      appInfo?: () => Promise<{ version: string }>;
      /** Opens the logs folder of the data directory; absent before 0.1.5. Resolves to '' or an error. */
      openLogsFolder?: () => Promise<string>;
      /** Opens "About Timon" with the speech-model licences (TODO #582); absent from an older desktop. */
      openAbout?: () => Promise<void>;
      uninstall?: {
        info: () => Promise<{ home: string; platform: string; appImage: string | null }>;
        run: (request: { mode: 'keep' | 'delete'; confirmation: string; locale: string }) => Promise<{ cancelled: boolean }>;
      };
      /** Local dictation (TODO #443); read through `plugins-client/local-dictation/desktop-speech`. Absent before it. */
      speech?: unknown;
      /**
       * Download of a newer Timon (docs/AUTO-UPDATE.md P2): the shell reads the
       * verified offer from its own daemon; the page sends gestures, never a
       * URL or a path. Read through `lib/update-download`. Absent from an older
       * desktop; refused in a window showing another machine.
       */
      updates?: {
        state: () => Promise<unknown>;
        start: () => Promise<unknown>;
        cancel: () => Promise<unknown>;
        open: (target: 'folder' | 'installer') => Promise<unknown>;
        /** P3: installs the verified file; `confirmed` = past running missions. Absent from a P2 desktop. */
        install?: (confirmed: boolean) => Promise<unknown>;
        onState: (listener: (state: unknown) => void) => () => void;
      };
      /** Install Tailscale when the daemon has no desktop; absent from an older desktop. */
      tailscale?: {
        openInstaller: () => Promise<unknown>;
        openApp: () => Promise<unknown>;
      };
      /**
       * Shows a machine in this window (multi-window V3, V4): the shell names
       * it in `X-Timon-Machine` on every request of that machine's page. An
       * id, never a URL; `route` is where a new page of the machine opens.
       * `{ shown: true }`: the shell switched pages, this one stays as it is;
       * otherwise (an older desktop) the page reloads itself. Absent from an
       * older desktop still.
       */
      windowMachine?: {
        set: (id: string, request?: { route?: string }) => Promise<unknown>;
      };
      /**
       * The light/dark mode this page paints and the machine it was served
       * for: the shell paints the next window or page of that machine with it.
       * Read through `lib/window-scheme`. Absent from an older desktop.
       */
      windowScheme?: (request: { scheme: 'light' | 'dark'; machineId?: string }) => Promise<unknown>;
      /**
       * One more window on this window's machine, at a route of this interface
       * (multi-window V5): a path, never a URL. Read through `lib/open-window`.
       * Absent from an older desktop.
       */
      openWindow?: (request: { route: string; machineId?: string }) => Promise<unknown>;
      /**
       * The icon macOS shows in the Dock while Timon runs. `get` resolves to
       * null where there is no Dock; a page of another machine is refused.
       * Read through `lib/dock-icon`. Absent from an older desktop.
       */
      dockIcon?: {
        get: () => Promise<{ icon: string } | null>;
        set: (icon: string) => Promise<{ icon: string }>;
      };
      /**
       * The size of the interface on this screen, every window alike. `set`
       * snaps to one of `steps`; `onChange` hears every change, made here,
       * in another window or with the keys. Read through `lib/ui-zoom`.
       * Absent from an older desktop.
       */
      zoom?: {
        /** The factor this page is laid out at now, read from Blink synchronously. Absent from an older desktop. */
        current?: () => number;
        get: () => Promise<{ factor: number; steps: number[] }>;
        set: (factor: number) => Promise<{ factor: number }>;
        step: (direction: 'in' | 'out' | 'reset') => Promise<{ factor: number }>;
        onChange: (listener: (factor: number) => void) => () => void;
      };
      browser?: {
        /** `conversation`, `locale` and `scheme` tell the desktop's annotation bubble where to send and how to look (TODO #481); an older desktop ignores them. */
        attach: (input: { profileId: string; viewToken: string; bounds: { x: number; y: number; width: number; height: number };
          conversation?: { agent: string; mission: string | null; fresh?: boolean }; locale?: string; scheme?: 'light' | 'dark' }) => Promise<unknown>;
        detach: () => Promise<unknown>;
      };
    };
  }
}

/** A browser connected to a desktop daemon does not have shell privileges. */
export function desktopBridge() {
  return typeof window !== 'undefined' && typeof window.timonDesktop?.restartAfterSetup === 'function'
    ? window.timonDesktop : null;
}

/**
 * Ends `/setup` on the daemon that will stay. The desktop shell may still run
 * its own (embedded) daemon next to the service the wizard just installed:
 * step 3 then ran on a daemon about to be replaced, while the service failed
 * its mission at each of its boots (401). The shell stops it, waits for the
 * service and reopens the window on `route` itself.
 *
 * `true`: the shell has the window, and the page must not navigate. `false`:
 * nothing to hand over (a browser, portable mode, an older shell, a refusal),
 * the page goes on to `route` by itself.
 */
export async function handOverToService(route: string): Promise<boolean> {
  const bridge = desktopBridge();
  if (typeof bridge?.handOverToService !== 'function') return false;
  try {
    return await bridge.handOverToService(route) !== 'not-needed';
  } catch {
    // The shell reported it; if the embedded daemon still serves, the page goes on there.
    return false;
  }
}
