
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginContext

> **PluginContext** = `object`

## Properties

### accountProvider

> **accountProvider**: [`PluginAccountProvider`](PluginAccountProvider.md)

***

### agents

> **agents**: `object`

#### docs

> **docs**: `object`

##### docs.get()

> **get**(`agent`, `file`): `Promise`\<`string` \| `null`\>

###### Parameters

###### agent

`string`

###### file

`string`

###### Returns

`Promise`\<`string` \| `null`\>

##### docs.list()

> **list**(`agent`): `Promise`\<[`PluginAgentDoc`](PluginAgentDoc.md)[]\>

###### Parameters

###### agent

`string`

###### Returns

`Promise`\<[`PluginAgentDoc`](PluginAgentDoc.md)[]\>

##### docs.put()

> **put**(`agent`, `file`, `content`): `Promise`\<[`PluginAgentDoc`](PluginAgentDoc.md)\>

###### Parameters

###### agent

`string`

###### file

`string`

###### content

`string`

###### Returns

`Promise`\<[`PluginAgentDoc`](PluginAgentDoc.md)\>

##### docs.rm()

> **rm**(`agent`, `file`): `Promise`\<`boolean`\>

###### Parameters

###### agent

`string`

###### file

`string`

###### Returns

`Promise`\<`boolean`\>

#### teams

> **teams**: `object`

##### teams.create()

> **create**(`input`): `Promise`\<[`PluginTeam`](PluginTeam.md)\>

###### Parameters

###### input

[`PluginTeamInput`](PluginTeamInput.md)

###### Returns

`Promise`\<[`PluginTeam`](PluginTeam.md)\>

##### teams.delete()

> **delete**(`teamId`): `Promise`\<`boolean`\>

###### Parameters

###### teamId

`string`

###### Returns

`Promise`\<`boolean`\>

##### teams.list()

> **list**(): `Promise`\<[`PluginTeam`](PluginTeam.md)[]\>

###### Returns

`Promise`\<[`PluginTeam`](PluginTeam.md)[]\>

#### create()

> **create**(`input`): `Promise`\<[`PluginAgent`](PluginAgent.md)\>

##### Parameters

###### input

[`PluginAgentInput`](PluginAgentInput.md)

##### Returns

`Promise`\<[`PluginAgent`](PluginAgent.md)\>

#### delete()

> **delete**(`name`, `options?`): `Promise`\<`boolean`\>

##### Parameters

###### name

`string`

###### options?

[`PluginAgentDeleteOptions`](PluginAgentDeleteOptions.md)

##### Returns

`Promise`\<`boolean`\>

#### export()

> **export**(`name`): `Promise`\<[`PluginAgentExport`](PluginAgentExport.md)\>

##### Parameters

###### name

`string`

##### Returns

`Promise`\<[`PluginAgentExport`](PluginAgentExport.md)\>

#### list()

> **list**(): `Promise`\<[`PluginAgent`](PluginAgent.md)[]\>

##### Returns

`Promise`\<[`PluginAgent`](PluginAgent.md)[]\>

#### rename()

> **rename**(`name`, `newName`): `Promise`\<[`PluginAgent`](PluginAgent.md)\>

##### Parameters

###### name

`string`

###### newName

`string`

##### Returns

`Promise`\<[`PluginAgent`](PluginAgent.md)\>

#### setAvatar()

> **setAvatar**(`name`, `avatar`): `Promise`\<`string` \| `null`\>

##### Parameters

###### name

`string`

###### avatar

`AgentAvatarInput`

##### Returns

`Promise`\<`string` \| `null`\>

#### update()

> **update**(`name`, `patch`): `Promise`\<[`PluginAgent`](PluginAgent.md)\>

##### Parameters

###### name

`string`

###### patch

[`PluginAgentPatch`](PluginAgentPatch.md)

##### Returns

`Promise`\<[`PluginAgent`](PluginAgent.md)\>

***

### backendAccounts

> **backendAccounts**: `object`

#### grant()

> **grant**(`accountId`, `userIds`): `Promise`\<[`PluginBackendAccount`](PluginBackendAccount.md)\>

##### Parameters

###### accountId

`string`

###### userIds

`string`[]

##### Returns

`Promise`\<[`PluginBackendAccount`](PluginBackendAccount.md)\>

#### list()

> **list**(): `Promise`\<[`PluginBackendAccount`](PluginBackendAccount.md)[]\>

##### Returns

`Promise`\<[`PluginBackendAccount`](PluginBackendAccount.md)[]\>

#### revoke()

> **revoke**(`accountId`, `userIds`): `Promise`\<[`PluginBackendAccount`](PluginBackendAccount.md)\>

##### Parameters

###### accountId

`string`

###### userIds

`string`[]

##### Returns

`Promise`\<[`PluginBackendAccount`](PluginBackendAccount.md)\>

***

### backends

> **backends**: `object`

#### list()

> **list**(): `Promise`\<[`PluginBackendCatalog`](PluginBackendCatalog.md)\>

##### Returns

`Promise`\<[`PluginBackendCatalog`](PluginBackendCatalog.md)\>

#### registerDialect()

> **registerDialect**(`id`, `dialect`): () => `void`

##### Parameters

###### id

`string`

###### dialect

[`Dialect`](../interfaces/Dialect.md) \| [`RemoteDialect`](RemoteDialect.md)

##### Returns

() => `void`

#### registerProfile()

> **registerProfile**(`profile`): () => `void`

##### Parameters

###### profile

[`RegisteredProfile`](RegisteredProfile.md)

##### Returns

() => `void`

***

### backup

> **backup**: `object`

#### enable()

> **enable**(): `Promise`\<[`PluginBackupStatus`](PluginBackupStatus.md)\>

##### Returns

`Promise`\<[`PluginBackupStatus`](PluginBackupStatus.md)\>

#### status()

> **status**(): `Promise`\<[`PluginBackupStatus`](PluginBackupStatus.md)\>

##### Returns

`Promise`\<[`PluginBackupStatus`](PluginBackupStatus.md)\>

***

### browser

> **browser**: `object`

#### list()

> **list**(): `Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md)[]\>

##### Returns

`Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md)[]\>

#### start()

> **start**(`project`): `Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md)\>

##### Parameters

###### project

`string`

##### Returns

`Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md)\>

#### status()

> **status**(`project`): `Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md) \| `undefined`\>

##### Parameters

###### project

`string`

##### Returns

`Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md) \| `undefined`\>

#### stop()

> **stop**(`project`): `Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md) \| `undefined`\>

##### Parameters

###### project

`string`

##### Returns

`Promise`\<[`PluginBrowserSession`](PluginBrowserSession.md) \| `undefined`\>

***

### browserAnnotations

> **browserAnnotations**: `object`

#### delete()

> **delete**(`id`): `Promise`\<`boolean`\>

##### Parameters

###### id

`string`

##### Returns

`Promise`\<`boolean`\>

#### findByRef()

> **findByRef**(`provider`, `ref`): `Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\> \| `undefined`\>

