import {
  type Connection,
  type ConnectionContext,
  routePartykitRequest,
  Server,
  type WSMessage,
} from "partyserver";
import {
  type ClientMessage,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type Player,
  RESULTS_COUNTDOWN_MS,
  type ResultsClosing,
  type RoomInfo,
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
  resetAt?: number;
  readyIds?: string[];
}

type Env = { Main: DurableObjectNamespace<MindMeld> };

export class MindMeld extends Server<Env> {
  // Must be static: PartyServer ignores an instance-level `options`.
  static options = { hibernate: true };

  createdAt?: number;
  status: RoomStatus = "lobby";
  players = new Map<string, Player>();
  currentRound = 0;
  submissions = new Map<string, string>();
  roundHistory: RoundResult[] = [];
  // Results countdown: set by the first "play-again" on the matched screen.
  resetAt?: number;
  readyIds: string[] = [];
  // Not persisted — tracks which socket is current for each connection id, so
  // a second socket with the same id (same browser, two tabs) can evict the
  // first, and the evicted socket's belated close can be ignored. Both sockets
  // stay in getConnections() until one closes. Lost across a hibernation wake,
  // which just means duplicate-tab eviction only applies within a single warm
  // instance — acceptable, since it only affects the rare same-browser-two-tabs
  // case.
  liveConnections = new Map<string, Connection>();

  async onStart() {
    const saved = await this.ctx.storage.get<PersistedState>("state");
    if (!saved) return;
    this.createdAt = saved.createdAt;
    this.status = saved.status;
    this.players = new Map(saved.players.map((p) => [p.id, p]));
    this.currentRound = saved.currentRound;
    this.submissions = new Map(saved.submissions);
    this.roundHistory = saved.roundHistory;
    this.resetAt = saved.resetAt;
    this.readyIds = saved.readyIds ?? [];
  }

  async persist() {
    const state: PersistedState = {
      createdAt: this.createdAt,
      status: this.status,
      players: [...this.players.values()],
      currentRound: this.currentRound,
      submissions: [...this.submissions.entries()],
      roundHistory: this.roundHistory,
      resetAt: this.resetAt,
      readyIds: this.readyIds,
    };
    await this.ctx.storage.put("state", state);
  }

  async onRequest(req: Request): Promise<Response> {
    if (req.method === "POST") {
      if (this.createdAt === undefined) {
        // Synchronous check-then-set: a Durable Object only interleaves
        // separate requests at `await` points, so mutating `createdAt`
        // before the first `await` here guarantees a racing second POST
        // for the same room code sees it already set and loses cleanly.
        this.createdAt = Date.now();
        this.status = "lobby";
        await this.persist();
        return Response.json(this.roomInfo(true));
      }
    }
    return Response.json(this.roomInfo(false));
  }

  roomInfo(created: boolean): RoomInfo {
    const host = [...this.players.values()]
      .filter((p) => p.named)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    return {
      exists: this.createdAt !== undefined,
      created,
      status: this.status,
      playerCount: this.players.size,
      full: this.players.size >= MAX_PLAYERS,
      hostLabel: host?.label,
    };
  }

  send(connection: Connection, message: ServerMessage) {
    connection.send(JSON.stringify(message));
  }

  // Named so it doesn't override Server.broadcast, which takes a raw string.
  broadcastMessage(message: ServerMessage, without?: string[]) {
    this.broadcast(JSON.stringify(message), without);
  }

  playersList(): Player[] {
    return [...this.players.values()];
  }

  connectedCount(): number {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  allConnectedReady(): boolean {
    return [...this.players.values()]
      .filter((p) => p.connected)
      .every((p) => this.readyIds.includes(p.id));
  }

  resultsClosing(): ResultsClosing | undefined {
    if (this.status !== "matched" || this.resetAt === undefined) return;
    return {
      remainingMs: Math.max(0, this.resetAt - Date.now()),
      readyIds: this.readyIds,
    };
  }

  // A Durable Object has a single alarm, shared by the results countdown and
  // the empty-room grace period, so always arm it for the earliest deadline.
  async armAlarm() {
    const now = Date.now();
    const deadlines: number[] = [];
    if (
      this.status === "matched" &&
      this.resetAt !== undefined &&
      this.resetAt > now
    ) {
      deadlines.push(this.resetAt);
    }
    if (this.connectedCount() === 0) {
      deadlines.push(Math.max(now, this.graceDeadline()));
    }
    if (deadlines.length > 0) {
      await this.ctx.storage.setAlarm(Math.min(...deadlines));
    }
  }

  // When an empty room may be torn down: the grace period after the last
  // player left.
  graceDeadline(): number {
    const lastLeft = Math.max(
      0,
      ...[...this.players.values()].map((p) => p.disconnectedAt ?? 0),
    );
    return lastLeft + GRACE_PERIOD_MS;
  }

  async resetToLobby() {
    this.status = "lobby";
    this.currentRound = 0;
    this.submissions.clear();
    this.roundHistory = [];
    this.resetAt = undefined;
    this.readyIds = [];
    await this.persist();
    this.broadcastMessage({
      type: "lobby-reset",
      players: this.playersList(),
    });
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
      roomCode: this.name,
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
      resultsClosing: this.resultsClosing(),
    };
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
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
      // The alarm may have been pushed back to the grace period while the
      // room was empty, so an expired countdown is resolved here too.
      if (
        this.status === "matched" &&
        this.resetAt !== undefined &&
        this.resetAt <= Date.now()
      ) {
        await this.resetToLobby();
      }
      await this.persist();
      this.send(connection, this.joinedMessage(existing));
      this.broadcastMessage(
        { type: "players-update", players: this.playersList() },
        [connection.id],
      );
      if (this.resetAt !== undefined) await this.armAlarm();
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
      named: Boolean(requestedLabel),
    };
    this.players.set(connection.id, player);
    this.liveConnections.set(connection.id, connection);
    await this.persist();

