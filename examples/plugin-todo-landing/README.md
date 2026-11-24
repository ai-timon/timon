# plugin-todo-landing

Replaces the badge that says where the branch of a TO DO idea stands (slot
`kanban.todo.landing`) — on the lines of the TO DO widgets, in the Kanban's
TO DO column and in the idea's detail — with a plain line of text: the pull
request's number and state, a link when it exists. The product's chip comes
back as soon as the plugin is removed.

The component takes no props: it reads `useTodoItem()` from `@timon/ui`
(client API 19), whose `landing` is `null` when no job of the idea has an
integration branch, or `{ state, branch, prNumber, prUrl, jobs }`. `state` is
`branch` (no pull request expected), `pending` (not created yet), `open`,
`merged` or `closed`; the job shown first is the one furthest from landing,
and `jobs` lists them all. The field is read-only: Timon derives it from the
branch of the idea's tasks. What a replacement must respect is in
[Slots](../../public-docs/docs/plugins/slots.md), under `kanban.todo.landing`.

The package deliberately ships no `SIGNATURE` file.
