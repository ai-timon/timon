---
title: Let an agent control your computer
sidebar_position: 3.4
---

With **Computer use**, an agent can look at your main screen and drive the mouse and the keyboard, like a person sitting at the machine. It is meant for what has no other way in: a desktop application without an API, a settings window, a legacy tool. For web pages, the [built-in browser](missions.md#the-built-in-browser) is safer and more precise.

Computer use needs the **Timon desktop app** running on the machine to control. It is off for every agent until you turn it on.

## Turn it on for one agent

1. Open the agent's settings and go to **Permissions**.
2. Switch on **Computer use**.
3. Follow the setup card that appears under the switch: it checks each requirement (desktop app connected, system permissions, input tool) and marks it ✅ or ❌. On macOS, **Allow** shows the system prompt; when macOS asks for it, **Restart Timon** reopens the app. Elsewhere the card gives the exact steps or the install command. It updates by itself when you come back from System Settings.

Only that agent gets the screen and input tools; other agents are unaffected. Switching it off removes them at the agent's next conversation. The agent can list and focus windows, read a window as a tree of elements and act on them, take a screenshot (a JPEG, 1024 px wide by default, of the whole screen or of [one window](#capture-one-window)), move the pointer, click, double-click, drag, scroll, type text and press key combinations. To keep the cost in tokens down, it chains the steps it can predict in a single call and looks at the screen only when the next step depends on it.

## Choose the applications it may use

Computer use is **refused for everything except an explicit list of applications**. In the card **Allowed applications** under the setup card, list the applications the agent may control, each in its own [mode](#choose-a-mode-per-application). Before every screenshot, mouse or keyboard action (click, double-click, move, drag, type, key, scroll, cursor position), Timon reads which application is in front, and the action is refused with `computer_app_not_allowed` unless it is on the list in the foreground mode. The error names the application it found, so the agent can ask you to add it.

The foreground application is checked just before each action. A window change in the interval between the check and the action remains possible.

- An entry can be the application's name, the name of its executable, or on macOS its bundle identifier (for example `TextEdit`, `notepad` or `com.apple.TextEdit`). The case does not matter, and a trailing `.exe` is ignored.
- **An empty list means the agent cannot do anything with the computer.** The card warns you about it. Only listing the windows and waiting stay possible.
- **Add from open windows** lists the applications that have a window open right now: click one to add it. Timon reads its accessibility tree first and pre-fills the mode (see below).
- Only a person can edit the list. An agent cannot add to it, whatever its account holds; it can only remove entries, and it can **ask you** to add some, as the next section describes.

**Known limit:** a screenshot of the whole screen shows everything on it, not only the allowed application in front. The agent can [capture one window](#capture-one-window) instead, but that capture is cut from the screen, so whatever covers the window shows in it too. Close or hide whatever the agent must not see before you let it work.

## Capture one window

The agent can capture a single window instead of the whole screen: `computer_screenshot` and the capture that ends `computer_actions` take a `windowId`, an id from `computer_list_windows`, or `front` for the window in front. On a wide screen this keeps the text readable without a larger, costlier image: a 5120 × 1440 screen shrunk to 1024 px is 288 px tall, while one window of it keeps the whole 1024 px.

- The window's application must be allowed in the foreground mode, like the application in front, which every screenshot already needs. Otherwise the capture is refused with `computer_app_not_allowed` or `computer_background_only`.
- Only the part of the window on the main screen is captured. A minimised window, or one on another screen, is refused with `window_not_visible`: the agent brings it forward with `computer_focus_window`, or captures the whole screen.
- The coordinates of the next clicks, moves, drags and scrolls are pixels of that capture, and they stay inside the window. The next screenshot, of a window or of the screen, sets the frame again: the agent takes one after a window moves.

## Choose a mode per application

Each allowed application carries its own mode, so one agent can work in the background in TextEdit and Notes and in the foreground in Discord. The setting **Default mode of new applications** (under **Allowed applications**) is only what a newly added application starts with; each line of the list has its own **Foreground / Background** choice.

| | Foreground | Background |
|---|---|---|
| What the agent uses | Screenshots, mouse, keyboard, and accessibility | Accessibility only (`computer_a11y_tree`, `computer_a11y_action`) |
| Your screen, mouse and keyboard | The agent takes them | Stay yours: you can keep working |
| `focus_window`, the `focus` action, the keyboard fallback of `set_value` | Allowed | Refused (`computer_background_only`) |
| Needs from the application | Nothing | A **rich accessibility tree** |
| Examples | Games, canvas applications, a remote-desktop window, applications that draw their own controls | Native applications: TextEdit, Notes, Finder, Notepad, Calculator, many settings windows |

Which applications are eligible for the background? Those whose controls the system describes: buttons, fields and menus with names and actions. A game or an application that draws everything on a canvas shows an **empty tree**, so only pixels work: allow it in the foreground. Applications built on a web engine sit in between: the tree of a browser page is usually rich once accessibility is on, but check it.

When you add an application from the open windows, Timon reads the tree of one of its windows (200 elements at most) and tells you what it found:

- **Rich accessibility: background possible**: at least three elements accept an action. The mode is pre-filled with Background.
- **Limited accessibility: foreground advised**: a few elements only. The mode is pre-filled with Foreground.
- **Empty tree: foreground only**: nothing but the window itself. The mode is pre-filled with Foreground.
- **Not checked**: an application added by name, or not open. It starts with the default mode, and you can open it and add it from the open windows to check it.

You can always change the pre-filled mode. Only a person can set modes: an agent can move an application from foreground to background (a narrowing) but never the other way round, and cannot add one.

The rules, per application:

- `computer_a11y_tree` and `computer_a11y_action` work for the application of the window or element, in either mode. In the background, the `focus` action and the keyboard fallback are refused for it.
- Screenshots, cursor position, click, double-click, move, drag, type, key and scroll need the application **in front** allowed in the foreground mode. Otherwise: `computer_background_only` when it is allowed in the background ("Notes is allowed in the background only: use a11y_tree / a11y_action"), `computer_app_not_allowed` when it is not on the list.
- `focus_window` is judged on the application of the window it targets, with the same two refusals.
- `computer_list_windows` and `computer_wait` are always possible.

## Allow from the conversation

You do not have to open the settings. Tell an agent, for example your orchestrator, "I want agent X to control Discord", and it calls `computer_use_propose` (`timon computer propose <agent> --add Discord --enable` from a terminal). Nothing changes yet: a card appears in that conversation, titled **Allow X to control Discord with computer use**.

- The card shows the agent's access **now** and **after** (computer use on or off, and the list of allowed applications before and after), then a reminder: the agent will control each application in the mode shown, such as `Notes (background)` or `Discord (foreground)`.
- **Allow** applies it: the agent's settings are updated as if you had edited them, and its running conversations restart with the new access at their next turn. **Refuse** changes nothing. Either way, the agent that asked is told your answer.
- Only you can press **Allow**, from the app (a signed-in session or a paired device): an agent's, a conversation's or the daemon's token is refused, so an agent can never grant itself access. A request applies once, and expires after 24 hours; after that, ask again.
- A request can add applications (up to 20, each with a mode, or the agent's default when it gives none), remove some, change the mode of a listed one, and switch computer use on or off. If the application is open, the card also shows the name your system gives it, such as "discord" for "Discord". The list keeps the name as the agent wrote it, which Timon compares without regard to case; to be exact, ask the agent to give the bundle identifier (`com.hnc.Discord` on macOS), the executable (`Discord.exe` on Windows) or the command (`discord` on Linux).

## Windows

Two more actions let the agent find its way around without guessing coordinates:

- `list_windows` returns the open windows as `{ id, title, app, focused }`.
- `focus_window` brings a window to the front by its `id`. It is refused with `computer_app_not_allowed` when the window's application is not on the list, and with a clear error when the window no longer exists.

Both can be used as a step of a chained call. The window `id` is only valid until the windows change: list them again when in doubt.

## Read a window by its elements

Before looking at pixels, the agent reads a window as a **tree of elements** (buttons, fields, menus, with their names, values and the actions they accept) and acts on an element directly. This is faster, cheaper (text instead of an image) and more reliable than guessing coordinates, and it moves neither your mouse nor your keyboard.

- `computer_a11y_tree` reads the window in front, or the one given by its `id` from `list_windows`. `query` keeps the elements whose name, value or role contains a word, together with the elements that contain them. Positions are only returned on request. Without `maxDepth` it reads up to 15 levels (the maximum), so the web content of a browser or Electron window is reached; `maxNodes` is the real limit. With a `query`, only the matches and the elements that contain them count against `maxNodes`: it is the way to search a large window.
- `computer_a11y_action` acts on an element by its id: `press`, `focus`, `set_value` (writes a value into a field), `select`, `expand`, `collapse`, `show_menu` or `scroll_into_view`. The element lists the actions it accepts; any other is refused with the possible ones. It can also be a step of a chained call.
- An element id lasts as long as the window does not change. After a change the agent gets `a11y_element_stale` and reads the tree again.
- A very large window (an editor with dozens of tabs open, for example) may take too long to read whole. The agent then gets what could be read, marked as cut short, or the error `a11y_tree_too_large` (HTTP 504), and narrows its request: a `query`, a smaller window by its `id`, or a lower `maxDepth`. On Linux the elements closest to the top of the window (toolbars, visible controls) are read first, and the pages that are not on screen are skipped.
- The agent takes a screenshot and clicks in pixels only when an element is missing from the tree.

The same list of allowed applications applies: the tree of a window, or an action on one of its elements, is refused with `computer_app_not_allowed` unless its application is listed. The action journal keeps the length of a value written with `set_value`, never the value.

The setup card has an optional **Accessibility tree** line. Without it, or where the system does not offer it yet, the agent works from screenshots as before. On Linux, accessibility must be turned on in the desktop session; Electron and Chromium applications build their tree only when accessibility is on, which Timon asks them for where the system allows it.

## Work in the background

An application allowed in the **background** keeps your screen, mouse and keyboard yours, so you can keep working while the agent acts:

- Allowed: `computer_list_windows`, `computer_a11y_tree`, `computer_a11y_action` (`press`, `set_value` written directly into the field, `select`, `expand`, `collapse`, `show_menu`, `scroll_into_view`) and `computer_wait`. The agent acts by window `id`, without bringing the window to the front.
- Refused with `computer_background_only` (HTTP 403): screenshots, click, double-click, move, drag, type, key, scroll and cursor position while that application is in front, `computer_focus_window` on its windows and the `focus` accessibility action, which would take your focus or show your screen.
- When a toolkit refuses to write a field through accessibility, the keyboard fallback is not used: the agent gets `a11y_failed` and tries another element, or asks you to allow the application in the foreground.

Set every application to Background (or pick Background as the default mode) to get an agent that never touches your screen.

## Allow Timon on your system

| System | What to do |
|---|---|
| macOS | Allow Timon under **Accessibility** (mouse and keyboard) and **Screen Recording** (screenshots), from the setup card or in **System Settings › Privacy & Security**. If the first agent action happens before, macOS asks then. Restart Timon after granting Screen Recording. |
| Windows | Nothing to grant. Windows does not let Timon type into an application running as administrator unless Timon runs as administrator too. |
| Linux | An **X11** session with the `xdotool` tool installed (`sudo apt install xdotool`, `sudo dnf install xdotool` or `sudo pacman -S xdotool`). |

**Wayland is not supported**: under Wayland the system does not let an application inject mouse and keyboard events, so Computer use reports itself as unavailable. Log in to an X11 session instead. The same happens when `xdotool` is missing or when macOS permissions are not granted yet; the agent's settings tell you which.

## Watch the agent's pointer

You see where the agent goes. Before a click, a double-click or a move, the mouse pointer glides to its target in about 200 ms instead of jumping there. While the agent is in control, Timon also draws its pointer over the screen: an arrow with the agent's name, the path it just took and a ring on each click. When the agent acts on an element through accessibility (as it does in the background, without moving the mouse), a frame shows the element it touched, when the application gives its position.

This drawing lets your clicks through, never takes the keyboard and is left out of the screenshots sent to the model. It disappears when the agent stops acting and when you press **Stop**.

To change it, create `computer-pointer.json` in Timon's folder (`~/.timon` on macOS and Linux, `%USERPROFILE%\.timon` on Windows):

```json
{ "motionMs": 200, "ghost": true }
```

- `motionMs`: how long the pointer glides, in milliseconds, up to 2000. `0` makes it jump as before.
- `ghost`: `false` hides the pointer Timon draws over the screen.

Changes apply to the next action, without restarting Timon. On Linux, the drawing needs a desktop with compositing (GNOME, KDE Plasma, Cinnamon and most desktops have it); on a window manager without it, set `"ghost": false`.

## Stop it at any time

While the agent is in control, a banner with a **Stop** button is visible in Timon, and a small always-on-top bar shows on the screen. You can also press **Control+Option+Command+Esc** (macOS) or **Ctrl+Alt+Shift+Esc** (Windows and Linux) from any application.

After a stop, every Computer use action of every agent is refused until you resume it from the banner. Only a person can stop or resume; an agent cannot. If another application already uses the shortcut, the button still works.

## Review what the agent did

Under the setup card, the agent's page shows an **Action journal** with its last 50 actions: time, action and result (a refused action shows the reason, such as `computer_stopped`). Press **Refresh** to reload it. The journal keeps the coordinates and keys of each action, never the text typed (only its length) and never a screenshot, and it keeps the last 5,000 actions across all agents. Only you can read it: an agent cannot read its own journal.

## Security

- **The agent really controls the machine.** It acts in whatever is open on your screen, with your accounts and your rights. Watch it work, close sensitive windows first, and do not leave it unattended with anything you cannot afford to lose.
- **Never ask the agent to type a password**, a recovery code or a payment detail, and never leave a password manager unlocked in view: every screenshot is sent to the model provider of the agent. Type secrets yourself.
- What is on the screen is data, not instructions: an agent can be misled by text shown in a window or a page. Stop it if it does something you did not ask for.
- Text the agent types is never written to Timon's logs.
