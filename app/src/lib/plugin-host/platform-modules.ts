/**
 * The platform modules a plugin bundle may import (`react`, `@timon/ui`, …).
 *
 * They live here rather than inside the route that serves them so that the
 * surface can be READ by a test: `@timon/ui` is part of the SDK contract
 * (§10.15), and an export removed from it breaks every installed plugin that
 * imports it. The route is a thin transport over this table.
 *
 * Each source is an ES module that re-exports from the single React and the
 * single component tree the app owns — a plugin never bundles its own.
 */
export const PLATFORM_MODULE_SOURCES: Record<string, string> = {
  'react.js': 'const r=globalThis.__TIMON_PLATFORM__.react;export default r;export const createElement=r.createElement,cloneElement=r.cloneElement,createContext=r.createContext,Fragment=r.Fragment,Component=r.Component,PureComponent=r.PureComponent,memo=r.memo,lazy=r.lazy,Suspense=r.Suspense,useCallback=r.useCallback,useContext=r.useContext,useEffect=r.useEffect,useId=r.useId,useLayoutEffect=r.useLayoutEffect,useMemo=r.useMemo,useReducer=r.useReducer,useRef=r.useRef,useState=r.useState,useSyncExternalStore=r.useSyncExternalStore;',
  'react-dom.js': 'const r=globalThis.__TIMON_PLATFORM__.reactDom;export default r;export const createPortal=r.createPortal,flushSync=r.flushSync;',
  // `@timon/ui`: the two composition slots, then the component kit
  // (`ui-kit.ts`). A name removed from here breaks every plugin that imports
  // it — the surface snapshot (§10.15) refuses it.
  'ui.js': 'const p=globalThis.__TIMON_PLATFORM__,u=p.ui;'
    + 'export const Slot=p.Slot,SlotKeyed=p.SlotKeyed,'
    + 'Tile=u.Tile,BrandMark=u.BrandMark,Button=u.Button,Input=u.Input,Label=u.Label,Separator=u.Separator,Switch=u.Switch,'
    + 'DropdownMenu=u.DropdownMenu,DropdownMenuTrigger=u.DropdownMenuTrigger,DropdownMenuContent=u.DropdownMenuContent,'
    + 'DropdownMenuItem=u.DropdownMenuItem,DropdownMenuCheckboxItem=u.DropdownMenuCheckboxItem,'
    + 'DropdownMenuLabel=u.DropdownMenuLabel,DropdownMenuSeparator=u.DropdownMenuSeparator,'
    + 'Tooltip=u.Tooltip,TooltipTrigger=u.TooltipTrigger,TooltipContent=u.TooltipContent,TooltipProvider=u.TooltipProvider,'
    + 'AnchoredPopover=u.AnchoredPopover,'
    + 'Dialog=u.Dialog,DialogPortal=u.DialogPortal,DialogOverlay=u.DialogOverlay,DialogTrigger=u.DialogTrigger,DialogClose=u.DialogClose,DialogContent=u.DialogContent,DialogHeader=u.DialogHeader,DialogFooter=u.DialogFooter,DialogTitle=u.DialogTitle,DialogDescription=u.DialogDescription,Select=u.Select,SelectGroup=u.SelectGroup,SelectValue=u.SelectValue,SelectTrigger=u.SelectTrigger,SelectContent=u.SelectContent,SelectLabel=u.SelectLabel,SelectItem=u.SelectItem,SelectSeparator=u.SelectSeparator,SelectScrollUpButton=u.SelectScrollUpButton,SelectScrollDownButton=u.SelectScrollDownButton,HUD_SURFACE=u.HUD_SURFACE,'
    + 'cn=u.cn,t=u.t,getLocale=u.getLocale,createTranslator=u.createTranslator,useTodoItem=u.useTodoItem,useTodoDetail=u.useTodoDetail,useMissionItem=u.useMissionItem,useAgentMenuItem=u.useAgentMenuItem,useConnectionForm=u.useConnectionForm,'
    + 'useIslandContent=u.useIslandContent,startIslandDrag=u.startIslandDrag,openInIsland=u.openInIsland,'
    + 'useUiDocument=u.useUiDocument,UiDocumentFrame=u.UiDocumentFrame,uiDocumentUrl=u.uiDocumentUrl,'
    + 'useSecretRequest=u.useSecretRequest,useUpdateStatus=u.useUpdateStatus,'
    + 'usePromptHistory=u.usePromptHistory,canRecallPrompt=u.canRecallPrompt,isTextareaWrapped=u.isTextareaWrapped,'
    + 'useChatMessage=u.useChatMessage,useComposerReply=u.useComposerReply,MessageActionButton=u.MessageActionButton,'
    + 'useBrowserChrome=u.useBrowserChrome,useBrowserRecording=u.useBrowserRecording,useBrowserSurface=u.useBrowserSurface,useBrowserAnnotations=u.useBrowserAnnotations,'
    + 'useModelPicker=u.useModelPicker,useBackendCatalog=u.useBackendCatalog,vendorLabel=u.vendorLabel,isPickable=u.isPickable,accountStateHint=u.accountStateHint,'
    + 'byPower=u.byPower,matchesQuery=u.matchesQuery,formatWindow=u.formatWindow,useModelFavorites=u.useModelFavorites,'
    + 'isNewModel=u.isNewModel,backendLimits=u.backendLimits,BackendLimitsBadge=u.BackendLimitsBadge,AccountStateBadge=u.AccountStateBadge,'
    + 'useProviderCliCards=u.useProviderCliCards,NativeViewCover=u.NativeViewCover,useTaskForm=u.useTaskForm,useOpenInNewWindow=u.useOpenInNewWindow,NavLink=u.NavLink,useDirectoryBrowser=u.useDirectoryBrowser,confirmAction=u.confirmAction,useConfirmDialog=u.useConfirmDialog,useGlassScope=u.useGlassScope,'
    + 'formatDate=u.formatDate,formatTime=u.formatTime,formatDateTime=u.formatDateTime,formatNumber=u.formatNumber,formatPercent=u.formatPercent,formatBytes=u.formatBytes,formatRelativeTime=u.formatRelativeTime,formatAgeShort=u.formatAgeShort,formatList=u.formatList,compareText=u.compareText,useAppCard=u.useAppCard,useMcpTab=u.useMcpTab,apiErrorMessage=u.apiErrorMessage,parseApiError=u.parseApiError,'
    + 'BoardCard=u.BoardCard,DetailShell=u.DetailShell,DetailFrame=u.DetailFrame,useKanbanCard=u.useKanbanCard,useTodoForm=u.useTodoForm,useJobDialog=u.useJobDialog,usePublishDialog=u.usePublishDialog,useGitStackProject=u.useGitStackProject,GitStackProjectPicker=u.GitStackProjectPicker,useTodoOpener=u.useTodoOpener,useProjectSettings=u.useProjectSettings,useWidgetCount=u.useWidgetCount,useWidgetAttention=u.useWidgetAttention,useWidgetMenu=u.useWidgetMenu,useWidgetInFront=u.useWidgetInFront,usePageToc=u.usePageToc,useAgentMascot=u.useAgentMascot,useEmailCode=u.useEmailCode,useLookStyler=u.useLookStyler,'
    + 'useProviderPage=u.useProviderPage,ProviderSection=u.ProviderSection,ProviderSettingRow=u.ProviderSettingRow,useProviderRow=u.useProviderRow,ProviderRow=u.ProviderRow,'
    + 'useNotices=u.useNotices,useNotice=u.useNotice,useUpdateDialog=u.useUpdateDialog;',
  'api.js': 'export const api=globalThis.__TIMON_PLATFORM__.api;',
  'theme.js': 'export const theme=globalThis.__TIMON_PLATFORM__.theme;',
  'navigate.js': 'export const navigate=globalThis.__TIMON_PLATFORM__.navigate;',
};

/** Names a module exports, read from its source — the snapshot test compares
 *  this to `contract-surface.json`, so an export cannot vanish silently. */
export function platformModuleExports(module: string): string[] {
  const source = PLATFORM_MODULE_SOURCES[module];
  if (!source) return [];
  const names = new Set<string>();
  for (const match of source.matchAll(/export const ([\w$]+)=/g)) names.add(match[1]!);
  // `export const a=…,b=…` : the names after the first are not preceded by
  // `export const`, so read the whole declaration list.
  for (const declaration of source.matchAll(/export const ((?:[\w$]+=[^;]+))/g)) {
    for (const part of declaration[1]!.split(',')) {
      const name = part.split('=')[0]!.trim();
      if (/^[\w$]+$/.test(name)) names.add(name);
    }
  }
  if (/export default /.test(source)) names.add('default');
  return [...names].sort();
}
