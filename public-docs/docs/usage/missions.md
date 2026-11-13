---
title: Missions
sidebar_position: 3
---

## Start and follow a conversation

Choose an agent in Chat, enter a concrete request and send it. The mission records assistant output, tool activity and its completion state. Use the mission view to inspect activity and errors when a result is missing or unexpected.

From a terminal:

```bash
timon spawn project.writer "Describe the current project."
```

The response contains a `mission_id`. Use that ID with `timon status`, `timon send`, `timon steer` or `timon wait`. The mission history remains available for inspection.

```bash
timon status MISSION_ID
timon send MISSION_ID "Focus on the installation instructions."
timon wait MISSION_ID --timeout=120
```

`timon wait` returns when the agent ends its turn. A turn Timon retries after a provider outage is not over: the wait goes on until the retried turn answers.

`timon send` continues the conversation without stopping a turn; to change course during one, see [Writing while the agent works](#writing-while-the-agent-works).

The top bar has a tab for each agent at work: its avatar, with a ring pulsing around it while it works, its state (thinking, needs you, done) and the elapsed time. The cross at the top right hides the tab until the agent's next mission; the pin at the bottom right keeps the tab in the bar even when the agent is idle. On a phone, the tabs have their own bar under the menu bar, which stays at the top of the screen when the menu bar hides as you scroll.

To start a blank conversation, click the pen at the top of the missions list, **New conv** on the mission card, or the pen at the right of the strip above the message box. In a project with several agents, it opens the list of the project's agents — its main agent first, each with its role, the agent open already selected: press Enter to start over with it, or pick another agent to open a new mission with that one. An agent alone in its project, or with no project, starts over in one click.

Press ↑ in the message box to bring back the prompts you already sent to this agent, one by one, and ↓ to come back toward the latest — past it, you find what you were typing. In a message shown on several lines, ↑ works from the start of the text and ↓ from its end; elsewhere the arrows move the cursor as usual, and they browse the `/` menu while it is open. The last 50 prompts per agent are kept in this browser only.

In the cockpit, the chat card shows its agents as one row of avatars, the one you are talking to larger. Click an avatar to switch the chat, or the **+** at the end of the row to add an agent from a searchable list. On the Agents page, the in-progress task list animates the «thinking» indicator on every mission being worked on.

## Your conversations and automated missions

Many missions are not conversations you started: Kanban tasks, routines and triggers, an agent delegating to another or waking up on a message, Timon's own maintenance. A small icon before each title in the Missions table tells who started it (hover it for the label), and the **Origin** filter keeps only one kind:

| Origin | Started by |
|---|---|
| **You** | Your messages in the chat, including from a messaging integration. |
| **Kanban task** | A task of the Kanban. |
| **Routine / trigger** | A routine or a trigger, through the task it created. |
| **Another agent** | An agent that delegated the work, or that woke this one with a message. |
| **System** | Timon itself: recovery after a crash, documentation, workflows. |

**Automated** keeps everything except your own conversations. In the chat, untick **Automated missions** in the filter menu of the mission list to show only your own conversations; the mission you have open stays listed.

## The missions list of the chat

The top of the list says what it shows, such as **All · 300** or **coder · 12**. The funnel button next to it opens the filter menu, and wears a dot when a choice differs from the default:

- **Role** keeps the missions of one role, with the number of each. A mission whose agent has no role is under **other**.
- **Automated missions** shows the missions you did not start yourself (on by default).
- **Group by orchestrator** puts each mission under the highest mission of the list that launched it, directly or not: a task, its review, its merge and what they spawned all sit under the orchestrator, on a lightly tinted panel joined to it by a thin line. The orchestrator shows how many missions it holds; click that number to fold or unfold them. Groups start folded, except the one holding the mission you have open. A mission whose launcher is not in the list stays on its own. With **Automated missions** off, the missions inside a group stay visible. With a **Role** chosen, an orchestrator of another role stays above its missions of that role to show where they come from: it is dimmed and not counted in the total.
- **Unfold sub-agents** opens every group by default (off by default; available while **Group by orchestrator** is on).
- **Avatar** shows the agent's face on each row (on by default).

These choices are remembered for your account, except the role, which applies to this window only. While an agent works, a ring pulses around its avatar, or a dot beside the title when avatars are hidden; an orchestrator's avatar pulses while one of the missions under it works. The pen next to the funnel starts a new conversation.

`GET /api/missions?origin=user` (or `automated`, `task`, `routine`, `agent`, `system`) applies the same filter, and each mission carries its `origin`.

## The name of a mission

The lists name a mission by its title: the one you typed (**Rename** in the chat list's right-click menu), the one its launcher gave it (a Kanban task's title, a workflow node, `timon spawn --title "Short name"` or the `title` of `mission_spawn`), or the one Timon generates at the end of the first reply of a conversation you opened. Without any, the first line of the message is shown. Which model writes the generated titles, and whether they are generated at all, is chosen in [Settings → Missions](settings.md#conversation-titles).

The same right-click menu has **Copy ID**, Timon's own id of the mission, and **Copy CLI session ID**, the id of the session of the command-line tool that runs it (a Claude Code session, a Codex thread…), shown shortened beside the entry and copied in full. Give both when you report a problem. The entry is missing until the tool has started its session; a mission resumed later may carry a new one.

## What state a mission is in

A mission shown as "running" is only an open conversation: the agent's process stays alive after a turn ends, until Timon closes it when idle. Each mission therefore carries a badge in the chat's mission list and in the Missions table:

| Badge | Meaning |
|---|---|
| **Working** | The agent's process is alive and a turn is running. |
| **Turn done** | The process is alive, but the last turn is over: the agent waits for your next message. |
| **Open** | The mission is still open but nothing is running: no process, or no finished turn yet. |
| **Interrupted** | The mission was cut before the end. Hover the badge for the cause: usage limit reached, out of credit, model overloaded, permission denied, killed, stopped by hand, silent too long, turn budget reached or crashed. |

A finished mission shows no badge. Next to the badge, a letter icon counts the messages still waiting in the agent's inbox and an arrow icon the requests it received and has not answered yet.

On the Agents graph, the ring still pulses for an agent at work; a small dot on the node marks the other cases: green for a finished turn, grey for an open mission, red for an interrupted one. Hover the dot for the detail.

The same fields (`liveness`, `interrupted_reason`, `pending_messages`, `open_deliveries`) come back from `GET /api/missions` and `GET /api/missions/:id`, and `timon status` reads them from the mission.

To interrupt work deliberately, use the mission's stop control or `timon kill MISSION_ID`. Interruption does not mean the requested work was completed: check files and task status before retrying.

If Timon itself restarts while a turn is running (a crash, an update, the background service restarted), the mission ends as **Interrupted** and its chat shows "turn interrupted: Timon restarted". The turn is not replayed on its own, since it may already have changed files or sent messages: check what it did, then send a message to carry on. When the backend can resume its session, the conversation picks up with its context.

If that session can no longer be found, Timon restarts the turn from the conversation it recorded. A **Native session unavailable** card in the chat says what the agent received: the recorded conversation, a summary, only its end, or nothing when no history exists. A long conversation is summarized rather than replayed whole, within the limit set for handovers.

A backend that keeps no session at all, seen when a turn ends without reporting one, gets no replay and no card: each of its turns starts from your message alone, and a single line in the chat says so at the first such turn.

## Writing while the agent works

You don't have to wait for the end of a turn to write to the agent. While it works, the chat input gives you two choices:

- **Enter steers the turn.** Your message reaches the agent now, and it changes course without waiting for the end of what it was doing.
- **Ctrl+Enter (⌘+Enter on macOS) queues the message.** It goes out on its own as the next turn, once the current one is over.

The input's placeholder recalls both shortcuts while the agent works. To swap them, so that Enter queues and Ctrl/⌘+Enter steers, open **Customize interface** in the top bar, then **Chat appearance**, and pick **Enter while the agent works** (the same menu opens from the palette button that appears at the end of the bar above the input when you hover it).

How a steer reaches the agent depends on its backend:

| Backend | What happens |
|---|---|
| Claude | The agent reads your message between two steps of the turn it is running. |
| Hermes gateway | The gateway takes the instruction into the running turn. |
| Codex, Grok, GitHub Copilot | The turn is stopped and the agent resumes the same conversation with your message. A step it had not finished is redone. |
| Pi | Pi takes the instruction into the running turn. |
| ACP agents (opencode, Hermes, Cursor…) | The turn is stopped and your message starts the next one, in the same session. |

When the turn was stopped to take your message, the chat shows "turn redirected". A message with a file attached is always queued. If the agent cannot be redirected right now (for example a Codex turn that has only just started), the message is queued instead and the chat says so.

From a terminal, or from another agent with the `mission_steer` tool:

```bash
timon steer MISSION_ID "Stop the refactor, fix the failing test first."
timon wait MISSION_ID
```

Outside the chat nothing is queued for you: the request is refused, with the reason, and the instruction is not kept.

| Refusal | Meaning | What to do |
|---|---|---|
| `no_turn_to_steer` | No turn is running. | `timon send` or `mission_send` |
| `steer_unsupported` | This agent cannot be redirected right now. | `timon send` or `mission_send`, or try again |
| `steer_self` | An agent tried to redirect its own mission. | Act on the instruction directly |

`timon send` and `mission_send` never stop a turn. If one is running, the agent takes the message between two steps or after the turn, depending on its backend; a backend that cannot take it refuses with `turn_in_progress`.

Each accepted steer returns how it landed: `method: "live"` when the agent reads the instruction inside the turn, `method: "restart"` when the turn was stopped and the instruction opened the next one. An agent can only steer missions of the account it works for; any other mission does not exist as far as it is concerned.

## Copying and replying to a message

Hover a message to show its buttons; each one says what it does when you point at it. Under an agent's message:

- **Copy** copies the text as you read it.
- **Copy as Markdown** copies the agent's answer with its formatting (headings, lists, code blocks, links), ready to paste into a document or a ticket.
- **Reply** answers that message.
- **Read aloud** reads it with your system's voice.

Under your own messages, **Copy** and **Reply** are there too.

### Replying to a message

**Reply** puts a strip above the message box with the start of the message you answer; type and send as usual. Click the strip to go back to that message, and its cross (or Escape) to cancel. Your message then shows the quote at its top; click it to scroll back to the message it answers. A reply works the same way while the agent works: it steers the turn or waits in the queue with the rest of your message.

The agent does not receive a copy of the whole message. It receives the start of it and its reference in the conversation, enough to find it in what it already read. After a compaction or a change of model, when that message may no longer be in its memory, it reads it again by that reference.

## Stopping an agent or a whole project

To stop one running mission, hover it in the chat's missions list and click the square, or right-click it and choose **Stop**; Timon asks you to confirm first.

Typing "STOP" in a chat does not stop anything by itself, and an empty Kanban does not mean nothing will start again: messages waiting in an inbox, scheduled tasks and triggers can all wake an agent later. To stop a scope for real, use:

```bash
timon stop agent AGENT_NAME
timon stop project PROJECT_SLUG
```

or **Stop everything** in the right-click menu of an agent's avatar in the chat card. For that agent, or for every agent of the project, Timon:

- terminates the running missions;
- cancels the messages still waiting in their inboxes, and those they sent that were not delivered yet;
- closes the requests they were answering, or waiting on, without sending an automatic reply;
- moves their `PENDING` and `IN_PROGRESS` tasks to `BLOCKED`, with the reason "Stopped by …". A project stop also covers the project's tasks assigned to agents from elsewhere;
- switches off the triggers and routines that would start their work, or that they created;
- cancels the workflow runs in progress that they pilot, that run or would run one of their nodes, or, for a project stop, that are filed under the project. The whole run is cancelled, its other missions included, and its pilot is not woken to hear about it;
- switches off the published workflows that would start a new run on them: those they pilot, those with a node on one of them, or, for a project stop, those filed under the project. Their schedules, webhooks, events and plugin entries stop with them, and stay off after a restart. You can still run such a workflow by hand.

The command lists everything it neutralised; add `--json` for the full detail. Nothing is deleted: to resume, unblock the tasks you still want and switch the triggers and workflows back on.

A stop only reaches your own missions, tasks, messages and triggers; an administrator's stop reaches everyone's. It requires the **Stop own agents and projects** permission (`missions:stop`), or the permission to start missions.

## Attaching images and files

Paste an image into the message box, drop files on it, or use the paperclip. Images go to the model with your message; other files (PDF, spreadsheets, archives…) are saved on the machine that runs Timon, and the agent opens them with its own tools. Some backends accept images only: the chat says so when you add another file.

- **Images are resized before sending**: longest side 2048 px, as JPEG, or PNG when the image has transparency. Models do not look at more detail than that. An image still larger than 8 MB afterwards is refused.
- **One message carries at most 18 MB** of images, files and long pastes together. An attachment that would go past it is not added, and a message says how many were left out: send them in a second message.
- **More than three images fold into a stack** that shows their number. Click it to see them all and remove one; click it again, click elsewhere or press Escape to fold it back.

## Images and videos in the chat

An agent shows a picture or a video with its `chat_show_media` tool. It appears in the conversation as a card: click the preview to enlarge it, or use **Download**. Videos play in place.

The agent can show:

- **a file of the mission**, by its absolute path inside the mission's working folder. Images: PNG, JPEG, GIF, WebP, AVIF. Videos: MP4, WebM, MOV, Ogg;
- **an `https://` address on a public site**, for instance the result of an image or video API. Timon downloads it itself and checks it is really an image or a video; your browser never contacts that site. The card says where it came from;
- **an inline image** (`data:image/…;base64`), up to 10 MB.

One conversation keeps at most 1 GB of shown media, all sources together. Past that, the agent is told the conversation has reached its media storage limit. The media are deleted with the conversation's attachments, once it has been finished for 30 days.

Images generated by a GPT model on the Codex backend appear on their own at the end of the turn, as "Generated image".

An agent can also show a table, a chart or a form as an interactive card, and wait for your answer: see [HTML cards in the chat](html-cards.md).

Timon refuses SVG files, files in hidden folders, plain `http://` addresses, IP addresses, `localhost` and local network names, custom ports, and addresses that carry a login. The agent receives the reason and can correct its request.

When you invoke a skill with `/skill` in a follow-up message to an agent on Codex, Grok or Copilot, the chat folds its procedure into a «Skill /name» line you can expand, instead of pasting the whole text in your bubble.

Agents that expose their reasoning (opencode, Hermes, Codex, Copilot) show it as a collapsed **Reasoning** block above the answer.

Images written inside a message, a note or an inbox item (Markdown `![…](…)`) are not loaded: their caption is shown instead, marked "Image not shown".

## Previewing files in the Files widget

Click a file in the **Files** widget of a chat to open it, read-only, without leaving Timon:

- **images**: PNG, JPEG, GIF, WebP, AVIF;
- **videos**: MP4, WebM, MOV, Ogg, with the player's controls;
- **PDF**, in your browser's own viewer;
- **Word (`.docx`), Excel (`.xlsx`) and PowerPoint (`.pptx`)**, as text: headings, paragraphs, lists and tables for Word, the cells of each sheet (first 1,000 rows) for Excel, the text of each slide for PowerPoint. Pictures, charts and page layout are not drawn; use **Download** to open the file in its own application.

When a folder holds several pictures, the viewer lets you browse them: the **left** and **right arrow** keys, or the arrow buttons on each side of the picture, show the previous and next picture of that folder, in the order the folder is listed, and a counter such as "3 / 12" shows where you are. It stops at the first and the last picture instead of starting over. Only the pictures of the folder you opened are browsed, not those of its subfolders.

The **Refresh** button of the widget reloads the folder listing and the open file.

Files open in a window, like the terminal and the browser: move it by its title bar, resize it from its bottom-right corner, or dock it to the **left** or **right** of the app to keep the file in view while you chat. The window remembers its place on each device. **Escape** and the arrow keys act on the window only when it has the focus, so typing in the chat never closes it.

Text and code files still open in the editor; Markdown files open on their rendered preview, and the **View** (eye) and **Edit** (pencil) buttons switch between the two. SVG files open as source, never as pictures. The older `.doc`, `.xls` and `.ppt` formats have no preview. A file opened from the tree must sit inside the agent's working folder; Office files are limited to 50 MB.

A file link in an agent's reply (an absolute path, a `file://` link or a relative path) opens in the same window, as a tab. If the file is outside the agent's folder, Timon asks first and shows the full path. Answer **Yes** only if you trust the link: the file then opens for reading and editing. This needs the **Open files outside an agent's folder** permission, which superadmins have by default; an agent cannot use it on its own.

## Creating and moving files in the Files widget

**New file** and **New folder** create the entry in the folder you are in: the last folder you clicked, or the one holding the file you opened. With nothing selected, they use the root of the agent's working folder. A name field opens at the top of that folder: type the name and press Enter, or Escape to cancel.

Right-click a file or a folder for its menu: **Open**, **Copy path**, **Copy relative path**, **Rename**, **Show in system explorer** and **Delete** (after a confirmation). **Copy path** puts the full path on the computer where Timon runs on the clipboard (with that system's own separators, `C:\…` on Windows); **Copy relative path** gives it from the agent's working folder. **Rename** turns the name into a field, with the part before the extension selected: press Enter (or click elsewhere) to apply, Escape to cancel. A rename keeps the entry in its folder and never overwrites another one; changing only the case of a name (`notes.txt` → `Notes.txt`) works on every system.

**Show in system explorer** opens Explorer on Windows, Finder on macOS or your file manager on Linux, with the file selected, on the computer where Timon runs. In the Timon desktop app it works even when Timon runs as a background service. In a web browser, a Timon that runs as a background service has no desktop to open it on: you are told the file is on that computer, and can open it from the desktop app there.

Drag a file or a folder onto another folder to move it, or onto the empty area of the widget to move it to the root. Timon asks you to confirm each move, and refuses to overwrite an entry with the same name, to move a folder into itself, or to leave the agent's working folder.

## A file next to the page

A file can also sit **next to the page** you are on, in an island of its own, instead of in the viewer window. Right-click it in the Files widget and choose **Open in a split**, then **To the right**, **To the left**, **Below**, **Above** or **In a tab**. Or drag it out of the tree onto the page: the highlighted area shows where it will land. Over the tree itself, a drag still moves the file into a folder.

Each file gets one tab, wherever it is: opening a file that is already in an island shows that tab. A picture, a video, a PDF or an Office document opens in the viewer with its **Download** button; a text file opens in the editor, with its **View** and **Edit** buttons and **Ctrl+S** (**Cmd+S** on macOS) to save while the island has the focus. Switching to another tab keeps what you typed. Closing a tab, or its island, with unsaved changes asks first: **Save** writes the file and closes the tab (it stays open if the save fails), **Don't save** closes it and drops the changes, **Cancel** keeps it open. Reloading or closing the window while a document has unsaved changes shows a warning. Closing a skill opened in an island asks the same way.

When you rename, move or delete a file or a folder from the tree, the islands showing it close. **Open in a window**, in the island's header, sends the file back to the viewer window. The viewer window works the other way too: drag the handle (six dots) of its title bar onto the page, or use its **Place in the workspace** menu; the editor offers it once the file's changes are saved. Islands, tabs and gaps work as described in [Next to a page: split the screen](terminal.md#next-to-a-page-split-the-screen).

## Tabs in the chat's side columns

Each side column of a chat can hold several tabs, so one column can switch between, say, a single widget filling the full height and three widgets sharing it. A column's commands are in the menu of its tab line, at the top of the column: right-click a tab (or focus it and press the Menu key or `Shift+F10`; on a touch screen, press and hold it) and choose **Add a tab to this column**, **Close this tab**, **Add a column** or **Remove this column**, **Swap the columns** or **Collapse rail**. A column with a single tab shows one thin bar there, which carries the same menu (a click opens it too). Unnamed tabs are thin bars as well, a named tab shows its name; hover a tab to see which widgets it holds, and click it to show it.

To put a widget in another tab, drag it onto that tab (tabs grow while you drag): it goes to the end of that tab. Widgets always share the whole height of their column, down to the bottom and never past it; drag the gap between two widgets to give one more room than the other. The edge sticks at 25 %, 33 %, 50 %, 67 %, 75 % and 100 % of the column; hold Shift to drag it freely. **Close this tab** closes the tab you right-clicked, whichever is shown; its widgets move to the first tab, which cannot be closed. Tabs follow their column when you swap the two columns, and are saved with your layout.

## Column width and a second column

Drag the inner edge of a side column — the one facing the conversation — to make it wider or narrower; a thin line shows under the pointer. The column on the other side follows by the same amount, so the screen stays symmetrical; hold `Ctrl` (`⌘` on macOS) while dragging to resize only the column you hold. You can also click the edge and use the left and right arrow keys (hold Shift for bigger steps), `Home` and `End` for the narrowest and widest. Double-click the edge to go back to the default width. Widths are saved with your layout.

The conversation itself can be made wider or narrower too: drag either edge of the text column (a thin line shows under the pointer just outside the messages). It stays centred, so both edges move. Double-click an edge to let the width follow the room the chat has again.

On a wide screen, each side can show a second column beside the first. Right-click the tab line of the column and choose **Add a column**: an empty column opens next to it, on the conversation's side, and you drag widgets into it like anywhere else. To remove it, right-click the thin bar at its top and choose **Remove this column**: an empty one goes away, one that still holds widgets becomes a tab of the first column, widgets included.

The conversation always keeps enough room. When the window gets too narrow, the second columns fold back into a tab of their first column (one tab per column), then the columns narrow; they come back as the window widens again.

On a phone, or in a window too narrow for the columns to sit beside the conversation (a docked browser included), each column that holds widgets gets a button at the top of the conversation, on its own side. It opens the column as a panel inside the chat, with its tabs and widgets (press and hold a tab for the column's menu); tap outside it, swipe it towards its edge or press `Escape` to close it. If no column holds the **Missions** list, a separate button opens it.

## Several conversations side by side

Multichat shows a grid of chats on a desktop screen. Pick a grid size from the grid menu at the top of the left side bar, then drag agents from the side bar anywhere onto a cell — an occupied cell is replaced, and dragging an agent by its cell header moves it or swaps it with another cell. Double-clicking an agent, or pressing `Enter` on it, puts it in the first empty cell. Each cell asks which conversation to continue, or starts a new one.

The side bar groups agents by pole, project and team; groups start folded and remember whether you opened them. Type in the search field (or press `/` from anywhere on the page) to find an agent by name, role, project, pole or team — accents and case do not matter. `Enter` adds the first match to the first empty cell, `Esc` clears the search. `Ctrl+B` (`⌘B` on macOS) folds the side bar into a thin rail of avatars that you can still drag from.

To avoid rebuilding the same grid every time, save it as a template: open **Templates** at the top of the side bar and choose **Save current setup…**. A template keeps the grid size and which agent sits in each cell, not the conversations. Selecting a template later brings that setup back in one click; an agent already on screen keeps its current conversation, and an agent deleted since then leaves its cell empty. **Manage** renames a template, replaces it with the grid on screen, or deletes it. Templates belong to your account and follow you from the browser to the desktop app.

To turn the chats on screen into separate islands, choose **Grid → Open in the workspace**. The occupied cells become columns and stacks in the same order; empty cells disappear. The original cells empty, and the Multichat page stays available as a tab beside the first chat. Islands already beside the grid stay in place. The workspace accepts the whole grid or leaves it untouched: at most eight islands can be open in total, so a full 3×3 grid needs an empty cell first. Saved templates stay as they are.

Once a cell shows a conversation, the arrow button in its header (**Open this mission in the chat**) opens that conversation in the full chat page, with what a cell cannot hold: the floating terminal a command card opens, and the widget columns. `Ctrl`+click (`⌘`+click on macOS) or the middle button opens it in a new browser tab instead.

For one chat, right-click an agent in the side bar or a cell header (or focus it and press `Shift+F10`) and choose **Open to the right**, **left**, **below**, **above**, or **Open in a tab**. From the side bar this opens a conversation picker; from a cell it moves the current conversation and empties that cell only after the workspace accepts it. Dragging from these same places follows the same rule outside the grid. While the pointer is over the grid, cells keep their usual place, replace and swap behaviour; move outside the grid to drop into the workspace.

## A conversation next to another page

An agent's conversation can also sit **next to the page** you are on — the Kanban, a project, or another conversation — in an island of its own, the way a terminal does (see [Terminal › Next to a page](terminal.md#next-to-a-page-split-the-screen)).

- **Drag** an agent's chip from the top bar, or a conversation from the **Missions** list, onto the page: onto an edge for a column or a stack, onto the centre for a tab. A chip that shows a running conversation opens that conversation.
- Or **right-click** the chip or the conversation and choose **Open to the right**, **Open to the left**, **Open below**, **Open above** or **Open in a tab**.
- A chat opened without a conversation first asks which one to continue, or starts a new one. The island remembers the conversation: reloading the page reopens it. Opening the same conversation twice brings its tab to the front instead.
- Each panel keeps the agent it shows. Picking another agent's conversation from a panel's **Missions** list titles that panel after the other agent, and the view stays the one you opened: when you come back to it, from its agent's chip in the top bar or after a reload, every panel shows what it showed. With the chat alone on screen, picking another agent's conversation opens that agent's chat instead.
- Only one chat of the page shows its widget columns: the one you last clicked in. The others show the buttons of their columns at the top; clicking one makes that chat the active one. A chat in a narrow island folds its columns into panels, as on a narrow window.
- On a page other than the chat, the columns of a chat start with the widgets of the chat page, then are arranged for that page on their own. A widget you take out of them stays out.
- A chat in a tab you are not looking at is closed until you come back to it, and reloads its conversation then.

## A mission's network activity

Timon can record the outbound connections a mission makes through its proxy: which hosts it reached, when, how much it sent and received, and whether the connection failed. Nothing is blocked; this is a record you can check. It is off by default: [turn it on](network-activity.md#turn-it-on) to use what follows.

- **In the chat**: add the **Mission network** widget to a side column (**Customize interface** → **Add widget**). It follows the conversation on screen. Its button with two columns opens the same view next to the page.
- **From an alert**: the first time a mission reaches a host its project's missions had never reached, you get a notification. Clicking it opens the mission's chat with its network view beside it.

The view lists the **hosts contacted**, the new ones first with a **new** badge, then the **recent connections**: method, host and port, the HTTP status sent back to the program, bytes sent and received, duration, and the upstream error when there was one. **Load older connections** reads further back. The view refreshes at the end of each of the mission's turns, and every 20 seconds while the page is visible; the refresh button reads it at once.

Only programs that use the `HTTP_PROXY` / `HTTPS_PROXY` variables go through the proxy. Programs that ignore them reach the network without appearing here; Node's built-in `fetch` is one of them. The last 2,000 connections of each mission are kept, for 30 days at most. While `host.isolation.egress.mode` is `off` in [the configuration](../installation/config-reference.md), which is the default, nothing is recorded and the view says **Connection journal disabled** and how to enable it. The same list is available from the command line with `timon mission egress <id>`.

## The built-in browser

The browser opens in the same window as the terminal. It floats and moves by its title bar, or docks to the **left** or **right** of the app; docked, one more button chooses whether it sits **beside the content** (the chat makes room) or **over it**. Its place is remembered on each device. On a phone it fills the screen.

The address bar accepts an address without `https://` (`google.fr`), and searches the web when you type words instead of an address.

### Next to the conversation

The browser can also sit **next to the conversation**, in an island of its own, instead of in its window. In the window's title bar, drag the handle (six dots) onto the page, or open **Place in the workspace** and choose **To the right**, **To the left**, **Below**, **Above** or **In a tab**. The window closes: an agent's browser is shown in one place at a time, and the **Browser** button of the top bar then brings its island forward. **Open in a window**, in the island's header, sends it back to the window. In the desktop app, the page you browse disappears while you drag something over the islands and comes back when you drop it; when its island shows another tab, the browser keeps running and comes back when you show it again.

Docked, the window's inner edge also resizes from the keyboard: focus it with **Tab**, then use the left and right arrow keys (Shift for bigger steps), **Home** and **End** for the narrowest and widest.

### Copy and paste

Click the page, then use **Ctrl+C**, **Ctrl+X** and **Ctrl+V** (**⌘C**, **⌘X**, **⌘V** on a Mac) to move text between the page and your device. These keys need no permission: your browser never asks for access to the clipboard. Only text is transferred.

The **Copy selection** and **Paste into page** buttons of the options menu, and the page's right-click menu, go through your browser's clipboard access instead, which may ask for your agreement. Timon shows what it is waiting for; if the access is refused, it opens the clipboard window, where you paste with the keyboard and send the text to the page. From a device that does not hold control of the browser, click the page first to take control, then copy or paste again.

### How agents use it

Agents drive the built-in browser with the `timon-browser` tools (`navigate_page`, `take_snapshot`, `click`, `fill`, `take_screenshot`…), the same tools as chrome-devtools-mcp, not with the `timon` tools. Each project keeps its own persistent profile, so logins survive between missions and when you quit and reopen Timon, including on sites that only keep you signed in until the browser closes. By default, each project has its own profile, and the browser panel and the agents of that project use the same one; a project is recognised from the agent's project field, the task it runs, or the folder it works in (including a folder registered outside a `projects` directory). Timon never takes over the name `chrome-devtools`: if you declare your own Chrome server, it keeps working next to the built-in browser, and stays available if the built-in one ever breaks. If a project's browser is not running, `timon browser start [<slug>]` starts it; an agent picks the tools up the next time its mission is spawned.

Agents can also debug the page you share with them: `list_console_messages` and `get_console_message` read the console and uncaught errors, `list_network_requests` and `get_network_request` inspect requests and responses, `emulate` throttles the network or the CPU, and `performance_start_trace` / `performance_stop_trace` return a summary of load timing and Core Web Vitals. Recording starts the first time an agent asks for it on a tab. Cookie and authorization headers are always hidden from the agent. A throttled page is throttled for you too, until the agent sets `emulate` back to `No emulation`.

### Teaching an agent a flow

Press **●** in the address bar to record what you do in the browser, review the steps, then let an agent turn them into a skill it can replay: see [Teach an agent by recording a browser flow](browser-recording.md).

### Showing an agent what to change on a page

Press **✎** in the address bar, click an element of the page and write what should change there: the agent of the conversation receives your comment with the element and a picture of it. See [Point at a page and tell the agent what to change](browser-annotations.md).

### Signing in to Google

You sign in with Google in the built-in browser like anywhere else: on Google itself, or through a site's **Sign in with Google** button, in the same tab or in its popup. On Google's sign-in pages the browser presents itself as other desktop apps do (its version number hidden), so that Google accepts it, and takes its usual identity back once you leave them.

If Google still answers "Couldn't sign you in — This browser or app may not be secure", **Sign in with Chrome** opens by itself on top of the page:

1. Choose **Open Chrome**. A Chrome window (or Microsoft Edge, or Chromium) opens on the computer that runs Timon, with a profile of its own. It never touches your personal Chrome profile. If you were signing in to another site, the window opens on that site: sign in to it there as usual, with Google. Otherwise it opens on Google's sign-in page.
2. Sign in there, with your password and second step as usual.
3. Back in Timon, choose **Done, copy the sign-in**. The window closes, the sign-in is copied into this project's built-in browser, where agents use it, and the tab goes back to the site, signed in. A sign-in popup left open is closed. Closing the Chrome window yourself does the same.

The dialog opens once for each refusal: close it and it stays closed. The strip shown above the refusal page, and the browser's options menu, open it again.

Chrome has to be installed on that computer, outside a snap or flatpak package (their sandbox cannot keep a Timon profile). If none is found, the dialog says so; you can point Timon at another one with the **Chrome used to sign in** setting (`TIMON_CHROME_PATH`, in Settings under Misc, or as an environment variable). The window opens on the computer that runs Timon, so from a phone or another computer you need to be in front of it.

Only cookies are copied. A site that keeps its sign-in in the page's own storage (many apps built on Firebase do) is not signed in by **Sign in with Chrome**.

Chrome remembers its own sign-in, so running it again later is quick. Run it again if Google ends the session in the built-in browser.

## Choosing a model

Every place that lets you choose a model opens the same picker: the model chip of the chat bar, the agent editor's **LLM** tab, a Kanban task (its form and the chip on its card), a series' roles and fallbacks, a workflow's agent node, the fallback model of Auto switch and the conversation-title setting.

- **Left rail**: ★ **Favorites** first, then one button per provider. Each [subscription account](subscription-accounts.md) is a button of its own (hover it for `Anthropic · Perso`), so two plans of the same provider never read the same. An account to sign in again or out of quota carries an amber dot: you can browse its models, not pick them, and the reason is shown above its list.
- **List**: the provider's models, the most capable first, with their context window (`1 M`, `200 k`) when it is known and a **New** badge for a week after a model is added. The model in use is ticked. The header warns when the provider runs remotely or cannot receive files, or settles its own tool approvals.
- **Search**, at the bottom: type part of a name, a model id or a provider, and the results come from every provider at once, each named with its account. The search field has the focus when the picker opens (on a touch screen it waits for your tap, so the keyboard does not cover the list); the arrow keys walk the list, Enter picks, and Escape clears the search, then closes the picker.
- **Favorites**: click a model's star to keep it in the ★ view. Favorites belong to your account, not to the screen: a star set in the chat shows in the agent editor too. A favorite is tied to one account (Opus on your work plan and Opus on your personal plan are two favorites); while that account is gone it is hidden, and it comes back with the account.
- **Your own model id**: where a screen accepts it, **Type a model id…** under a provider's list sends the id you type to that provider unchanged.
- **Inherit**: forms that can leave the choice to someone else (a Kanban task, a series role, a workflow node) start the list with that entry, which says what would apply.

On a phone or a tablet the picker opens as a sheet at the bottom of the screen, and rises above the keyboard while you type in the search.

A model or account that is no longer offered stays shown, ticked and greyed, instead of silently reading as another one: pick another to change it. A [plugin](../plugins/slots.md) can replace the picker everywhere at once.

## Changing the model of a conversation

Click the model pill under the message box to move a conversation to another backend or model and keep talking. If the whole conversation fits, the new model receives all of it. If it is too long, the model you are leaving summarises it first. If that model cannot do it (out of quota, signed out), the new model writes the summary instead. If neither can, only the end of the conversation is carried over, and the chat says why the summary failed.

A backend or account that is out of quota is refused at once, with the time it reopens, and the conversation does not move. An account that is out of quota does not hold a conversation back: moving it to another account or to the machine's own sign-in takes effect. If the new model cannot start its first turn, the conversation says why and stays on the model it was using: send a message there or try again.

## Compacting a conversation

The ring beside the send button, under the message box, shows how full the model's context window is, its size in the centre; it turns red from 40 %. Click it to open its panel: the window used (`132k / 200k (66 %)`) with a bar, the model, the backend or account, the window's size and the tokens the conversation has used so far. Near the limit (80 %) the panel advises compacting, and a notice offers it once.

**Compact** works in one click, on the same model:

- **Claude** and **Grok** compact the conversation in place: it goes on in the same chat with a shorter context, and the gauge drops at once.
- Other backends summarise the conversation and continue in a **new conversation** on the same model, which opens by itself when it is ready; the old one stays in your conversations. The button then reads **Compact into a new conversation**.

The steps show in the panel (summarising, opening the new conversation, compacting) and the ring turns while it runs, even with the panel closed; a reload picks the progress back up. An in-place compaction waits for the agent to finish its reply. If the compaction fails, the panel and a notice say why.

**Compact onto another model…** opens the model picker: choose the model the conversation continues on, add an optional first message, and **Compact** starts at once. **Switch** in the same window moves the conversation to that model without compacting.

In the conversation, a compaction is one quiet line: the tokens before and after, **Show the summary** for the summary the agent continues from, or **Open the new conversation** after a summary into a new one.

## Permission mode of a conversation

Under the message box, at the left, three pills show the model, its thinking level behind a brain icon, and a shield with the conversation's permission mode. Click the model pill to switch model, the brain pill to pick another thinking level, and the shield to pick another mode:

| Mode | What the agent does |
|---|---|
| **Plan** | Reads and proposes, changes nothing. |
| **Ask** | Asks before every tool that is not pre-approved. |
| **Accept edits** | Edits files freely, asks for the rest. |
| **Auto** | The classifier allows safe actions and asks you only when in doubt. |
| **Bypass** | Runs every tool without asking: no Allow/Deny card, no classifier. |

The new mode applies from your next message, and the conversation goes on where it was. A turn already running finishes in the mode it started with. **Bypass** asks for confirmation, and is offered only to accounts allowed to give agents any permission level (`agents:privileged-config`, held by administrators); an agent can never raise a conversation above its own level. Backends that only know three levels (Codex) offer **Plan**, **Auto** and **Bypass**. Backends whose permissions cannot change during a conversation show no shield, and neither does a conversation that has not started yet: the agent's own mode applies until then. **Composer controls**, in the chat appearance menu shown while you edit the layout, hides the shield.

From a terminal, `timon mission permission-mode get <mission_id>` shows a mission's mode, where it comes from and the modes you may pick, and `timon mission permission-mode set <mission_id> <mode>` changes it, with the same rules as the shield. Agents use the `mission_permission_mode_get` and `mission_permission_mode_set` tools.

## When the provider cannot be reached

Codex and Claude retry a request on their own when the connection drops or the provider's servers are busy. While they do, the chat keeps the turn open and shows a single line under the reply in progress, for example "Can't reach codex servers — retrying (2/5)…", with the provider's own reason underneath; once it reconnects the line just says "Reconnected after 2 retries".

If the provider gives up, the chat says its servers were unreachable and offers **Retry**, which sends your last message again in the same conversation. Nothing is re-sent behind your back in a chat.

A mission nobody watches (a Kanban task, a routine, a wake, a sub-mission) is retried by Timon instead, up to 3 times, 30 s, 1 min and 2 min apart, in the same session: the agent is asked to pick up where it stopped without redoing what it already did. The thread shows "Timon retry 1/3 in 30s…". An agent waiting on that mission's answer keeps waiting; if the last retry fails too, it is told the provider was unreachable and to try again later. A usage limit, a sign-in problem or a refused request is never retried this way. **Settings → AI models → Circuit breaker** holds the number of retries (0 turns them off).

## When a subscription quota is exhausted

Timon records backend cooldowns and consults the fallback plan before dispatching more work. A recorded cooldown is never taken at its word: before each new mission or message, Timon checks the backend again, against the account's real usage when it can read it (the same figures as the LLM Quota widget), otherwise with a single attempt every two minutes. A backend whose quota has reopened is used again at once. Timon never falls back onto a backend whose CLI is not installed on the machine. Task-specific choices take precedence; a series can define different fallbacks for its coordinator and task types. An explicit refusal to fall back remains a refusal.

A chat conversation whose backend rejects a turn for quota switches itself onto its fallback and continues the same conversation, with its history; your next message goes there too. If no fallback is available, the chat stays paused until the quota reopens.

An orchestrator found stopped when Timon restarts is moved to its fallback without being restarted. Its chat shows an **Automatic fallback** card, and your next message there gives the new backend the recorded conversation. A message from another agent or a finished task that wakes it first does not carry that conversation.

Eligible pending work can move to another available backend. Running tasks are not all killed just because a different task hit its quota. A Kanban task stopped by its backend's quota, credit or availability restarts on its own, in a series or not, as soon as that backend is available again or a fallback can take it; a task whose fallback is refused waits for the backend to reopen. When the provider announced a reopening time, the task waits for it plus two minutes, without any coordinator agent having to wake up, and retries before that time are not counted against its automatic retries. Tasks blocked for a business reason are not automatically cleared as quota failures.

When the provider answers that a **model is at capacity** (codex: "Selected model is at capacity", Anthropic: "Overloaded"), the task is not treated as a crash. It moves at once to its fallback backend, following the same order as above, and runs again there. The rest of the series and the backend's other models are not affected. If no fallback is available, the task is retried later on the same model, up to three times.

The model catalogue and quota reset times come from the active backend. A missing usage probe is **unknown usage**, not a zero-percent gauge. A provider that does not report a reset time cannot give Timon an exact reopening promise.
