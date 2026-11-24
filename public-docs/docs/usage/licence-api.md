---
title: Activate your licence
---

Without a licence, Timon is Free: complete, every feature and plugin, for one
account. There is no Free licence to get: no key, registration, activation or
renewal, and nothing to warn you about. Activate a paid licence only when you
need additional user accounts: they come from the Multi-user
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

## Renewal

Once activated, Timon renews the licence in the background, a few minutes
apart. A short loss of connection, or a restart, does not turn it off. When
the network is not ready yet as Timon starts, it tries again three times, 30
seconds, 1 minute and 2 minutes apart, before going back to its usual pace.

### When Timon cannot check your licence online

A paid licence works without a connection for a while: the time it tolerates
offline is set by your plan. During that time Timon shows nothing at all. An
outage of the licensing service, or of your network, is not something you have
to deal with, and Timon keeps trying in the background.

### When paid features are paused

A licence that ends does not stop Timon: it continues on Free, and additional
accounts keep their data but cannot sign in until a licence is back. Timon then
shows one card at the bottom left of the interface, and only in two cases:

- **Paid features are paused**: the time tolerated offline ran out before Timon
  could check the licence online. They come back on their own as soon as a
  renewal goes through, and the card goes away with them. Timon keeps trying,
  at start and then at its usual pace, including after the computer was off
  for a long time.
- **Your license is no longer active**: the licensing service refused it for good
  (revoked, expired, released, unknown key, or a key bound to another
  computer). Timon stops asking. **Enter my key** opens the **License key**
  block of your profile, where you enter a key to get a paid licence back.

A card you close stays closed, on every device of your account, until the
situation changes. Timon raises no notification for these cases, on screen,
by push or by Telegram. Without a licence at all, Timon is Free and shows
nothing.

A late payment on your subscription, and the end of your licence fourteen
days ahead (three days ahead, as a warning), are cards too.

A beta build has no Free tier: when its licence ends it shows a full-screen
notice instead of the app, and the Notification center says why once.

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
issuing or administering other people's licences. Without a licence, nothing
calls it.
Prefer the supported CLI or Licence screen when you do not need a custom client.
