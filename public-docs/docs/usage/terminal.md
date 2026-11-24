---
title: Built-in terminal
sidebar_position: 4.75
---

Timon has a terminal emulator of its own. It runs a shell **on the machine where Timon's daemon runs**, and you can use it from the desktop app, a browser, or your phone: from the sofa, you can run a `sudo` command or reboot a service on your computer as if you were sitting in front of it.

## Open a terminal

- **The Terminal page**: **Terminal** in the navigation rail, or `/terminal`. This is the most comfortable place on a phone.
- **A popup over the page**: the **Terminal** button in the strip above the chat's message box, beside the Git branch, opens a terminal in the folder of the mission's project, as a popup over the page you are on. In a multichat cell, that shell belongs to the conversation's project. On the Terminal page, **Open in the workspace** does the same without a folder.

A terminal is an island like any other: each tab is a shell. **+** starts a new one; the cross on a tab closes it and stops its shell.

## One terminal per project

Shells belong to the project you are in — or to the agent, when it has no project. In the chat of a project, **Terminal** only shows that project's shells, and a new one starts in the project's folder; two projects' shells never share a tab strip. A terminal you opened stays where you put it — on that page and project — and is not on the others, unless you choose **Keep on every page** in its menu.

On the **Terminal** page, the buttons next to the title switch between **No project** and every project or agent that has shells. A shell started on your desktop shows on your phone there, with what it printed so far.

## Commands an agent asks you to run

An agent never types in your terminal, and never opens it. When it needs a command it may not run itself (one with `sudo`, for instance), the command shows as a card in the mission's conversation. **Paste into a terminal** opens the terminal of the mission's project and types the command at its prompt, without Enter: read it, then press Enter yourself. From the multichat grid or the cockpit, it opens the terminal of that conversation's project. On another project's page, the terminal is not opened: the command is copied to your clipboard instead. See [Agent tools](agent-tools.md) for the other choices on the card.

## A shell keeps running when you leave

Leaving the page or locking your phone does not stop the shell: a long `apt upgrade` keeps going, and coming back shows the screen as it is now. Timon reconnects on its own when the connection drops, and as soon as you come back to the app.

A shell that no tab has shown for **30 minutes** is stopped. Change the delay in **Settings → Interface → Terminal → Close a detached terminal after**.

Restarting or updating Timon's service does not stop the shells either: they run in a separate process that stays up meanwhile, so a rebuild followed by a restart, typed in the terminal itself, goes through to the end, and the window reconnects on its own once the service is back. Only restarting the computer stops them — and, on Windows, installing a new version of the app. If that separate process cannot start on your machine, the shells run inside the service and stop when it restarts.

## Place the terminal

The terminal opens as a popup: move it like a window by its header (its title, or the six dots at the left), resize it from any edge or corner. While it moves nothing else is drawn; push the pointer against an edge of the screen and a highlighted area shows where it will dock — release there to dock it, anywhere else and it stays a popup where you left it. Around the middle of an edge, it takes the whole width (or height) of the page; further along that edge, and in a corner, it docks to the column or row under the pointer — push it into the bottom-right corner to stack it under a terminal on the right. Escape puts it back. The island's **⋯** menu — or a right click on its tab — offers **Dock to the workspace** (the popup becomes a column of the page, like any island) and **Keep on every page** (the popup follows you to other pages and projects, until you choose **Keep on this page only**). The **–** button beside a popup's cross (also in its menu) minimizes it: it leaves the page and waits as a small tab in the bottom-right corner, with its title (and its number of tabs when it has several); click the tab, or focus it and press Enter, to bring the popup back at the same place and size. A minimized popup kept on every page stays minimized from page to page, and still counts among the 4 popups a page can hold. The arrangement is remembered for each page and project, on your account.

On a phone, the terminal takes the whole screen and stays above the on-screen keyboard.

## Next to a page: split the screen

A terminal can also sit **next to the page** you are on, in an island of its own, instead of floating over it. A drag of its tab onto an edge of another island places it, or, from the keyboard, **M** on its focused tab.

