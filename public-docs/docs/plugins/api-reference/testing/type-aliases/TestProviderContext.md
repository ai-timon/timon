
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: TestProviderContext

> **TestProviderContext** = `ProviderPluginContext` & `object`

## Type Declaration

### logs

> `readonly` **logs**: readonly [`LoggedLine`](LoggedLine.md)[]

Everything the plugin logged.

### registered

> `readonly` **registered**: `object`

What the plugin registered, in order.

#### registered.dialects

> `readonly` **dialects**: `ReadonlyMap`\<`string`, `Dialect` \| `RemoteDialect`\>

#### registered.productProfiles

> `readonly` **productProfiles**: readonly `BackendProfile`[]

What it registered with `ctx.provider.registerProductProfile`, in order.

#### registered.profiles

> `readonly` **profiles**: readonly `RegisteredProfile`[]

#### registered.providers

> `readonly` **providers**: `ReadonlyMap`\<`string`, `NativeProviderDefinition`\>

What it registered with `ctx.provider.registerProvider`, by id.

#### registered.dialect()

> **dialect**(`id`): `AnyDialect`

The dialect registered under `id`; for a provider registered natively, the dialect the
daemon adapts it to — the form the conformance bench takes. Throws, naming the ids it
has, if there is none.

##### Parameters

###### id

`string`

##### Returns

`AnyDialect`

### shownFrom

> `readonly` **shownFrom**: `ReadonlyMap`\<`string`, readonly `string`[]\>

The directories the plugin opened to `chat_show_media` (`media.allowShow`), by mission.

### cleanup()

> **cleanup**(): `void`

Removes the temporary folders `scratch.mission` and `scratch.profile` created.

#### Returns

`void`

### setAccountInUse()

> **setAccountInUse**(`accountId`, `inUse`): `void`

Stands in for a process on the account starting (true) or ending (false) outside the fence.

#### Parameters

##### accountId

`string`

##### inUse

`boolean`

#### Returns

`void`

### setOsCredential()

> **setOsCredential**(`key`, `value`): `void`

Stands in for a CLI that writes the keychain while the plugin works (a sign-in, a renewal
outside any fence): sets the entry `key` (`service` or `service|account`), or deletes it on null.

#### Parameters

##### key

`string`

##### value

`string` \| `null`

#### Returns

`void`
