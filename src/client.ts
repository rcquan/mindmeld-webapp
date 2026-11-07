import "./styles.css";

import PartySocket from "partysocket";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type Player,
  type RoomInfo,
  type RoomStatus,
  type RoundResult,
  type RoundWord,
  type ServerMessage,
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

// The frontend and the room server are served from the same Worker,
// so the page's own origin is always the right host to talk to —
// this avoids origin mismatches (e.g. localhost vs 127.0.0.1) that trip CORS.
const APP_HOST = location.host;

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
  // Set while the home screen is showing an invite link's landing page.
  invite?: Invite;
}

type InviteError = "full" | "started" | "not-found" | "network";

interface Invite {
  code: string;
  info?: RoomInfo;
  error?: InviteError;
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
  } else if (state.screen === "lobby") {
    const known = new Set(state.players.map((p) => p.id));
    const joined = players.find((p) => !known.has(p.id));
    if (joined) showToast(`${joined.label} joined`);
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
const homeScreen = document.querySelector<HTMLElement>(
  '[data-screen="home"]',
) as HTMLElement;
const inviteHeading = el<HTMLParagraphElement>("invite-heading");
const inviteHost = el<HTMLParagraphElement>("invite-host");
const inviteJoinBtn = el<HTMLButtonElement>("invite-join");
const inviteError = el<HTMLParagraphElement>("invite-error");
const inviteRecoverBtn = el<HTMLButtonElement>("invite-recover");
const inviteExitBtn = el<HTMLButtonElement>("invite-exit");

const roomCodeBtn = el<HTMLButtonElement>("copy-code");
const copyHint = el<HTMLParagraphElement>("copy-hint");
const inviteBtn = el<HTMLButtonElement>("invite-btn");
const inviteLabel = el<HTMLSpanElement>("invite-label");
const inviteHint = el<HTMLParagraphElement>("invite-hint");
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

  if (state.screen === "home") {
    const invite = state.invite;
    homeScreen.classList.toggle("invite-mode", Boolean(invite));
    if (invite) {
      inviteHeading.textContent = `You're invited to room ${invite.code}`;
      const host = invite.info?.hostLabel;
      inviteHost.hidden = !host || Boolean(invite.error);
      inviteHost.textContent = host ? `${host} is waiting` : "";
      inviteError.hidden = !invite.error;
      inviteError.textContent = invite.error
        ? INVITE_ERROR_TEXT[invite.error]
        : "";
      inviteRecoverBtn.hidden = !invite.error;
      inviteRecoverBtn.textContent =
        invite.error === "network" ? "Try again" : "Create your own room";
      // Joining only makes sense once we know the room is open.
      const joinable = Boolean(invite.info) && !invite.error;
      inviteJoinBtn.hidden = !joinable;
      displayNameInput.hidden = Boolean(invite.error);
      inviteExitBtn.hidden = Boolean(invite.error);
    } else {
      displayNameInput.hidden = false;
    }
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
    const count = state.players.length;
    const alone = count < MIN_PLAYERS;
    lobbyStatus.textContent = alone
      ? `Waiting for players (${count}/${MAX_PLAYERS})…`
      : `${count}/${MAX_PLAYERS} players — ready when you are`;
    startGameBtn.disabled = alone;
    startGameBtn.classList.toggle("btn-primary", !alone);

    // Inviting is the main action until someone else is here; after that,
    // starting the game is, and inviting steps back to a text link.
    inviteBtn.hidden = count >= MAX_PLAYERS;
    inviteBtn.className = alone ? "btn btn-primary" : "btn-link";
    inviteLabel.textContent = !canNativeShare
      ? "Copy invite link"
      : alone
        ? "Invite friends"
        : "Invite more friends";
    if (inviteBtn.hidden) inviteHint.textContent = "";
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
  state.invite = undefined;
  inviteHint.textContent = "";
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
      // Joined via an invite link: drop ?code= so a refresh or a copied
      // address bar doesn't bring the invite landing back.
      if (location.search) history.replaceState(null, "", "/");
      state.invite = undefined;
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
    host: APP_HOST,
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
    host: APP_HOST,
    room: roomCode,
  });
  return (await res.json()) as RoomInfo;
}

