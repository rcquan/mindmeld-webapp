export type RoomStatus = "lobby" | "round-active" | "revealed" | "matched";

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;

export interface Player {
  id: string;
  label: string;
  joinedAt: number;
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
  | { type: "play-again" };

export type ErrorCode = "room-full" | "already-started" | "not-found";

export type ServerMessage =
  | {
      type: "joined";
      you: Player;
      roomCode: string;
      status: RoomStatus;
      players: Player[];
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
  | { type: "word-rejected"; message: string };
