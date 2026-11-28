---
title: Machines
sidebar_position: 4.8
---

A **machine** is a computer that runs Timon's daemon: your laptop, a desktop at home, a server. The **Machines** plugin lets one Timon interface (the desktop app, a browser tab or the app installed on your phone) switch from one machine to another, **in the same window**. Nothing is merged: each machine keeps its own agents, projects, missions, settings and theme, and you see one machine at a time.

Typical use: a server works around the clock on long missions, and you follow it from the Timon you already use on your computer or phone, without opening another address. To set such a server up, see [Run Timon on a headless server](../installation/headless-server.md).

## Turn it on

Machines ships with Timon and is **off by default**. Turn it on from its card in **Plugins**, on the computer whose interface you use. The machines you drive do not need it: they only need to authorize your computer as a [connected device](connected-devices.md).

Once on, it adds **Settings → Plugins → Machines** and a machine selector at the foot of the navigation menu.

## Add a machine

1. **On the other machine**, signed in directly on it, open **Settings → Access & network → Devices** and choose **Authorize a new device**. A one-time code appears, valid 5 minutes. When that machine's daemon is published with `tailscale serve`, the card also shows the address to enter; when it is not, **Make this machine reachable** publishes it on your tailnet only (never on the internet) and shows that address — installing Tailscale and signing it in first if needed ([Connected devices](connected-devices.md#make-this-machine-reachable)).
2. **On this computer**, open **Settings → Plugins → Machines** → **Add a machine** (or **Settings → Access & network → Devices** → **Enter a code from another machine**, which leads there), and enter:
   - the **address of the other machine's daemon**, for example `https://my-server.my-tailnet.ts.net:8443`: the address alone, with no login, query or fragment, and its final form (a redirect is refused);
   - the **pairing code**;
   - a **name**, if you want one other than the machine's own.
3. **Pair.** The machine joins the list, with its state and its Timon version.

