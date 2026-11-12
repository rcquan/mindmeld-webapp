export type RoomStatus = "lobby" | "round-active" | "revealed" | "matched";

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;
// Bots cost an API call per round each, so a room can have at most this many.
export const MAX_BOTS = 3;
// Enforced by the server; public/index.html sets the same maxlength on the inputs.
export const MAX_WORD_LENGTH = 40;
export const MAX_LABEL_LENGTH = 24;
// How long the results screen stays up after someone taps Play again.
export const RESULTS_COUNTDOWN_MS = 30_000;

export interface Player {
  id: string;
  label: string;
  joinedAt: number;
  connected: boolean;
  disconnectedAt?: number;
  // True once the player chose a label rather than getting `Player N`.
  named?: boolean;
  // Set for server-run bots. Bots have no socket and are never "ready".
  bot?: { persona: string };
}

// Presets the host can pick from in the lobby. The prompts and knob values
// live in src/bots.ts, which the browser bundle doesn't import.
export const BOT_PERSONA_OPTIONS = [
  {
    id: "bridge",
    label: "The Bridge",
    description: "Looks for the true midpoint of every word.",
  },
  {
    id: "categorizer",
    label: "The Categorizer",
    description: "Names the category the words share.",
  },
  {
    id: "specifier",
    label: "The Specifier",
    description: "Picks one specific thing that fits them all.",
  },
  {
    id: "stubborn",
    label: "The Stubborn One",
    description: "Sticks close to its own last word.",
  },
  {
    id: "follower",
    label: "The Crowd Follower",
    description: "Goes with the majority and drops the outlier.",
  },
  {
    id: "wildcard",
    label: "The Wildcard",
    description: "Puns, phrases and pop-culture leaps.",
  },
] as const;

export type BotPersonaId = (typeof BOT_PERSONA_OPTIONS)[number]["id"];

export function isBotPersonaId(id: unknown): id is BotPersonaId {
  return BOT_PERSONA_OPTIONS.some((p) => p.id === id);
}

// The match rule, shared by the server and the bot simulation: every word
// equal after trimming and lowercasing.
export function isMatch(words: string[]): boolean {
  const norm = words.map((w) => w.trim().toLowerCase());
  return norm.length > 0 && norm.every((w) => w === norm[0]);
}

export interface RoomInfo {
  exists: boolean;
  created: boolean;
  status: RoomStatus;
  playerCount: number;
  full: boolean;
  // Label of the earliest-joined player who chose a name, for invite links.
  hostLabel?: string;
}

export interface RoundWord {
  playerId: string;
  label: string;
  word: string;
}

export interface RoundResult {
  round: number;
  words: RoundWord[];
  matched: boolean;
}

export type ClientMessage =
  | { type: "set-label"; label: string }
  | { type: "start-game" }
  | { type: "submit-word"; word: string }
  | { type: "next-round" }
  | { type: "play-again" }
  | { type: "add-bot"; persona: string }
  | { type: "remove-bot"; playerId: string };

export interface ResultsClosing {
  // Relative, not absolute, so client clock skew doesn't matter.
  remainingMs: number;
  readyIds: string[];
}

export type ErrorCode = "room-full" | "already-started" | "not-found";

export type ServerMessage =
  | {
      type: "joined";
      you: Player;
      roomCode: string;
      status: RoomStatus;
      players: Player[];
      round: number;
      path: RoundResult[];
      submissionProgress?: { submittedCount: number; totalCount: number };
      revealResults?: RoundWord[];
      youSubmitted: boolean;
      resultsClosing?: ResultsClosing;
    }
  | { type: "players-update"; players: Player[] }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "round-start"; round: number }
  | { type: "submission-progress"; submittedCount: number; totalCount: number }
  | {
      type: "round-revealed";
      round: number;
      results: RoundWord[];
      matched: boolean;
      path: RoundResult[];
    }
  | { type: "lobby-reset"; players: Player[] }
  | ({ type: "results-closing" } & ResultsClosing)
  | { type: "word-rejected"; message: string };
