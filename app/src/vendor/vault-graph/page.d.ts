export interface VaultDiscNode {
  id: string;
  label: string;
  folder: string;
  dirs: string[];
  sub: string;
  type: string;
  tags: string[];
  created: string;
  touched: string;
  words: number;
  deg: number;
  ghost?: boolean;
}

export interface VaultDiscEdge {
  s: number;
  t: number;
  w: number;
}

export interface VaultDiscData {
  vault: string;
  generated: string;
  nodes: VaultDiscNode[];
  edges: VaultDiscEdge[];
  stats: {
    files: number;
    nodes: number;
    edges: number;
    unresolved: number;
    orphans: number;
    dates: { frontmatter: number; filename: number; stamp: number; none: number };
    templatesExcluded: boolean;
    ghostsIncluded: boolean;
  };
}

export interface VaultGraphApi {
  readTheme: () => void;
  renderer?: { refresh: () => void; kill: () => void };
  placeLogo?: () => void;
  heatBuild?: () => void;
}

export interface VaultGraphHandle {
  readonly api: VaultGraphApi | null;
  readonly ready: boolean;
  /**
   * Release everything the mount created: animation frames, observers, window and
   * document listeners, the renderer, the `__vg` global. Idempotent, and safe to call
   * before the deferred init has run -- which is the point of it living here rather
   * than on `api`, null for the first 20ms of the view's life.
   */
  destroy(): void;
}

export interface VaultGraphDeps {
  Graph: unknown;
  Sigma: unknown;
  rendering?: unknown;
  locale?: string;
  dictionary?: Record<string, string>;
  formatDate?: (value: string | number, kind: 'month' | 'weekday' | 'weekdayNarrow' | 'generated') => string;
  logoMask?: string;
  settingsUI?: boolean;
  folderColors?: Record<string, string>;
  folderShown?: Record<string, boolean>;
  onFolderColors?: (map: Record<string, string>) => void;
  onFolderShown?: (map: Record<string, boolean>) => void;
  panEnabled?: boolean;
  onPanEnabled?: (value: boolean) => void;
  onRefresh?: () => void;
  win?: Window;
  doc?: Document;
}

export function mountVaultGraph(
  root: HTMLElement,
  data: VaultDiscData,
  deps: VaultGraphDeps,
): VaultGraphHandle;
