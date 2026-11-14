---
title: Rewinding a conversation
sidebar_position: 3.4
---

Rewinding takes a conversation back to one of your own messages, as if you had never sent it: that message and everything after it disappear from the chat, the agent forgets them, and the message comes back in the message box so you can change it and send it again.

## Rewind to a message

Hover one of your messages and click **Rewind to here**. The button exists only under messages you typed, not under an agent's answer, a tool result or a card. There is no confirmation: the conversation is cut at once, and **Back here · Undo the rewind** appears where it now ends.

- The message and everything after it leave the conversation, in the chat and in what the agent remembers.
- Its text and images are put back in the message box. Edit them, or clear them, and send.
- The conversation stays the same mission: same name, same place in the missions list.
- You can rewind again, further back.
- **Undo the rewind** brings everything back as it was, the agent's memory included, as long as you have not sent anything since. Several rewinds in a row are undone together. Once you send a message, the conversation goes on from the rewind and the rewound part does not come back.

## What a rewind does not undo

A rewind changes the **conversation only**.

- **Files are not restored.** What the agent wrote, edited or deleted on disk stays as it is. Use [git](./git.md) or the task's worktree to go back on files.
- **Actions already done are not undone.** Kanban tasks it created, missions it started, messages it sent, commands it ran: they all stay.
- **Money spent stays spent.** The mission's cost and statistics still count the rewound turns. The context gauge starts again at the next answer.

Rewound turns no longer appear in the mission's history, its trace, its export or in mission search.

## When you can rewind

- **Not while the agent works.** The button is greyed out, and pointing at it says the agent is working. Wait for the end of the turn, or [stop it](./missions.md#stopping-an-agent-or-a-whole-project), then rewind.
- **Only in your own conversations.** Missions started by a Kanban task, a routine, a trigger or another agent cannot be rewound.

## How the agent forgets

Nothing runs when you rewind: the cut happens when you send your next message, which can take a moment longer than usual.

- **Claude and Codex** cut their own session at that message: the agent picks up exactly where the conversation now ends.
- **Other agents** (opencode, Pi, Hermes, GitHub Copilot and the rest) start a fresh session that continues from a summary of the conversation up to that message. The same happens with Claude or Codex if their own cut fails. The agent then keeps the gist of the earlier conversation rather than every detail.
