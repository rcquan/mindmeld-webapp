# Mind Meld

Multiplayer word game: 2–6 players each submit a word every round until everyone picks the same one. It runs on a Cloudflare Worker, with one [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) Durable Object per room.

## Commands

```bash
npm run dev           # local server at http://localhost:8787, with live reload
npm run typecheck     # checks the client and worker TypeScript projects
npm run lint          # Biome; npm run format applies its fixes
npm run build:client  # bundles src/client.ts into public/dist (dev and deploy run this for you)
npm run smoke         # starts wrangler dev on :8799 and plays a 2-player game over WebSockets
npm run deploy        # production: confirm with the user first
node scripts/simulate-bots.ts --personas bridge,categorizer,wildcard --games 3
                      # offline bot-vs-bot games for tuning personas; real API calls, so costs money
```

Merging to `main` deploys to production through GitHub Actions (`.github/workflows/deploy.yml`), so treat a merge like `npm run deploy`. Durable Object migrations in `wrangler.jsonc` ship on merge too, so review those carefully, especially `deleted_classes`.

## Architecture

- `src/server.ts`: the `MindMeld` Durable Object (rooms, game rules, disconnect handling) and the Worker entry point.
- `src/client.ts`: browser UI, connected to the room with `partysocket`.
- `src/bots.ts`: bot players (see [docs/bots.md](docs/bots.md)). Imported by the server and by `scripts/simulate-bots.ts`, so it must not import Worker or Durable Object code, and its imports keep the `.ts` extension so Node can run it.
- `src/shared.ts`: types and constants used by both. Nothing checks at build time that server and client handle the same messages, so update both by hand.
- `scripts/smoke-test.mjs`: plain JS that speaks the same message protocol without importing `shared.ts`. When you rename or change a message, or change the join and round flow, update it too, or CI fails.
- Bots have no socket: they count in `connectedCount()` (rounds, `MIN_PLAYERS`), but not in `humanConnectedCount()` (empty-room teardown), the `onAlarm` reconcile, or play-again readiness. Bot turns run in `runBots` via `ctx.waitUntil`; `onStart` restarts any that were lost.
- `public/`: static assets. `public/dist/` is generated and gitignored.

## Testing

CI (`.github/workflows/ci.yml`) runs on every PR and before every deploy. It runs lint, typecheck, a `wrangler deploy --dry-run` that also builds the client, and `npm run smoke`. The smoke test covers creating a room, joining, starting, a mismatched round, a matched round, bots (add and remove, the 3-bot cap, host-only management, bot ids refused, and one bot round), and the `already-started` and `not-found` errors. It doesn't cover UI rendering, `play-again` and the results countdown, `room-full`, or disconnects. So after changing anything in `src/`, still run the `/verify` skill. Two tabs on the same origin share a client ID and count as one player, so use `localhost` in one and `127.0.0.1` in the other.

## When to read the docs

| Read | When you're |
|---|---|
| [docs/partyserver.md](docs/partyserver.md) | Changing `src/server.ts`, or room, connection, hibernation or alarm behavior |
| [docs/cloudflare.md](docs/cloudflare.md) | Changing `wrangler.jsonc` or `.github/workflows/`, deploying, debugging CI, or debugging production |
| [docs/partykit.md](docs/partykit.md) | Reading older code, commits or examples that mention PartyKit |
| [docs/bots.md](docs/bots.md) | Changing `src/bots.ts`, bot personas or prompts, `runBots`, or running or reading bot simulations |
