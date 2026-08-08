# Security

Plugins in this repository run **in-process inside the user's Executor
daemon** with the daemon's filesystem access. Bugs that would be minor in a
sandboxed context (path traversal, writing outside the target project,
following unexpected symlinks) are security issues here.

Report vulnerabilities privately via
[GitHub security advisories](https://github.com/artists-so/plugins/security/advisories/new)
rather than public issues. You should hear back within a week.

Scope worth reporting: any way a crafted project file or tool argument makes a
plugin read or write outside the project it was pointed at, execute code, or
exfiltrate data.
