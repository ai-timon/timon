'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Plus,
  Search,
  Trash2,
  ChevronDown,
  ChevronRight,
  Server,
  Cloud,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Slot, useSlotEntries } from '@/lib/plugin-host/render';
import { PageTocLayout } from '@/components/page-toc/page-toc';
import { MCP_FEATURED_SLOT, McpTabProvider } from '@/lib/mcp-tab-context';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { apiErrorMessage, responseErrorMessage } from '@/lib/api-error';

type Transport = 'stdio' | 'http' | 'external';

type OAuthStatus = 'none' | 'pending' | 'authorized' | 'expired';

type Summary = {
  id: string;
  name?: string;
  description?: string;
  transport_type: Transport;
  tools_count: number;
  tools_cache?: string[];
  last_status?: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown';
  last_seen_at?: number;
  oauth_status?: OAuthStatus;
  source?: 'timon' | 'claude_ai' | 'claude_cli';
  /** Agents are not given the server: it needs the secrets vault, which is off. */
  held_back?: 'vault_off';
};

type StdioConfig = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type HttpConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};

type Detail = Summary & { transport: StdioConfig | HttpConfig };

type EditorState = {
  id: string;
  name: string;
  description: string;
  transport: Transport;
  // stdio
  command: string;
  argsText: string;
  envText: string;
  // http
  url: string;
  headersText: string;
};

