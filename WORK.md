# Worktree: version-detection

**Branch:** `feature/watchdog-version-detection`
**Base commit:** `4066a3f08`
**Goal:** Implement the ability for Claw to detect which Watchdog build version (git commit hash) it is currently running on.

## Plan

1. Have Watchdog write the active commit hash to a known file (`.watchdog/active-version`) when activating a build
2. On gateway startup, read that file and expose the version in the health state / runtime info
3. Optionally pass it through to the system prompt so Claw knows its own version

## Status

- [x] Worktree created
- [ ] Watchdog writes active version file on build activation
- [ ] Gateway reads version file on startup
- [ ] Version exposed in health state
- [ ] Version available in system prompt / runtime info
- [ ] Tests pass
- [ ] Merged to main
