---
title: Activate your licence
---

Free works without a licence key, registration, activation or renewal request.
Free includes every feature and plugin for one account. Activate a paid licence
only when you need additional user accounts: they come from the Multi-user
plugin, reserved for a pro licence (see [Several accounts](multi-user.md)).
One exception: a third-party layout that replaces the whole interface (White
Label) needs a licence that includes White Label (see [Kinds](../plugins/kinds.md)).
Your local Timon account remains separate from licence activation.

## Enter a key from your profile

In **Settings**, open **Profile** from the account section at the bottom of
the list, and find the **License key** block. It shows what this installation
runs on: **Free**, or your plan with its end date. Paste the activation key you
received and click **Activate**; once a licence is installed, the same field
replaces it. Entering another key forgets what belonged to the previous one on
this machine, including its machine name.

Only an administrator account gets the field; other accounts see the state.
**License details** opens the **License** screen, next to **Profile**, where
you can also name this machine or release it.

## Activate from the command line

Run these commands against your own Timon installation:

```bash
timon license activate '<your-activation-key>'
timon license status
```

Replace the placeholder with the activation key supplied to you. Activation
requires connectivity. Keep your key private: do not include it in shared
scripts, screenshots or support logs. Command arguments may be retained in
shell history; the profile's License key block is an alternative to entering a key in a
terminal.

The CLI reports whether activation succeeded and which edition is available.
If activation is refused, check that you selected the intended installation and
used the correct key. Follow the displayed message or contact support without
sharing the key. See [Command-line interface](cli.md) for targeting an instance.

## Activation endpoint for custom clients

Use this endpoint on **your own daemon**, with an authenticated account allowed
to manage that installation's licence:

```http
POST /api/license/activate
Content-Type: application/json
```

```json
{"key":"<your-activation-key>"}
```

On success, HTTP `200` returns the licence state; `status` is `"valid"`, and
`plan` and `edition` describe the activated offer. Clients should tolerate
additional response fields. A failed request returns a non-success status and
an `error`, sometimes accompanied by a `message`. Display a useful error without
recording the submitted key. Missing authentication or insufficient rights must
be resolved through normal sign-in; retrying does not grant permission.

This is a customer activation interface, not an interface for creating,
issuing or administering other people's licences. Free needs no call to it.
Prefer the supported CLI or Licence screen when you do not need a custom client.