##### Parameters

###### provider

`string`

###### ref

`string`

##### Returns

`Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\> \| `undefined`\>

#### get()

> **get**(`id`): `Promise`\<[`PluginBrowserAnnotationDetail`](PluginBrowserAnnotationDetail.md) \| `undefined`\>

##### Parameters

###### id

`string`

##### Returns

`Promise`\<[`PluginBrowserAnnotationDetail`](PluginBrowserAnnotationDetail.md) \| `undefined`\>

#### list()

> **list**(`filter?`): `Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\>[]\>

##### Parameters

###### filter?

[`PluginBrowserAnnotationFilter`](PluginBrowserAnnotationFilter.md)

##### Returns

`Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\>[]\>

#### resolve()

> **resolve**(`id`, `resolution`): `Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\>\>

##### Parameters

###### id

`string`

###### resolution

[`PluginBrowserAnnotationResolution`](PluginBrowserAnnotationResolution.md)

##### Returns

`Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\>\>

#### setRef()

> **setRef**(`id`, `ref`): `Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\>\>

##### Parameters

###### id

`string`

###### ref

`BrowserAnnotationExternalRef` \| `null`

##### Returns

`Promise`\<`Readonly`\<`Omit`\<`BrowserAnnotationMetadata`, `"ownerUserId"` \| `"thumbnailBytes"`\>\>\>

***

### browserRecordings

> **browserRecordings**: `object`

#### delete()

> **delete**(`id`): `Promise`\<`boolean`\>

##### Parameters

###### id

`string`

##### Returns

`Promise`\<`boolean`\>

#### findByRef()

> **findByRef**(`provider`, `ref`): `Promise`\<`Readonly`\<`Omit`\<`BrowserRecordingMetadata`, `"ownerUserId"`\>\> \| `undefined`\>

##### Parameters

###### provider

`string`

###### ref

`string`

##### Returns

`Promise`\<`Readonly`\<`Omit`\<`BrowserRecordingMetadata`, `"ownerUserId"`\>\> \| `undefined`\>

#### get()

> **get**(`id`): `Promise`\<[`PluginBrowserRecordingDetail`](PluginBrowserRecordingDetail.md) \| `undefined`\>

##### Parameters

###### id

`string`

##### Returns

`Promise`\<[`PluginBrowserRecordingDetail`](PluginBrowserRecordingDetail.md) \| `undefined`\>

#### list()

> **list**(`filter?`): `Promise`\<`Readonly`\<`Omit`\<`BrowserRecordingMetadata`, `"ownerUserId"`\>\>[]\>

##### Parameters

###### filter?

###### profileId?

`string`

##### Returns

`Promise`\<`Readonly`\<`Omit`\<`BrowserRecordingMetadata`, `"ownerUserId"`\>\>[]\>

#### patch()

> **patch**(`id`, `ops`): `Promise`\<[`PluginBrowserRecordingDetail`](PluginBrowserRecordingDetail.md)\>

##### Parameters

###### id

`string`

###### ops

readonly [`PluginBrowserRecordingOp`](PluginBrowserRecordingOp.md)[]

##### Returns

`Promise`\<[`PluginBrowserRecordingDetail`](PluginBrowserRecordingDetail.md)\>

#### setRef()

> **setRef**(`id`, `ref`): `Promise`\<`Readonly`\<`Omit`\<`BrowserRecordingMetadata`, `"ownerUserId"`\>\>\>

##### Parameters

###### id

`string`

###### ref

`BrowserRecordingExternalRef` \| `null`

##### Returns

`Promise`\<`Readonly`\<`Omit`\<`BrowserRecordingMetadata`, `"ownerUserId"`\>\>\>

***

### businessEvents

> **businessEvents**: [`PluginBusinessEvents`](PluginBusinessEvents.md)

***

### chat

> **chat**: `ScopedChat`

***

### config

> `readonly` **config**: `Record`\<`string`, `unknown`\>

***

### connections

> **connections**: [`PluginConnections`](PluginConnections.md)

***

### docs

> **docs**: `object`

#### read()

> **read**(`route`, `heading?`): `Promise`\<`string`\>

##### Parameters

###### route

`string`

###### heading?

`string`

##### Returns

`Promise`\<`string`\>

#### search()

> **search**(`query`, `options?`): `Promise`\<[`PluginDocHit`](PluginDocHit.md)[]\>

##### Parameters

###### query

`string`

###### options?

###### limit?

`number`

##### Returns

`Promise`\<[`PluginDocHit`](PluginDocHit.md)[]\>

***

### events

> **events**: `object`

#### on()

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginTaskEventKind`](PluginTaskEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginTodoEventKind`](PluginTodoEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginUiDocumentEventKind`](PluginUiDocumentEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginQuestionEventKind`](PluginQuestionEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginMissionEventKind`](PluginMissionEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginMemoryEventKind`](PluginMemoryEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginProjectEventKind`](PluginProjectEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginAgentEventKind`](PluginAgentEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginAutomationEventKind`](PluginAutomationEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginBrowserRecordingEventKind`](PluginBrowserRecordingEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**\<`K`\>(`kind`, `handler`): () => `void`

###### Type Parameters

###### K

`K` *extends* [`PluginBrowserAnnotationEventKind`](PluginBrowserAnnotationEventKind.md)

###### Parameters

###### kind

`K`

###### handler

(`ev`) => `void` \| `Promise`\<`void`\>

###### Returns

() => `void`

##### Call Signature

> **on**(`kind`, `handler`): () => `void`

###### Parameters

###### kind

`"mission_complete"` \| `"task_done"` \| `"task_blocked"` \| `"mission_started"` \| `"turn_complete"` \| `"mission_title_changed"` \| `"notifications_changed"` \| `"workflow_run"` \| `"workflow_proposal"`

###### handler

(`ev`) => `void`

###### Returns

() => `void`

***

### fetch?

> `readonly` `optional` **fetch?**: *typeof* `globalThis.fetch`

***

### forge

> **forge**: `object`

#### issues

> **issues**: `object`

##### issues.get()

> **get**(`project`, `number`): `Promise`\<[`PluginForgeIssueDetails`](PluginForgeIssueDetails.md) \| `undefined`\>

###### Parameters

###### project

`string`

###### number

`number`

###### Returns

`Promise`\<[`PluginForgeIssueDetails`](PluginForgeIssueDetails.md) \| `undefined`\>

##### issues.list()

> **list**(`project`, `opts`): `Promise`\<`Readonly`\<\{ `author`: `string` \| `null`; `createdAt`: `string`; `labels`: readonly [`PluginForgeLabel`](PluginForgeLabel.md)[]; `number`: `number`; `state`: `"open"` \| `"closed"`; `title`: `string`; `updatedAt`: `string`; `url`: `string`; \}\>[]\>

###### Parameters

###### project

`string`

###### opts

###### label

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `author`: `string` \| `null`; `createdAt`: `string`; `labels`: readonly [`PluginForgeLabel`](PluginForgeLabel.md)[]; `number`: `number`; `state`: `"open"` \| `"closed"`; `title`: `string`; `updatedAt`: `string`; `url`: `string`; \}\>[]\>

