'use client';

/**
 * `@timon/ui` — the component kit a plugin builds its surface with (§10.15).
 *
 * Why the product ships one at all: a plugin that cannot reuse these has two
 * options, both bad. Re-implement the visuals (and drift from the theme the
 * user chose, since tokens are CSS custom properties owned by the theme
 * plugin), or bundle its own React and component library (two Reacts in one
 * page, hooks blowing up on the first shared context).
 *
 * What belongs here: primitives already used by the product's own surfaces.
 * Anything specific to one screen stays in that screen — the kit is a
 * CONTRACT, and every export added to it can never be removed (see
 * `docs/SDK-COMPAT.md`).
 */
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { AnchoredPopover } from '@/components/anchored-popover';
import { Dialog, DialogPortal, DialogOverlay, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton } from '@/components/ui/select';
import { BrandMark } from '@/components/brand-mark';
import { Tile } from '@/components/tile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTodoItem } from '@/plugins-client/kanban/todo-badge-slot';
import { useTodoDetail } from '@/plugins-client/kanban/todo-detail-slot';
import { useMissionItem } from '@/plugins-client/missions/mission-badge-slot';
import { useAgentMenuItem } from '@/plugins-client/bots/agent-menu-slot';
import { useConnectionForm } from '@/components/settings/connection-form-slot';
import { useBrowserChrome, useBrowserSurface } from '@/components/browser-chrome';
import { useBrowserRecording } from '@/hooks/use-browser-recording';
import { useBrowserAnnotations } from '@/hooks/use-browser-annotations';
import { useIslandContent } from '@/components/islands/island-content';
import { openInIsland } from '@/lib/island-bus';
import { startIslandDrag } from '@/lib/island-drag';
import { getLocale, t } from '@/lib/i18n';
import {
  compareText, formatAgeShort, formatBytes, formatDate, formatDateTime, formatList, formatNumber, formatPercent,
  formatRelativeTime, formatTime,
} from '@/lib/intl';
import { apiErrorMessage, parseApiError } from '@/lib/api-error';
// Scoped to one plugin's own messages, any language, ICU (docs/PLUGINS.md).
import { createTranslator } from '@/lib/plugin-translator';
import { UiDocumentFrame, useUiDocument } from '@/components/chat/ui-document-block';
import { uiDocumentUrl } from '@/lib/ui-documents';
import { useSecretRequest } from '@/components/chat/secret-request-card';
import { useUpdateStatus } from '@/components/updates/update-status-context';
import { useNotice, useNotices } from '@/components/notices/notice-context';
import { useUpdateDialog } from '@/components/updates/update-dialog-context';
import { canRecallPrompt, isTextareaWrapped, usePromptHistory } from '@/lib/prompt-history';
import { MessageActionButton, useChatMessage, useComposerReply } from '@/components/chat/message-actions';
import { useModelPicker } from '@/components/model-picker/picker-context';
import { useProviderCliCards } from '@/components/provider-cli/provider-cli-context';
import { useTaskForm } from '@/components/task-form/task-form-context';
import { useDirectoryBrowser } from '@/components/directory-browser-context';
import { confirmAction, useConfirmDialog } from '@/components/confirm-dialog/confirm-dialog-context';
import { useAppCard } from '@/components/app-card/app-card-context';
import { usePageToc } from '@/components/page-toc/page-toc-context';
import { useAgentMascot } from '@/components/mascot/agent-mascot-context';
import { useEmailCode } from '@/components/email-code/email-code-context';
import { useLookStyler } from '@/components/mascot/look-styler/look-styler-context';
import { useProviderPage } from '@/components/provider-page/provider-page-context';
import { ProviderSection, ProviderSettingRow } from '@/components/provider-page/provider-section';
import { useProviderRow } from '@/components/provider-list/provider-row-context';
import { ProviderRow } from '@/components/provider-list/provider-row';
import { useMcpTab } from '@/lib/mcp-tab-context';
import { useGlassScope } from '@/components/glass-scope';
import { useModelFavorites } from '@/hooks/use-model-favorites';
import { accountStateHint, backendLimits, isNewModel, isPickable, useBackendCatalog, vendorLabel } from '@/lib/backends';
import { AccountStateBadge } from '@/components/account-state-badge';
import { BackendLimitsBadge } from '@/components/backend-limits-badge';
import { byPower, formatWindow, matchesQuery } from '@/lib/llm-sort';
import { NativeViewCover } from '@/lib/native-view-cover';
import { useOpenInNewWindow } from '@/lib/open-window';
import { BoardCard } from '@/components/board-card';
import { DetailShell } from '@/components/detail-shell';
import { DetailFrame } from '@/components/detail-frame';
import { NavLink } from '@/components/nav-link';
import { useKanbanCard } from '@/plugins-client/kanban/kanban-card-context';
import { useTodoForm } from '@/plugins-client/kanban/todo-form-context';
import { useJobDialog } from '@/plugins-client/kanban/job-dialog-context';
import { usePublishDialog } from '@/plugins-client/kanban/publish-dialog-context';
import { GitStackProjectPicker, useGitStackProject } from '@/plugins-client/kanban/git-stack-project';
import { useTodoOpener } from '@/plugins-client/kanban/todo-opener';
import { useProjectSettings } from '@/components/project-settings-slot';
import { useWidgetAttention, useWidgetCount, useWidgetInFront, useWidgetMenu } from '@/components/widget-host/widget-self';

