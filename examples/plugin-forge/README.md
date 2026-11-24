# GitHub issues of a project (template)

A starting point for a plugin that works with the GitHub repository of a Timon
project through `ctx.forge` (API 19). Read `lib/index.js` (about 70 lines),
copy the folder, change the manifest `id`, then adapt the three routes. The
reference guide is [The GitHub repository of a project](../../public-docs/docs/plugins/forge.md).

The plugin holds neither `gh` nor a token: Timon reads the repository with the
account set on the project (**Settings › Projects**, integration in pull
request mode) and never shows it to the plugin.

- `GET /api/plugins/forge-example/candidates?project=<slug>` lists the open
  issues carrying the label of the plugin's settings (`accepted` by default).
  Each one comes with `brief`, the issue marked as outside text, ready for an
  agent's brief.
- `POST /api/plugins/forge-example/thanks` with `{ "project": "<slug>", "issue": 7 }`
  proposes a thank-you comment, once per issue. It appears in the notification
  centre; you read it, edit it if you like, and publish or discard it in the
  **Publish on GitHub** window. Nothing is posted before that click.
- `GET /api/plugins/forge-example/proposals?project=<slug>` says where the
  plugin's proposals stand.

The comment is a template: it never quotes the issue, whose text was written
by someone else. Keep it that way when you adapt it.

Both permissions are sensitive and named apart on the install sheet. Calling
the routes needs an account allowed to manage projects; proposing needs a
person signed in, not a token.