The address must be **HTTPS**, with a valid certificate: `tailscale serve`, a reverse proxy such as Caddy or nginx, or a Cloudflare Tunnel all provide one. Plain HTTP is refused, even on a private network; it is only accepted for a Timon on this same computer. [Run Timon on a headless server](../installation/headless-server.md#4-drive-it-from-the-timon-on-your-computer) gives the `tailscale serve` recipe.

Pairing the same address again (with a new code) keeps the machine in place and replaces its access: use it when a machine says it no longer accepts this computer.

## Switch machines

Open the selector at the foot of the navigation menu: it shows the active machine and its state. Pick a machine: the whole interface reloads as that machine's, in the same window (an installed phone app stays in its window), on the last page you viewed on that machine. **This computer** brings you back.

Each machine keeps its own last page, in this browser or app: switching from a conversation on one machine to the Kanban on another, then back, reopens that conversation. A machine you have never opened here starts on the home page. If the page you left names something deleted since on that machine (a conversation, an agent, a task, a group), you land on the main page of that section instead, such as the chat or the Missions list. The Settings dialog you switched from is not reopened.

On another machine, the selector reads **as** *account*: the account you act as there, the one that authorized this computer. It can differ from your account on this computer.

The choice is kept by this browser or app until you switch again or sign out: signing out always brings the interface back to this computer.

### Several windows in the desktop app

In the desktop app, each window drives its own machine: with three screens, keep one window per screen, each on a different machine, without switching back and forth.

- **Open a window**: right-click Timon in the taskbar or the dock and choose **New window** (Windows: the taskbar's jump list; Linux: the dock or app grid menu, GNOME and KDE; macOS: the Dock menu). Also **New window** in the tray menu (and the **File** menu on macOS), **Ctrl+Shift+N** (**Cmd+Shift+N** on macOS), or launch Timon again while it is running. The new window opens on the machine you chose last. If Timon was updated while it was running, it asks you to quit and reopen it first.
- **Open a page in a new window**: in the navigation menu, **Shift+click** or a **middle click** on an entry (the Kanban board, the missions, an agent's chat…) opens that page in a new window on the same machine, ready to drag to another screen. This works with a single machine too.
- **Choose its machine**: the selector at the foot of the menu switches **this window only**; the others stay where they are. The window's title names its machine, in the taskbar and in Alt+Tab, and the top bar shows it next to the logo.
- **Switch back instantly**: a window keeps the last three machines you showed in it open in the background. Coming back to one is instant and finds it exactly as you left it: the page, the scroll position, a message you had not sent, the panels you had opened. A fourth machine closes the one you used least recently; going back to it later reopens it on the last page you viewed there. Each machine kept open uses memory, about as much as a browser tab running Timon. If a page you are closing that way has unsaved changes, Timon asks first.
- **Get them back**: when you quit Timon, it remembers each window: its screen, size, whether it was maximized, its machine and the page it showed. At the next launch they reopen as they were, a window you opened on the Kanban back on the Kanban. A window whose screen is no longer connected opens on a screen you can see. Closing windows one by one before quitting forgets them, except the last one, which reopens on its page too. The Settings dialog is not reopened, nor a sign-in or setup page.

A web browser or the installed web app keeps one machine for all its tabs, the one chosen last in it.

### What follows the active machine

Everything you work with: agents, projects, missions and chats, the Kanban, settings, the built-in terminal (a shell on that machine), its notifications centre, its plugins, and its licence screen.

So does **the account you act as there**: the screen layout (widgets, islands, columns, menu) is that account's, the same one you get when you open that machine directly and the one its agents read and propose; what you may do (administration pages, buttons greyed for lack of a right) follows that account's rights; and missions started there with that account show as yours.

**Light or dark mode** follows the machine too, like its primary colour: each machine keeps its own, so with several desktop windows one can be light and another dark. Switching the mode in a window changes it for that machine only. A machine where you never chose one shows this computer's mode until you do.

The **built-in browser** of a project, opened from a browser or the installed web app, shows and drives the browser of the active machine, as it does on this computer. That machine must have the Timon desktop app running, since the desktop app runs the built-in browser. In the desktop app's own window, see [Known limits](#known-limits).

### What stays on this computer

- **Your sign-in.** You sign in on this computer; your avatar, profile, password and **Sign out** are this computer's account's.
- **The list of machines**, which belongs to your account on this computer: someone else signed in here does not see yours.
- **Third-party plugins' interfaces**: see [below](#third-party-plugins).

## States and warnings

Each machine shows a state in the selector and in **Settings → Plugins → Machines**: *Online*, *Unreachable*, *Access revoked*, *Certificate refused*, *Error*, or *Not checked yet*. **Check now** asks again.

| What happens | What you see |
| --- | --- |
| The active machine stops answering | A banner while you work; at the next load, a screen with **Try again** and **Back to this computer**. Nothing is lost on that machine |
| The machine revoked this computer, or its access expired | A screen saying it no longer accepts this computer: pair it again |
| The machine runs a Timon too old for this interface | The switch is refused, or a screen asks you to update that machine |
| The machine runs a newer Timon than this interface | It works; a banner suggests updating this interface |
| The machine's licence has ended | Its licence screen, which says it is that machine's licence, with a way back to this computer |

## Notifications

A notification raised on a machine of your list reaches you through this computer: its card appears in this computer's notification centre, its title starting with the machine's name, and push notifications reach the phones subscribed here.

- **Approve** / **Deny** on a push notification answers the machine that asked, whatever machine the interface shows.
- Opening a notification switches the interface to its machine first.
- Only cards for your account there, or for no one in particular, are relayed. Cards older than the pairing are not pushed.
- **This computer must be on.** It is the one that relays: while it is off, the other machines' cards wait in their own notification centres.

## Third-party plugins

On another machine, a third-party plugin's interface loads only if **the same signed version** of that plugin is installed and enabled on this computer. Otherwise the plugin's card in **Plugins** is marked **To approve on this computer**: install and enable that version here, then reload. This keeps a machine of your list from running code in this interface that you never approved here. A plugin built into Timon, such as the quota monitor, needs no approval: it loads from this computer's own copy when that copy has the same version and the same interface code as the other machine's, and is enabled here too. Two Timon releases can ship different code under one plugin version: if the card still says **To approve on this computer**, update the older of the two machines.

## Rename or remove a machine

In **Settings → Plugins → Machines**, **Rename** changes the name shown here only. **Remove** revokes this computer's access on that machine and erases what this browser kept for it. If the machine cannot be reached at that moment, it is removed here anyway: revoke this computer in that machine's **Settings → Access & network → Devices**.

## Security

- **A paired computer has all the rights of the account that authorized it, administration included.** Give a code only to a computer you control, and only for an account whose rights you mean to grant.
- **HTTPS, always.** The access a machine grants never travels in clear. Keep each daemon on its loopback and publish it through `tailscale serve` (your devices only) rather than on the internet.
- **This computer keeps the access** to each machine of your list, encrypted in its secrets vault. It never gives it to the browser, and it never sends this computer's own credentials to another machine.
- **Revoke what you no longer use**, from the other machine's [Connected devices](connected-devices.md), or by removing the machine here. An access unused for 90 days expires by itself.

## Built-in browser in desktop windows

Every desktop window can open the built-in browser. Different profiles can stay
visible in different windows. Windows on the same profile share its tabs and
sign-ins: click the page in the window you want to use to take control; the other
window stays a viewer.

The browser follows the machine selected in each window. On another machine it
uses live video, as in the web app; Timon's desktop app must be running on that
machine. If the local native view cannot open, the panel also uses live video.

## Known limits

- A switch reopens the page, not its scroll position.
- Approving a third-party plugin on this computer while you are on another machine takes effect at the next reload.
