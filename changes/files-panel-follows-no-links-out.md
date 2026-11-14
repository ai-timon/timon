---
type: fixed
---
The Files panel no longer writes, creates folders or deletes outside an agent's folder through a symbolic link, and no longer touches the `.git` folder under another name; deleting a link now removes the link, not the folder it points to.
