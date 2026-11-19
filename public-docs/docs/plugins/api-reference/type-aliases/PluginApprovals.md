
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginApprovals

> **PluginApprovals** = `object`

## Methods

### get()

> **get**(`id`): `Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `input`: `unknown`; `missionId`: `string`; `tool`: `string`; \}\> \| `undefined`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `input`: `unknown`; `missionId`: `string`; `tool`: `string`; \}\> \| `undefined`\>

***

### list()

> **list**(`filter?`): `Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `input`: `unknown`; `missionId`: `string`; `tool`: `string`; \}\>[]\>

#### Parameters

##### filter?

[`PluginApprovalListFilter`](PluginApprovalListFilter.md)

#### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string`; `createdAt`: `number`; `expiresAt`: `number` \| `null`; `id`: `string`; `input`: `unknown`; `missionId`: `string`; `tool`: `string`; \}\>[]\>

***

### resolve()

> **resolve**(`id`, `decision`): `Promise`\<`Readonly`\<\{ `id`: `string`; `status`: `"allowed"` \| `"denied"`; \}\>\>

#### Parameters

##### id

`string`

##### decision

[`PluginApprovalDecision`](PluginApprovalDecision.md)

#### Returns

`Promise`\<`Readonly`\<\{ `id`: `string`; `status`: `"allowed"` \| `"denied"`; \}\>\>
