# plugin-publish-dialog

Replaces the "Publish on GitHub" window (slot `forge.publish.dialog`) — opened
from a job's or a pull request's row, a pull request's menu and the
notification of a proposed comment — with a plain dialog: the text to post,
editable, where it goes and as which account, then **Publish**, **Save for
later** or **Do not publish**. The product's window comes back as soon as the
plugin is removed.

The component takes no props: it reads `usePublishDialog()` from `@timon/ui`
(client API 19) and draws the whole window with `Dialog`. It holds no access
to GitHub or to the daemon: `publish()`, `save()` and `discard()` are the
host's gestures, sent through the signed-in person's session; the daemon
refuses them from anyone else and checks the project's account again before
posting. Each resolves `false` on a refusal, and `error` then says why.
`problem` tells, before anything is sent, why the daemon would refuse the
text. What a replacement must respect is in
[Slots](../../public-docs/docs/plugins/slots.md), under
`forge.publish.dialog`.

The package deliberately ships no `SIGNATURE` file.