#### proposals

> **proposals**: `object`

##### proposals.get()

> **get**(`project`, `id`): `Promise`\<`Readonly`\<\{ `body`: `string`; `createdAt`: `number`; `id`: `string`; `key`: `string`; `kind`: `"comment"`; `project`: `string`; `publishedAt`: `number` \| `null`; `repo`: `string`; `sourceRef`: `string` \| `null`; `state`: [`PluginForgeProposalState`](PluginForgeProposalState.md); `target`: `Readonly`\<\{ `number`: `number`; `type`: `"issue"` \| `"pull"`; `url`: `string`; \}\>; `updatedAt`: `number`; `url`: `string` \| `null`; \}\> \| `undefined`\>

###### Parameters

###### project

`string`

###### id

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `body`: `string`; `createdAt`: `number`; `id`: `string`; `key`: `string`; `kind`: `"comment"`; `project`: `string`; `publishedAt`: `number` \| `null`; `repo`: `string`; `sourceRef`: `string` \| `null`; `state`: [`PluginForgeProposalState`](PluginForgeProposalState.md); `target`: `Readonly`\<\{ `number`: `number`; `type`: `"issue"` \| `"pull"`; `url`: `string`; \}\>; `updatedAt`: `number`; `url`: `string` \| `null`; \}\> \| `undefined`\>

##### proposals.list()

> **list**(`project`): `Promise`\<`Readonly`\<\{ `body`: `string`; `createdAt`: `number`; `id`: `string`; `key`: `string`; `kind`: `"comment"`; `project`: `string`; `publishedAt`: `number` \| `null`; `repo`: `string`; `sourceRef`: `string` \| `null`; `state`: [`PluginForgeProposalState`](PluginForgeProposalState.md); `target`: `Readonly`\<\{ `number`: `number`; `type`: `"issue"` \| `"pull"`; `url`: `string`; \}\>; `updatedAt`: `number`; `url`: `string` \| `null`; \}\>[]\>

###### Parameters

###### project

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `body`: `string`; `createdAt`: `number`; `id`: `string`; `key`: `string`; `kind`: `"comment"`; `project`: `string`; `publishedAt`: `number` \| `null`; `repo`: `string`; `sourceRef`: `string` \| `null`; `state`: [`PluginForgeProposalState`](PluginForgeProposalState.md); `target`: `Readonly`\<\{ `number`: `number`; `type`: `"issue"` \| `"pull"`; `url`: `string`; \}\>; `updatedAt`: `number`; `url`: `string` \| `null`; \}\>[]\>

#### pulls

> **pulls**: `object`

##### pulls.checks()

> **checks**(`project`, `number`): `Promise`\<`Readonly`\<\{ `checks`: readonly [`PluginForgeCheck`](PluginForgeCheck.md)[]; `draft`: `boolean`; `mergeable`: `"mergeable"` \| `"conflicting"` \| `"unknown"`; `mergeState`: [`PluginForgeMergeState`](PluginForgeMergeState.md); `number`: `number`; `review`: `"approved"` \| `"changes_requested"` \| `"review_required"` \| `null`; `state`: `"open"` \| `"closed"` \| `"merged"`; \}\> \| `undefined`\>

###### Parameters

###### project

`string`

###### number

`number`

###### Returns

`Promise`\<`Readonly`\<\{ `checks`: readonly [`PluginForgeCheck`](PluginForgeCheck.md)[]; `draft`: `boolean`; `mergeable`: `"mergeable"` \| `"conflicting"` \| `"unknown"`; `mergeState`: [`PluginForgeMergeState`](PluginForgeMergeState.md); `number`: `number`; `review`: `"approved"` \| `"changes_requested"` \| `"review_required"` \| `null`; `state`: `"open"` \| `"closed"` \| `"merged"`; \}\> \| `undefined`\>

##### pulls.get()

> **get**(`project`, `number`): `Promise`\<[`PluginForgePullDetails`](PluginForgePullDetails.md) \| `undefined`\>

###### Parameters

###### project

`string`

###### number

`number`

###### Returns

`Promise`\<[`PluginForgePullDetails`](PluginForgePullDetails.md) \| `undefined`\>

##### pulls.list()

> **list**(`project`): `Promise`\<`Readonly`\<\{ `author`: `string` \| `null`; `closingIssues`: readonly [`PluginForgeIssueRef`](PluginForgeIssueRef.md)[]; `headOwner`: `string` \| `null`; `headRepository`: `string` \| `null`; `isDraft`: `boolean`; `labels`: readonly [`PluginForgeLabel`](PluginForgeLabel.md)[]; `maintainerCanModify`: `boolean`; `mergeState`: [`PluginForgeMergeState`](PluginForgeMergeState.md); `number`: `number`; `title`: `string`; `updatedAt`: `string`; `url`: `string`; \}\>[]\>

###### Parameters

###### project

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `author`: `string` \| `null`; `closingIssues`: readonly [`PluginForgeIssueRef`](PluginForgeIssueRef.md)[]; `headOwner`: `string` \| `null`; `headRepository`: `string` \| `null`; `isDraft`: `boolean`; `labels`: readonly [`PluginForgeLabel`](PluginForgeLabel.md)[]; `maintainerCanModify`: `boolean`; `mergeState`: [`PluginForgeMergeState`](PluginForgeMergeState.md); `number`: `number`; `title`: `string`; `updatedAt`: `string`; `url`: `string`; \}\>[]\>

#### propose()

> **propose**(`project`, `input`): `Promise`\<`Readonly`\<\{ `created`: `boolean`; `proposal`: [`PluginForgeProposal`](PluginForgeProposal.md); \}\>\>

##### Parameters

###### project

`string`

###### input

[`PluginForgeProposalInput`](PluginForgeProposalInput.md)

##### Returns

`Promise`\<`Readonly`\<\{ `created`: `boolean`; `proposal`: [`PluginForgeProposal`](PluginForgeProposal.md); \}\>\>

#### repository()

> **repository**(`project`): `Promise`\<`Readonly`\<\{ `project`: `string`; `repo`: `string`; `url`: `string`; \}\> \| `undefined`\>

##### Parameters

###### project

`string`

##### Returns

`Promise`\<`Readonly`\<\{ `project`: `string`; `repo`: `string`; `url`: `string`; \}\> \| `undefined`\>

***

### host

> **host**: `object`

#### exec()

> **exec**(`bin`, `args?`, `opts?`): `Promise`\<[`PluginExecResult`](PluginExecResult.md)\>

##### Parameters

###### bin

`string`

###### args?

readonly `string`[]

###### opts?

###### cwd?

