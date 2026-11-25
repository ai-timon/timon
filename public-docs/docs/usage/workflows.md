---
title: Workflows
sidebar_position: 4.6
---

A workflow is a graph you draw in **Workflows**: triggers start it, agents, conditions and actions run in turn, and every run shows what each node did. You build it on a draft, **Publish** it to freeze a version, and runs always execute a published version (or the draft, when you run the draft explicitly).

After the run ends, Timon can release idle workflow agent processes whose turns and pending work are settled. Their conversation history and session memory remain available. An idle agent that is still part of an unfinished run keeps its process through this idle cleanup.

## Nodes

The **Add** palette lists every node type the daemon knows, grouped by family: triggers, agents, logic, actions, human, memory and output. A node has one input and one or more output ports; an edge leaves a port and enters the next node.

A node with several output ports takes only one of them per run: the `true` or `false` of a condition, the matched case of a switch, the answer to a human question, the route an agent picks, or the `done` or `failed` of an agent, a script or an HTTP request. The nodes on the branches that were not taken are marked **skipped**, and the run completes once nothing is left to run.

### Several triggers

A workflow can have several triggers, and each run starts from one of them: the schedule, webhook or event that fired, or the **Manual** trigger when you press **Run** or test the draft. The other triggers are marked **skipped**, along with the nodes only they lead to. A pause placed after a schedule therefore always runs before the rest of a scheduled run, even when a **Manual** trigger joins the same branch, and a node fed by two triggers runs from whichever one started the run.

### Done and failed ports

Agents, skills, scripts and HTTP requests have a `done` and a `failed` port. When the node succeeds it leaves by `done`. When it fails:

- if an edge leaves its `failed` port, the run follows that edge and carries on: the node shows its error, and the run can still complete;
- otherwise the run fails, unless the workflow's **On error** setting is **continue**.

## HTTP request

The **HTTP request** node calls a web service once and puts the response in its output:

| Field | |
|---|---|
| **URL** | `https://…`, with templates such as `{{input.id}}` or `{{nodes.<id>.output.text}}`. |
| **Method** | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE` or `HEAD`. `GET` and `HEAD` send no body. |
| **Headers** | A JSON object of header names and values. Values accept templates. |
| **Body** | Text sent as is, with templates. Sent as `application/json` unless you set a `Content-Type` header. |
| **Timeout** | 30 seconds by default, 5 minutes at most. |
| **Private network** | Off by default. See below. |

The output is `{ status, headers, body }`: `body` is parsed when the service answers JSON, and is the text otherwise. Read it further down with `{{nodes.<id>.output.body}}`. A status outside 200–299, a timeout, or a response over 1 MB fails the node (and takes its `failed` port if one is wired).

**Secrets.** To send an API key, store it in the vault (**Settings → Secrets**) and write `{{secrets.NAME}}` in a header value, for example `Authorization: Bearer {{secrets.API_TOKEN}}`. The secret must be granted to everyone, to the workflow's project, or to the node's own agent name `wf.<workflow>.<node>`, as for a script node. A secret can only be used in a header: it is refused in the URL and in the body, which end up in logs. A secret the node cannot read fails the node.

**Who can use it.** The request is made on behalf of the workflow's owner, checked when you publish and again at every run:

- the owner's account needs the **Outbound HTTP calls** permission;
- the request goes to public HTTPS addresses only. Cloud metadata and link-local addresses are never reachable, and every redirect is checked again;
- **Private network** lets the request reach this machine, your local network or Tailscale (plain `http://` is accepted towards this machine and Tailscale). Only a workflow owned by an administrator can turn it on.

## Loops

A workflow cannot draw a cycle, except through a **loop edge**: select an edge that goes back to an earlier node, turn on **Loop edge** and set **Max iterations** (3 by default, 100 at most). A typical revision loop: an agent writes a draft, a condition checks it, and the condition's `false` port loops back to the agent.

Each time the loop edge is taken, its target and every node after it run again, once the current pass has nothing else left to run. On the run page, a node that ran several times shows its pass number (`#2`, `#3`).

- After **Max iterations** passes, the edge is no longer followed: the run carries on without it, and the branch that was never taken is skipped.
- `{{loops.<edge id>.count}}` is the number of passes so far (`0` the first time). `loops.<edge id>.exhausted` becomes true once the limit is reached: an edge leaving the same port with the condition `loops.<edge id>.exhausted == true` runs only when the loop gives up.
- In a new pass, `{{nodes.<id>.output}}` still holds what that node produced in the previous pass, until it runs again. The agent at the start of the loop can read the feedback that sent it back.
- A condition on the loop edge itself decides whether it is followed.
- **Retries** on a node count again from zero in each pass.

Publishing refuses a loop edge without **Max iterations**, above 100, or one that does not lead back to a node before its source.

## Layout

**Tidy** in the builder's top bar lays the graph out in columns, left to right, in the order the nodes run. Within a column, each node is placed level with the nodes that feed it, so edges cross as little as possible.

A workflow created from the command line, the API or an agent's proposal can leave out the node positions. The canvas then lays those nodes out itself instead of stacking them on top of each other; the nodes you placed stay where they are. The positions are saved the first time you move a node.
