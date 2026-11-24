
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderContextOptions

> **ProviderContextOptions** = `object`

## Properties

### accountsInUse?

> `readonly` `optional` **accountsInUse?**: readonly `string`[]

Accounts (by id) another process runs on outside the fence: `held()` and `remove` answer `in-use`. `setAccountInUse` changes it.

***

### apiVersion?

> `readonly` `optional` **apiVersion?**: `number`

The `apiVersion` the plugin's manifest declares. Default: 12, the contract `ctx.provider` belongs to.

***

### baseEnv?

> `readonly` `optional` **baseEnv?**: `Readonly`\<`Record`\<`string`, `string`\>\>

What `ctx.provider.env()` answers on top of the identity pointers (the daemon's would add the system variables).

***

### binaries?

> `readonly` `optional` **binaries?**: `Readonly`\<`Record`\<`string`, \{ `converse?`: (`args`) => `ProviderConversation`; `path?`: `string`; `probe?`: (`args`) => `Partial`\<`ProviderProbeResult`\>; `version?`: `string`; \}\>\>

The programs `ctx.provider.binary` knows: where each is, which version it prints, and what a probe of it answers. A name
that is not here is "not installed". `serve` is not available in the stand-in (it needs a process): use a fake CLI.

***

### credentialDirs?

> `readonly` `optional` **credentialDirs?**: readonly `string`[]

Absolute folders `scratch.link` may take a source from: stand for the home-relative `declares.credentialDirs` a real provider declared.

***

### generatedMedia?

> `readonly` `optional` **generatedMedia?**: readonly `ProviderGeneratedMedia`[]

What `ctx.provider.media.adopt` returns for any directory. Default: nothing.

***

### gitRoots?

> `readonly` `optional` **gitRoots?**: `Readonly`\<`Record`\<`string`, readonly `string`[]\>\>

What `ctx.provider.git.writableRoots` answers, by working directory. A folder that is not here is not a repository.

***

### lockedOsCredentials?

> `readonly` `optional` **lockedOsCredentials?**: readonly `string`[]

Services whose `account.osCredential(...).remove()` the store refuses, as a locked keychain does.

***

### osCredentials?

> `readonly` `optional` **osCredentials?**: `Readonly`\<`Record`\<`string`, `string`\>\>

What `ctx.provider.osCredentials` holds, by `service` or `service|account`. A key that is not here reads as null.
`ctx.provider.account.osCredential(profile, service).read()` reads the same keys, and `remove(expected)`
deletes one while it still holds `expected`. `setOsCredential` changes them during a test.

***

### secrets?

> `readonly` `optional` **secrets?**: readonly `string`[]

Values `ctx.provider.redact` masks (12 characters or more, like the daemon's). Default: none.

***

### settings?

> `readonly` `optional` **settings?**: `Readonly`\<`Record`\<`string`, `ProviderSettingValue`\>\>

What `ctx.settings.get` answers: the plugin's own settings, secrets included.

***

### signingInAccounts?

> `readonly` `optional` **signingInAccounts?**: readonly `string`[]

Accounts (by id) a sign-in flow runs on: `account.osCredential(...).held()` and `remove` answer `signing-in`.

***

### unfencedMissions?

> `readonly` `optional` **unfencedMissions?**: readonly `string`[]

Launches (by mission id) that run outside the fence: `held()` and `remove` answer `unfenced`.
Any other launch is taken as fenced, as a mission on macOS with isolation on.

***

### userMcpServers?

> `readonly` `optional` **userMcpServers?**: readonly `ProviderMcpServer`[]

The agent's own MCP servers `ctx.provider.mcp()` should list, after Timon's.
