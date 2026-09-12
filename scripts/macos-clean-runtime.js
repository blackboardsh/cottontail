// Apply only to a runtime child process; the Node test harness and build tools
// may themselves be installed with Homebrew. Cover libraries, certificates and
// executables rather than selecting one dependency that happened to regress.
export const macosWithoutHomebrewProfile = '(version 1)(allow default)(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local"))';
