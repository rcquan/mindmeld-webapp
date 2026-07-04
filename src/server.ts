import type * as Party from "partykit/server";
import {
  type ClientMessage,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type Player,
  type RoomStatus,
  type RoundResult,
  type ServerMessage,
} from "./shared";

// How long a fully-empty room is kept alive in storage before teardown, to
// survive a transient disconnect (e.g. a backgrounded mobile tab) without
// requiring anyone to still be connected.
const GRACE_PERIOD_MS = 60_000;

interface PersistedState {
  createdAt?: number;
  status: RoomStatus;
  players: Player[];
  currentRound: number;
  submissions: [string, string][];
  roundHistory: RoundResult[];
}

export default class MindMeld implements Party.Server {
  readonly options: Party.ServerOptions = { hibernate: true };

  createdAt?: number;
  status: RoomStatus = "lobby";
  players = new Map<string, Player>();
  currentRound = 0;
  submissions = new Map<string, string>();
  roundHistory: RoundResult[] = [];
  // Not persisted — PartyKit's own connection manager re-keys its internal
  // map by connection.id on every accept(), so by the time onConnect runs
  // for a duplicate identity, the old Connection object is already gone
  // from room.getConnections(). We keep our own reference so we can still
  // close it. Lost across a hibernation wake, which just means duplicate-tab
  // eviction only applies within a single warm instance — acceptable, since
  // it only affects the rare same-browser-two-tabs case.
  liveConnections = new Map<string, Party.Connection>();

  constructor(readonly room: Party.Room) {}

  async onStart() {
    const saved = await this.room.storage.get<PersistedState>("state");
    if (!saved) return;
    this.createdAt = saved.createdAt;
    this.status = saved.status;
    this.players = new Map(saved.players.map((p) => [p.id, p]));
    this.currentRound = saved.currentRound;
    this.submissions = new Map(saved.submissions);
    this.roundHistory = saved.roundHistory;
  }

