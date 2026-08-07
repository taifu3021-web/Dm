---
name: Discord bot roles
description: Role assignment for multiple Discord bot tokens.
---

The first non-empty token in `WORKER_BOT_TOKENS` is the main bot. It owns slash-command registration and interaction handling; later tokens are helper bots that clear their registered slash commands, then participate in the DM sending pool without handling commands.

**Why:** Multiple bots sharing the same slash commands creates duplicate command registrations and makes command ownership unclear, while helper bots can increase DM throughput when each has its own rate-limited queue.

**How to apply:** Preserve the token order when changing worker configuration, keep command registration/interaction handling gated to the first token, and keep helper bots in the dispatcher pool.

Each online bot sends the requested `repeat` count independently, with `repeat` capped at 100 per bot and a separate 0.8-second queue per bot.

**Why:** The repeat limit is intended to protect each bot's Discord rate limit while allowing helper bots to increase throughput.

**How to apply:** Treat `repeat: 100` as up to 100 sends per online bot, not 100 sends total across the bot pool.