import "./styles.css";

import PartySocket from "partysocket";
import type {
  Player,
  RoomInfo,
  RoomStatus,
  RoundResult,
  RoundWord,
  ServerMessage,
} from "./shared";

// How long the client keeps retrying a dropped connection in the background
// before giving up and showing the fatal "lost connection" screen.
const RECONNECT_ERROR_THRESHOLD_MS = 120_000;

function getClientId(): string {
  let id = localStorage.getItem("mindmeld-client-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("mindmeld-client-id", id);
  }
  return id;
}

// The frontend and the room server are served from the same PartyKit
// project, so the page's own origin is always the right host to talk to —
// this avoids origin mismatches (e.g. localhost vs 127.0.0.1) that trip CORS.
const PARTYKIT_HOST = location.host;

type Screen =
  | "home"
  | "lobby"
  | "collecting"
  | "revealed"
  | "matched"
  | "error";

interface State {
  screen: Screen;
  roomCode: string;
  you?: Player;
  players: Player[];
  round: number;
  submitted: boolean;
  submissionProgress?: { submittedCount: number; totalCount: number };
  revealResults: RoundWord[];
  path: RoundResult[];
  errorMessage: string;
  wordError: string;
}

const state: State = {
  screen: "home",
  roomCode: "",
  players: [],
  round: 0,
  submitted: false,
  revealResults: [],
  path: [],
  errorMessage: "",
  wordError: "",
};

let toastTimer: ReturnType<typeof setTimeout>;
function showToast(message: string) {
  const toast = el<HTMLParagraphElement>("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2500);
}

function setPlayers(players: Player[]) {
  if (state.screen !== "home" && players.length < state.players.length) {
    showToast("A player left the room.");
  }
  state.players = players;
}

let socket: PartySocket | undefined;

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const screens = document.querySelectorAll<HTMLElement>("[data-screen]");
const homeError = el<HTMLParagraphElement>("home-error");
const joinForm = el<HTMLFormElement>("join-form");
const joinCode = el<HTMLInputElement>("join-code");
const createRoomBtn = el<HTMLButtonElement>("create-room");
const displayNameInput = el<HTMLInputElement>("display-name");

const roomCodeBtn = el<HTMLButtonElement>("copy-code");
const copyHint = el<HTMLParagraphElement>("copy-hint");
const playerList = el<HTMLUListElement>("player-list");
const lobbyStatus = el<HTMLParagraphElement>("lobby-status");
const startGameBtn = el<HTMLButtonElement>("start-game");

const roundLabel = el<HTMLParagraphElement>("round-label");
const wordForm = el<HTMLFormElement>("word-form");
const wordInput = el<HTMLInputElement>("word-input");
const wordError = el<HTMLParagraphElement>("word-error");
const submissionProgressEl = el<HTMLParagraphElement>("submission-progress");
const historyWrap = el<HTMLDivElement>("history-wrap");
const historyHead = el<HTMLTableRowElement>("history-head");
const historyBody = el<HTMLTableSectionElement>("history-body");

const revealedRoundLabel = el<HTMLParagraphElement>("revealed-round-label");
const revealGrid = el<HTMLUListElement>("reveal-grid");
const nextRoundBtn = el<HTMLButtonElement>("next-round");

const matchedWord = el<HTMLHeadingElement>("matched-word");
const pathList = el<HTMLOListElement>("path-list");
const playAgainBtn = el<HTMLButtonElement>("play-again");

const errorMessageEl = el<HTMLParagraphElement>("error-message");
const errorBackBtn = el<HTMLButtonElement>("error-back");

function render() {
  for (const section of screens) {
    section.classList.toggle("active", section.dataset.screen === state.screen);
  }

  if (state.screen === "lobby") {
    roomCodeBtn.textContent = state.roomCode;
    playerList.innerHTML = "";
    for (const player of state.players) {
      const li = document.createElement("li");
      li.textContent =
        player.id === state.you?.id ? `${player.label} (you)` : player.label;
      if (!player.connected) li.textContent += " (reconnecting…)";
      li.classList.toggle("player-disconnected", !player.connected);
      playerList.appendChild(li);
    }
    lobbyStatus.textContent =
      state.players.length < 2
        ? `Waiting for players (${state.players.length}/6)…`
        : `${state.players.length}/6 players — ready when you are`;
    startGameBtn.disabled = state.players.length < 2;
  }

  if (state.screen === "collecting") {
    roundLabel.textContent = `Round ${state.round}`;
    wordInput.disabled = state.submitted;
    (wordForm.querySelector("button") as HTMLButtonElement).disabled =
      state.submitted;
    if (state.submitted && state.submissionProgress) {
      submissionProgressEl.hidden = false;
      submissionProgressEl.textContent = `Waiting on ${
        state.submissionProgress.totalCount -
        state.submissionProgress.submittedCount
      } more player(s)… (${state.submissionProgress.submittedCount}/${
        state.submissionProgress.totalCount
      } submitted)`;
    } else {
      submissionProgressEl.hidden = true;
    }
    wordError.hidden = !state.wordError;
    wordError.textContent = state.wordError;

    historyWrap.hidden = state.path.length === 0;
    if (state.path.length > 0) {
      historyHead.innerHTML = "";
      for (const player of state.players) {
        const th = document.createElement("th");
        th.textContent =
          player.id === state.you?.id ? `${player.label} (you)` : player.label;
        th.classList.toggle("player-disconnected", !player.connected);
        historyHead.appendChild(th);
      }
      historyBody.innerHTML = "";
      for (const round of state.path) {
        const tr = document.createElement("tr");
        for (const player of state.players) {
          const td = document.createElement("td");
          td.textContent =
            round.words.find((w) => w.playerId === player.id)?.word ?? "";
          tr.appendChild(td);
        }
        historyBody.appendChild(tr);
      }
    }
  }

  if (state.screen === "revealed") {
    revealedRoundLabel.textContent = `Round ${state.round}`;
    revealGrid.innerHTML = "";
    for (const result of state.revealResults) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = result.label;
      const word = document.createElement("span");
      word.className = "word";
      word.textContent = result.word;
      li.append(label, word);
      revealGrid.appendChild(li);
    }
  }

  if (state.screen === "matched") {
    matchedWord.textContent = state.revealResults[0]?.word ?? "";
    pathList.innerHTML = "";
    for (const round of state.path) {
      const li = document.createElement("li");
      li.className = round.matched ? "matched-row" : "";
      li.textContent = `Round ${round.round}: ${round.words
        .map((w) => w.word)
        .join(" · ")}`;
      pathList.appendChild(li);
    }
  }

  if (state.screen === "error") {
    errorMessageEl.textContent = state.errorMessage;
  }
}

