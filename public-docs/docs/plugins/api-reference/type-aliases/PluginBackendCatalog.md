
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginBackendCatalog

> **PluginBackendCatalog** = `object`

## Properties

### backends

> **backends**: `object`[]

#### account?

> `optional` **account?**: `object`

##### account.id

> **id**: `string`

##### account.name

> **name**: `string`

#### accountUsage

> **accountUsage**: `boolean`

#### brand?

> `optional` **brand?**: `string`

#### capabilities

> **capabilities**: [`BackendCapabilities`](BackendCapabilities.md)

#### custom?

> `optional` **custom?**: `boolean`

#### defaultModel

> **defaultModel**: `string` \| `null`

#### icon?

> `optional` **icon?**: `string`

#### id

> **id**: `string`

#### instanceOf?

> `optional` **instanceOf?**: `string`

#### label

> **label**: `string`

#### models

> **models**: [`CatalogModel`](CatalogModel.md)[]

#### nativeCompact?

> `optional` **nativeCompact?**: `boolean`

#### permissionModeApplied?

> `optional` **permissionModeApplied?**: `boolean`

#### permissionModel

> **permissionModel**: [`PermissionModel`](PermissionModel.md)

#### rateLimitReporting

> **rateLimitReporting**: [`RateLimitReporting`](RateLimitReporting.md)

#### remote?

> `optional` **remote?**: `boolean`

#### selfManagedPermissions?

> `optional` **selfManagedPermissions?**: `boolean`

#### sessionResumable

> **sessionResumable**: `boolean`

#### signedIn

> **signedIn**: `boolean` \| `null`

#### signInCommand?

> `optional` **signInCommand?**: `string`

#### signInThen?

> `optional` **signInThen?**: `string`

#### slugPrefixes?

> `optional` **slugPrefixes?**: `string`[]

#### subscription?

> `optional` **subscription?**: `object`

##### subscription.note

> **note**: `string`

##### subscription.planMaxToggle?

> `optional` **planMaxToggle?**: `boolean`

#### supportedPermissionModes?

> `optional` **supportedPermissionModes?**: `string`[]

#### thinkingControls?

> `optional` **thinkingControls?**: [`ReasoningControl`](ReasoningControl.md)\[`"type"`\][]

#### unverified?

> `optional` **unverified?**: `PluginBackendUnverified`[]

#### vendor?

> `optional` **vendor?**: `string`

***

### defaultBackend

> **defaultBackend**: `string` \| `null`

***

### modelBrands

> **modelBrands**: `object`[]

#### brand

> **brand**: `string`

#### match

> **match**: `string`