`string`

##### Returns

`Promise`\<[`PluginExecResult`](PluginExecResult.md)\>

***

### id

> `readonly` **id**: `string`

***

### kanban

> **kanban**: `object`

#### refs

> **refs**: `object`

##### refs.findByRef()

> **findByRef**(`provider`, `ref`): `Promise`\<[`PluginTask`](PluginTask.md) \| `undefined`\>

###### Parameters

###### provider

`string`

###### ref

`string`

###### Returns

`Promise`\<[`PluginTask`](PluginTask.md) \| `undefined`\>

##### refs.list()

> **list**(`taskId`): `Promise`\<[`PluginTaskLink`](PluginTaskLink.md)[]\>

###### Parameters

###### taskId

`string`

###### Returns

`Promise`\<[`PluginTaskLink`](PluginTaskLink.md)[]\>

##### refs.remove()

> **remove**(`taskId`, `provider`, `ref`): `Promise`\<`boolean`\>

###### Parameters

###### taskId

`string`

###### provider

`string`

###### ref

`string`

###### Returns

`Promise`\<`boolean`\>

##### refs.set()

> **set**(`taskId`, `link`): `Promise`\<[`PluginTaskLink`](PluginTaskLink.md)\>

###### Parameters

###### taskId

`string`

###### link

[`PluginTaskLinkInput`](PluginTaskLinkInput.md)

###### Returns

`Promise`\<[`PluginTaskLink`](PluginTaskLink.md)\>

#### todos

> **todos**: [`PluginTodos`](PluginTodos.md)

#### add()

> **add**(`task`): `Promise`\<[`PluginTask`](PluginTask.md)\>

##### Parameters

###### task

[`PluginTaskInput`](PluginTaskInput.md)

##### Returns

`Promise`\<[`PluginTask`](PluginTask.md)\>

#### block()

> **block**(`id`, `reason`): `Promise`\<[`PluginTask`](PluginTask.md)\>

##### Parameters

###### id

`string`

###### reason

`string`

##### Returns

`Promise`\<[`PluginTask`](PluginTask.md)\>

#### delete()

> **delete**(`id`, `opts?`): `Promise`\<\{ `deleted`: `string`[]; \}\>

##### Parameters

###### id

`string`

###### opts?

###### chain?

`boolean`

##### Returns

`Promise`\<\{ `deleted`: `string`[]; \}\>

#### done()

> **done**(`id`, `input`): `Promise`\<[`PluginTask`](PluginTask.md)\>

##### Parameters

###### id

`string`

###### input

[`PluginTaskDoneInput`](PluginTaskDoneInput.md)

##### Returns

`Promise`\<[`PluginTask`](PluginTask.md)\>

#### ensure()

> **ensure**(`task`, `links`): `Promise`\<\{ `created`: `boolean`; `task`: [`PluginTask`](PluginTask.md); \}\>

##### Parameters

###### task

[`PluginTaskInput`](PluginTaskInput.md)

###### links

readonly [`PluginTaskLinkInput`](PluginTaskLinkInput.md)[]

##### Returns

`Promise`\<\{ `created`: `boolean`; `task`: [`PluginTask`](PluginTask.md); \}\>

#### get()

> **get**(`id`): `Promise`\<[`PluginTask`](PluginTask.md) \| `undefined`\>

##### Parameters

###### id

`string`

##### Returns

`Promise`\<[`PluginTask`](PluginTask.md) \| `undefined`\>

#### list()

> **list**(`filter?`): `Promise`\<[`PluginTask`](PluginTask.md)[]\>

##### Parameters

###### filter?

[`PluginTaskFilter`](PluginTaskFilter.md)

##### Returns

`Promise`\<[`PluginTask`](PluginTask.md)[]\>

#### update()

> **update**(`id`, `patch`): `Promise`\<[`PluginTask`](PluginTask.md)\>

##### Parameters

###### id

`string`

###### patch

[`PluginTaskPatch`](PluginTaskPatch.md)

##### Returns

`Promise`\<[`PluginTask`](PluginTask.md)\>

***

### layout

> **layout**: `Omit`\<`ScopedLayout`, `"navigate"` \| `"onboardingProfile"`\>

***

### license

> **license**: `object`

#### edition()

> **edition**(): `Promise`\<[`PluginEdition`](PluginEdition.md)\>

##### Returns

`Promise`\<[`PluginEdition`](PluginEdition.md)\>

***

### log

> `readonly` **log**: [`PluginLog`](PluginLog.md)

***

### mcp

> **mcp**: `object`

#### issueToken()

> **issueToken**(`input`): `Promise`\<[`PluginMcpToken`](PluginMcpToken.md)\>

##### Parameters

###### input

[`PluginMcpTokenInput`](PluginMcpTokenInput.md)

##### Returns

`Promise`\<[`PluginMcpToken`](PluginMcpToken.md)\>

#### revokeToken()

> **revokeToken**(`tokenId`): `Promise`\<`boolean`\>

##### Parameters

###### tokenId

`string`

##### Returns

`Promise`\<`boolean`\>

***

### mcpServers

> **mcpServers**: [`PluginMcpServers`](PluginMcpServers.md)

***

### memory

> **memory**: `object`

#### rules

> **rules**: `object`

##### rules.add()

> **add**(`input`): `Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `createdAt`: `number`; `id`: `number`; `kind`: `string`; `mine`: `boolean`; `project`: `string` \| `null`; `role`: `string` \| `null`; `scope`: `string`; `source`: `string`; `status`: `string`; `text`: `string`; `tier`: `string`; \}\>\>

###### Parameters

###### input

[`PluginMemoryRuleInput`](PluginMemoryRuleInput.md)

###### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `createdAt`: `number`; `id`: `number`; `kind`: `string`; `mine`: `boolean`; `project`: `string` \| `null`; `role`: `string` \| `null`; `scope`: `string`; `source`: `string`; `status`: `string`; `text`: `string`; `tier`: `string`; \}\>\>

##### rules.list()

> **list**(`filter?`): `Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `createdAt`: `number`; `id`: `number`; `kind`: `string`; `mine`: `boolean`; `project`: `string` \| `null`; `role`: `string` \| `null`; `scope`: `string`; `source`: `string`; `status`: `string`; `text`: `string`; `tier`: `string`; \}\>[]\>

###### Parameters

###### filter?

[`PluginMemoryRuleFilter`](PluginMemoryRuleFilter.md)

###### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `createdAt`: `number`; `id`: `number`; `kind`: `string`; `mine`: `boolean`; `project`: `string` \| `null`; `role`: `string` \| `null`; `scope`: `string`; `source`: `string`; `status`: `string`; `text`: `string`; `tier`: `string`; \}\>[]\>

##### rules.rm()