const BLANK_EDITOR: EditorState = {
  id: '',
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
};

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function kvToLines(o?: Record<string, string>): string {
  return Object.entries(o || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function detailToEditor(d: Detail): EditorState {
  if (d.transport.type === 'stdio') {
    return {
      ...BLANK_EDITOR,
      id: d.id,
      name: d.name || '',
      description: d.description || '',
      transport: 'stdio',
      command: d.transport.command,
      argsText: (d.transport.args || []).join('\n'),
      envText: kvToLines(d.transport.env),
    };
  }
  return {
    ...BLANK_EDITOR,
    id: d.id,
    name: d.name || '',
    description: d.description || '',
    transport: 'http',
    url: d.transport.url,
    headersText: kvToLines(d.transport.headers),
  };
}

function StatusBadge({ status }: { status?: Summary['last_status'] }) {
  if (!status) return null;
  const map = {
    connected: {
      label: t('mcpPage.status.connected'),
      Icon: CheckCircle2,
      cls: 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]',
    },
    'needs-auth': {
      label: t('mcpPage.status.needsAuth'),
      Icon: AlertCircle,
      cls: 'border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]',
    },
    failed: {
      label: t('mcpPage.status.failed'),
      Icon: AlertCircle,
      cls: 'border-destructive/30 bg-destructive/10 text-destructive',
    },
    pending: {
      label: t('mcpPage.status.pending'),
      Icon: HelpCircle,
      cls: 'border-border bg-muted text-muted-foreground',
    },
    unknown: {
      label: t('mcpPage.status.unknown'),
      Icon: HelpCircle,
      cls: 'border-border bg-muted text-muted-foreground',
    },
  } as const;
  // Defensive: the backend can surface statuses outside this union
  // (e.g. claude.ai connectors report "pending"); never destructure undefined.
  const { label, Icon, cls } = map[status] ?? map.unknown;
  return (
    <Badge variant="outline" className={cn('gap-1.5 border font-normal', cls)}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}

async function startOAuth(id: string): Promise<void> {
  const r = await fetch(`/api/ui/mcp/${encodeURIComponent(id)}/oauth/start`, {
    method: 'POST',
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.authorize_url) {
    toast.error(t('mcpPage.oauthStartFailed', { error: apiErrorMessage(j, r.statusText || { status: r.status }).slice(0, 120) }));
    return;
  }
  const w = window.open(j.authorize_url, '_blank', 'noopener,noreferrer');
  if (!w) toast.info(t('mcpPage.popupBlocked', { url: j.authorize_url }));
}

/** `leading` opens the toolbar row: the Capabilities page puts its tabs there. */
export function McpClient({ leading }: { leading?: ReactNode } = {}) {
  const [servers, setServers] = useState<Summary[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorState>(BLANK_EDITOR);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const idInputRef = useRef<HTMLInputElement>(null);
  const [editingOAuthStatus, setEditingOAuthStatus] = useState<OAuthStatus>('none');
  const featured = useSlotEntries(MCP_FEATURED_SLOT).length > 0;
  const tabValue = useMemo(() => ({ query }), [query]);

  async function refresh() {
    try {
      const r = await fetch('/api/ui/mcp', { cache: 'no-store' });
      const j = r.ok ? await r.json() : { servers: [] };
      setServers(j.servers || []);
    } catch {
      setServers([]);
    }
  }

  useEffect(() => {
    refresh();
    // Tools-cache refreshes on agent spawn; poll lightly to surface updates.
    const id = setInterval(refresh, 10000);
    // Listen for the OAuth callback page broadcasting completion.
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('timon-mcp-oauth');
      bc.onmessage = (ev) => {
        const m = ev.data as { ok?: boolean; mcpId?: string; error?: string };
        if (m?.ok) toast.success(t('mcpPage.authorizedServer', { id: m.mcpId || '' }));
        else if (m?.error) toast.error(t('mcpPage.oauthFailed', { error: String(m.error).slice(0, 120) }));
        refresh();
      };
    } catch { /* not supported, the redirect-back path handles it */ }
    // Surface ?oauth=success|error from the post-redirect bounce.
    const url = new URL(window.location.href);
    // `?new=1` (a link to "add a server") opens the editor at once.
    if (url.searchParams.get('new') === '1') {
      url.searchParams.delete('new');
      window.history.replaceState(null, '', url.toString());
      void openEditor(null);
    }
    const o = url.searchParams.get('oauth');
    if (o === 'success') toast.success(t('mcpPage.authorized'));
    else if (o === 'error') toast.error(t('mcpPage.oauthFailed', { error: url.searchParams.get('error') || t('apiErrors.unknown') }));
    if (o) {
      url.searchParams.delete('oauth');
      url.searchParams.delete('id');
      url.searchParams.delete('error');
      window.history.replaceState(null, '', url.toString());
    }
    return () => { clearInterval(id); bc?.close(); };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.name || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q),
    );
  }, [servers, query]);

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function openEditor(id: string | null) {
    if (!id) {
      setEditing(null);
      setDraft(BLANK_EDITOR);
      setEditingOAuthStatus('none');
    } else {
      try {
        const r = await fetch(`/api/ui/mcp/${encodeURIComponent(id)}`);
        if (!r.ok) {
          toast.error(t('apiErrors.mcp_not_found'));
          return;
        }
        const d: Detail & { transport: HttpConfig & { oauth?: { tokens?: { expires_at?: number; refresh_token?: string } } } } = await r.json();
        setEditing(id);
        setDraft(detailToEditor(d));
        // Compute editing oauth status for the dialog (mirrors backend logic).
        if (d.transport.type === 'http' && d.transport.oauth) {
          const tok = d.transport.oauth.tokens;
          if (!tok) setEditingOAuthStatus('pending');
          else if (tok.expires_at && tok.expires_at < Date.now() && !tok.refresh_token)
            setEditingOAuthStatus('expired');
          else setEditingOAuthStatus('authorized');
        } else {
          setEditingOAuthStatus('none');
        }
      } catch {
        toast.error(t('mcpPage.loadFailed'));
        return;
      }
    }
    setOpen(true);
    setTimeout(() => idInputRef.current?.focus(), 60);
  }

  async function save() {
    const id = draft.id.trim();
    if (!/^[a-z0-9._-]+$/.test(id)) {
      toast.error(t('mcpPage.invalidId'));
      return;
    }
    const body: {
      id: string;
      name?: string;
      description?: string;
      transport: StdioConfig | HttpConfig;
    } = {
      id,
      name: draft.name.trim() || undefined,
      description: draft.description.trim() || undefined,
      transport:
        draft.transport === 'stdio'
          ? {
              type: 'stdio',
              command: draft.command.trim(),
              args: parseLines(draft.argsText),
              env: parseKv(draft.envText),
            }
          : { type: 'http', url: draft.url.trim(), headers: parseKv(draft.headersText) },
    };
    if (body.transport.type === 'stdio' && !body.transport.command) {
      toast.error(t('mcpPage.commandRequired'));
      return;
    }
    if (body.transport.type === 'http' && !body.transport.url) {
      toast.error(t('mcpPage.urlRequired'));
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/ui/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await responseErrorMessage(r));
      toast.success(t('mcpPage.saved', { id }));
      setOpen(false);
      await refresh();
    } catch (e) {
      toast.error(t('mcpPage.saveFailed', { error: String((e as Error).message || e).slice(0, 80) }));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing) return;
    if (!(await confirmAction({ title: t('confirmDialog.deleteMcp', { name: editing }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    const r = await fetch(`/api/ui/mcp/${encodeURIComponent(editing)}`, {
      method: 'DELETE',
    });
    if (r.ok) {
      toast.success(t('mcpPage.deleted', { id: editing }));
      setOpen(false);
      await refresh();
    } else {
      toast.error(t('mcpPage.deleteFailed', { error: await responseErrorMessage(r) }));
    }
  }

  return (
    <>
      <div className={cn('flex flex-wrap items-center gap-2 pb-4', !leading && 'mt-5')}>
        {leading}
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-[12.5px]">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('mcpPage.searchPlaceholder')}
            className="border-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <div className="flex-1" />
        <span className="tabular-nums text-[12.5px] text-muted-foreground">
          {t('mcpPage.serverCount', { count: servers.length })}
        </span>
        <Button
          size="sm"
          onClick={() => openEditor(null)}
          className="h-8 gap-1.5 font-semibold"
        >
          <Plus className="size-3.5" /> {t('mcpPage.newMcp')}
        </Button>
      </div>

      {/* The official connectors (and any plugin's section) come first: they are
          the one-click way in; the user's own servers follow. */}
      <PageTocLayout>
        <McpTabProvider value={tabValue}>
          <Slot name={MCP_FEATURED_SLOT} />
        </McpTabProvider>
        {featured && (
          <h2
            id="mcp-your-servers"
            data-toc={t('mcpTab.yourServers')}
            data-toc-count={visible.length}
            className="m-0 mt-8 text-[18px] font-semibold -tracking-[0.01em]"
          >
            {t('mcpTab.yourServers')}
          </h2>
        )}

        {visible.length ? (
          <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 2xl:grid-cols-3">
            {visible.map((s) => {
              const isOpen = expanded.has(s.id);
              const isExternal = s.source === 'claude_ai' || s.source === 'claude_cli' || s.transport_type === 'external';
              // Only a server claude names `claude.ai <X>` is an account connector;
              // the rest comes from the user's own claude configuration (TIM-0088).
              const externalKind = s.source === 'claude_ai' ? 'claudeAi' : 'claudeCli';
              const Icon = s.transport_type === 'stdio' ? Server : Cloud;
              return (
                <article
                  key={s.id}
                  className={cn(
                    'flex flex-col gap-2.5 rounded-xl border bg-card px-4 py-3.5',
                    isExternal ? 'border-dashed border-muted-foreground/30' : 'border-border',
                  )}
                >
                  <header className="flex items-start gap-2.5">
                    <button
                      type="button"
                      onClick={() => !isExternal && openEditor(s.id)}
                      className={cn('flex-1 text-left', isExternal && 'cursor-default')}
                      title={isExternal ? t(`mcpPage.external.${externalKind}.readOnly`) : undefined}
                    >
                      <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                        <Icon className="size-3.5 text-muted-foreground" />
                        {s.name || s.id}
                      </div>
                      {s.name && s.name !== s.id && (
                        <div className="mt-0.5 text-[10.5px] text-muted-foreground/70">
                          {s.id}
                        </div>
                      )}
                    </button>
                    {isExternal ? (
                      <Badge
                        variant="outline"
                        className="border-muted-foreground/30 bg-muted/30 font-normal text-muted-foreground"
                        title={t(`mcpPage.external.${externalKind}.hint`)}
                      >
                        {t(`mcpPage.external.${externalKind}.badge`)}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className={cn(
                          'font-normal',
                          s.transport_type === 'stdio'
                            ? 'border-[hsl(var(--info)/0.3)] bg-[hsl(var(--info)/0.06)] text-[hsl(var(--info))]'
                            : 'border-primary/30 bg-primary/10 text-primary',
                        )}
                      >
                        {s.transport_type}
                      </Badge>
                    )}
                  </header>
                  {s.description && (
                    <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      {s.description}
                    </p>
                  )}
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={s.last_status} />
                    <OAuthPill status={s.oauth_status} />
                    <HeldBackPill heldBack={s.held_back} />
                    <button
                      type="button"
                      onClick={() => toggleExpand(s.id)}
                      className={cn(
                        'ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-1.5 py-0.5 tabular-nums text-[10.5px] transition-colors',
                        'hover:border-muted-foreground/30',
                      )}
                    >
                      {isOpen ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                      {t('mcpPage.toolCount', { count: s.tools_count })}
                    </button>
                  </div>
                  {isOpen && (
                    <ToolList id={s.id} fallback={s.tools_cache} />
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-border p-10 text-center text-[13px] text-muted-foreground/80">
            {t('mcpPage.emptyBefore')}{' '}
            <strong className="text-foreground">{t('mcpPage.newMcp')}</strong>{' '}
            {t('mcpPage.emptyAfter')}
          </div>
        )}
      </PageTocLayout>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88vh] max-w-[760px] gap-0 overflow-hidden p-0">
          <DialogHeader className="flex-col gap-1 space-y-0 px-5 py-4">
            <div className="flex items-center gap-3">
              <Input
                ref={idInputRef}
                value={draft.id}
                disabled={editing !== null}
                onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
                placeholder="my-mcp-id" // i18n-exempt: sample identifier
                className="h-8 w-56 font-semibold"
              />
              <Badge variant={editing ? 'default' : 'secondary'}>
                {editing ? t('mcpPage.editor.editing') : t('mcpPage.editor.new')}
              </Badge>
            </div>
            <p className="text-[11.5px] text-muted-foreground/80">
              {t('mcpPage.editor.idHintFile')}
              <code /* code-font: file path */ className="mx-1 font-mono">~/.timon/mcp/&lt;id&gt;.json</code>
              {t('mcpPage.editor.idHintReference')} <code /* code-font: config key */ className="font-mono">mcp_servers</code>{' '}
              {t('mcpPage.editor.idHintAllowed')} <code /* code-font: character set */ className="font-mono">a-z 0-9 . _ -</code>
            </p>
            <DialogTitle className="sr-only">
              {editing ? t('mcpPage.editor.editTitle', { id: editing }) : t('mcpPage.editor.newTitle')}
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-auto px-5 py-5">
            <div className="flex flex-col gap-4">
              <div className="grid gap-1.5">
                <label className="text-[12px] font-semibold text-muted-foreground">
                  {t('mcpPage.editor.displayName')}
                </label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder={t('mcpPage.editor.displayNamePlaceholder')}
                />
                <p className="text-[11px] text-muted-foreground/70">
                  {t('mcpPage.editor.displayNameHintKey')}
                  <code /* code-font: file name */ className="mx-1 font-mono">.mcp.json</code>
                  {t('mcpPage.editor.displayNameHintTools')} <code /* code-font: tool name pattern */ className="font-mono">mcp__&lt;name&gt;__&lt;tool&gt;</code>.{' '}
                  {t('mcpPage.editor.displayNameHintFallback')}
                </p>
              </div>
              <div className="grid gap-1.5">
                <label className="text-[12px] font-semibold text-muted-foreground">
                  {t('mcpPage.editor.description')}
                </label>
                <Textarea
                  value={draft.description}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, description: e.target.value }))
                  }
                  className="min-h-[60px]"
                  placeholder={t('mcpPage.editor.descriptionPlaceholder')}
                />
              </div>

              <Tabs
                value={draft.transport}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, transport: v as Transport }))
                }
              >
                <TabsList className="grid w-fit grid-cols-2">
                  <TabsTrigger value="stdio" className="gap-1.5">
                    <Server className="size-3.5" /> {t('mcpPage.editor.stdioTab')}
                  </TabsTrigger>
                  <TabsTrigger value="http" className="gap-1.5">
                    <Cloud className="size-3.5" /> {t('mcpPage.editor.httpTab')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="stdio" className="mt-3 space-y-3">
                  <div className="grid gap-1.5">
                    <label className="text-[12px] font-semibold text-muted-foreground">
                      {t('mcpPage.editor.command')}
                    </label>
                    <Input
                      /* code-font: shell command */ className="font-mono"
                      value={draft.command}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, command: e.target.value }))
                      }
                      placeholder="npx" // i18n-exempt: sample command
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-[12px] font-semibold text-muted-foreground">
                      {t('mcpPage.editor.arguments')} <span className="text-muted-foreground/60">{t('mcpPage.editor.argumentsHint')}</span>
                    </label>
                    <Textarea
                      /* code-font: command arguments */ className="min-h-[90px] font-mono text-[12px]"
                      value={draft.argsText}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, argsText: e.target.value }))
                      }
                      // i18n-exempt: sample arguments
                      placeholder={`-y\n@modelcontextprotocol/server-filesystem\n/workspace`}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <label className="text-[12px] font-semibold text-muted-foreground">
                      {t('mcpPage.editor.environment')} <span className="text-muted-foreground/60">{t('mcpPage.editor.environmentHint')}</span>
                    </label>
                    <Textarea
                      /* code-font: environment variables */ className="min-h-[70px] font-mono text-[12px]"
                      value={draft.envText}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, envText: e.target.value }))
                      }
                      // i18n-exempt: sample environment
                      placeholder={`NODE_ENV=production\nAPI_KEY=...`}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="http" className="mt-3 space-y-3">
                  <div className="grid gap-1.5">
                    <label className="text-[12px] font-semibold text-muted-foreground">
                      {t('mcpPage.editor.url')}
                    </label>
                    <Input
                      /* code-font: URL */ className="font-mono"
                      value={draft.url}
                      onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                      placeholder="https://api.example.com/mcp" // i18n-exempt: sample URL
                    />
                  </div>
                  {editing && (
                    <OAuthBlock
                      id={editing}
                      status={editingOAuthStatus}
                      onAfterStart={async () => { await refresh(); }}
                    />
                  )}
                  {!editing && (
                    <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground/80">
                      {t('mcpPage.editor.saveBeforeOAuth')}
                    </p>
                  )}
                  <div className="grid gap-1.5">
                    <label className="text-[12px] font-semibold text-muted-foreground">
                      {t('mcpPage.editor.headers')} <span className="text-muted-foreground/60">{t('mcpPage.editor.headersHint')}</span>
                    </label>
                    <Textarea
                      /* code-font: HTTP headers */ className="min-h-[90px] font-mono text-[12px]"
                      value={draft.headersText}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, headersText: e.target.value }))
                      }
                      // i18n-exempt: sample headers
                      placeholder={`Authorization=Bearer xxx\nX-Custom-Header=value`}
                    />
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>

          <DialogFooter className="bg-muted/30 px-5 py-3">
            {editing && (
              <Button
                variant="outline"
                onClick={remove}
                className="mr-auto gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" /> {t('confirmDialog.delete')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? t('mcpPage.editor.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}

/**
 * Lazy fetch of the full detail (which contains tools_cache) when the user
 * expands a card. The list summary already carries tools_count; this returns
 * the actual names.
 */
function ToolList({ id, fallback }: { id: string; fallback?: string[] }) {
  const [tools, setTools] = useState<string[] | null>(fallback ?? null);
  const [loading, setLoading] = useState(!fallback);

  useEffect(() => {
    if (fallback?.length) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/ui/mcp/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setTools(d?.tools_cache ?? []);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, fallback]);

  if (loading) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground/70">
        {t('mcpPage.toolsLoading')}
      </div>
    );
  }
  if (!tools?.length) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground/70">
        {t('mcpPage.toolsEmpty')}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {tools.map((tool) => (
        <span
          key={tool}
          className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-foreground/85"
        >
          {tool}
        </span>
      ))}
    </div>
  );
}

function HeldBackPill({ heldBack }: { heldBack?: Summary['held_back'] }) {
  if (heldBack !== 'vault_off') return null;
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] font-normal text-[hsl(var(--warning))]"
      title={t('mcpPage.heldBack.vaultOffHint')}
    >
      <KeyRound className="size-3" />
      {t('mcpPage.heldBack.vaultOff')}
    </Badge>
  );
}

