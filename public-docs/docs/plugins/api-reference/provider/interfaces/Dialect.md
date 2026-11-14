
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Interface: Dialect

## Properties

### appliesPermissionMode?

> `readonly` `optional` **appliesPermissionMode?**: `boolean`

***

### browserToolsHint?

> `readonly` `optional` **browserToolsHint?**: `string`

***

### capabilities?

> `readonly` `optional` **capabilities?**: `Partial`\<[`BackendCapabilities`](../type-aliases/BackendCapabilities.md)\>

***

### defaultCmd

> `readonly` **defaultCmd**: `string`

***

### finishMissionOnExit

> `readonly` **finishMissionOnExit**: `boolean`

***

### hostedConnectors

> `readonly` **hostedConnectors**: `boolean`

***

### id

> `readonly` **id**: `string`

***

### localEnv?

> `readonly` `optional` **localEnv?**: [`LocalEnvPolicy`](../type-aliases/LocalEnvPolicy.md)

***

### maxPromptBytes?

> `readonly` `optional` **maxPromptBytes?**: `number`

***

### nativeCompact?

> `readonly` `optional` **nativeCompact?**: `object`

#### command

> `readonly` **command**: `string`

***

### nestedSandbox?

> `readonly` `optional` **nestedSandbox?**: [`NestedSandboxDeclaration`](../type-aliases/NestedSandboxDeclaration.md)

***

### permissionModel

> `readonly` **permissionModel**: `"none"` \| `"mcp-bridge"` \| `"sandbox"` \| `"protocol"`

***

### permissionsHint?

> `readonly` `optional` **permissionsHint?**: `string`

***

### persistentProcess

> `readonly` **persistentProcess**: `boolean`

***

### rateLimitReporting

> `readonly` **rateLimitReporting**: `"none"` \| `"structured"` \| `"textual"`

***

### sessionResumable

> `readonly` **sessionResumable**: `boolean`

***

### sessionStore

> `readonly` **sessionStore**: `"global"` \| `"per-mission"`

***

### supportedPermissionModes?

> `readonly` `optional` **supportedPermissionModes?**: readonly `string`[]

***

### thinkingControls?

> `readonly` `optional` **thinkingControls?**: readonly (`"levels"` \| `"budget"` \| `"toggle"`)[]

## Methods

### accountUsage()?

> `optional` **accountUsage**(`profile`, `options?`): `Promise`\<[`AccountUsage`](../type-aliases/AccountUsage.md) \| `null`\>

#### Parameters

##### profile

[`ProfileRuntime`](../type-aliases/ProfileRuntime.md)

##### options?

[`UsageProbeOptions`](../type-aliases/UsageProbeOptions.md)

#### Returns

`Promise`\<[`AccountUsage`](../type-aliases/AccountUsage.md) \| `null`\>

***

### buildSpawn()

> **buildSpawn**(`opts`, `profile`): `Promise`\<[`SpawnResult`](../type-aliases/SpawnResult.md)\>

#### Parameters

##### opts

[`BuildSpawnOpts`](../type-aliases/BuildSpawnOpts.md)

##### profile

[`ProfileRuntime`](../type-aliases/ProfileRuntime.md)

#### Returns

`Promise`\<[`SpawnResult`](../type-aliases/SpawnResult.md)\>

***

### discoverModels()?

> `optional` **discoverModels**(`profile`): `Promise`\<(`string` \| [`DiscoveredModel`](../type-aliases/DiscoveredModel.md))[]\>

#### Parameters

##### profile

[`ProfileRuntime`](../type-aliases/ProfileRuntime.md)

#### Returns

`Promise`\<(`string` \| [`DiscoveredModel`](../type-aliases/DiscoveredModel.md))[]\>

***

### dispose()?

> `optional` **dispose**(`missionId`): `void`

#### Parameters

##### missionId

`string`

#### Returns

`void`

***

### enrichEvent()?

> `optional` **enrichEvent**(`ev`, `missionId`): [`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

#### Parameters

##### ev

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

##### missionId

`string`

#### Returns

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

***

### extractSessionId()

> **extractSessionId**(`ev`): `string` \| `null`

#### Parameters

##### ev

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

#### Returns

`string` \| `null`

***

### isSessionNotFoundError()?

> `optional` **isSessionNotFoundError**(`stderr`): `boolean`

#### Parameters

##### stderr

`string`

#### Returns

`boolean`

***

### openSession()?

> `optional` **openSession**(`args`): [`SessionDriver`](SessionDriver.md)

#### Parameters

##### args

[`SessionOpenArgs`](../type-aliases/SessionOpenArgs.md)

#### Returns

[`SessionDriver`](SessionDriver.md)

***

### parseLine()

> **parseLine**(`line`): [`NormalizedEvent`](../type-aliases/NormalizedEvent.md)[]

#### Parameters

##### line

`string`

#### Returns

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)[]

***

### permissionsByAgent()?

> `optional` **permissionsByAgent**(`profileId`): `boolean`

#### Parameters

##### profileId

`string`

#### Returns

`boolean`

***

### setModel()?

> `optional` **setModel**(`proc`, `model`): `Promise`\<`boolean`\>

#### Parameters

##### proc

`ChildProcessWithoutNullStreams`

##### model

`string`

#### Returns

`Promise`\<`boolean`\>

***

### spans()?

> `optional` **spans**(`ev`, `state`, `eventId`): [`SpanOp`](../type-aliases/SpanOp.md)[]

#### Parameters

##### ev

[`NormalizedEvent`](../type-aliases/NormalizedEvent.md)

##### state

[`SpanState`](../type-aliases/SpanState.md)

##### eventId

`number`

#### Returns

[`SpanOp`](../type-aliases/SpanOp.md)[]

***

### writeUserInput()

> **writeUserInput**(`proc`, `text`, `images?`): `void`

#### Parameters

##### proc

`ChildProcessWithoutNullStreams`

##### text

`string`

##### images?

[`ImageAttachment`](../type-aliases/ImageAttachment.md)[]

#### Returns

`void`