> **rm**(`id`): `Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `createdAt`: `number`; `id`: `number`; `kind`: `string`; `mine`: `boolean`; `project`: `string` \| `null`; `role`: `string` \| `null`; `scope`: `string`; `source`: `string`; `status`: `string`; `text`: `string`; `tier`: `string`; \}\>\>

###### Parameters

###### id

`number`

###### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `createdAt`: `number`; `id`: `number`; `kind`: `string`; `mine`: `boolean`; `project`: `string` \| `null`; `role`: `string` \| `null`; `scope`: `string`; `source`: `string`; `status`: `string`; `text`: `string`; `tier`: `string`; \}\>\>

#### overview()

> **overview**(): `Promise`\<`MemoryOverview`\>

##### Returns

`Promise`\<`MemoryOverview`\>

#### search()

> **search**(`query`): `Promise`\<`MemorySearchResult`\>

##### Parameters

###### query

`string`

##### Returns

`Promise`\<`MemorySearchResult`\>

#### show()

##### Call Signature

> **show**(`scope`, `id`): `Promise`\<`Readonly`\<\{ `modified`: `number`; `name`: `string`; `size`: `number`; \}\>[]\>

###### Parameters

###### scope

[`PluginMemoryTargetScope`](PluginMemoryTargetScope.md)

###### id

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `modified`: `number`; `name`: `string`; `size`: `number`; \}\>[]\>

##### Call Signature

> **show**(`scope`, `id`, `file`): `Promise`\<`Readonly`\<\{ `content`: `string`; `name`: `string`; \}\>\>

###### Parameters

###### scope

[`PluginMemoryTargetScope`](PluginMemoryTargetScope.md)

###### id

`string`

###### file

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `content`: `string`; `name`: `string`; \}\>\>

***

### messages

> **messages**: [`PluginMessages`](PluginMessages.md)

***

### missions

> **missions**: `object`

#### fork()

> **fork**(`missionId`, `input`): `Promise`\<[`PluginMissionFork`](PluginMissionFork.md)\>

##### Parameters

###### missionId

`string`

###### input

[`PluginMissionForkInput`](PluginMissionForkInput.md)

##### Returns

`Promise`\<[`PluginMissionFork`](PluginMissionFork.md)\>

#### get()

> **get**(`id`): `Promise`\<`unknown`\>

##### Parameters

###### id

`string`

##### Returns

`Promise`\<`unknown`\>

#### kill()

> **kill**(`missionId`): `Promise`\<\{ `outcome`: `"killed"` \| `"closed"`; \}\>

##### Parameters

###### missionId

`string`

##### Returns

`Promise`\<\{ `outcome`: `"killed"` \| `"closed"`; \}\>

#### list()

> **list**(`opts?`): `Promise`\<`unknown`[]\>

##### Parameters

###### opts?

###### agents?

`string`[]

###### limit?

`number`

###### status?

`string`

##### Returns

`Promise`\<`unknown`[]\>

#### rename()

> **rename**(`missionId`, `title`): `Promise`\<\{ `title`: `string` \| `null`; \}\>

##### Parameters

###### missionId

`string`

###### title

`string` \| `null`

##### Returns

`Promise`\<\{ `title`: `string` \| `null`; \}\>

#### search()

> **search**(`q`, `filter?`): `Promise`\<[`PluginMissionSearchResult`](PluginMissionSearchResult.md)\>

##### Parameters

###### q

`string`

###### filter?

[`PluginMissionSearchFilter`](PluginMissionSearchFilter.md)

##### Returns

`Promise`\<[`PluginMissionSearchResult`](PluginMissionSearchResult.md)\>

#### send()

> **send**(`missionId`, `text`): `Promise`\<[`PluginMissionSendResult`](PluginMissionSendResult.md)\>

##### Parameters

###### missionId

`string`

###### text

`string`

##### Returns

`Promise`\<[`PluginMissionSendResult`](PluginMissionSendResult.md)\>

#### spawn()

> **spawn**(`input`): `Promise`\<`string`\>

##### Parameters

###### input

[`PluginMissionInput`](PluginMissionInput.md)

##### Returns

`Promise`\<`string`\>

#### stopScope()

> **stopScope**(`scope`): `Promise`\<`Readonly`\<`Record`\<`string`, `unknown`\>\>\>

##### Parameters

###### scope

[`PluginStopScope`](PluginStopScope.md)

##### Returns

`Promise`\<`Readonly`\<`Record`\<`string`, `unknown`\>\>\>

#### summarize()

> **summarize**(`missionId`, `opts?`): `Promise`\<[`PluginMissionSummary`](PluginMissionSummary.md)\>

##### Parameters

###### missionId

`string`

###### opts?

###### force?

`boolean`

##### Returns

`Promise`\<[`PluginMissionSummary`](PluginMissionSummary.md)\>

***

### modules

> **modules**: `object`

#### list()

> **list**(): `Promise`\<[`PluginModuleInfo`](PluginModuleInfo.md)[]\>

##### Returns

`Promise`\<[`PluginModuleInfo`](PluginModuleInfo.md)[]\>

***

### notifications

> **notifications**: [`PluginNotifications`](PluginNotifications.md)

***

### notify

> **notify**: `object`

#### alert()

> **alert**(`title`, `body?`, `opts?`): `void`

##### Parameters

###### title

`string`

###### body?

`string`

###### opts?

###### urgent?

`boolean`

##### Returns

`void`

#### report()

> **report**(`title`, `body?`): `void`

##### Parameters

###### title

`string`

###### body?

`string`

##### Returns

`void`

***

### onboarding

> **onboarding**: `object`

#### profile

> **profile**: `ScopedLayout`\[`"onboardingProfile"`\]

***

### outbox

> **outbox**: [`PluginOutbox`](PluginOutbox.md)

***

### permissions

> `readonly` **permissions**: readonly [`PluginPermission`](PluginPermission.md)[]

***

### permissionSource

> **permissionSource**: [`PluginPermissionSource`](PluginPermissionSource.md)

***

### pipelines

> **pipelines**: `object`

#### create()

> **create**(`input`): `Promise`\<[`PluginOwnPipeline`](PluginOwnPipeline.md)\>

##### Parameters

###### input

[`PluginPipelineInput`](PluginPipelineInput.md)

##### Returns

`Promise`\<[`PluginOwnPipeline`](PluginOwnPipeline.md)\>

#### delete()

> **delete**(`pipelineId`): `Promise`\<`boolean`\>

##### Parameters

###### pipelineId

`string`

##### Returns

`Promise`\<`boolean`\>

#### get()

> **get**(`pipelineId`): `Promise`\<[`PluginPipeline`](PluginPipeline.md) \| [`PluginOwnPipeline`](PluginOwnPipeline.md) \| `undefined`\>

##### Parameters

###### pipelineId

`string`

##### Returns

`Promise`\<[`PluginPipeline`](PluginPipeline.md) \| [`PluginOwnPipeline`](PluginOwnPipeline.md) \| `undefined`\>

#### list()

> **list**(): `Promise`\<([`PluginPipeline`](PluginPipeline.md) \| [`PluginOwnPipeline`](PluginOwnPipeline.md))[]\>

##### Returns

`Promise`\<([`PluginPipeline`](PluginPipeline.md) \| [`PluginOwnPipeline`](PluginOwnPipeline.md))[]\>

#### run()

> **run**(`pipelineId`, `input?`): `Promise`\<[`PluginPipelineRun`](PluginPipelineRun.md)\>

##### Parameters

###### pipelineId

`string`

###### input?

`Record`\<`string`, `unknown`\>

##### Returns

`Promise`\<[`PluginPipelineRun`](PluginPipelineRun.md)\>

#### runStatus()

> **runStatus**(`runId`): `Promise`\<[`PluginPipelineRunStatus`](PluginPipelineRunStatus.md) \| `undefined`\>

##### Parameters

###### runId

`string`

##### Returns

`Promise`\<[`PluginPipelineRunStatus`](PluginPipelineRunStatus.md) \| `undefined`\>

***

### plugins

> **plugins**: `object`

#### list()

> **list**(): `Promise`\<[`PluginInfo`](PluginInfo.md)[]\>

##### Returns

`Promise`\<[`PluginInfo`](PluginInfo.md)[]\>

#### setEnabled()

> **setEnabled**(`pluginId`, `enabled`): `Promise`\<`boolean`\>

##### Parameters

###### pluginId

`string`

###### enabled

`boolean`

##### Returns

`Promise`\<`boolean`\>

***

### projects

> **projects**: `object`

#### create()

> **create**(`input`): `Promise`\<`Readonly`\<\{ `project`: [`PluginProject`](PluginProject.md); `warnings`: readonly [`PluginProjectWarning`](PluginProjectWarning.md)[]; \}\>\>

##### Parameters

###### input

[`PluginProjectInput`](PluginProjectInput.md)

##### Returns

`Promise`\<`Readonly`\<\{ `project`: [`PluginProject`](PluginProject.md); `warnings`: readonly [`PluginProjectWarning`](PluginProjectWarning.md)[]; \}\>\>

#### get()

> **get**(`slug`): `Promise`\<`Readonly`\<\{ `color`: `string` \| `null`; `createdBy`: `string` \| `null`; `cwd`: `string` \| `null`; `icon`: `string` \| `null`; `kind`: `string` \| `null`; `lastActivity`: `number` \| `null`; `mine`: `boolean`; `name`: `string` \| `null`; `slug`: `string`; `speech`: `string` \| `null`; `status`: `string`; `workspace`: `string` \| `null`; \}\> \| `undefined`\>

##### Parameters

###### slug

`string`

##### Returns

`Promise`\<`Readonly`\<\{ `color`: `string` \| `null`; `createdBy`: `string` \| `null`; `cwd`: `string` \| `null`; `icon`: `string` \| `null`; `kind`: `string` \| `null`; `lastActivity`: `number` \| `null`; `mine`: `boolean`; `name`: `string` \| `null`; `slug`: `string`; `speech`: `string` \| `null`; `status`: `string`; `workspace`: `string` \| `null`; \}\> \| `undefined`\>

#### list()

> **list**(): `Promise`\<`Readonly`\<\{ `color`: `string` \| `null`; `createdBy`: `string` \| `null`; `cwd`: `string` \| `null`; `icon`: `string` \| `null`; `kind`: `string` \| `null`; `lastActivity`: `number` \| `null`; `mine`: `boolean`; `name`: `string` \| `null`; `slug`: `string`; `speech`: `string` \| `null`; `status`: `string`; `workspace`: `string` \| `null`; \}\>[]\>

##### Returns

`Promise`\<`Readonly`\<\{ `color`: `string` \| `null`; `createdBy`: `string` \| `null`; `cwd`: `string` \| `null`; `icon`: `string` \| `null`; `kind`: `string` \| `null`; `lastActivity`: `number` \| `null`; `mine`: `boolean`; `name`: `string` \| `null`; `slug`: `string`; `speech`: `string` \| `null`; `status`: `string`; `workspace`: `string` \| `null`; \}\>[]\>

#### roles()

> **roles**(`slug`): `Promise`\<`Readonly`\<`Partial`\<`Record`\<`TaskRole`, `Readonly`\<\{ `agent`: `string`; `backend?`: `string` \| `null`; `model?`: `string` \| `null`; `permissionMode?`: `string` \| `null`; \}\>\>\>\>\>

##### Parameters

###### slug

`string`

##### Returns

`Promise`\<`Readonly`\<`Partial`\<`Record`\<`TaskRole`, `Readonly`\<\{ `agent`: `string`; `backend?`: `string` \| `null`; `model?`: `string` \| `null`; `permissionMode?`: `string` \| `null`; \}\>\>\>\>\>

#### setRole()

> **setRole**(`slug`, `role`, `spec`): `Promise`\<`Readonly`\<`Partial`\<`Record`\<`TaskRole`, `Readonly`\<\{ `agent`: `string`; `backend?`: `string` \| `null`; `model?`: `string` \| `null`; `permissionMode?`: `string` \| `null`; \}\>\>\>\>\>

##### Parameters

###### slug

`string`

###### role

`string`

###### spec

[`PluginRoleInput`](PluginRoleInput.md) \| `null`

##### Returns

`Promise`\<`Readonly`\<`Partial`\<`Record`\<`TaskRole`, `Readonly`\<\{ `agent`: `string`; `backend?`: `string` \| `null`; `model?`: `string` \| `null`; `permissionMode?`: `string` \| `null`; \}\>\>\>\>\>

#### update()

> **update**(`slug`, `patch`): `Promise`\<`Readonly`\<\{ `project`: [`PluginProject`](PluginProject.md); `warnings`: readonly [`PluginProjectWarning`](PluginProjectWarning.md)[]; \}\>\>

##### Parameters

###### slug

`string`

###### patch

[`PluginProjectPatch`](PluginProjectPatch.md)

##### Returns

`Promise`\<`Readonly`\<\{ `project`: [`PluginProject`](PluginProject.md); `warnings`: readonly [`PluginProjectWarning`](PluginProjectWarning.md)[]; \}\>\>

#### workspaces()

> **workspaces**(): `Promise`\<`Readonly`\<\{ `color`: `string` \| `null`; `leadAgent`: `string` \| `null`; `name`: `string`; `projects`: readonly `string`[]; `slug`: `string`; \}\>[]\>

##### Returns

`Promise`\<`Readonly`\<\{ `color`: `string` \| `null`; `leadAgent`: `string` \| `null`; `name`: `string`; `projects`: readonly `string`[]; `slug`: `string`; \}\>[]\>

***

### provider

> **provider**: `ProviderServices`

***

### questions

> **questions**: [`PluginQuestions`](PluginQuestions.md)

***

### realtime

> **realtime**: [`PluginRealtime`](PluginRealtime.md)

***

### routines

> **routines**: `object`

#### create()

> **create**(`input`): `Promise`\<[`PluginRoutine`](PluginRoutine.md)\>

##### Parameters

###### input

[`PluginRoutineInput`](PluginRoutineInput.md)

##### Returns

`Promise`\<[`PluginRoutine`](PluginRoutine.md)\>

#### delete()

> **delete**(`routineId`): `Promise`\<`boolean`\>

##### Parameters

###### routineId

`string`

##### Returns

`Promise`\<`boolean`\>

#### list()

> **list**(): `Promise`\<[`PluginRoutine`](PluginRoutine.md)[]\>

##### Returns

`Promise`\<[`PluginRoutine`](PluginRoutine.md)[]\>

#### update()

> **update**(`routineId`, `patch`): `Promise`\<[`PluginRoutine`](PluginRoutine.md)\>

##### Parameters

###### routineId

`string`

###### patch

[`PluginRoutinePatch`](PluginRoutinePatch.md)

##### Returns

`Promise`\<[`PluginRoutine`](PluginRoutine.md)\>

***

### secrets

> **secrets**: [`PluginSecrets`](PluginSecrets.md)

***

### series

> **series**: `object`

#### fallback

> **fallback**: `object`

##### fallback.clear()

> **clear**(`seriesId`, `scope`, `group?`): `Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

