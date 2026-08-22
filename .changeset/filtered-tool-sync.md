---
"executor": patch
---

Limit stale tool-catalog refreshes to explicit list filters and the connections visible through an active toolkit policy. Opening one toolkit MCP endpoint no longer starts every stale stdio integration, preventing unrelated OAuth browser launches and 1Password prompts during agent startup.