function OAuthPill({ status }: { status?: OAuthStatus }) {
  if (!status || status === 'none') return null;
  const map = {
    pending: {
      label: t('mcpPage.oauth.pending'),
      Icon: KeyRound,
      cls: 'border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]',
    },
    authorized: {
      label: t('mcpPage.oauth.authorized'),
      Icon: ShieldCheck,
      cls: 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]',
    },
    expired: {
      label: t('mcpPage.oauth.expired'),
      Icon: AlertCircle,
      cls: 'border-destructive/30 bg-destructive/10 text-destructive',
    },
  } as const;
  const entry = map[status as keyof typeof map];
  if (!entry) return null;
  const { label, Icon, cls } = entry;
  return (
    <Badge variant="outline" className={cn('gap-1.5 border font-normal', cls)}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}

/**
 * Authorize control rendered inside the editor for http MCPs. Triggers the
 * OAuth flow against the orchestrator: probe → DCR → PKCE → tokens stored
 * server-side, then injected as Authorization: Bearer at spawn time.
 */
function OAuthBlock({
  id,
  status,
  onAfterStart,
}: {
  id: string;
  status: OAuthStatus;
  onAfterStart: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await startOAuth(id);
      await onAfterStart();
    } finally {
      setBusy(false);
    }
  }
  const label =
    status === 'authorized'
      ? t('mcpPage.oauth.reauthorize')
      : status === 'expired'
      ? t('mcpPage.oauth.reauthorizeExpired')
      : t('mcpPage.oauth.authorize');
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <KeyRound className="size-3.5 text-muted-foreground" />
        <span className="text-[12px] font-semibold">{t('mcpPage.oauth.title')}</span>
        <OAuthPill status={status === 'none' ? undefined : status} />
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={go} disabled={busy} className="h-7 gap-1.5">
          {busy ? t('mcpPage.oauth.opening') : label}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
        {t('mcpPage.oauth.hintBefore', { brand: BRAND.displayName })}{' '}
        <code /* code-font: HTTP header name */ className="font-mono">Authorization</code>{' '}
        {t('mcpPage.oauth.hintAfter')}
      </p>
    </div>
  );
}