/** What `@timon/ui` exposes. One object, so `platform-globals` and the served
 *  module cannot list different members. */
export const UI_KIT = {
  Tile, Button, Input, Label, Separator, Switch,
  Dialog, DialogPortal, DialogOverlay, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
  Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton,
  HUD_SURFACE,
  // Shared brand marks stay consistent as provider identities evolve.
  BrandMark,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
  // The panel a compact widget opens from its icon, kept inside the window.
  AnchoredPopover,
  cn, t, getLocale, createTranslator,
  // The idea a `kanban.todo.badge` / `kanban.todo.detail` occupant is rendered for.
  useTodoItem, useTodoDetail,
  // The mission a `mission.card.badge` occupant is rendered for.
  useMissionItem,
  // The agent an `agent.menu.item` occupant is rendered for (client API 15).
  useAgentMenuItem,
  // The connection type a `settings.connection.form` occupant is a form for,
  // and in `edit` mode the connection it opens on.
  useConnectionForm,
  // The island workspace (client API 8): a content reads its place, a source
  // drags or opens one. The same three calls the product's own contents use.
  useIslandContent, startIslandDrag, openInIsland,
  // An HTML document of the conversation (client API 9): what a
  // `chat.document` occupant renders, and the frame that keeps it sandboxed.
  useUiDocument, UiDocumentFrame, uiDocumentUrl,
  // A secret an agent asks its user for (client API 15): what a
  // `chat.secret` occupant renders, and its two gestures.
  useSecretRequest,
  // Deprecated since client API 17: the `updates.banner` slot is no longer
  // painted, so this answers `null`. Kept so an API 15 plugin still loads.
  useUpdateStatus,
  // The composer's prompt history (client API 12): a `chat.composer`
  // replacement recalls the same prompts as the product's input.
  usePromptHistory, canRecallPrompt, isTextareaWrapped,
  // The bubble a `chat.message.action` occupant sits under, the reply the
  // composer is about to send, and the product's own action button (client API 15).
  useChatMessage, useComposerReply, MessageActionButton,
  // The built-in browser a `browser.toolbar` / `browser.drawer` occupant is
  // painted in (client API 13), its recording (`@timon/browser-recording`),
  // the picture a `browser.surface` layer sits on and the annotations
  // (`@timon/browser-annotations`, same wave).
  useBrowserChrome, useBrowserRecording, useBrowserSurface, useBrowserAnnotations,
  // The model selector (client API 13, `model.picker`): the host a replacement
  // is painted for, and the catalogue, ordering, search and favourites the
  // product's picker reads — a replacement needs nothing of the core beyond these.
  useModelPicker, useBackendCatalog, vendorLabel, isPickable, accountStateHint,
  byPower, matchesQuery, formatWindow, useModelFavorites,
  // What the product's rows and header show beyond the catalogue's names: the
  // "new" badge, the provider's declared limits, an account's state.
  isNewModel, backendLimits, BackendLimitsBadge, AccountStateBadge,
  // The provider cards (client API 14, `providers.cli`): the host a replacement is painted for —
  // the AI CLIs, their install jobs and the gestures (install, try again, check for updates).
  useProviderCliCards,
  // The task form (client API 14, `task.form`): the host a replacement is painted for — the task,
  // the agents, and the gestures (save, attach, remove a file, finish, close).
  useTaskForm,
  // What a plugin's own portal holds to come above the desktop's native browser
  // view (client API 14): the kit's Dialog, Select and menus already do.
  NativeViewCover,
  // "Open in a new window" (client API 14, multi-window V5): a route of the
  // app in one more desktop window on the same machine; `null` off the desktop.
  useOpenInNewWindow,
  // A `nav.item` entry drawn like the product's own (client API 15): it follows the
  // rail folded or unfolded, the active route and the menu editor, which a plugin
  // cannot read itself.
  NavLink,
  // The folder browser (client API 15, `directory.picker`): the host a replacement is painted
  // for — one level of the active machine's disk at a time, choose, cancel.
  useDirectoryBrowser,
  // The confirmation dialog (client API 15, `confirm.dialog`): `confirmAction` asks the
  // product's dialog from anywhere, `useConfirmDialog` is the question a replacement paints.
  confirmAction,
  useConfirmDialog,
  // Where the frosted glass sits for the calling widget (client API 15): its
  // island as one plate, or each widget as a card; `null` while it is off.
  useGlassScope,
  // Dates, numbers, sizes, relative times and lists in the reader's language
  // (client API 15): the product's own formatters, so a plugin needs no locale branch.
  formatDate, formatTime, formatDateTime, formatNumber, formatPercent, formatBytes,
  formatRelativeTime, formatAgeShort, formatList, compareText,
  // An app card of the Apps page (client API 15, `apps.card`): the app a replacement paints,
  // its state, and the gestures (connect, disconnect).
  useAppCard,
  // The MCP tab around an `mcp.featured` section (client API 15): its search, to filter with.
  useMcpTab,
  // A route error in the reader's language (client API 15): `apiErrors.<code>`
  // of the product, else the English the route sent.
  apiErrorMessage, parseApiError,
  // The Kanban's card and popup (client API 15, TODO #837): the zones of a TO DO idea's or a
  // task's tile, the inside of its popup, and the modal frame (veil, focus, Escape) around it.
  BoardCard, DetailShell, DetailFrame,
  // The item a `kanban.card` occupant paints (client API 15): a TO DO idea or a task, and its gestures.
  useKanbanCard,
  // The TO DO idea form (client API 15, `todo.form`), the twin of `useTaskForm`: the idea,
  // and the gestures (save, hand off to the orchestrator, finish, close).
  useTodoForm,
  // A Kanban job's window (client API 19, `kanban.job.dialog`): the job, its links, and the
  // way to its ideas and pilot mission.
  useJobDialog,
  // The "Publish on GitHub" window (client API 19, `forge.publish.dialog`): the text, where it
  // goes, as which account, and the host's gestures, which go through the person's session.
  usePublishDialog,
  // The project a widget of the "Git" stack shows (client API 19): the chat's in a chat's
  // rail, else the one picked once for the whole stack, and the picker that picks it.
  useGitStackProject, GitStackProjectPicker,
  // Opens a TO DO idea by its number in the product's form (client API 19); the caller
  // paints `todoModal` where it stays mounted.
  useTodoOpener,
  // The project a `project.settings` row is painted for (client API 19).
  useProjectSettings,
  // What a widget hands its tab in a stack (client API 19): a count, a dot while something waits
  // for the person, its header actions moved to the widget's menu, and whether it is in view.
  useWidgetCount, useWidgetAttention, useWidgetMenu, useWidgetInFront,
  // The table of contents of a list page (client API 15, `page.toc`): its headings, the one
  // in view, and the jump to one.
  usePageToc,
  // The agent's mascot (client API 15, `agent.mascot`): its look, size, state, and whether
  // it may move (`prefers-reduced-motion`).
  useAgentMascot,
  // The code screen (client API 15, `email.code`): the six digits an email brought, the state,
  // the refusal and the resend countdown; the host talks to the daemon.
  useEmailCode,
  // The mascot configurator (client API 15, `agent.lookstyler`): the look being edited, the
  // change, the agent's name and role, the states to try, the closed lists and a random look.
  useLookStyler,
  // The page of one provider (client API 16, `settings.provider.section`): the provider on
  // screen, its status, `refresh` and `back`; the frame the product's sections use, and
  // its row (a title and a status at the left, one action and a "…" menu at the right).
  useProviderPage, ProviderSection, ProviderSettingRow,
  // One provider's row (client API 16, `providers.row`): the provider it is painted for, how
  // to open its page, the surface's action; and the host, to paint rows of your own.
  useProviderRow, ProviderRow,
  // The bottom-left cards (client API 17): what a `notices` entry pushes its cards with,
  // and the card a `notices.card` occupant paints, with its gestures (close, act).
  useNotices, useNotice,
  // The update window (client API 17, `updates.dialog`): the version, its highlights and
  // changelog, the download and the gestures of the step it is at.
  useUpdateDialog,
};

/**
 * A few members by name, as the served `ui.js` hands them to a third-party
 * bundle: a bundled half that holds itself to the public surface
 * (`local-dictation`, TODO #484 §3.5) imports them from `@timon/ui` the same
 * way. Values of `UI_KIT`, never other ones.
 */
export { Button, createTranslator, formatNumber, getLocale, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, t };