function resetToHome(message?: string) {
  socket?.close();
  socket = undefined;
  clearDisconnectTimer();
  state.screen = "home";
  state.roomCode = "";
  state.you = undefined;
  state.players = [];
  state.round = 0;
  state.submitted = false;
  state.submissionProgress = undefined;
  state.revealResults = [];
  state.path = [];
  state.wordError = "";
  homeError.hidden = !message;
  homeError.textContent = message ?? "";
  render();
}

function usedWordsSet(): Set<string> {
  const used = new Set<string>();
  for (const round of state.path) {
    for (const { word } of round.words) used.add(word.toLowerCase());
  }
  return used;
}

function showError(message: string) {
  state.errorMessage = message;
  state.screen = "error";
  render();
}

function handleMessage(raw: string) {
  const message: ServerMessage = JSON.parse(raw);
  switch (message.type) {
    case "joined": {
      state.you = message.you;
      state.roomCode = message.roomCode;
      state.players = message.players;
      state.round = message.round;
      state.path = message.path;
      state.submissionProgress = message.submissionProgress;
      state.revealResults = message.revealResults ?? [];
      state.submitted = message.youSubmitted;
      state.wordError = "";
      state.screen = statusToScreen(message.status);
      break;
    }
    case "players-update": {
      setPlayers(message.players);
      break;
    }
    case "error": {
      // The server is about to close this connection for a reason that
      // won't resolve itself (room full/started/gone) — close cleanly on
      // our end too so the client doesn't keep silently retrying forever.
      clearDisconnectTimer();
      socket?.close();
      showError(message.message);
      return;
    }
    case "round-start": {
      state.round = message.round;
      state.submitted = false;
      state.submissionProgress = undefined;
      state.wordError = "";
      wordInput.value = "";
      state.screen = "collecting";
      break;
    }
    case "submission-progress": {
      state.submissionProgress = {
        submittedCount: message.submittedCount,
        totalCount: message.totalCount,
      };
      break;
    }
    case "word-rejected": {
      state.submitted = false;
      state.wordError = message.message;
      break;
    }
    case "round-revealed": {
      state.round = message.round;
      state.revealResults = message.results;
      state.path = message.path;
      if (message.matched) {
        state.screen = "matched";
      } else {
        state.screen = "revealed";
      }
      break;
    }
    case "lobby-reset": {
      setPlayers(message.players);
      state.round = 0;
      state.submitted = false;
      state.submissionProgress = undefined;
      state.revealResults = [];
      state.path = [];
      state.wordError = "";
      state.screen = "lobby";
      break;
    }
  }
  render();
}