- The page and the terminal share the screen; drag the gap between them to give one more room, or double-click it to share it evenly again. With the keyboard, focus the gap and use the arrow keys (Shift for bigger steps).
- Several sessions can be split side by side or stacked, up to 8 islands. Once there are two, each island shows its tabs: click a tab to show it, its cross (or a middle click) to close it — which stops its shell. The page itself never closes.
- Hold **Alt** (Option on a Mac) while dropping a tab or an island to make it a popup where the pointer is; release it outside the workspace (on the top bar, say) and it becomes a popup there too.

### Drag and drop

You can also **drag** a session's tab (from the island's header or the Terminal page) onto the page:

- onto the **left or right edge** of an island: a new column beside it;
- onto its **top or bottom edge**: stacked above or below it;
- onto its **centre**, or onto its row of tabs: one more tab in that island, at the place under the pointer;
- along the **edge of the screen** (a thin band at the very left, right or bottom, a sliver at the top): a column or row that spans the whole height or width.

While you drag, a highlighted area shows the place the session will take, and a label says what will happen ("Open to the right of Kanban", "Add a tab to Kanban"). When a drop is not possible — too many islands, or the drop would change nothing — the label says why and nothing moves.

Tabs of an island move the same way: drag one to another island. An island itself moves like a window: grab its header (its title, or the six dots at the left) and it turns into a popup that follows the pointer; it docks only against an edge of the screen, as described in [Place the terminal](#place-the-terminal). To merge two islands, drag their tabs, or press **M** on a focused tab. A popup closes from the cross at the right of its header.

The menu of **Open in a split** does the same without a mouse. Drag and drop is not available on a phone or a narrow window.

### With the keyboard

- **F6** moves the focus to the next island's tabs, **Shift+F6** to the previous one. A terminal that uses F6 for its own program keeps the key: press it from another island.
- In a row of tabs, the **left and right arrows** show the previous or next tab, **Home** and **End** the first and last, **Delete** closes the focused tab (never the page).
- On a focused tab, **M** moves that tab and **Shift+M** its whole island: the arrow keys choose the island, **Tab** cycles through the place (a tab in it, or its right, bottom, left or top half), **Enter** drops and **Escape** cancels. The same highlighted area and label as with the mouse show where it will land. The chevron of an island's header (or a right click on a tab, or the menu key) opens its menu: open as a popup, dock, keep on every page, minimize, close — and, with frosted glass on, **Glass**, where that island's glass sits (see [Settings](settings.md#appearance-and-plugin-settings)); on a narrow screen, the menu of a tab in the stacked row offers it too.
- The arrangement is remembered for each page and project, on your account. On a phone or a narrow window, the page and the terminals are shown one at a time, with a row of tabs on top. Right-click a tab, or press the Menu key, to close it, open it in its own window or move it left or right among the tabs of its island; with a mouse, you can also drag it along the row.

This works in the chat, on the pages inside the main frame (cockpit, Kanban, settings, the Terminal page, plugin pages) and on the Events, Notifications, Agents, Projects and Multichat pages. On the Multichat page the whole grid is one island: a terminal opens beside the grid, not in one of its cells. On the Agents and Projects pages, the widget rails fold behind their buttons when the page's island gets narrower than a small window. In the chat, the widget columns stay in the chat's island: when the island gets too narrow for them, they fold into panels opened by the buttons at its top, as on a small window.

## Save an arrangement of islands

Once a page is split the way you like, keep that arrangement under a name and lay it on any other page. Open the appearance menu (the palette icon of the top bar): under **Island arrangements**, **Save the islands of this view** asks for a name. The arrangement is saved for your account, whatever the page or the project you saved it from.

- Click an arrangement in that list to lay it on the page you are on. Only the islands change: the page's widgets and the chat's columns stay as they were.
- An arrangement keeps which contents sit where, never what they were doing that day. A chat comes back with its agent and asks which conversation to continue; a terminal starts a new shell in the same project; a browser opens the agent's own profile. Saved layouts of a view (above the arrangements in the same menu) follow the same rule for their islands. Laying an arrangement or a saved layout on the page you are on closes the tabs it replaces, as if you had closed them: a terminal it removes ends its shell, and a document with unsaved changes asks first.
- The arrow beside an arrangement opens it as a page of its own. **Manage** lets you rename an arrangement, overwrite it with the islands of the page you are on, **Show it in the menu**, or delete it. Up to 12 arrangements.
- An arrangement shown in the menu gets its own entry in the main menu, with its name. You can move or hide that entry like any other (**Customize the menu**). Its page opens with the arrangement; what you change there stays on that page and leaves the saved arrangement untouched. **Restore the arrangement**, in the page's own island, puts it back as saved. Deleting the arrangement removes its menu entry.

A page that shows nothing but itself has no arrangement to save: split it first.

An agent can save an arrangement for you too, or list the ones you kept ([agent tools](agent-tools.md#splitting-your-screen-into-islands)); it never adds one to the main menu.

## Copy and paste

Select text with the mouse, then:

| | Copy | Paste |
|---|---|---|
| **macOS** | Cmd+C | Cmd+V |
| **Linux** | Ctrl+Shift+C | Ctrl+Shift+V |
| **Windows** | Ctrl+Shift+C, or Ctrl+C while text is selected | Ctrl+Shift+V |

Ctrl+C with nothing selected still interrupts the running command, and Ctrl+V still reaches the shell as it does in any terminal. A right-click on a selection offers **Copy**, and **Paste** when Timon may read your clipboard.

When you open Timon by its address on your network over `http://` (not `https://`, nor on the computer itself), the browser keeps scripts away from the clipboard: copying still works, and you paste with the keyboard shortcut or the browser's own right-click menu.

## On a phone: the extra keys

A phone keyboard has no Esc, Ctrl, Tab or arrow keys. On a touch screen, a bar under the terminal adds them:

- **Ctrl** stays pressed for the next key: tap **Ctrl**, then `c` to send Ctrl+C.
- **Esc**, **Tab** and the four arrows (the up arrow brings back the previous command).
- `|`, `/`, `-`, `~`, `>`, `&` and `*`, which hide on the second page of most keyboards.
- **Copy** appears first while text is selected in the terminal, and copies it.

## Icons and Powerline prompts

The terminal comes with the [Nerd Fonts](https://www.nerdfonts.com/) symbols: prompts such as starship or Powerlevel10k, and tools such as `eza` or `lazygit`, show their icons and Powerline arrows without any font to install. An icon is one character wide and may overlap the space after it, as in most terminals. If you installed *Symbols Nerd Font Mono* on your machine, that copy is used.

## Who can open a terminal

A terminal is a shell as the user account the daemon runs under: whoever has one can do everything that account can, including `sudo` with its password. So:

- Only an account allowed to **open a terminal** can start or join one. The superadmin always can; for anyone else, add the permission *Open a shell on the host from the built-in terminal* to a permission set held by one of their groups — only for someone you would trust with your computer.
- Each user only sees their own shells. Not even the superadmin can join another user's shell.
- Agents cannot open one: a terminal is for a person signed in from a browser or the app.
- **Settings → Interface → Terminal → Built-in terminal** turns it off for everyone.

To use it from your phone away from home, reach Timon through a private network such as [Tailscale](https://tailscale.com/), never by publishing its port on the internet. [Remote access to the web interface](../installation/remote-access.md) explains how.

## Shell and platform

The terminal starts your login shell (`bash`, `zsh`…) on Linux and macOS, and PowerShell on Windows (PowerShell 7 when it is installed, otherwise Windows PowerShell 5.1, where commands chain with `;` rather than `&&`). **Settings → Interface → Terminal → Built-in terminal shell** (advanced) starts another program instead.

The older **Host terminal** module is different: it opens your computer's own terminal application, in a window of your desktop, and needs a graphical session.
