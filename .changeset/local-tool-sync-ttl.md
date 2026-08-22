---
"executor": patch
---

Allow the local daemon to disable periodic remote tool-catalog refreshes with `EXECUTOR_TOOLS_SYNC_TTL_MS=off`. Explicit refreshes, stale notifications, and integration configuration changes continue to rebuild catalogs.