    this.send(connection, this.joinedMessage(player));
    this.broadcastMessage(
      { type: "players-update", players: this.playersList() },
      [connection.id],
    );
  }

  async onClose(connection: Connection) {
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
    this.broadcastMessage({
      type: "players-update",
      players: this.playersList(),
    });

    const liveCount = this.connectedCount();

    if (liveCount === 0) {
      await this.armAlarm();
      return;
    }

    // A finished game has nothing to reset: let people keep the results up
    // (phones drop the socket just from opening the share sheet).
    if (this.status === "matched") {
      if (this.resetAt !== undefined && this.allConnectedReady()) {
        await this.resetToLobby();
      }
      return;
    }

    if (liveCount < MIN_PLAYERS) {
      await this.resetToLobby();
      return;
    }

    if (this.status === "round-active" && this.submissions.size === liveCount) {
      await this.revealRound();
    }
  }

  async onAlarm() {
    const liveIds = new Set([...this.getConnections()].map((c) => c.id));

    if (liveIds.size === 0) {
      // The countdown can fire while everyone is briefly away (e.g. in the
      // share sheet): finish it, then wait out the grace period.
      if (this.graceDeadline() > Date.now()) {
        if (
          this.status === "matched" &&
          this.resetAt !== undefined &&
          this.resetAt <= Date.now()
        ) {
          await this.resetToLobby();
        }
        await this.armAlarm();
        return;
      }
      // Nobody reconnected within the grace period — the room really was
      // abandoned. Tear it down so the room code becomes reusable.
      this.createdAt = undefined;
      this.resetAt = undefined;
      this.readyIds = [];
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
      this.broadcastMessage({
        type: "players-update",
        players: this.playersList(),
      });
    }

    if (this.status === "matched" && this.resetAt !== undefined) {
      if (this.resetAt <= Date.now()) {
        await this.resetToLobby();
      } else {
        await this.armAlarm();
      }
    }
  }

  async onMessage(sender: Connection, message: WSMessage) {
    if (typeof message !== "string") return;

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
        player.named = true;
        await this.persist();
        this.broadcastMessage({
          type: "players-update",
          players: this.playersList(),
        });
        break;
      }
      case "start-game": {
        if (this.status !== "lobby" || this.connectedCount() < MIN_PLAYERS)
          return;
        this.status = "round-active";
        this.currentRound = 1;
        this.submissions.clear();
        await this.persist();
        this.broadcastMessage({
          type: "round-start",
          round: this.currentRound,
        });
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
        this.broadcastMessage({
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
        this.broadcastMessage({
          type: "round-start",
          round: this.currentRound,
        });
        break;
      }
      case "play-again": {
        if (this.status !== "matched") return;
        if (!this.players.has(sender.id)) return;
        if (this.readyIds.includes(sender.id)) return;
        // Check-then-set before any await, so two simultaneous first taps
        // can't both start a countdown.
        this.readyIds.push(sender.id);
        const firstTap = this.resetAt === undefined;
        if (firstTap) this.resetAt = Date.now() + RESULTS_COUNTDOWN_MS;
        if (this.allConnectedReady()) {
          await this.resetToLobby();
          return;
        }
        await this.persist();
        if (firstTap) await this.armAlarm();
        const closing = this.resultsClosing();
        if (closing) {
          this.broadcastMessage({ type: "results-closing", ...closing });
        }
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

    this.broadcastMessage({
      type: "round-revealed",
      round: this.currentRound,
      results,
      matched,
      path: this.roundHistory,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env)) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
