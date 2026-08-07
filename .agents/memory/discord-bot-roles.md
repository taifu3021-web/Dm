---
name: Discord bot roles
description: Role assignment for multiple Discord bot tokens.
---

The first non-empty token in `WORKER_BOT_TOKENS` is the main bot. It owns slash-command registration and interaction handling; later tokens are worker bots that remain online without registering or handling commands.

**Why:** Multiple bots sharing the same slash commands creates duplicate command registrations and makes command ownership unclear.

**How to apply:** Preserve the token order when changing worker configuration, and keep command registration/interaction handling gated to the first token.