###### Parameters

###### seriesId

`string`

###### scope

`string`

###### group?

`string` \| `null`

###### Returns

`Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

##### fallback.list()

> **list**(`seriesId`): `Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

###### Parameters

###### seriesId

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

##### fallback.set()

> **set**(`seriesId`, `rule`): `Promise`\<`Readonly`\<\{ `applied`: \{ `backend`: `string`; `model`: `string` \| `null`; \} \| `null`; `applyError`: `string` \| `null`; `rules`: readonly [`PluginSeriesRule`](PluginSeriesRule.md)[]; \}\>\>

###### Parameters

###### seriesId

`string`

###### rule

[`PluginSeriesFallbackInput`](PluginSeriesFallbackInput.md)

###### Returns

`Promise`\<`Readonly`\<\{ `applied`: \{ `backend`: `string`; `model`: `string` \| `null`; \} \| `null`; `applyError`: `string` \| `null`; `rules`: readonly [`PluginSeriesRule`](PluginSeriesRule.md)[]; \}\>\>

#### role

> **role**: `object`

##### role.clear()

> **clear**(`seriesId`, `scope`, `group?`): `Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

###### Parameters

###### seriesId

`string`

###### scope

`string`

###### group?

`string` \| `null`

###### Returns

`Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

##### role.list()

> **list**(`seriesId`): `Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

###### Parameters

###### seriesId

`string`

###### Returns

`Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

