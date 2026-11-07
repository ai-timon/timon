'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { Columns2, Copy, FilePlus, FolderOpen, FolderPlus, FolderSymlink, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { copyToClipboard } from '@/lib/clipboard';
import { desktopBridge } from '@/lib/desktop';
import { iconFor } from '@/lib/file-icons';
import { revealOnDesktop } from '@/lib/reveal-entry';
import { canDrop, inDir, parentDir, stemLength } from '@/lib/file-paths';
import { imagePathsIn } from '@/lib/file-preview/gallery';
import { previewKindFor } from '@/lib/file-preview/kind';
import { WIDGET_TOOLBAR, WIDGET_TOOLBAR_LABEL, WidgetButton } from '@/components/widget-toolbar';
import { fmtSize } from './chat-format';
import { FileContextMenu } from './file-context-menu';
import { fileViewer } from '@/lib/file-viewer';
import { ISLAND_OPEN_EDGES, openInIsland, useIslandBus } from '@/lib/island-bus';
import { startIslandDrag } from '@/lib/island-drag';
import { fileIslandContent } from './file-island';
import type { DirListing, FileBody, FileEntry } from './chat-types';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { apiErrorMessage } from '@/lib/api-error';

/* ─────────────────────────────────────────────────────────────────
   File browser — inline tree of the agent's working dir.
   Click a folder to expand it in place (indented), click a file to
   open it in the editor overlay with syntax highlighting. The viewer
   has an edit toggle that flips to a plain-text editor and exposes
   a Save button (PUT /api/agents/<name>/files?path=).
   ──────────────────────────────────────────────────────────────────── */

/** A name being typed in the tree: a row renamed in place, or a new entry under `dir`. */
type NameEdit =
  | { mode: 'rename'; path: string; kind: FileEntry['kind'] }
  | { mode: 'create'; dir: string; kind: 'file' | 'dir' };

/**
 * Extracted verbatim from `chat-client.tsx`, where it was the "Files" tab of
 * the `LeftSidebar`. The body has not changed: only its types, its size
 * formatter and its modal editor left the file before it.
 */
