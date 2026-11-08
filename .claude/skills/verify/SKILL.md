---
name: verify
description: Verify a change to the Mind Meld app by running the local dev server and exercising the multiplayer flow across multiple browser tabs. Use after any change to src/server.ts, src/client.ts, or src/shared.ts. The automated smoke test covers only the core game flow.
---

The only automated check is `npm run smoke`, which CI also runs. It plays a headless 2-player game covering create, join, start, a mismatched round, a matched round, and the `already-started` and `not-found` errors. Everything else means driving the real multiplayer flow by hand.

0. Run `npm run smoke` first. If it fails, fix that before checking anything in a browser. If your change altered messages or the game flow, update `scripts/smoke-test.mjs` to match.
1. Run `npm run dev` (starts `wrangler dev --live-reload`) if it isn't already running.
2. Open at least two browser tabs/windows pointed at the local dev URL (Wrangler prints it on startup, typically `http://localhost:8787`). Tabs on the same origin share a client ID and count as one player, so use `localhost` in one and `127.0.0.1` in the other.
3. In tab 1, create a room and note the 6-digit code. In tab 2 (and more, up to `MAX_PLAYERS`), join that room with the code.
4. Exercise the specific flow your change touches:
   - **Join/lobby**: player list updates live in all tabs; joining a full or already-started room shows the right error (`room-full` / `already-started`).
   - **Round flow**: `start-game` requires `MIN_PLAYERS`; submitting a word in one tab updates `submission-progress` in the others; once everyone submits, the round reveals (`round-revealed`) in all tabs simultaneously.
   - **Match/replay**: identical words end the game (`matched`); mismatched words let players continue to `next-round`; `play-again` resets to lobby.
   - **Disconnect handling**: closing a tab removes that player everywhere; dropping below `MIN_PLAYERS` resets the room to lobby; closing the last tab clears room state.
5. Watch the `wrangler dev` terminal output for server-side errors/exceptions during the above.
6. If the change touches `src/shared.ts` message types, confirm both `src/server.ts` and `src/client.ts` were updated to match — there's no shared build-time check for this, only manual review.

Report what you tested and any flow you were not able to exercise (e.g. multi-round matching requires deliberately mismatched then matched words).
