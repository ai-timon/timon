/**
 * Compile-time guards of the browser half's copies of `@timon-ai/sdk` types.
 *
 * The app builds on its own (its Docker context is `app/`, without
 * `packages/`), so `slots.ts`, `loader.ts`, `dictation/contract.ts`,
 * `usage-types.ts`, `backends.ts`… cannot import the SDK and keep copies
 * instead. Nothing in the app build may name `packages/`, hence this file
 * lives outside `src/` (not in `tsconfig.json`'s `include`, not copied by the
 * Dockerfile) and is compiled by `src/lib/plugin-host/sdk-mirrors.test.ts`,
 * which also fails on an app type named like an SDK export that this file
 * does not guard.
 *
 * The direction is SDK ⊆ app: a value typed by the SDK — what a plugin hands
 * the host, what the daemon sends the app — is accepted by the app's type.
 * Where the app keeps a full copy, the guard is identity, so the reverse
 * holds too (what the host hands a plugin is what the SDK promised); the
 * host-only members below are the only tolerated difference.
 */
import type * as Sdk from '../../packages/sdk/src/index.js';
import type { ApprovalScope } from '../src/lib/approval-scopes';
import type * as Backends from '../src/lib/backends';
import type * as Dictation from '../src/lib/dictation/contract';
import type * as Mascot from '../src/lib/mascot/parts-contract';
import type { IslandParams } from '../src/lib/island-tree';
import type { PluginEventKind } from '../src/lib/plugin-host/event-kinds';
import type { clientContext } from '../src/lib/plugin-host/loader';
import type {
  IslandContentOptions, IslandParamSpec, SlotChildren, SlotKind, WidgetOptions,
} from '../src/lib/plugin-host/slots';
import type { AccountUsage, UsageEntry, UsageWindow } from '../src/lib/plugin-host/usage-types';
import type { NoticeAction, NoticeIcon, NoticeInput, NoticeTone } from '../src/lib/notices';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
/** `A` is accepted where `B` is expected (not distributed over unions). */
type Accepts<B, A> = [A] extends [B] ? true : false;

/**
 * Members the product reads from its own registrations only, never promised
 * to a third party: `formerIds` is honoured for an `@timon/` plugin alone,
 * `tabIcon` is a React component (the SDK has no React), `order` ranks the
 * product's nav entries, `page` shapes the product's own views in the island
 * workspace, `dispose` belongs to the loader that unloads.
 */
type HostOnlyWidgetKeys = 'formerIds' | 'bareIslandOn';
type HostOnlyIslandKeys = 'tabIcon' | 'bare';
type HostOnlyRegisterKeys = 'order' | 'page';
type LoaderOnlyContextKeys = 'dispose';

// A host-only key that left the app, or that the SDK now publishes, is no
// longer host-only: drop it from the list above.
type _HostOnlyWidgetKeysExist = Assert<Equals<Extract<keyof WidgetOptions, HostOnlyWidgetKeys>, HostOnlyWidgetKeys>>;
type _HostOnlyIslandKeysExist = Assert<Equals<Extract<keyof IslandContentOptions, HostOnlyIslandKeys>, HostOnlyIslandKeys>>;
type _HostOnlyWidgetKeysUnpublished = Assert<Equals<Extract<keyof Sdk.WidgetOptions, HostOnlyWidgetKeys>, never>>;
type _HostOnlyIslandKeysUnpublished = Assert<Equals<Extract<keyof Sdk.IslandContentOptions, HostOnlyIslandKeys>, never>>;

// Slots (`plugin-host/slots.ts`, `island-tree.ts`).
type _SlotKind = Assert<Equals<SlotKind, Sdk.SlotKind>>;
type _SlotChildren = Assert<Equals<SlotChildren, Sdk.SlotChildren>>;
type _IslandParams = Assert<Equals<IslandParams, Sdk.IslandParams>>;
type _IslandParamSpec = Assert<Equals<IslandParamSpec, Sdk.IslandParamSpec>>;
type _WidgetOptions = Assert<Equals<Omit<WidgetOptions, HostOnlyWidgetKeys>, Sdk.WidgetOptions>>;
type _IslandContentOptions = Assert<Equals<Omit<IslandContentOptions, HostOnlyIslandKeys>, Sdk.IslandContentOptions>>;

// Dictation (`dictation/contract.ts`).
type _DictationLanguages = Assert<Equals<Dictation.DictationLanguages, Sdk.DictationLanguages>>;
type _DictationInterim = Assert<Equals<Dictation.DictationInterim, Sdk.DictationInterim>>;
type _DictationAvailability = Assert<Equals<Dictation.DictationAvailability, Sdk.DictationAvailability>>;
type _DictationErrorCode = Assert<Equals<Dictation.DictationErrorCode, Sdk.DictationErrorCode>>;
type _DictationEvent = Assert<Equals<Dictation.DictationEvent, Sdk.DictationEvent>>;
type _DictationStartOptions = Assert<Equals<Dictation.DictationStartOptions, Sdk.DictationStartOptions>>;
type _DictationSession = Assert<Equals<Dictation.DictationSession, Sdk.DictationSession>>;
type _DictationEngine = Assert<Equals<Dictation.DictationEngine, Sdk.DictationEngine>>;

