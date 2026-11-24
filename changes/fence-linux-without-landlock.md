---
type: added
---
On Linux without Landlock, missions are now fenced with Linux namespaces: Timon's private files are hidden from them and **Settings › System › Security** names this fence. A kernel that offers neither Landlock nor unprivileged user namespaces now refuses missions instead of running them unfenced.
