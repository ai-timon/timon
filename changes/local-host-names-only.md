---
type: changed
---
When Timon listens only on this computer, the app and the daemon, built-in terminal included, now answer only under an IP address, `localhost`, a `*.localhost` or `*.ts.net` name, or a name from the configuration. If you reach such an installation under another name through your own proxy, declare it in `app.publicUrl` or set `daemon.behindTlsProxy`.
