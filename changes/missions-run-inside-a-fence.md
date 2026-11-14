---
type: fixed
---
On Linux with Landlock (kernel 5.19 or later) and on macOS, missions now run inside a fence enforced by the operating system: Timon's private files are out of their reach, the rest of your home folder is read-only to them, and Unix sockets (Docker, ssh-agent) are cut. Settings › System › Security shows whether it applies on your computer and lets you require it or grant exceptions to one agent or project; `timon doctor` reports it too.
