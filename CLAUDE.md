# Mind Meld

Multiplayer word game: 2–6 players each submit a word every round until everyone picks the same one. It runs on a Cloudflare Worker, with one [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver) Durable Object per room.

## Commands

```bash
npm run dev           # local server at http://localhost:8787, with live reload
npm run typecheck     # checks the client and worker TypeScript projects
npm run lint          # Biome; npm run format applies its fixes
npm run build:client  # bundles src/client.ts into public/dist (dev and deploy run this for you)
npm run deploy        # production: confirm with the user first
```

## Architecture

- `src/server.ts`: the `MindMeld` Durable Object (rooms, game rules, disconnect handling) and the Worker entry point.
- `src/client.ts`: browser UI, connected to the room with `partysocket`.
- `src/shared.ts`: types and constants used by both. Nothing checks at build time that server and client handle the same messages, so update both by hand.
- `public/`: static assets. `public/dist/` is generated and gitignored.

## Testing

There's no automated test suite. After changing anything in `src/`, run the `/verify` skill. Two tabs on the same origin share a client ID and count as one player, so use `localhost` in one and `127.0.0.1` in the other.

## When to read the docs

| Read | When you're |
|---|---|
| [docs/partyserver.md](docs/partyserver.md) | Changing `src/server.ts`, or room, connection, hibernation or alarm behavior |
| [docs/cloudflare.md](docs/cloudflare.md) | Changing `wrangler.jsonc`, deploying, or debugging production |
| [docs/partykit.md](docs/partykit.md) | Reading older code, commits or examples that mention PartyKit |
