import Anthropic from "@anthropic-ai/sdk";
import {
  type Connection,
  type ConnectionContext,
  routePartykitRequest,
  Server,
  type WSMessage,
} from "partyserver";
import { BOT_PERSONAS, chooseBotWord, fallbackWord } from "./bots";
import {
  type ClientMessage,
  isBotPersonaId,
  isMatch,
  MAX_BOTS,
  MAX_LABEL_LENGTH,
  MAX_PLAYERS,
  MAX_WORD_LENGTH,
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

// Server-created bot ids. Clients choose their own connection ids, so any
// connection with this prefix is someone posing as a bot.
const BOT_ID_PREFIX = "bot-";
function isBotId(id: string): boolean {
  return id.startsWith(BOT_ID_PREFIX);
}

type Env = {
  Main: DurableObjectNamespace<MindMeld>;
  // Optional: without it, bots play words from a built-in list.
  ANTHROPIC_API_KEY?: string;
};

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
  // `${round}:${botId}` for bot turns running in this instance, so a wake in
  // onStart doesn't double-run one that is still in flight.
  botTurns = new Set<string>();
  anthropic?: Anthropic;

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
    // A round's bot turns run in waitUntil promises, which don't survive the
    // instance being evicted: restart any bot that hasn't submitted yet.
    if (this.status === "round-active") {
      this.ctx.waitUntil(this.runBots(this.currentRound));
    }
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

  // Bots count: they play rounds and count toward MIN_PLAYERS.
  connectedCount(): number {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  // Bots have no socket, so a room is empty once its humans are gone.
  humanConnectedCount(): number {
    return [...this.players.values()].filter((p) => p.connected && !p.bot)
      .length;
  }

  bots(): Player[] {
    return [...this.players.values()].filter((p) => p.bot);
  }

  allConnectedReady(): boolean {
    return [...this.players.values()]
      .filter((p) => p.connected && !p.bot)
      .every((p) => this.readyIds.includes(p.id));
  }

  // The earliest-joined human. Only the host manages bots, since bots cost
  // API calls; if the host leaves for good, the next human takes over.
  hostId(): string | undefined {
    return [...this.players.values()]
      .filter((p) => !p.bot)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0]?.id;
  }

  botClient(): Anthropic | undefined {
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) return undefined;
    // SDK defaults are a 10-minute timeout with 2 retries, which would hold a
    // round open for up to half an hour; a bot that slow should fall back.
    this.anthropic ??= new Anthropic({
      apiKey,
      timeout: 15_000,
      maxRetries: 1,
    });
    return this.anthropic;
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
    if (this.humanConnectedCount() === 0) {
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

    // Bot ids are public (players-update lists them) and connection ids are
    // client-chosen, so anyone could connect as a bot. Closing here is best
    // effort (wrangler dev keeps the socket open), so onMessage and onClose
    // also ignore these ids.
    if (isBotId(connection.id)) {
      connection.close(4003, "reserved-id");
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
      .slice(0, MAX_LABEL_LENGTH);
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
    // A socket that claimed a bot's id must not mark the bot disconnected.
    if (isBotId(connection.id)) return;
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

    // Only bots left: keep the game for a reconnect, and let the grace
    // period tear the room down otherwise.
    if (this.humanConnectedCount() === 0) {
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
      if (player.bot) continue;
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
    if (isBotId(sender.id)) return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    switch (parsed.type) {
      case "set-label": {
        const player = this.players.get(sender.id);
        if (!player || player.bot || this.status !== "lobby") return;
        if (typeof parsed.label !== "string") return;
        const label = parsed.label.trim().slice(0, MAX_LABEL_LENGTH);
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
        if (this.humanConnectedCount() === 0) return;
        this.status = "round-active";
        this.currentRound = 1;
        this.submissions.clear();
        await this.persist();
        this.broadcastMessage({
          type: "round-start",
          round: this.currentRound,
        });
        this.ctx.waitUntil(this.runBots(this.currentRound));
        break;
      }
      case "submit-word": {
        const player = this.players.get(sender.id);
        if (!player || player.bot) return;
        if (typeof parsed.word !== "string") return;
        const rejected = await this.acceptSubmission(sender.id, parsed.word);
        if (rejected) {
          this.send(sender, { type: "word-rejected", message: rejected });
        }
        break;
      }
      case "add-bot": {
        if (sender.id !== this.hostId() || this.status !== "lobby") return;
        if (!isBotPersonaId(parsed.persona)) return;
        if (this.players.size >= MAX_PLAYERS) return;
        if (this.bots().length >= MAX_BOTS) return;
        const persona = BOT_PERSONAS[parsed.persona];
        const base = `${persona.label.replace(/^The /, "")} Bot`;
        const taken = new Set(this.bots().map((b) => b.label));
        let label = base;
        for (let n = 2; taken.has(label); n++) label = `${base} ${n}`;
        const bot: Player = {
          id: `${BOT_ID_PREFIX}${crypto.randomUUID()}`,
          label,
          joinedAt: Date.now(),
          connected: true,
          named: true,
          bot: { persona: persona.id },
        };
        this.players.set(bot.id, bot);
        await this.persist();
        this.broadcastMessage({
          type: "players-update",
          players: this.playersList(),
        });
        break;
      }
      case "remove-bot": {
        if (sender.id !== this.hostId() || this.status !== "lobby") return;
        const bot = this.players.get(parsed.playerId);
        if (!bot?.bot) return;
        this.players.delete(bot.id);
        await this.persist();
        this.broadcastMessage({
          type: "players-update",
          players: this.playersList(),
        });
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
        this.ctx.waitUntil(this.runBots(this.currentRound));
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

  // Shared by human and bot submissions. Returns why the word was
  // rejected, or undefined once it's accepted (or silently ignored).
  async acceptSubmission(
    playerId: string,
    rawWord: string,
  ): Promise<string | undefined> {
    if (this.status !== "round-active") return;
    if (!this.players.has(playerId)) return;
    const word = rawWord.trim();
    if (!word) return;
    // The input's maxlength is client-side only. Without this, one huge
    // word pushes the persisted state past the 128 KiB storage value
    // limit and every later persist() fails, freezing the room.
    if (word.length > MAX_WORD_LENGTH) {
      return `Words can be at most ${MAX_WORD_LENGTH} characters.`;
    }
    if (this.usedWords().has(word.toLowerCase())) {
      return `"${word}" was already used — try something new.`;
    }
    this.submissions.set(playerId, word);
    await this.persist();
    this.broadcastMessage({
      type: "submission-progress",
      submittedCount: this.submissions.size,
      totalCount: this.connectedCount(),
    });
    if (this.submissions.size === this.connectedCount()) {
      await this.revealRound();
    }
  }

  // Plays every bot's turn for `round`, in parallel. Each bot waits out its
  // think time, then re-checks the room, which may have moved on meanwhile.
  async runBots(round: number) {
    const client = this.botClient();
    await Promise.all(
      this.bots().map(async (bot) => {
        const key = `${round}:${bot.id}`;
        if (this.submissions.has(bot.id) || this.botTurns.has(key)) return;
        const persona =
          BOT_PERSONAS[bot.bot?.persona as keyof typeof BOT_PERSONAS];
        if (!persona) return;
        this.botTurns.add(key);
        try {
          const started = Date.now();
          const [min, max] = persona.knobs.thinkMs;
          const thinkMs = min + Math.random() * (max - min);
          const context = () => ({
            round,
            history: [...this.roundHistory],
            selfId: bot.id,
            usedWords: this.usedWords(),
          });
          const choice = await chooseBotWord(client, persona, context());
          const wait = thinkMs - (Date.now() - started);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          if (!this.botTurnOpen(round, bot.id)) return;
          const rejected = await this.acceptSubmission(bot.id, choice.word);
          // chooseBotWord already avoids used and over-long words, so this
          // is a last resort: an unused fallback word is always accepted.
          if (rejected) {
            console.warn(`bot ${bot.label}: ${rejected}`);
            await this.acceptSubmission(bot.id, fallbackWord(context()));
          }
        } catch (err) {
          console.error(`bot ${bot.label} failed`, err);
          await this.recoverBotTurn(round, bot).catch((e) =>
            console.error(`bot ${bot.label} recovery failed`, e),
          );
        } finally {
          this.botTurns.delete(key);
        }
      }),
    );
  }

  // Whether `botId` still owes a word for `round`.
  botTurnOpen(round: number, botId: string): boolean {
    return (
      this.status === "round-active" &&
      this.currentRound === round &&
      this.players.has(botId) &&
      !this.submissions.has(botId)
    );
  }

  // A bot's turn failed. Never leave the round waiting on it: submit a
  // fallback word, or, if its word was recorded but the reveal didn't run
  // (persist threw midway), run the reveal now.
  async recoverBotTurn(round: number, bot: Player) {
    if (this.botTurnOpen(round, bot.id)) {
      await this.acceptSubmission(
        bot.id,
        fallbackWord({
          round,
          history: [...this.roundHistory],
          selfId: bot.id,
          usedWords: this.usedWords(),
        }),
      );
    } else if (
      this.status === "round-active" &&
      this.currentRound === round &&
      this.submissions.size === this.connectedCount()
    ) {
      await this.revealRound();
    }
  }

  async revealRound() {
    const results = [...this.submissions.entries()].map(([playerId, word]) => {
      const player = this.players.get(playerId);
      return { playerId, label: player?.label ?? "Player", word };
    });
    const matched = isMatch(results.map((r) => r.word));

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