function statusToScreen(status: RoomStatus): Screen {
  switch (status) {
    case "lobby":
      return "lobby";
    case "round-active":
      return "collecting";
    case "revealed":
      return "revealed";
    case "matched":
      return "matched";
  }
}

let disconnectTimer: ReturnType<typeof setTimeout> | undefined;

function clearDisconnectTimer() {
  clearTimeout(disconnectTimer);
  disconnectTimer = undefined;
}

function connect(roomCode: string) {
  const label = displayNameInput.value.trim().slice(0, 24);
  localStorage.setItem("mindmeld-name", label);
  socket = new PartySocket({
    host: PARTYKIT_HOST,
    room: roomCode,
    id: getClientId(),
    query: { label },
  });
  socket.addEventListener("message", (event) => handleMessage(event.data));
  socket.addEventListener("open", clearDisconnectTimer);
  socket.addEventListener("close", (event) => {
    if (state.screen === "error" || event.code === 1000) return;
    showToast("Reconnecting…");
    if (!disconnectTimer) {
      disconnectTimer = setTimeout(() => {
        showError("Lost connection to the room.");
      }, RECONNECT_ERROR_THRESHOLD_MS);
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !socket) return;
  if (socket.readyState !== socket.OPEN) socket.reconnect();
});

function randomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function peek(roomCode: string): Promise<RoomInfo> {
  const res = await PartySocket.fetch({
    host: PARTYKIT_HOST,
    room: roomCode,
  });
  return (await res.json()) as RoomInfo;
}

async function createRoom(roomCode: string): Promise<RoomInfo> {
  const res = await PartySocket.fetch(
    { host: PARTYKIT_HOST, room: roomCode },
    { method: "POST" },
  );
  return (await res.json()) as RoomInfo;
}

createRoomBtn.addEventListener("click", async () => {
  createRoomBtn.disabled = true;
  try {
    let code = randomCode();
    let info = await createRoom(code);
    for (let attempt = 0; attempt < 5 && !info.created; attempt++) {
      code = randomCode();
      info = await createRoom(code);
    }
    if (!info.created) {
      homeError.hidden = false;
      homeError.textContent = "Couldn't find a free room code — try again.";
      return;
    }
    connect(code);
  } catch {
    homeError.hidden = false;
    homeError.textContent =
      "Couldn't reach the server — check your connection and try again.";
  } finally {
    createRoomBtn.disabled = false;
  }
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = joinCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    homeError.hidden = false;
    homeError.textContent = "Enter the 6-digit room code.";
    return;
  }
  try {
    const info = await peek(code);
    if (!info.exists) {
      homeError.hidden = false;
      homeError.textContent = "Room not found — check the code.";
      return;
    }
    if (info.full) {
      homeError.hidden = false;
      homeError.textContent = "Room is full (6/6).";
      return;
    }
    if (info.status !== "lobby") {
      homeError.hidden = false;
      homeError.textContent = "This game already started — ask for a new code.";
      return;
    }
    homeError.hidden = true;
    connect(code);
  } catch {
    homeError.hidden = false;
    homeError.textContent =
      "Couldn't reach the server — check your connection and try again.";
  }
});

roomCodeBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode);
  copyHint.hidden = false;
  setTimeout(() => (copyHint.hidden = true), 1500);
});

startGameBtn.addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "start-game" }));
});

wordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const word = wordInput.value.trim();
  if (!word || state.submitted) return;
  if (usedWordsSet().has(word.toLowerCase())) {
    state.wordError = `"${word}" was already used — try something new.`;
    render();
    return;
  }
  socket?.send(JSON.stringify({ type: "submit-word", word }));
  state.submitted = true;
  state.wordError = "";
  render();
});

wordInput.addEventListener("input", () => {
  if (state.wordError) {
    state.wordError = "";
    render();
  }
});

nextRoundBtn.addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "next-round" }));
});

playAgainBtn.addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "play-again" }));
});

errorBackBtn.addEventListener("click", () => {
  resetToHome();
});

const params = new URLSearchParams(location.search);
const prefillCode = params.get("code");
if (prefillCode && /^\d{6}$/.test(prefillCode)) {
  joinCode.value = prefillCode;
}
displayNameInput.value = localStorage.getItem("mindmeld-name") ?? "";

render();