// Mascot packs (`mascot/parts-contract.ts`).
type _MascotPartLabel = Assert<Equals<Mascot.MascotPartLabel, Sdk.MascotPartLabel>>;
type _MascotPoint = Assert<Equals<Mascot.MascotPoint, Sdk.MascotPoint>>;
type _MascotPart = Assert<Equals<Mascot.MascotPart, Sdk.MascotPart>>;
type _MascotHeadComponent = Assert<Equals<Mascot.MascotHeadComponent, Sdk.MascotHeadComponent>>;

// Events and quotas a browser half reads (`event-kinds.ts`, `usage-types.ts`).
type _PluginEventKind = Assert<Equals<PluginEventKind, Sdk.PluginEventKind>>;
type _UsageWindow = Assert<Equals<UsageWindow, Sdk.UsageWindow>>;
type _AccountUsage = Assert<Equals<AccountUsage, Sdk.AccountUsage>>;
type _UsageEntry = Assert<Equals<UsageEntry, Sdk.UsageEntry>>;

// Notice cards (`lib/notices.ts`, client API 17).
type _NoticeTone = Assert<Equals<NoticeTone, Sdk.NoticeTone>>;
type _NoticeAction = Assert<Equals<NoticeAction, Sdk.NoticeAction>>;
type _NoticeInput = Assert<Equals<NoticeInput, Sdk.NoticeInput>>;
type _NoticeIcon = Assert<Equals<NoticeIcon, Sdk.NoticeIcon>>;

// The context (`plugin-host/loader.ts`): the app types it by inference from
// `clientContext`, the SDK by hand. Same members, at the top and one level
// down; the object the host builds satisfies the SDK's type; and the register
// options are the SDK's plus the host-only keys. `slots.register` is compared
// through its options only: the host takes a React `ComponentType` where the
// SDK, which has no React, types the component loosely (`ClientComponent`).
type AppContext = Omit<ReturnType<typeof clientContext>, LoaderOnlyContextKeys>;
type SdkContext = Sdk.ClientContext;
type AppRegisterOptions = Parameters<AppContext['slots']['register']>[0];
type SdkRegisterOptions = Parameters<SdkContext['slots']['register']>[0];

type _ContextKeys = Assert<Equals<keyof AppContext, keyof SdkContext>>;
type _ContextSlotsKeys = Assert<Equals<keyof AppContext['slots'], keyof SdkContext['slots']>>;
type _ContextSettingsKeys = Assert<Equals<keyof AppContext['settings'], keyof SdkContext['settings']>>;
type _ContextEventsKeys = Assert<Equals<keyof AppContext['events'], keyof SdkContext['events']>>;
type _ContextRealtimeKeys = Assert<Equals<keyof AppContext['realtime'], keyof SdkContext['realtime']>>;
type _ContextThemeKeys = Assert<Equals<keyof AppContext['theme'], keyof SdkContext['theme']>>;
type _ContextUsageKeys = Assert<Equals<keyof AppContext['usage'], keyof SdkContext['usage']>>;
type _ContextNoticesKeys = Assert<Equals<keyof AppContext['notices'], keyof SdkContext['notices']>>;
type _ContextSatisfiesSdk = Assert<Accepts<Omit<SdkContext, 'slots'>, Omit<AppContext, 'slots'>>>;
type _RegisterOptions = Assert<Equals<
  Omit<AppRegisterOptions, HostOnlyRegisterKeys | 'widget' | 'island'>,
  Omit<SdkRegisterOptions, 'widget' | 'island'>
>>;
type _RegisterWidget = Assert<Equals<AppRegisterOptions['widget'], WidgetOptions | undefined>>;
type _RegisterIsland = Assert<Equals<AppRegisterOptions['island'], IslandContentOptions | undefined>>;
type _RegisterAcceptsSdkOptions = Assert<Accepts<AppRegisterOptions, SdkRegisterOptions>>;

// The backend catalogue the app reads from the daemon (`backends.ts`,
// `approval-scopes.ts`). Full copies are identical; `CatalogModel` and the
// capabilities are partial VIEWS (the app reads some fields, and leaves
// `timonPreamble` out on purpose): the daemon's value must satisfy the view,
// and the view may name no field the daemon does not have.
type _ApprovalScope = Assert<Equals<ApprovalScope, Sdk.ApprovalScope>>;
type _PermissionModel = Assert<Equals<Backends.PermissionModel, Sdk.PermissionModel>>;
type _ReasoningControl = Assert<Equals<Backends.ReasoningControl, Sdk.ReasoningControl>>;
type _DeclaredReasoningControl = Assert<Equals<Backends.DeclaredReasoningControl, Sdk.DeclaredReasoningControl>>;
type _ModelReasoning = Assert<Equals<Backends.ModelReasoning, Sdk.ModelReasoning>>;
type _CatalogModelView = Assert<Accepts<Backends.CatalogModel, Sdk.CatalogModel>>;
type _CatalogModelNoPhantom = Assert<Equals<Exclude<keyof Backends.CatalogModel, keyof Sdk.CatalogModel>, never>>;
type _BackendCapabilitiesView = Assert<Accepts<Backends.BackendCapabilities, Sdk.BackendCapabilities>>;
type _BackendCapabilitiesNoPhantom = Assert<Equals<Exclude<keyof Backends.BackendCapabilities, keyof Sdk.BackendCapabilities>, never>>;
type _BackendCapabilityView = Assert<Accepts<Sdk.BackendCapability, Backends.BackendCapability>>;
