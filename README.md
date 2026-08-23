# Love Sword Arena - Multiplayer Skills Synced

This build keeps the full previous game and adds server-authoritative multiplayer skill synchronization.

- R skill use is sent to the Cloudflare Durable Object.
- Server validates skill/cooldown and applies damage.
- Nova, Rose Barrage, Moon Slash, Heartstorm and Love Dash are synchronized.
- Moon Slash projectile is authoritative and damages on collision.
- Skill effects are broadcast to all players.
- Existing revive, restart, upgrade, sword and bow systems are preserved.
