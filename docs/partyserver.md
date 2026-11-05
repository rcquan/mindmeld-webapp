# PartyServer in Mind Meld

How `src/server.ts` uses PartyServer. For the general API, see the [PartyServer README](https://github.com/cloudflare/partykit/tree/main/packages/partyserver).

## Model

Each room is one instance of the `MindMeld` class, a Durable Object that extends PartyServer's `Server`. The room code is the object's name (`this.name`), so the same code always reaches the same instance.

`routePartykitRequest` in the Worker's `fetch` handler sends `/parties/main/:room` to it. `main` comes from the `Main` binding in `wrangler.jsonc`, kebab-cased, and is also `partysocket`'s default party. Renaming the binding breaks this route.

## Lifecycle hooks

| Hook | What Mind Meld does there |
|---|---|
| `onStart` | Loads the `state` key from storage. Runs before any other hook on every cold start, including after hibernation and before an alarm. |
| `onRequest` | `POST` creates the room, and a second `POST` reports it already exists. `GET` returns room info without creating anything. |
| `onConnect` | Runs **before** the client gets its 101 response. Rejects with `not-found`, `room-full` or `already-started`, or adds or restores the player. |
| `onMessage` | Handles `ClientMessage`s and ignores non-string frames. |
| `onClose` | Marks the player offline, then starts the grace period, resets to the lobby, or reveals the round. |
| `onAlarm` | Tears the room down if nobody came back, otherwise reconciles `connected` flags. |

## State and hibernation

`static options = { hibernate: true }` lets the object leave memory while its WebSockets stay open. Instance fields don't survive that. Anything that must survive goes through `persist()`, which writes everything to one `state` key. `onStart` reads it back.

Call `persist()` after every change to game state. `liveConnections` is deliberately not persisted (see below).

## Connection identity

The client generates a UUID, stores it in `localStorage`, and sends it as `id`. `partysocket` passes that as the `_pk` query param, and PartyServer uses it as `connection.id`. That's why a reconnecting player keeps their seat, and `Player.id` equals `connection.id`.

Two tabs in one browser therefore share an ID. When a second socket arrives, `onConnect` closes the first with code 4000, and `onClose` uses `liveConnections` to ignore that socket's late close event. Both sockets appear in `getConnections()` until one closes. `liveConnections` is empty after a wake, so eviction only applies while the instance stays warm. `getConnection(id)` throws if two sockets share an ID, so use `getConnections(id)` instead: each connection is tagged with its own ID.

## Grace period and teardown

When the last player disconnects, `onClose` sets an alarm for `GRACE_PERIOD_MS` (60s). A disconnect might only be a backgrounded mobile tab, so players are marked offline rather than removed. If nobody is connected when the alarm fires, the room is reset and `createdAt` is cleared, which frees the code for reuse. Reconnecting doesn't cancel the alarm: it fires anyway, finds live connections, and reconciles.

## Pitfalls

- **`options` must be `static`.** An instance property is ignored and the room silently stops hibernating.
- **Don't override `Server` methods.** That includes `broadcast`, `getConnection`, `getConnections`, `getConnectionTags`, `fetch`, `alarm` and `webSocket*`. PartyServer doesn't check for this. The app's JSON helper is `broadcastMessage` for this reason.
- **`onMessage` takes `(connection, message)`.** This is the reverse of PartyKit, and `message` can be binary.
- **Don't use the storage key `__ps_name`.** PartyServer reserves it.
- **A Durable Object only interleaves at `await`s.** `onRequest` relies on this: it sets `createdAt` before its first `await`, so a racing `POST` for the same code loses cleanly. Keep check-then-set logic free of `await`s.

## Close timing

After a server-initiated close, the client receives the close frame and code at once, but the browser's `close` event can lag. It took about 2s in Chromium under `wrangler dev`, and about 10s in Node's WebSocket client both under `wrangler dev` and in production. When testing, check `readyState` rather than waiting for the event.
