---
title: Several accounts
---

Timon is built for one person: Free gives every feature and plugin to **one account**, the administrator created at the first run (replacing the whole interface with a third-party layout, White Label, needs a licence that includes it). Letting other people sign in to the same Timon is the job of **Multi-user**, a separate plugin reserved for a **pro licence**. Timon itself does not invite, add or organise accounts.

## With Multi-user

Once your pro licence is active and Multi-user is installed and on, its **Team** page appears in the menu. From there an administrator invites people, sorts them into groups, decides what each group may do and reads the activity log. See [Plugin gallery](plugins-gallery.md) to turn it on or off.

Each person keeps their own missions, projects and settings; what they may see beyond their own work is what their groups allow.

The address of an account invited or created from the Team page is not confirmed: nobody proved they read it. Its owner confirms it from **Profile**, under **Sign-in email**, with **Confirm your address** › **Send the code** (it needs an internet connection; a card at the bottom left of the app reminds them); until then, **Forgot password** cannot send them a code, and an administrator resets their password from the Team page. The same applies after anyone changes their sign-in email.

### What permissions do not cover

Every mission runs under the same operating-system account as Timon itself, whoever started it. Permissions decide what a person may do through Timon's screens, commands and tools; against the files of the machine, what protects Timon is the [mission isolation](mission-isolation.md), and it depends on the system:

- **Linux with Landlock (kernel 5.19 or later) or with unprivileged user namespaces, and macOS**: each mission runs inside a fence the operating system enforces. It cannot read Timon's private files, such as the operator's credentials or the key of the secrets vault, nor the folders of other agents and missions.
- **Windows**: there is no fence. A mission an account starts can read Timon's data folder, including the operator's credentials and the key of the secrets vault, so anyone who may start missions can reach more than their own permissions allow. A Linux kernel that offers neither Landlock nor unprivileged user namespaces refuses missions.

On an installation with several accounts, set the isolation mode to **Required** (**Settings › System › Security**, or `host.isolation.filesystem` set to `enforce`): a computer that cannot fence a mission then refuses to start it, instead of starting it unfenced. Where missions cannot be fenced, give the **Spawn missions** permission (`missions:spawn`) only to people you would trust with the whole installation.

Even fenced, a mission writes the projects it works on: what it leaves there runs later with the rights of whoever runs it. Review the changes of missions started by other accounts before you run them, and give missions their own backend accounts rather than the one you use yourself.

## Access to the Providers screen

**Settings → AI models → Providers** is offered to the other accounts at one of three levels, chosen for each permission set on the Team page (**Permissions**, then **Providers screen**):

| Level | What the account sees and does |
|---|---|
| **Full access** | Like the superadmin: every section of a provider's page (Connection, API key, Models, Program, its own settings), adding and removing providers, switching them on and off. The Program section decides which program Timon runs on this machine: give this level only to people you would let do that. |
| **Own accounts only** | The list of providers, read only, and on a provider's page the **Connection** section with **its own** [subscription accounts](./subscription-accounts.md): add one, sign it in, rename it, delete it. Nothing else: no program, API key, settings, models, on/off switch or new provider. |
| **Hidden** | The screen does not appear: no tab, no settings search result, no link from a notification. |

The superadmin always has full access. An account in several groups gets the widest level any of them gives. The **Employee** permission set a new installation starts with gives **Own accounts only**, the level we recommend for a new account; a permission set you create gives **Hidden** until you pick another level.

When you update an installation whose accounts managed their own subscription accounts before these levels existed, every permission set that said nothing about providers is given **Own accounts only** once, so nobody loses what they had. Change it afterwards as you wish.

## Without it

If the licence ends, or Multi-user is removed or turned off, **only the administrator keeps access**. The other accounts are suspended, never deleted: they cannot sign in, but their missions, settings and data stay where they are. The administrator sees a card explaining why. Access comes back, unchanged, as soon as the pro licence and Multi-user are both there again.

## Upgrading an installation that already has several accounts

Earlier versions of Timon managed roles, groups and invitations themselves. When this version first starts, it keeps all of them aside, in a file of its data directory that only your own account can read, and Multi-user picks them up when it first starts. Nothing is lost if you update Timon before installing Multi-user: until then, the other accounts are suspended as described above.

## Recovering an account from the command line

Two commands stay in Timon, for the operator of the machine, with or without Multi-user:

```bash
timon user list
timon user reset-password <email-or-id>
```

The second prints a temporary password once; hand it over yourself. See the [command-line reference](cli-reference.md).
