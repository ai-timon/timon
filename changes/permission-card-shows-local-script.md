---
type: added
---
A permission card for a shell command that runs a project file (`./run_tests.sh`, `python build.py`, `npm test`, `make check`) now shows that file's first lines, size and fingerprint. It also reads a command wrapped in `sh -c` or `eval`, and refuses the approval if the file changed, appeared or is too large to fingerprint; a remembered approval of such a command holds only while every file it runs is unchanged.