export function FileBrowser({ agentId }: { agentId: string }) {
  // Cached children per dir path ('' = root). Populated lazily when a
  // dir is expanded for the first time.
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Absolute path of the agent's folder, from the root listing ('' has no entry to carry it).
  const [rootAbs, setRootAbs] = useState<string | null>(null);
  // Every file opens as an island of the workspace (lib/file-viewer).
  // The folder the user is in: the last one clicked, or the one holding the
  // last file opened. New files and folders are created there ('' = root).
  const [activeDir, setActiveDir] = useState('');
  // Drag and drop: the entry being dragged and the folder under the pointer ('' = root).
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Right-click menu: the row it was opened on and where.
  const [menu, setMenu] = useState<{ path: string; kind: FileEntry['kind']; x: number; y: number } | null>(null);
  // Names are typed in the tree, never in window.prompt(): Electron does not
  // implement it, so the desktop app renamed and created nothing (TIM-0132).
  const [edit, setEdit] = useState<NameEdit | null>(null);
  // A file also drags into the island workspace of the view (§6). Its folders
  // stay drop targets: the workspace's layer only rises outside the tree.
  const bus = useIslandBus();
  const treeBox = useRef<HTMLDivElement>(null);
  const islandDrag = bus.present && !bus.narrow
    ? (ev: ReactDragEvent, rel: string) => {
      startIslandDrag(ev, fileIslandContent(agentId, rel), { label: rel.slice(rel.lastIndexOf('/') + 1), hold: treeBox.current });
    }
    : undefined;

  // Always fetch the root on mount / agent change.
  useEffect(() => {
    setChildren(new Map());
    setExpanded(new Set(['']));
    setActiveDir('');
    setEdit(null);
    setError(null);
    void fetchDir('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function fetchDir(rel: string): Promise<void> {
    setLoading((s) => new Set(s).add(rel));
    try {
      const qs = rel ? '?path=' + encodeURIComponent(rel) : '';
      const r = await fetch('/api/ui/agents/' + encodeURIComponent(agentId) + '/files' + qs);
      const j = await r.json();
      if (!r.ok || j.kind !== 'dir') {
        setError(apiErrorMessage(j, i18n('fileSurface.listFailed', { path: rel || '/' })));
        return;
      }
      const d = j as DirListing;
      setChildren((m) => new Map(m).set(rel, d.entries));
      if (rel === '' && d.abs) setRootAbs(d.abs);
      setError(null);
    } catch (e) {
      setError(i18n('fileSurface.requestFailed', { error: String(e) }));
    } finally {
      setLoading((s) => {
        const next = new Set(s);
        next.delete(rel);
        return next;
      });
    }
  }

  async function toggleDir(rel: string): Promise<void> {
    setActiveDir(rel);
    const isOpen = expanded.has(rel);
    setExpanded((s) => {
      const next = new Set(s);
      if (isOpen) next.delete(rel);
      else next.add(rel);
      return next;
    });
    if (!isOpen && !children.has(rel)) await fetchDir(rel);
  }

  async function openFile(rel: string): Promise<void> {
    setActiveDir(parentDir(rel));
    const kind = previewKindFor(rel);
    if (kind) {
      setError(null);
      const dir = parentDir(rel);
      fileViewer.openPreview(agentId, { path: rel, kind, images: kind === 'image' ? imagePathsIn(dir, children.get(dir)) : undefined });
      return;
    }
    setLoading((s) => new Set(s).add('file:' + rel));
    try {
      const r = await fetch(
        '/api/ui/agents/' + encodeURIComponent(agentId)
        + '/files?path=' + encodeURIComponent(rel),
      );
      const j = await r.json();
      if (!r.ok) {
        setError(apiErrorMessage(j, i18n('fileSurface.openFailed', { path: rel })));
        return;
      }
      fileViewer.openText(agentId, j as FileBody);
      setError(null);
    } catch (e) {
      setError(i18n('fileSurface.requestFailed', { error: String(e) }));
    } finally {
      setLoading((s) => {
        const next = new Set(s);
        next.delete('file:' + rel);
        return next;
      });
    }
  }

  /** After a successful save, refresh the file body so size/modified
   *  are accurate and we drop the dirty indicator. */
  async function reloadFile(rel: string): Promise<FileBody | null> {
    try {
      const r = await fetch(
        '/api/ui/agents/' + encodeURIComponent(agentId)
        + '/files?path=' + encodeURIComponent(rel),
      );
      const j = await r.json();
      if (!r.ok || j.kind !== 'file') return null;
      return j as FileBody;
    } catch { return null; }
  }

  /** Refresh the listing for the directory containing `rel`. */
  function refreshParent(rel: string) {
    const parts = rel.split('/');
    parts.pop();
    void fetchDir(parts.join('/'));
  }

  /** Reloads every listed directory (root + expanded ones) and the open file. */
  async function refreshAll(): Promise<void> {
    const dirs = ['', ...Array.from(expanded).filter((rel) => rel !== '')];
    await Promise.all(dirs.map((rel) => fetchDir(rel)));
  }

  /** Opens a name field at the top of the current folder, unfolding it and its parents. */
  function startCreate(kind: 'file' | 'dir') {
    const dir = activeDir;
    setExpanded((s) => {
      const next = new Set(s);
      let at = dir;
      while (at) { next.add(at); at = parentDir(at); }
      return next;
    });
    if (!children.has(dir)) void fetchDir(dir);
    setEdit({ mode: 'create', dir, kind });
  }

  async function createFile(dir: string, typed: string) {
    const path = inDir(dir, typed);
    const r = await fetch('/api/ui/agents/' + encodeURIComponent(agentId) + '/files?path=' + encodeURIComponent(path), { method: 'POST' });
    const j = await r.json();
    if (!r.ok) { setError(apiErrorMessage(j, i18n('fileSurface.createFileFailed'))); return; }
    refreshParent(path);
    fileViewer.openText(agentId, { kind: 'file', path, size: 0, modified: Date.now(), binary: false, truncated: false, content: '' }, 'edit');
  }

  async function createDir(dir: string, typed: string) {
    const path = inDir(dir, typed);
    const r = await fetch('/api/ui/agents/' + encodeURIComponent(agentId) + '/files?path=' + encodeURIComponent(path) + '&action=mkdir', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) { setError(apiErrorMessage(j, i18n('fileSurface.createFolderFailed'))); return; }
    refreshParent(path);
    setExpanded((s) => new Set(s).add(path));
  }

  /** The name field was left with `typed` (already trimmed, never empty). */
  function commitName(target: NameEdit, typed: string) {
    setEdit(null);
    if (target.mode === 'rename') void renameEntry(target.path, typed);
    else if (target.kind === 'file') void createFile(target.dir, typed);
    else void createDir(target.dir, typed);
  }

  /** Opens the location in the desktop's file manager. The daemon opens it
   *  when it has a desktop session; otherwise the Electron client does, from
   *  the user's own session. A plain browser against a daemon with no session
   *  is told the file is on the daemon's machine. */
  async function revealEntry(rel: string) {
    const outcome = await revealOnDesktop({ agentId, path: rel, bridge: desktopBridge() });
    if (outcome.status === 'opened') toast.success(i18n('chatPage.openedInExplorer', { path: rel || '/' }));
    else if (outcome.status === 'no-desktop') toast.error(i18n('chatPage.revealNoDesktop'));
    else toast.error(outcome.message || i18n('chatPage.openFailed'));
  }

  /** Absolute path of a row, as the daemon built it (the client never joins host paths). */
  function absOf(rel: string): string | null {
    if (rel === '') return rootAbs;
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    return children.get(parentDir(rel))?.find((e) => e.name === name)?.abs ?? null;
  }

  async function copyPath(text: string | null) {
    const ok = text !== null && await copyToClipboard(text);
    if (ok) toast.success(i18n('chatPage.fileMenu.pathCopied'));
    else toast.error(i18n('chatPage.fileMenu.pathCopyFailed'));
  }

  async function deleteEntry(rel: string) {
    if (!(await confirmAction({ title: i18n('confirmDialog.deleteFile', { path: rel }), confirmLabel: i18n('confirmDialog.delete'), destructive: true }))) return;
    const r = await fetch('/api/ui/agents/' + encodeURIComponent(agentId) + '/files?path=' + encodeURIComponent(rel), { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) { setError(apiErrorMessage(j, i18n('fileSurface.deleteFailed'))); return; }
    fileViewer.closeUnder(rel, agentId);
    refreshParent(rel);
  }

  async function renameEntry(rel: string, typed: string) {
    if (typed === rel.slice(rel.lastIndexOf('/') + 1)) return;
    const r = await fetch(
      '/api/ui/agents/' + encodeURIComponent(agentId) + '/files?path=' + encodeURIComponent(rel)
      + '&action=rename&name=' + encodeURIComponent(typed),
      { method: 'POST' },
    );
    const j = await r.json();
    if (!r.ok) { setError(apiErrorMessage(j, i18n('fileSurface.renameFailed'))); return; }
    setError(null);
    // What was open under the old name points nowhere now; the folders listed under it too.
    fileViewer.closeUnder(rel, agentId);
    setExpanded((s) => new Set([...s].filter((d) => d !== rel && !d.startsWith(rel + '/'))));
    refreshParent(rel);
  }

  /** Moves `from` into the folder `toDir`, after a confirmation (a slip of the mouse must not reorganise a project). */
  async function moveEntry(from: string, toDir: string) {
    setDragging(null);
    setDropTarget(null);
    if (!canDrop(from, toDir)) return;
    if (!(await confirmAction({ title: toDir ? i18n('confirmDialog.moveFile', { from, to: toDir }) : i18n('confirmDialog.moveFileToRoot', { from }), confirmLabel: i18n('confirmDialog.move') }))) return;
    const r = await fetch(
      '/api/ui/agents/' + encodeURIComponent(agentId) + '/files?path=' + encodeURIComponent(from)
      + '&action=move&to=' + encodeURIComponent(toDir),
      { method: 'POST' },
    );
    const j = await r.json();
    if (!r.ok) { setError(apiErrorMessage(j, i18n('fileSurface.moveFailed'))); return; }
    setError(null);
    // The open file or preview would point at a path that no longer exists.
    fileViewer.closeUnder(from, agentId);
    // Folders already listed under the moved one are stale too.
    setExpanded((s) => {
      const next = new Set([...s].filter((d) => d !== from && !d.startsWith(from + '/')));
      if (toDir) next.add(toDir);
      return next;
    });
    refreshParent(from);
    void fetchDir(toDir);
  }

  /** "Open in a split" (§11): beside the focused island, or in a tab of it; one entry below 768 px. */
  function splitItem(rel: string) {
    const icon = <Columns2 className="size-4" aria-hidden />;
    const open = (edge: (typeof ISLAND_OPEN_EDGES)[number]) => { openInIsland(fileIslandContent(agentId, rel), { edge }); };
    if (bus.narrow) return { key: 'split', label: i18n('islands.openIn.narrow'), icon, onSelect: () => open('center') };
    return {
      key: 'split',
      label: i18n('islands.openIn.menu'),
      icon,
      onSelect: () => {},
      submenu: ISLAND_OPEN_EDGES.map((edge) => ({ key: edge, label: i18n(`islands.openIn.${edge}`), icon, onSelect: () => open(edge) })),
    };
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={WIDGET_TOOLBAR}>
        <span className={WIDGET_TOOLBAR_LABEL}>{agentId}/</span>
        <WidgetButton onClick={() => void revealEntry('')} title={i18n('chatPage.openRootInExplorer')} aria-label={i18n('chatPage.openRootInExplorer')} icon={<FolderSymlink className="size-3.5" />} />
        <WidgetButton onClick={() => void refreshAll()} title={i18n('chatPage.refreshFiles')} aria-label={i18n('chatPage.refreshFiles')} icon={<RefreshCw className="size-3.5" />} />
        <WidgetButton onClick={() => startCreate('file')} title={i18n('fileSurface.newFile')} aria-label={i18n('fileSurface.newFile')} icon={<FilePlus className="size-3.5" />} />
        <WidgetButton onClick={() => startCreate('dir')} title={i18n('fileSurface.newFolder')} aria-label={i18n('fileSurface.newFolder')} icon={<FolderPlus className="size-3.5" />} />
      </div>
      <div
        ref={treeBox}
        className={cn('flex-1 overflow-auto py-1', dragging && dropTarget === '' && 'bg-primary/5')}
        // Dropping on the empty area (or a file row) moves the entry to the root.
        onDragOver={(ev) => {
          if (dragging && canDrop(dragging, '')) { ev.preventDefault(); setDropTarget(''); }
        }}
        onDragLeave={(ev) => { if (ev.currentTarget === ev.target) setDropTarget(null); }}
        onDrop={(ev) => { ev.preventDefault(); if (dragging) void moveEntry(dragging, ''); }}
      >
        {error && (
          <div className="mx-1.5 my-1 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {error}
          </div>
        )}
        <FileTreeLevel
          path=""
          depth={0}
          children={children}
          expanded={expanded}
          loading={loading}
          onToggle={toggleDir}
          onOpen={openFile}
          onDelete={deleteEntry}
          onReveal={revealEntry}
          dnd={{ dragging, setDragging, dropTarget, setDropTarget, onMove: moveEntry, island: islandDrag }}
          onMenu={(path, kind, x, y) => setMenu({ path, kind, x, y })}
          edit={{ state: edit, commit: commitName, cancel: () => setEdit(null) }}
        />
      </div>
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.path}
          onClose={() => setMenu(null)}
          items={[
            menu.kind === 'dir'
              ? { key: 'open', label: i18n('chatPage.fileMenu.open'), icon: <FolderOpen className="size-4" aria-hidden />, onSelect: () => void toggleDir(menu.path) }
              : { key: 'open', label: i18n('chatPage.fileMenu.open'), icon: <FolderOpen className="size-4" aria-hidden />, onSelect: () => void openFile(menu.path) },
            ...(menu.kind === 'file' && bus.present ? [splitItem(menu.path)] : []),
            { key: 'copy-path', label: i18n('chatPage.fileMenu.copyPath'), icon: <Copy className="size-4" aria-hidden />, onSelect: () => void copyPath(absOf(menu.path)) },
            { key: 'copy-rel-path', label: i18n('chatPage.fileMenu.copyRelativePath'), icon: <Copy className="size-4" aria-hidden />, onSelect: () => void copyPath(menu.path || '.') },
            { key: 'rename', label: i18n('chatPage.fileMenu.rename'), icon: <Pencil className="size-4" aria-hidden />, onSelect: () => setEdit({ mode: 'rename', path: menu.path, kind: menu.kind }) },
            { key: 'reveal', label: i18n('chatPage.fileMenu.reveal'), icon: <FolderSymlink className="size-4" aria-hidden />, onSelect: () => void revealEntry(menu.path) },
            { key: 'delete', label: i18n('chatPage.fileMenu.delete'), icon: <Trash2 className="size-4" aria-hidden />, danger: true, onSelect: () => void deleteEntry(menu.path) },
          ]}
        />
      )}
    </div>
  );
}

