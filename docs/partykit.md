# PartyKit history

Mind Meld started on PartyKit and has since moved to PartyServer. This page is for reading older code, commits and examples.

**The `partykit` CLI and `partykit.json` no longer apply.** Don't reintroduce them. `partysocket`, the client library, is still in use and isn't deprecated, and `routePartykitRequest` is simply the name of a PartyServer function.

## Why we moved

PartyKit's hosted platform shut down on 23 Oct 2026, and `npx partykit deploy` stopped working that day, even for Workers in your own Cloudflare account. See the [migration guide](https://docs.partykit.io/guides/migrate-to-partyserver/).

Room data wasn't copied. Rooms only exist while people play, and are wiped 60s after the last player leaves.

## Old to new

| PartyKit | PartyServer in this repo |
|---|---|
| `partykit.json` | `wrangler.jsonc` |
| `partykit dev`, `partykit deploy` | `npm run dev`, `npm run deploy` |
| Dev server on port 1999 | Port 8787 |
| `class X implements Party.Server` | `class X extends Server<Env>` |
| `constructor(readonly room: Party.Room)` | None needed |
| `this.room.id` | `this.name` |
| `this.room.storage` | `this.ctx.storage` |
| `this.room.env` | `this.env` |
| `this.room.broadcast(...)` | `this.broadcast(...)` |
| `this.room.getConnections()` | `this.getConnections()` |
| `onMessage(message, sender)` | `onMessage(connection, message)` |
| Instance `options` | `static options` |
| `serve.build` | `build.command` in `wrangler.jsonc` |
| `export default class` | Named class export, plus a default `{ fetch }` handler |

Code comments or old commits may mention behavior from PartyKit's connection manager. Check [partyserver.md](partyserver.md) for what's true now.

## The old Worker

PartyKit deployed the app as the `rcquan-mindmeld` Worker, with `PARTYKIT_DURABLE` and `PARTYKIT_ASSETS` (R2) bindings. It can't take new deploys through PartyKit.

`rcquan-mindmeld-webapp` is a separate Worker in the same account, with one deployment from earlier on 4 Jul 2026. It looks like an earlier attempt, but that's inferred from its name and date.

TODO after cutover: record the status of `rcquan-mindmeld`.