##### role.set()

> **set**(`seriesId`, `choice`): `Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

###### Parameters

###### seriesId

`string`

###### choice

[`PluginSeriesRoleInput`](PluginSeriesRoleInput.md)

###### Returns

`Promise`\<`Readonly`\<\{ `backend`: `string` \| `null`; `model`: `string` \| `null`; `planGroup`: `string` \| `null`; `scope`: `string`; `updatedAt`: `number`; \}\>[]\>

***

### settings

> **settings**: `object`

#### get()

> **get**(`key`): [`PluginSettingValue`](PluginSettingValue.md)

##### Parameters

###### key

`string`

##### Returns

[`PluginSettingValue`](PluginSettingValue.md)

***

### skills

> **skills**: [`PluginSkills`](PluginSkills.md)

***

### sql

> **sql**: [`PluginSqlDatabase`](PluginSqlDatabase.md)

***

### storage

> **storage**: [`PluginStorage`](PluginStorage.md)

***

### system

> **system**: `object`

#### doctor()

> **doctor**(): `Promise`\<[`PluginDoctorReport`](PluginDoctorReport.md)\>

##### Returns

`Promise`\<[`PluginDoctorReport`](PluginDoctorReport.md)\>

#### health()

> **health**(): `Promise`\<[`PluginSystemHealth`](PluginSystemHealth.md)\>

##### Returns

`Promise`\<[`PluginSystemHealth`](PluginSystemHealth.md)\>

#### logs()

> **logs**(`options?`): `Promise`\<`string`[]\>

##### Parameters

###### options?

[`PluginLogsOptions`](PluginLogsOptions.md)

##### Returns

`Promise`\<`string`[]\>

***

### traces

> **traces**: `object`

#### get()

> **get**(`id`, `opts?`): `Promise`\<`unknown`\>

##### Parameters

###### id

`string`

###### opts?

[`PluginTraceOptions`](PluginTraceOptions.md)

##### Returns

`Promise`\<`unknown`\>

***

### transports

> **transports**: [`PluginTransports`](PluginTransports.md)

***

### triggers

> **triggers**: `object`

#### create()

> **create**(`input`): `Promise`\<[`PluginTriggerCreated`](PluginTriggerCreated.md)\>

##### Parameters

###### input

[`PluginTriggerInput`](PluginTriggerInput.md)

##### Returns

`Promise`\<[`PluginTriggerCreated`](PluginTriggerCreated.md)\>

#### disable()

> **disable**(`triggerId`): `Promise`\<`boolean`\>

##### Parameters

###### triggerId

`string`

##### Returns

`Promise`\<`boolean`\>

#### get()

> **get**(`triggerId`): `Promise`\<[`PluginTriggerInfo`](PluginTriggerInfo.md) \| [`PluginOwnTrigger`](PluginOwnTrigger.md) \| `undefined`\>

##### Parameters

###### triggerId

`string`

##### Returns

`Promise`\<[`PluginTriggerInfo`](PluginTriggerInfo.md) \| [`PluginOwnTrigger`](PluginOwnTrigger.md) \| `undefined`\>

#### list()

> **list**(): `Promise`\<[`PluginTriggerInfo`](PluginTriggerInfo.md)[]\>

##### Returns

`Promise`\<[`PluginTriggerInfo`](PluginTriggerInfo.md)[]\>

#### remove()

> **remove**(`triggerId`): `Promise`\<`boolean`\>

##### Parameters

###### triggerId

`string`

##### Returns

`Promise`\<`boolean`\>

#### test()

> **test**(`triggerId`, `options?`): `Promise`\<[`PluginTriggerTestResult`](PluginTriggerTestResult.md)\>

##### Parameters

###### triggerId

`string`

###### options?

[`PluginTriggerTestOptions`](PluginTriggerTestOptions.md)

##### Returns

`Promise`\<[`PluginTriggerTestResult`](PluginTriggerTestResult.md)\>

***

### ui

> **ui**: `object`

#### documents

> **documents**: [`PluginUiDocuments`](PluginUiDocuments.md)

#### navigate

> **navigate**: `ScopedLayout`\[`"navigate"`\]

#### token()

> **token**(): `string`

##### Returns

`string`

***

### usage

> **usage**: `object`

#### get()

> **get**(`backend`, `options?`): `Promise`\<[`UsageEntry`](UsageEntry.md) \| `null`\>

##### Parameters

###### backend

`string`

###### options?

[`UsageProbeOptions`](UsageProbeOptions.md)

##### Returns

`Promise`\<[`UsageEntry`](UsageEntry.md) \| `null`\>

#### list()

> **list**(`options?`): `Promise`\<[`UsageEntry`](UsageEntry.md)[]\>

##### Parameters

###### options?

[`UsageProbeOptions`](UsageProbeOptions.md)

##### Returns

`Promise`\<[`UsageEntry`](UsageEntry.md)[]\>

#### registerCollector()

> **registerCollector**(`backend`, `collect`): () => `void`

##### Parameters

###### backend

`string`

###### collect

[`UsageCollector`](UsageCollector.md)

##### Returns

() => `void`

***

### users

> **users**: `object`

#### get()

> **get**(`userId`): `Promise`\<[`PluginAccountUser`](PluginAccountUser.md) \| `undefined`\>

##### Parameters

###### userId

`string`

##### Returns

`Promise`\<[`PluginAccountUser`](PluginAccountUser.md) \| `undefined`\>

#### list()

> **list**(): `Promise`\<[`PluginAccountUser`](PluginAccountUser.md)[]\>

##### Returns

`Promise`\<[`PluginAccountUser`](PluginAccountUser.md)[]\>

#### setStatus()

> **setStatus**(`userId`, `status`): `Promise`\<[`PluginAccountUser`](PluginAccountUser.md)\>

##### Parameters

###### userId

`string`

###### status

`"active"` \| `"disabled"`

##### Returns

`Promise`\<[`PluginAccountUser`](PluginAccountUser.md)\>

***

### version

> `readonly` **version**: `string`

***

### webhooks

> **webhooks**: `object`

#### asOwner()

> **asOwner**\<`T`\>(`name`, `fn`): `Promise`\<[`PluginWebhookOwnerRun`](PluginWebhookOwnerRun.md)\<`T`\>\>

##### Type Parameters

###### T

`T`

##### Parameters

###### name

`string`

###### fn

() => `T` \| `Promise`\<`T`\>

##### Returns

`Promise`\<[`PluginWebhookOwnerRun`](PluginWebhookOwnerRun.md)\<`T`\>\>

#### on()

> **on**(`name`, `handler`): () => `void`

##### Parameters

###### name

`string`

###### handler

[`PluginWebhookHandler`](PluginWebhookHandler.md)

##### Returns

() => `void`

***

### workflows

> **workflows**: [`PluginWorkflows`](PluginWorkflows.md) & `object`

#### Type Declaration

##### cancel()

> **cancel**(`runId`): `Promise`\<`boolean`\>

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<`boolean`\>

##### get()

> **get**(`workflowId`): `Promise`\<[`PluginWorkflowDetail`](PluginWorkflowDetail.md) \| `undefined`\>

###### Parameters

###### workflowId

`string`

###### Returns

`Promise`\<[`PluginWorkflowDetail`](PluginWorkflowDetail.md) \| `undefined`\>

##### list()

> **list**(): `Promise`\<[`PluginWorkflow`](PluginWorkflow.md)[]\>

###### Returns

`Promise`\<[`PluginWorkflow`](PluginWorkflow.md)[]\>

##### run()

> **run**(`workflowId`, `input?`): `Promise`\<[`PluginWorkflowRun`](PluginWorkflowRun.md)\>

###### Parameters

###### workflowId

`string`

###### input?

`unknown`

###### Returns

`Promise`\<[`PluginWorkflowRun`](PluginWorkflowRun.md)\>

##### status()

> **status**(`runId`): `Promise`\<[`PluginWorkflowRunStatus`](PluginWorkflowRunStatus.md) \| `undefined`\>

###### Parameters

###### runId

`string`

###### Returns

`Promise`\<[`PluginWorkflowRunStatus`](PluginWorkflowRunStatus.md) \| `undefined`\>

***

### worktrees

> **worktrees**: `object`

#### create()

> **create**(`taskId`, `opts?`): `Promise`\<`Readonly`\<\{ `base`: `string` \| `null`; `branch`: `string` \| `null`; `mergedCommitSha`: `string` \| `null`; `path`: `string` \| `null`; `taskId`: `string`; \}\>\>

##### Parameters

###### taskId

`string`

###### opts?

###### base?

`string`

##### Returns

`Promise`\<`Readonly`\<\{ `base`: `string` \| `null`; `branch`: `string` \| `null`; `mergedCommitSha`: `string` \| `null`; `path`: `string` \| `null`; `taskId`: `string`; \}\>\>

#### dispose()

> **dispose**(`taskId`, `opts?`): `Promise`\<\{ `disposed`: `boolean`; \}\>

##### Parameters

###### taskId

`string`

###### opts?

###### force?

`boolean`

##### Returns

`Promise`\<\{ `disposed`: `boolean`; \}\>

#### info()

> **info**(`taskId`): `Promise`\<`Readonly`\<\{ `base`: `string` \| `null`; `branch`: `string` \| `null`; `mergedCommitSha`: `string` \| `null`; `path`: `string` \| `null`; `taskId`: `string`; \}\> \| `undefined`\>

##### Parameters

###### taskId

`string`

##### Returns

`Promise`\<`Readonly`\<\{ `base`: `string` \| `null`; `branch`: `string` \| `null`; `mergedCommitSha`: `string` \| `null`; `path`: `string` \| `null`; `taskId`: `string`; \}\> \| `undefined`\>

## Methods

### assert()

> **assert**(`permission`): `void`

#### Parameters

##### permission

[`PluginPermission`](PluginPermission.md)

#### Returns

`void`

***

### assertPermission()

> **assertPermission**(`permission`): `void`

#### Parameters

##### permission

`string`

#### Returns

`void`

***

### can()

> **can**(`permission`): `boolean`

#### Parameters

##### permission

[`PluginPermission`](PluginPermission.md)

#### Returns

`boolean`

***

### effect()

#### Call Signature

> **effect**(`fn`): [`PluginEffectHandle`](PluginEffectHandle.md)

##### Parameters

###### fn

() => `void` \| [`PluginSyncEffect`](PluginSyncEffect.md)

##### Returns

[`PluginEffectHandle`](PluginEffectHandle.md)

#### Call Signature

> **effect**(`fn`): [`PluginAsyncEffectHandle`](PluginAsyncEffectHandle.md)

##### Parameters

###### fn

() => `void` \| [`PluginEffect`](PluginEffect.md)

##### Returns

[`PluginAsyncEffectHandle`](PluginAsyncEffectHandle.md)

***

### router()

> **router**(`prefix?`): `Router`

#### Parameters

##### prefix?

`string`

#### Returns

`Router`

***

### user()

> **user**(): [`PluginUser`](PluginUser.md) \| `undefined`

#### Returns

[`PluginUser`](PluginUser.md) \| `undefined`
