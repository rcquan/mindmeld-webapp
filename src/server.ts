import type * as Party from "partykit/server";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type ClientMessage,
  type Player,
  type RoomStatus,
  type RoundResult,
  type ServerMessage,
} from "./shared";

interface PersistedState {
  createdAt?: number;
  status: RoomStatus;
  players: Player[];
  currentRound: number;
  submissions: [string, string][];
  roundHistory: RoundResult[];
}

export default class MindMeld implements Party.Server {
  createdAt?: number;
  status: RoomStatus = "lobby";
  players = new Map<string, Player>();
  currentRound = 0;
  submissions = new Map<string, string>();
  roundHistory: RoundResult[] = [];

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

  onRequest(): Response {
    return Response.json({
      exists: this.createdAt !== undefined,
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

  usedWords(): Set<string> {
    const used = new Set<string>();
    for (const round of this.roundHistory) {
      for (const { word } of round.words) used.add(word.toLowerCase());
    }
    return used;
  }

  async onConnect(connection: Party.Connection, ctx: Party.ConnectionContext) {
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

    if (this.createdAt === undefined) this.createdAt = Date.now();
    const requestedLabel = new URL(ctx.request.url).searchParams
      .get("label")
      ?.trim()
      .slice(0, 24);
    const player: Player = {
      id: connection.id,
      label: requestedLabel || `Player ${this.players.size + 1}`,
      joinedAt: Date.now(),
    };
    this.players.set(connection.id, player);
    await this.persist();

    this.send(connection, {
      type: "joined",
      you: player,
      roomCode: this.room.id,
      status: this.status,
      players: this.playersList(),
    });
    this.broadcast({ type: "players-update", players: this.playersList() }, [
      connection.id,
    ]);
  }

  async onClose(connection: Party.Connection) {
    if (!this.players.has(connection.id)) return;
    this.players.delete(connection.id);
    this.submissions.delete(connection.id);

    if (this.players.size === 0) {
      this.createdAt = undefined;
      this.status = "lobby";
      this.currentRound = 0;
      this.roundHistory = [];
      await this.persist();
      return;
    }

    if (this.players.size < MIN_PLAYERS) {
      this.status = "lobby";
      this.currentRound = 0;
      this.submissions.clear();
      this.roundHistory = [];
      await this.persist();
      this.broadcast({ type: "lobby-reset", players: this.playersList() });
      return;
    }

    await this.persist();
    this.broadcast({ type: "players-update", players: this.playersList() });

    if (
      this.status === "round-active" &&
      this.submissions.size === this.players.size
    ) {
      await this.revealRound();
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
        if (this.status !== "lobby" || this.players.size < MIN_PLAYERS) return;
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
          totalCount: this.players.size,
        });
        if (this.submissions.size === this.players.size) {
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
    this.roundHistory.push({ round: this.currentRound, words: results, matched });
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