/** Render the children of a directory at a given depth. Recurses for
 *  each expanded subdir so the whole tree lives in one scrollable list
 *  with consistent left-padding per level. */
function FileTreeLevel({
  path,
  depth,
  children,
  expanded,
  loading,
  onToggle,
  onOpen,
  onDelete,
  onReveal,
  dnd,
  onMenu,
  edit,
}: {
  path: string;
  depth: number;
  children: Map<string, FileEntry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  onToggle: (rel: string) => void;
  onOpen: (rel: string) => void;
  onDelete?: (rel: string) => void;
  onReveal?: (rel: string) => void;
  onMenu: (rel: string, kind: FileEntry['kind'], x: number, y: number) => void;
  dnd: {
    dragging: string | null;
    setDragging: (rel: string | null) => void;
    dropTarget: string | null;
    setDropTarget: (rel: string | null) => void;
    onMove: (from: string, toDir: string) => void;
    /** Set while a file may be dragged into the island workspace. */
    island?: (ev: ReactDragEvent, rel: string) => void;
  };
  edit: {
    state: NameEdit | null;
    commit: (target: NameEdit, typed: string) => void;
    cancel: () => void;
  };
}) {
  const entries = children.get(path);
  const editing = edit.state;
  // A new entry is typed at the top of the folder it will land in.
  const creating = editing?.mode === 'create' && editing.dir === path ? editing : null;
  const createRow = creating && (() => {
    const { Icon, tint } = iconFor('', creating.kind, false);
    return (
      <div className="flex items-center gap-1.5 px-1.5 py-[3px]" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="w-3 shrink-0" />
        <Icon className={cn('size-4 shrink-0', tint)} />
        <NameInput
          initial=""
          kind={creating.kind}
          label={i18n(creating.kind === 'file' ? 'chatPage.fileMenu.newFileLabel' : 'chatPage.fileMenu.newFolderLabel', { dir: path || '/' })}
          onCommit={(typed) => edit.commit(creating, typed)}
          onCancel={edit.cancel}
        />
      </div>
    );
  })();
  if (!entries) {
    if (createRow) return createRow;
    return loading.has(path) ? (
      <div
        className="py-1 text-[11px] text-muted-foreground/70"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {i18n('fileSurface.loading')}
      </div>
    ) : null;
  }
  if (entries.length === 0) {
    if (createRow) return createRow;
    return (
      <div
        className="py-1 text-[11px] italic text-muted-foreground/60"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {i18n('fileSurface.empty')}
      </div>
    );
  }
  return (
    <>
      {createRow}
      {entries.map((e) => {
        const fullPath = path ? path + '/' + e.name : e.name;
        const isOpen = e.kind === 'dir' && expanded.has(fullPath);
        const { Icon, tint } = iconFor(e.name, e.kind, isOpen);
        const renaming = editing?.mode === 'rename' && editing.path === fullPath ? editing : null;
        return (
          <Fragment key={fullPath}>
            <div
              className={cn(
                'group relative flex items-center',
                e.kind === 'dir' && dnd.dropTarget === fullPath && 'bg-primary/15 ring-1 ring-primary/40',
              )}
              // A draggable row would turn a mouse selection in the name field into a drag.
              draggable={!renaming}
              onContextMenu={(ev) => { ev.preventDefault(); onMenu(fullPath, e.kind, ev.clientX, ev.clientY); }}
              onDragStart={(ev) => {
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', fullPath);
                dnd.setDragging(fullPath);
                // Added after the tree's own type, which moves the file into a folder.
                if (e.kind === 'file') dnd.island?.(ev, fullPath);
              }}
              onDragEnd={() => { dnd.setDragging(null); dnd.setDropTarget(null); }}
              onDragOver={e.kind === 'dir' ? (ev) => {
                if (dnd.dragging && canDrop(dnd.dragging, fullPath)) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  dnd.setDropTarget(fullPath);
                }
              } : undefined}
              onDrop={e.kind === 'dir' ? (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (dnd.dragging) dnd.onMove(dnd.dragging, fullPath);
              } : undefined}
            >
              {renaming ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-[3px]" style={{ paddingLeft: 8 + depth * 14 }}>
                  <span className="w-3 shrink-0 text-center text-muted-foreground/50">
                    {e.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}
                  </span>
                  <Icon className={cn('size-4 shrink-0', tint)} />
                  <NameInput
                    initial={e.name}
                    kind={e.kind}
                    label={i18n('chatPage.fileMenu.renameLabel', { name: e.name })}
                    onCommit={(typed) => edit.commit(renaming, typed)}
                    onCancel={edit.cancel}
                  />
                </div>
              ) : (
              <button
                type="button"
                onClick={() => (e.kind === 'dir' ? onToggle(fullPath) : onOpen(fullPath))}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-[3px] text-left text-[12px] transition-colors hover:bg-muted/50"
                style={{ paddingLeft: 8 + depth * 14 }}
              >
                <span className="w-3 shrink-0 text-center text-muted-foreground/50">
                  {e.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}
                </span>
                <Icon className={cn('size-4 shrink-0', tint)} />
                <span
                  title={e.name}
                  className={cn(
                    'flex-1 truncate',
                    e.kind === 'dir' ? 'font-medium text-foreground' : 'text-foreground/85',
                    e.kind === 'symlink' && 'italic text-muted-foreground',
                  )}
                >
                  {e.name}
                </span>
                {e.kind === 'file' && (
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/60">
                    {fmtSize(e.size)}
                  </span>
                )}
              </button>
              )}
              {onReveal && !renaming && (
                <button
                  type="button"
                  title={i18n('chatPage.openInSystemExplorer', { name: e.name })}
                  onClick={(ev) => { ev.stopPropagation(); onReveal(fullPath); }}
                  className="mr-0.5 grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                >
                  <FolderSymlink className="size-3" />
                </button>
              )}
              {onDelete && !renaming && (
                <button
                  type="button"
                  title={i18n('fileSurface.deleteEntry', { name: e.name })}
                  onClick={(ev) => { ev.stopPropagation(); onDelete(fullPath); }}
                  className="mr-1 grid size-5 shrink-0 place-items-center rounded text-destructive opacity-0 hover:bg-destructive/10 group-hover:opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
            {isOpen && (
              <FileTreeLevel
                path={fullPath}
                depth={depth + 1}
                children={children}
                expanded={expanded}
                loading={loading}
                onToggle={onToggle}
                onOpen={onOpen}
                onDelete={onDelete}
                onReveal={onReveal}
                dnd={dnd}
                onMenu={onMenu}
                edit={edit}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * The name field of a row renamed or created in place. Enter or leaving the
 * field commits, Escape cancels; a blank or unchanged name changes nothing.
 */
function NameInput({ initial, kind, label, onCommit, onCancel }: {
  initial: string;
  kind: FileEntry['kind'];
  label: string;
  onCommit: (typed: string) => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  // Enter unmounts the field, which may blur it: the name is sent once.
  const settled = useRef(false);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, stemLength(initial, kind));
    // Mount only: the selection is set once, then belongs to the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function settle(commit: boolean) {
    if (settled.current) return;
    settled.current = true;
    const typed = field.current?.value.trim() ?? '';
    if (commit && typed && typed !== initial) onCommit(typed);
    else onCancel();
  }

  return (
    <input
      ref={field}
      defaultValue={initial}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      // The row's own menu would cover the field's cut / copy / paste.
      onContextMenu={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        // Keys typed in the name belong to it, not to a shortcut of the page.
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); settle(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); settle(false); }
      }}
      onBlur={() => settle(true)}
      className="min-w-0 flex-1 rounded-sm bg-background px-1 text-[12px] text-foreground outline-none ring-1 ring-primary/60"
    />
  );
}
