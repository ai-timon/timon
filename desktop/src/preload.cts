// Sandboxed preloads must be CommonJS and expose capabilities, never raw IPC.
const { contextBridge, ipcRenderer, webFrame } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('timonDesktop', {
  selectDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('timon:select-directory', defaultPath),
  selectPluginSource: (kind: 'folder' | 'archive'): Promise<string | null> => ipcRenderer.invoke('timon:select-plugin-source', kind),
  selectExecutable: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('timon:select-executable', defaultPath),
  revealPath: (request: { agentId: string; path: string }): Promise<unknown> => ipcRenderer.invoke('timon:reveal-path', request),
  setupRestartPending: (): Promise<boolean> => ipcRenderer.invoke('timon:setup-restart-pending'),
  restartAfterSetup: (): Promise<void> => ipcRenderer.invoke('timon:restart-after-setup'),
  // End of a first setup: the service takes over, then the window opens `route`, a path of the interface.
  handOverToService: (route: string): Promise<string> => ipcRenderer.invoke('timon:setup-handover', route),
  appInfo: (): Promise<{ version: string }> => ipcRenderer.invoke('timon:app-info'),
  openLogsFolder: (): Promise<string> => ipcRenderer.invoke('timon:open-logs'),
  // About Timon and the speech-model licences (TODO #582).
  openAbout: (): Promise<void> => ipcRenderer.invoke('timon:open-about'),
  uninstall: {
    info: () => ipcRenderer.invoke('timon:uninstall-info'),
    run: (request: { mode: 'keep' | 'delete'; confirmation: string; locale: string }) => ipcRenderer.invoke('timon:uninstall', request),
  },
  // Local dictation (TODO #443). Audio is 16 kHz mono Float32 PCM, ~100 ms per
  // chunk; events carry the session id, and `stopped` is always the last one.
  speech: {
    getState: (modelId?: string): Promise<unknown> => ipcRenderer.invoke('timon:speech-state', modelId ? { modelId } : undefined),
    downloadModel: (modelId?: string): Promise<unknown> => ipcRenderer.invoke('timon:speech-download', modelId ? { modelId } : undefined),
    cancelDownload: (modelId?: string): Promise<boolean> => ipcRenderer.invoke('timon:speech-cancel-download', modelId ? { modelId } : undefined),
    deleteModel: (modelId?: string): Promise<unknown> => ipcRenderer.invoke('timon:speech-delete-model', modelId ? { modelId } : undefined),
    // `language`: 'auto' or a tag ('fr', 'fr-FR'); the main process picks the model that fits.
    // `interim`: 'auto' | 'live' | 'delayed' | 'final-only'; it can only make the model's own mode stricter.
    startDictation: (modelId?: string, language?: string, interim?: string): Promise<unknown> => ipcRenderer.invoke(
      'timon:speech-start',
      modelId || language || interim
        ? { ...(modelId ? { modelId } : {}), ...(language ? { language } : {}), ...(interim ? { interim } : {}) }
        : undefined,
    ),
    // The live catalog (TODO #484): built-in models, confirmed packs, local imports.
    listModels: (): Promise<unknown> => ipcRenderer.invoke('timon:speech-list-models'),
    // The main process opens the folder picker: no path ever crosses from the page.
    importModel: (request?: { family?: string; languages?: string[] }): Promise<unknown> => ipcRenderer.invoke('timon:speech-import-model', request),
    // A plugin's model entry; the main process asks the user before anything downloads.
    proposePack: (request: { pluginId: string; modelId: string }): Promise<unknown> => ipcRenderer.invoke('timon:speech-propose-pack', request),
    feed: (sessionId: string, samples: Float32Array): void => ipcRenderer.send('timon:speech-feed', { sessionId, samples, sampleRate: 16000 }),
    stopDictation: (sessionId: string): Promise<void> => ipcRenderer.invoke('timon:speech-stop', { sessionId }),
    cancelDictation: (sessionId: string): Promise<void> => ipcRenderer.invoke('timon:speech-cancel', { sessionId }),
    // 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'; `request` prompts on macOS.
    microphone: (request?: boolean): Promise<{ status: string }> => ipcRenderer.invoke('timon:speech-microphone', request ? { request: true } : undefined),
    onEvent: (listener: (event: unknown) => void): (() => void) => {
      const forward = (_event: unknown, payload: unknown): void => listener(payload);
      ipcRenderer.on('timon:speech-event', forward);
      return () => { ipcRenderer.removeListener('timon:speech-event', forward); };
    },
  },
  // The machine this window drives (multi-window V3): an id, and the page to open should the
  // machine have no live page in the window (V4). `shown`: the shell switched pages, nothing reloads.
  windowMachine: {
    set: (id: string, request?: { route?: string }): Promise<{ id: string; shown?: boolean }> =>
      ipcRenderer.invoke('timon:window-machine', id, request?.route === undefined ? undefined : { route: request.route }),
  },
  // The light/dark mode this page paints, and the machine it was served for: the shell
  // paints the next window or page of that machine with it before it loads.
  windowScheme: (request: { scheme: 'light' | 'dark'; machineId?: string }): Promise<{ recorded: boolean }> =>
    ipcRenderer.invoke('timon:window-scheme', request),
  // The Dock icon (macOS): `get` resolves to null where there is no Dock; a page of another machine is refused.
  dockIcon: {
    get: (): Promise<{ icon: string } | null> => ipcRenderer.invoke('timon:dock-icon-get'),
    set: (icon: string): Promise<{ icon: string }> => ipcRenderer.invoke('timon:dock-icon-set', { icon }),
  },
  // The interface size of this screen, every window alike: a factor, snapped by the shell to one of `steps`.
  // `current`: the factor this page is laid out at now, read from Blink without a round trip.
  zoom: {
    current: (): number => webFrame.getZoomFactor(),
    get: (): Promise<{ factor: number; steps: number[] }> => ipcRenderer.invoke('timon:ui-zoom-get'),
    set: (factor: number): Promise<{ factor: number }> => ipcRenderer.invoke('timon:ui-zoom-set', { factor }),
    step: (direction: 'in' | 'out' | 'reset'): Promise<{ factor: number }> => ipcRenderer.invoke('timon:ui-zoom-step', { direction }),
    onChange: (listener: (factor: number) => void): (() => void) => {
      const forward = (_event: unknown, payload: unknown): void => {
        const factor = (payload as { factor?: unknown } | null)?.factor;
        if (typeof factor === 'number' && Number.isFinite(factor)) listener(factor);
      };
      ipcRenderer.on('timon:ui-zoom-changed', forward);
      return () => { ipcRenderer.removeListener('timon:ui-zoom-changed', forward); };
    },
  },
  // One more window on this window's machine, at a route of this interface (V5): a path, never a URL.
  openWindow: (request: { route: string; machineId?: string }): Promise<{ opened: boolean }> => ipcRenderer.invoke('timon:open-window', request),
  browser: {
    // `conversation`, `locale` and `scheme` tell the annotation bubble where to send and how to speak (TODO #481).
    attach: (request: { profileId: string; viewToken: string; bounds: { x: number; y: number; width: number; height: number };
      conversation?: { agent: string; mission: string | null }; locale?: string; scheme?: 'light' | 'dark' }): Promise<{ attached: boolean } | void> =>
      ipcRenderer.invoke('timon:browser-attach', request),
    detach: (): Promise<void> => ipcRenderer.invoke('timon:browser-detach'),
  },
  // A newer Timon (docs/AUTO-UPDATE.md P2, P3): the shell downloads and installs the
  // installer the local daemon verified. No URL, path or version crosses from the page.
  updates: {
    state: (): Promise<unknown> => ipcRenderer.invoke('timon:update-state'),
    start: (): Promise<unknown> => ipcRenderer.invoke('timon:update-start'),
    cancel: (): Promise<unknown> => ipcRenderer.invoke('timon:update-cancel'),
    open: (target: 'folder' | 'installer'): Promise<unknown> => ipcRenderer.invoke('timon:update-open', { target }),
    // P3: installs the verified file; `confirmed` = « install anyway » past running missions.
    install: (confirmed: boolean): Promise<unknown> => ipcRenderer.invoke('timon:update-install', { confirmed: confirmed === true }),
    onState: (listener: (state: unknown) => void): (() => void) => {
      const forward = (_event: unknown, payload: unknown): void => listener(payload);
      ipcRenderer.on('timon:update-event', forward);
      return () => { ipcRenderer.removeListener('timon:update-event', forward); };
    },
  },
  // The daemon decides which verified package; nothing crosses from the page.
  tailscale: {
    openInstaller: (): Promise<unknown> => ipcRenderer.invoke('timon:tailscale-installer'),
    openApp: (): Promise<unknown> => ipcRenderer.invoke('timon:tailscale-open-app'),
  },
});