async function createRoom(roomCode: string): Promise<RoomInfo> {
  const res = await PartySocket.fetch(
    { host: APP_HOST, room: roomCode },
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

// Why a room can't be joined right now, or undefined if it can.
function unjoinableReason(info: RoomInfo): InviteError | undefined {
  if (!info.exists) return "not-found";
  if (info.full) return "full";
  if (info.status !== "lobby") return "started";
  return undefined;
}

const JOIN_ERROR_TEXT: Record<InviteError, string> = {
  "not-found": "Room not found — check the code.",
  full: `Room is full (${MAX_PLAYERS}/${MAX_PLAYERS}).`,
  started: "This game already started — ask for a new code.",
  network: "Couldn't reach the server — check your connection and try again.",
};

const INVITE_ERROR_TEXT: Record<InviteError, string> = {
  "not-found": "This invite has expired.",
  full: `This room is full (${MAX_PLAYERS}/${MAX_PLAYERS}).`,
  started: "This game has already started. Ask for a new invite after it ends.",
  network: "Couldn't reach the server. Check your connection.",
};

async function checkJoinable(
  code: string,
): Promise<{ info?: RoomInfo; error?: InviteError }> {
  try {
    const info = await peek(code);
    return { info, error: unjoinableReason(info) };
  } catch {
    return { error: "network" };
  }
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = joinCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    homeError.hidden = false;
    homeError.textContent = "Enter the 6-digit room code.";
    return;
  }
  const { error } = await checkJoinable(code);
  if (error) {
    homeError.hidden = false;
    homeError.textContent = JOIN_ERROR_TEXT[error];
    return;
  }
  homeError.hidden = true;
  connect(code);
});

async function loadInvite(code: string) {
  state.invite = { code };
  render();
  const { info, error } = await checkJoinable(code);
  // The person may have left the landing while the check was in flight.
  if (state.invite?.code !== code) return;
  state.invite = { code, info, error };
  render();
  if (!error) displayNameInput.focus();
}

function exitInviteMode() {
  state.invite = undefined;
  history.replaceState(null, "", "/");
  homeError.hidden = true;
  render();
}

inviteJoinBtn.addEventListener("click", async () => {
  const invite = state.invite;
  if (!invite) return;
  inviteJoinBtn.disabled = true;
  try {
    // Check again: the room may have filled or started while they typed.
    const { info, error } = await checkJoinable(invite.code);
    if (error) {
      state.invite = { code: invite.code, info, error };
      render();
      return;
    }
    connect(invite.code);
  } finally {
    inviteJoinBtn.disabled = false;
  }
});

inviteRecoverBtn.addEventListener("click", () => {
  const invite = state.invite;
  if (invite?.error === "network") loadInvite(invite.code);
  else exitInviteMode();
});

inviteExitBtn.addEventListener("click", exitInviteMode);

function flashHint(hint: HTMLElement, ms = 1500) {
  hint.hidden = false;
  setTimeout(() => (hint.hidden = true), ms);
}

roomCodeBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.roomCode);
  flashHint(copyHint);
});

function inviteData(): ShareData {
  const code = state.roomCode;
  const name = displayNameInput.value.trim();
  return {
    title: "Mind Meld",
    text: name
      ? `${name} invited you to Mind Meld. Room ${code}`
      : `Join my Mind Meld game! Room ${code}`,
    url: `${location.origin}/?code=${code}`,
  };
}

// Phones get the native share sheet (Messages first); browsers without the
// Web Share API get a copy-to-clipboard button instead.
const canNativeShare =
  typeof navigator.share === "function" &&
  navigator.canShare?.({ title: "x", text: "x", url: location.href }) !== false;

async function copyInvite(data: ShareData) {
  try {
    await navigator.clipboard.writeText(`${data.text} ${data.url}`);
    inviteHint.textContent = "Link copied: paste it into a text";
  } catch {
    inviteHint.textContent = `Share this code: ${state.roomCode}`;
  }
}

inviteBtn.addEventListener("click", async () => {
  const data = inviteData();
  if (!canNativeShare) {
    await copyInvite(data);
    return;
  }
  try {
    await navigator.share(data);
    inviteHint.textContent = "Invite sent. Waiting for friends…";
  } catch (err) {
    // Closing the share sheet without picking anything isn't an error.
    if (err instanceof DOMException && err.name === "AbortError") return;
    await copyInvite(data);
  }
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

displayNameInput.value = localStorage.getItem("mindmeld-name") ?? "";

const inviteCode = new URLSearchParams(location.search).get("code");
if (inviteCode && /^\d{6}$/.test(inviteCode)) {
  loadInvite(inviteCode);
} else {
  render();
}
