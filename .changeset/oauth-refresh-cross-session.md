---
"@executor-js/sdk": patch
---

Share the OAuth refresh gate across execution stacks so rotating refresh tokens are not reused. The in-flight gate lived inside a single scoped executor, but a self-host builds a fresh scoped executor per MCP session, so two sessions could each redeem the same stored refresh token. Providers that rotate refresh tokens reject the second redemption and may revoke the whole token family, forcing reauthorization. The gate now hangs off the shared root database handle and its key includes the tenant, so concurrent sessions join one grant. The grant runs on its own fiber that callers join, so a cancelled session no longer interrupts peers waiting on the same refresh. Dedup covers one database handle in one process; multi-replica deployments still need database-backed coordination.