  async persist() {
    const state: PersistedState = {
      createdAt: this.createdAt,
      status: this.status,
      players: [...this.players.values()],
      currentRound: this.currentRound,
      submissions: [...this.submissions.entries()],
      roundHistory: this.roundHistory,
    };
    await this.room.storage.put("state", state);
  }

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === "POST") {
      if (this.createdAt === undefined) {
        // Synchronous check-then-set: a Durable Object only interleaves
        // separate requests at `await` points, so mutating `createdAt`
        // before the first `await` here guarantees a racing second POST
        // for the same room code sees it already set and loses cleanly.
        this.createdAt = Date.now();
        this.status = "lobby";
        await this.persist();
        return Response.json({
          exists: true,
          created: true,
          status: this.status,
          playerCount: 0,
          full: false,
        });
      }
      return Response.json({
        exists: true,
        created: false,
        status: this.status,
        playerCount: this.players.size,
        full: this.players.size >= MAX_PLAYERS,
      });
    }

    return Response.json({
      exists: this.createdAt !== undefined,
      created: false,
      status: this.status,
      playerCount: this.players.size,
      full: this.players.size >= MAX_PLAYERS,
    });
  }

  send(connection: Party.Connection, message: ServerMessage) {
    connection.send(JSON.stringify(message));
  }

  broadcast(message: ServerMessage, without?: string[]) {
    this.room.broadcast(JSON.stringify(message), without);
  }

  playersList(): Player[] {
    return [...this.players.values()];
  }

  connectedCount(): number {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  usedWords(): Set<string> {
    const used = new Set<string>();
    for (const round of this.roundHistory) {
      for (const { word } of round.words) used.add(word.toLowerCase());
    }
    return used;
  }

  lastRevealResults() {
    const last = this.roundHistory[this.roundHistory.length - 1];
    return last?.words;
  }

  joinedMessage(player: Player): Extract<ServerMessage, { type: "joined" }> {
    return {
      type: "joined",
      you: player,
      roomCode: this.room.id,
      status: this.status,
      players: this.playersList(),
      round: this.currentRound,
      path: this.roundHistory,
      submissionProgress:
        this.status === "round-active"
          ? {
              submittedCount: this.submissions.size,
              totalCount: this.connectedCount(),
            }
          : undefined,
      revealResults:
        this.status === "revealed" || this.status === "matched"
          ? this.lastRevealResults()
          : undefined,
      youSubmitted: this.submissions.has(player.id),
    };
  }

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
    if (this.createdAt === undefined) {
      this.send(connection, {
        type: "error",
        code: "not-found",
        message: "This room no longer exists.",
      });
      connection.close();
      return;
    }

    const existing = this.players.get(connection.id);
    if (existing) {
      // Same stable client identity reconnecting (PartySocket sends the same
      // `id` on every retry, which the platform uses verbatim as
      // connection.id) — let them back in regardless of room-full/started
      // gates below, since those only apply to genuinely new joiners.
      const previous = this.liveConnections.get(connection.id);
      if (previous && previous !== connection) {
        previous.close(4000, "replaced-by-new-connection");
      }
      this.liveConnections.set(connection.id, connection);
      existing.connected = true;
      existing.disconnectedAt = undefined;
      await this.persist();
      this.send(connection, this.joinedMessage(existing));
      this.broadcast({ type: "players-update", players: this.playersList() }, [
        connection.id,
      ]);
      return;
    }

    if (this.players.size >= MAX_PLAYERS) {
      this.send(connection, {
        type: "error",
        code: "room-full",
        message: "This room is full.",
      });
      connection.close();
      return;
    }
    if (this.status !== "lobby") {
      this.send(connection, {
        type: "error",
        code: "already-started",
        message: "This game has already started.",
      });
      connection.close();
      return;
    }

    const requestedLabel = new URL(ctx.request.url).searchParams
      .get("label")
      ?.trim()
      .slice(0, 24);
    const player: Player = {
      id: connection.id,
      label: requestedLabel || `Player ${this.players.size + 1}`,
      joinedAt: Date.now(),
      connected: true,
    };
    this.players.set(connection.id, player);
    this.liveConnections.set(connection.id, connection);
    await this.persist();

    this.send(connection, this.joinedMessage(player));
    this.broadcast({ type: "players-update", players: this.playersList() }, [
      connection.id,
    ]);
  }

  async onClose(connection: Party.Connection) {
    const player = this.players.get(connection.id);
    if (!player) return;
    // If our own bookkeeping shows a *different* connection object as the
    // current one for this id, this close is a belated event from a tab we
    // already evicted as a duplicate — ignore it, don't clobber the newer
    // connection's state. If there's no entry at all (e.g. this instance
    // just woke from hibernation, which doesn't repopulate liveConnections),
    // we can't tell the difference, so fall through and treat it as a real
    // disconnect — the safe default.
    if (
      this.liveConnections.has(connection.id) &&
      this.liveConnections.get(connection.id) !== connection
    ) {
      return;
    }
    this.liveConnections.delete(connection.id);
    // Don't delete the player or clear their submission — a disconnect may
    // just be a backgrounded tab. Mark them offline and let onAlarm (after
    // the grace period) or a reconnect in onConnect resolve what happens.
    player.connected = false;
    player.disconnectedAt = Date.now();
    await this.persist();
    this.broadcast({ type: "players-update", players: this.playersList() });

    const liveCount = this.connectedCount();

    if (liveCount === 0) {
      await this.room.storage.setAlarm(Date.now() + GRACE_PERIOD_MS);
      return;
    }

    if (liveCount < MIN_PLAYERS) {
      this.status = "lobby";
      this.currentRound = 0;
      this.submissions.clear();
      this.roundHistory = [];
      await this.persist();
      this.broadcast({ type: "lobby-reset", players: this.playersList() });
      return;
    }

    if (this.status === "round-active" && this.submissions.size === liveCount) {
      await this.revealRound();
    }
  }

  async onAlarm() {
    const liveIds = new Set([...this.room.getConnections()].map((c) => c.id));

    if (liveIds.size === 0) {
      // Nobody reconnected within the grace period — the room really was
      // abandoned. Tear it down so the room code becomes reusable.
      this.createdAt = undefined;
      this.status = "lobby";
      this.players.clear();
      this.submissions.clear();
      this.roundHistory = [];
      this.currentRound = 0;
      await this.persist();
      return;
    }

    // Someone is connected after all (reconnected, or a new join happened,
    // before this alarm fired) — reconcile against ground truth instead of
    // tearing anything down. No explicit cancellation is needed on
    // reconnect; this alarm firing "late" against a live room is a no-op.
    let changed = false;
    for (const player of this.players.values()) {
      const isLive = liveIds.has(player.id);
      if (player.connected !== isLive) {
        player.connected = isLive;
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
      this.broadcast({ type: "players-update", players: this.playersList() });
    }
  }

  async onMessage(message: string, sender: Party.Connection) {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    switch (parsed.type) {
      case "set-label": {
        const player = this.players.get(sender.id);
        if (!player || this.status !== "lobby") return;
        const label = parsed.label.trim().slice(0, 24);
        if (!label) return;
        player.label = label;
        await this.persist();
        this.broadcast({ type: "players-update", players: this.playersList() });
        break;
      }
      case "start-game": {
        if (this.status !== "lobby" || this.connectedCount() < MIN_PLAYERS)
          return;
        this.status = "round-active";
        this.currentRound = 1;
        this.submissions.clear();
        await this.persist();
        this.broadcast({ type: "round-start", round: this.currentRound });
        break;
      }
      case "submit-word": {
        if (this.status !== "round-active") return;
        if (!this.players.has(sender.id)) return;
        const word = parsed.word.trim();
        if (!word) return;
        if (this.usedWords().has(word.toLowerCase())) {
          this.send(sender, {
            type: "word-rejected",
            message: `"${word}" was already used — try something new.`,
          });
          return;
        }
        this.submissions.set(sender.id, word);
        await this.persist();
        this.broadcast({
          type: "submission-progress",
          submittedCount: this.submissions.size,
          totalCount: this.connectedCount(),
        });
        if (this.submissions.size === this.connectedCount()) {
          await this.revealRound();
        }
        break;
      }
      case "next-round": {
        if (this.status !== "revealed") return;
        const last = this.roundHistory[this.roundHistory.length - 1];
        if (!last || last.matched) return;
        this.currentRound += 1;
        this.submissions.clear();
        this.status = "round-active";
        await this.persist();
        this.broadcast({ type: "round-start", round: this.currentRound });
        break;
      }
      case "play-again": {
        if (this.status !== "matched") return;
        this.status = "lobby";
        this.currentRound = 0;
        this.roundHistory = [];
        this.submissions.clear();
        await this.persist();
        this.broadcast({ type: "lobby-reset", players: this.playersList() });
        break;
      }
    }
  }

  async revealRound() {
    const results = [...this.submissions.entries()].map(([playerId, word]) => {
      const player = this.players.get(playerId);
      return { playerId, label: player?.label ?? "Player", word };
    });
    const words = results.map((r) => r.word.toLowerCase());
    const matched = words.length > 0 && words.every((w) => w === words[0]);

    this.status = matched ? "matched" : "revealed";
    this.roundHistory.push({
      round: this.currentRound,
      words: results,
      matched,
    });
    await this.persist();

    this.broadcast({
      type: "round-revealed",
      round: this.currentRound,
      results,
      matched,
      path: this.roundHistory,
    });
  }
}

MindMeld satisfies Party.Worker;
