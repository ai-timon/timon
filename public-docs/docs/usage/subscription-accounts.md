---
title: Subscription accounts
sidebar_position: 9
---

A subscription account lets Timon use **several subscriptions of the same provider** side by side: a personal and a work Claude plan, two ChatGPT plans for Codex, or one plan per person on a shared installation. Each account is its own choice in every model selector (`Claude · Perso`), next to the provider's plain entry.

Accounts exist for **Claude** and **Codex**, the two providers that sign in through their own command-line tool. Providers you added yourself, and profiles that use an API key, have a single sign-in.

:::note One rule to remember
A mission never moves to another subscription on its own. If its account is signed out, out of quota or deleted, the mission fails with that reason; it is never silently run on someone else's plan. The one exception is the orchestrator piloting a series: it may move to another of **your own** connections (see [Quotas, fallback and Auto switch](#quotas-fallback-and-auto-switch)).
:::

## Add an account

Open **Settings → AI models → Providers**, choose the provider, then **Add an account** in its **Connection** section; the **Provider** field is not asked there, the page already names it. On a shared installation, an account that is not the superadmin needs its role to give it at least **Own accounts only** on the Providers screen (see [Several accounts](./multi-user.md#access-to-the-providers-screen)); with **Hidden**, an administrator signs its accounts in for it.

| Field | What it is |
|---|---|
| **Provider** | Claude or Codex. Only providers whose command-line tool is installed on the Timon machine are offered. |
| **Name** | The label shown in the selectors, for example `Perso` or `Work`. Up to 60 characters; unique for a provider and an owner, whatever the capitals. |
| **For** | Who owns the account: **Me**, another user, or **The instance** (see [Instance accounts](#instance-accounts)). Only administrators see this field; for everyone else the account is always their own. |

**Create and sign in** creates the account and starts its sign-in straight away.

## Sign in

The sign-in runs **on the machine where Timon runs**, while you stay in your own browser, so it works the same when Timon is on a server and you are on another computer.

- **Claude**: open the sign-in page, sign in with the subscription this account is for, then paste the code shown on the last page (or the address of that page) and choose **Finish sign-in**.
- **Codex**: open the sign-in page and enter the one-time code Timon shows. Timon finishes on its own once you confirm there.

Good to know:

- The sign-in belongs to the browser session that started it. Another session, even yours, cannot see or finish it. It stops after 10 minutes (15 for Codex), when you **Cancel the sign-in**, or when you leave the pane.
- The code you paste is sent in the request body, never in an address, and is never shown back or logged.
- Once it succeeds, the row shows **Signed in as** the address of the subscription. Only the account's owner and administrators see that address; a user the account was assigned to does not.
- **Timon refuses a subscription that is already signed in under another account** on the machine: one subscription, one account.
- **Reconnecting** an account with a different subscription than the one it was created with is refused (the message names the address the account belongs to). On Linux and Windows, and for Codex, the account keeps its previous sign-in. For Claude on macOS the sign-in is done in place, so a refused reconnect leaves the account signed out: it shows **Sign in again** and you reconnect it with the right subscription.

Timon's database holds no secret for an account. The command-line tool keeps its sign-in in a private folder of the Timon home, one folder per account.

On macOS, Claude Code first saves an account's sign-in in your login keychain. An [isolated mission](mission-isolation.md) can read the keychain but not update it, so it could not renew that sign-in when it expires. Before each isolated mission on a Claude account, Timon therefore moves the account's sign-in from the keychain into the account's folder, where the mission renews it. Timon moves nothing while something else may update that keychain entry, so a fresh sign-in is never lost: while you are signing the account in again, and while another mission or a summary runs on the account without isolation (isolation turned off, or not available). The sign-in then stays in the keychain, and the next isolated mission moves it. Timon does not see a `claude` you start yourself with the account's folder: close it before missions run on that account. If the keychain cannot be read or refuses the change (for example while it is locked), the sign-in stays where it is and a mission may fail to renew it: unlock the keychain, then start the mission again.

## What each state means

| In the list and in the selectors | Meaning | What to do |
|---|---|---|
| **Signed in** | The account runs missions. | Nothing. |
| **Not signed in** | Created, never signed in through Timon. An account signed in by hand outside Timon still runs, but shows this until you sign it in from here. | **Sign in**. |
| **Sign in again** | The sign-in was lost or refused: the provider's tool reported an authentication failure, or a reconnect was refused. Timon also raises a notification that names the account. Its missions are refused with that reason; the other accounts keep running. | **Sign in again**, with the subscription it was created with. |
| **Out of quota** | The subscription's usage limit was reached. The account is sidelined for the cooldown and comes back by itself. Timon re-reads the account's usage every few minutes and lifts it as soon as the quota is open again; a turn that succeeds, or a new sign-in, lifts it at once. | Wait, or pick another account for new work. |

## Who uses which account

**Administrators** (superadmins) can use every account. Anyone else can use the accounts they own and the ones an administrator assigned to them; an account they may not use does not appear for them at all.

What a mission runs on is decided by the daemon when the mission starts:

| The agent, task or selector says | Mission of an administrator | Mission of another user | Mission with no owner (routine, system or plugin job) |
|---|---|---|---|
| A specific account (`Claude · Perso`) | That account. | That account, if it is theirs or assigned to them; otherwise refused. | Only an [instance account](#instance-accounts); otherwise refused. |
| The plain provider (`Claude`) | The provider's sign-in on the Timon machine. | Their own account, else the oldest one assigned to them, else the machine's sign-in (see the note below). | The first instance account of that provider, else the machine's sign-in. |

:::caution A user with no account can be refused
As soon as an **administrator** has created an account for a provider (for anyone, or for the instance), a user who has no account of their own on it is **refused** instead of running on the machine's sign-in: the mission fails with *No account is assigned to the owner of this mission; ask an administrator to assign one*. A user adding their own account does not trigger this for the others.
:::

Other rules:

- **A mission keeps its account.** The first turn decides and the choice is frozen: an account created or assigned later does not move a conversation in progress, because its session lives in that account's folder. Choosing another account or provider explicitly for the next turn resolves again. Every later turn still checks that the account exists, is allowed and is signed in.
- **Codex on Windows:** choosing another account explicitly also replaces the conversation’s sign-in when symbolic links are unavailable; no administrator rights are needed.
- **Using someone else's account is recorded.** The first time a mission runs on an account its owner does not own, the audit log gets a `backend_account.use` line.
- **Agents do not choose who pays.** A mission token cannot create, rename, delete, assign or sign in accounts; this is done from a signed-in browser session, or by an administrator with `timon backend-account`.

## Instance accounts

An instance account has **no owner**: it is for the missions nobody launched from an account, such as routines, system jobs and plugin jobs. An administrator creates one with **For → The instance**.

- A mission with no owner can only run on an instance account, or on the machine's sign-in when the provider has none.
- When several exist for a provider, the oldest one is used for those missions.

## Assign an account to a user

An account belongs to its owner. An administrator can let other users use it without handing over the sign-in.

On the provider's page (**Settings → AI models → Providers**, then the provider, **Connection** section), choose **Assign** on the account's row, tick the users who may use it (every account of the installation, listed by its display name), and **Save**. The owner is not offered: they use it anyway. The row then shows **Assigned to** and their names. Only administrators see the **Assign** button and that line.

From a terminal on the machine that runs Timon:

```bash
timon backend-account list                                  # accounts, their state and who they are assigned to
timon backend-account grant claude@k3f9a2b1c0 --user ada@example.com,bob@example.com
timon backend-account revoke claude@k3f9a2b1c0 --user bob@example.com
```

An account is named by its id or by its `claude@<id>` / `codex@<id>` form; a user by their email address or their id (`timon user list`). `grant` and `revoke` add to and remove from the current list, leaving the other users as they were.

A user an account was assigned to can pick it and run missions on it, and nothing more: they cannot sign it in, rename it or delete it. Every change is recorded in the audit log as `backend_account.grant`.

## Rename an account

**Rename** on the account's row changes the name shown in the selectors (`Claude · Work`). The same rule as at creation applies: up to 60 characters, unique for a provider and an owner whatever the capitals. Agents, tasks and missions set on the account keep it: they store its id, not its name.

## Reconnect and delete

- **Sign in again** (or **Sign in**) reconnects an account, with the same subscription.
- **Delete** asks for confirmation, removes the account's sign-in from the machine and cancels a sign-in in progress. Agents and tasks that were set on that account fail with *the account no longer exists* until you choose another one; so do missions already running on it, at their next turn. Nothing is moved automatically.

Only an account's owner or an administrator signs it in, renames it or deletes it. A user an account was assigned to can use it and nothing more.

## Where an account appears

An account is chosen like any model, in the [model picker](missions.md#choosing-a-model): the chat composer, the agent editor, a Kanban task, a series' role or fallback, and a workflow node. It lists only the accounts you may use, each as its own button in the left rail, and shows their state (**Sign in again**, **Out of quota**).

Wherever Timon stores a backend, an account is written `claude@<account id>` (for example `claude@k3f9a2b1c0`), so a command-line or tool call that sets a backend takes the same form. The `instance` field of `GET /api/backends/accounts` gives the exact string.

## Quotas, fallback and Auto switch

- **Each account has its own gauge.** The **LLM quotas** widget lists, next to the provider's sign-in of the Timon machine, every signed-in account you may use (`Claude · Perso`), measured on that account's own subscription. The strip under the chat composer of a mission running on an account shows that account's figures. An account that is not signed in has no gauge, and another user's account never appears, nor in the widget's trend.
- **A gap after a long pause.** On Linux and Windows, Timon renews a Claude account's expired session when it reads its usage, as the CLI would. On macOS only the account's missions renew it: when none has run for several hours, its gauge keeps its last reading (or shows *probe temporarily unavailable*) until the next one.

- **Automatic fallback never moves an account.** The [Auto switch](settings.md#providers-and-fallback-choices) levels, the model-equivalence step and the last-resort model apply to the plain provider only. A mission set on an account, or whose plain `Claude` resolves to one, does not slide to another subscription when its quota runs out.
- **Except the orchestrator of a series.** It holds the plan of the whole job and receives every task's return, so leaving it stopped stops the job. When its account runs dry and the fallback set for it cannot be used, it moves, keeping its conversation, to the first of these that works: another connection of the same provider that belongs to the mission's owner (the computer's own sign-in, one of their accounts, an account shared with them), on the same model; then the model-equivalence step and the last-resort model. Another user's account is never used, even for an administrator. A series fallback set to `none` for the orchestrator still stops it there. When nothing works, the orchestrator stays stopped and its owner gets one urgent notification listing what to do.
- **A fallback you declare is honoured.** A fallback set on a series or on a task is a decision of yours, so it may name another account or provider; that is the only way a mission leaves an account.
- **Sign-in failures are per account.** The circuit breaker marks the account that failed as **Sign in again**; the provider's other accounts keep running.

## Known limits

- **macOS**: the usage of a Claude account is not shown (Timon does not read it on macOS). Codex accounts are shown.
- An account lives on the machine running the daemon; there is no sharing of accounts between two Timon installations.
- Check your provider's terms before letting several people use the same subscription: Timon enforces who may pick an account, not what your plan allows.
