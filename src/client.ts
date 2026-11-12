import "./styles.css";

import PartySocket from "partysocket";
import {
  BOT_PERSONA_OPTIONS,
  MAX_BOTS,
  MAX_LABEL_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type Player,
  type ResultsClosing,
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
  // Set once someone taps Play again on the results screen. `deadline` is
  // on this client's clock.
  resultsClosing?: { deadline: number; readyIds: string[] };
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
const addBotForm = el<HTMLFormElement>("add-bot-form");
const botPersonaSelect = el<HTMLSelectElement>("bot-persona");
const botHint = el<HTMLParagraphElement>("bot-hint");

for (const persona of BOT_PERSONA_OPTIONS) {
  const option = document.createElement("option");
  option.value = persona.id;
  option.textContent = persona.label;
  botPersonaSelect.appendChild(option);
}

function renderBotHint() {
  const persona = BOT_PERSONA_OPTIONS.find(
    (p) => p.id === botPersonaSelect.value,
  );
  botHint.textContent = persona?.description ?? "";
}
renderBotHint();

const roundLabel = el<HTMLParagraphElement>("round-label");
const roundPrompt = el<HTMLHeadingElement>("round-prompt");
const roundHint = el<HTMLParagraphElement>("round-hint");
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
const resultsCountdown = el<HTMLParagraphElement>("results-countdown");
const shareResultsBtn = el<HTMLButtonElement>("share-results");
const copyImageBtn = el<HTMLButtonElement>("copy-image");
const downloadResultsBtn = el<HTMLButtonElement>("download-results");
const shareHint = el<HTMLParagraphElement>("share-hint");

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
      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent =
        player.id === state.you?.id ? `${player.label} (you)` : player.label;
      if (!player.connected) name.textContent += " (reconnecting…)";
      li.appendChild(name);
      if (player.bot) {
        li.classList.add("player-bot");
        const tag = document.createElement("span");
        tag.className = "bot-tag";
        tag.textContent = "bot";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove-bot";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${player.label}`);
        remove.addEventListener("click", () => {
          socket?.send(
            JSON.stringify({ type: "remove-bot", playerId: player.id }),
          );
        });
        li.append(tag, remove);
      }
      li.classList.toggle("player-disconnected", !player.connected);
      playerList.appendChild(li);
    }
    const count = state.players.length;
    const full = count >= MAX_PLAYERS;
    const botsFull = state.players.filter((p) => p.bot).length >= MAX_BOTS;
    addBotForm.hidden = full || botsFull;
    botHint.hidden = full || botsFull;
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
    // Round 1 is a free pick; every later round is about converging.
    const firstRound = state.path.length === 0;
    roundPrompt.textContent = firstRound
      ? "Type any word that comes to mind"
      : "Find the middle ground";
    roundHint.textContent = firstRound
      ? "Words stay hidden until everyone submits."
      : "What's the most obvious word that connects these?";
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
    renderPathList();
    shareResultsBtn.hidden = !resultCard.file || !canShareFile(resultCard.file);
    copyImageBtn.hidden = !resultCard.blob || !canCopyImage;
    downloadResultsBtn.disabled = !resultCard.blob;
    renderCountdown();
  }
  syncCountdownTicker();

  if (state.screen === "error") {
    errorMessageEl.textContent = state.errorMessage;
  }
}

interface Participant {
  id: string;
  label: string;
}

// Everyone who submitted a word in any round, in join order. Players who
// have since left keep the name stored with their words and go last, in the
// order they first played. Spectators who never submitted are left out.
function participantOrder(
  path: RoundResult[],
  players: Player[],
): Participant[] {
  const firstSeen = new Map<string, { label: string; index: number }>();
  for (const round of path) {
    for (const w of round.words) {
      if (!firstSeen.has(w.playerId)) {
        firstSeen.set(w.playerId, { label: w.label, index: firstSeen.size });
      }
    }
  }
  const current = new Map(players.map((p) => [p.id, p]));
  return [...firstSeen.entries()]
    .map(([id, seen]) => {
      const player = current.get(id);
      return {
        id,
        label: player?.label ?? seen.label,
        joinedAt: player?.joinedAt ?? Number.POSITIVE_INFINITY,
        index: seen.index,
      };
    })
    .sort((a, b) => a.joinedAt - b.joinedAt || a.index - b.index)
    .map(({ id, label }) => ({ id, label }));
}

// A round's words in participant order, with each player's current name.
function orderedWords(round: RoundResult, order: Participant[]): RoundWord[] {
  const words: RoundWord[] = [];
  for (const p of order) {
    const w = round.words.find((rw) => rw.playerId === p.id);
    if (w) words.push({ ...w, label: p.label });
  }
  return words;
}

function srOnly(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "sr-only";
  span.textContent = text;
  return span;
}

// The rounds that led to the match, ending in a marker instead of repeating
// the matched word, which the headline already shows.
function renderPathList() {
  pathList.innerHTML = "";
  const order = participantOrder(state.path, state.players);
  for (const round of state.path) {
    if (round.matched) continue;
    const li = document.createElement("li");
    const num = document.createElement("span");
    num.className = "path-round";
    num.append(srOnly("Round "), String(round.round));
    const words = document.createElement("span");
    words.className = "path-words";
    for (const w of orderedWords(round, order)) {
      const span = document.createElement("span");
      span.className = "path-word";
      span.append(srOnly(`${w.label}: `), w.word);
      words.appendChild(span);
    }
    li.append(num, words);
    pathList.appendChild(li);
  }
  const last = state.path[state.path.length - 1];
  if (last) {
    const li = document.createElement("li");
    li.className = "matched-row";
    const marker = document.createElement("span");
    marker.className = "path-marker";
    marker.textContent =
      state.path.length === 1 ? "First try" : `Melded in round ${last.round}`;
    li.appendChild(marker);
    pathList.appendChild(li);
  }
}

function renderCountdown() {
  const closing = state.resultsClosing;
  resultsCountdown.hidden = !closing;
  if (!closing) {
    playAgainBtn.textContent = "Play again";
    playAgainBtn.disabled = false;
    return;
  }
  const connected = state.players.filter((p) => p.connected);
  const readyCount = connected.filter((p) =>
    closing.readyIds.includes(p.id),
  ).length;
  const secondsLeft = Math.ceil((closing.deadline - Date.now()) / 1000);
  resultsCountdown.textContent =
    secondsLeft > 0
      ? `Back to the lobby in ${secondsLeft}s · ${readyCount} of ${connected.length} ready`
      : "Returning to lobby…";
  const youReady = Boolean(
    state.you && closing.readyIds.includes(state.you.id),
  );
  playAgainBtn.textContent = youReady ? "Ready ✓" : "I'm ready";
  playAgainBtn.disabled = youReady;
}

let countdownTicker: ReturnType<typeof setInterval> | undefined;

// Ticks only the countdown line, and only while one is on screen.
function syncCountdownTicker() {
  const active = state.screen === "matched" && Boolean(state.resultsClosing);
  if (active && !countdownTicker) {
    countdownTicker = setInterval(renderCountdown, 1000);
  } else if (!active && countdownTicker) {
    clearInterval(countdownTicker);
    countdownTicker = undefined;
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
  state.resultsClosing = undefined;
  clearResultCard();
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
  state.resultsClosing = undefined;
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
      state.resultsClosing = toResultsClosing(message.resultsClosing);
      state.screen = statusToScreen(message.status);
      if (state.screen === "matched") prepareResultCard();
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
        state.resultsClosing = undefined;
        prepareResultCard();
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
      state.resultsClosing = undefined;
      clearResultCard();
      state.screen = "lobby";
      break;
    }
    case "results-closing": {
      state.resultsClosing = toResultsClosing(message);
      break;
    }
  }
  render();
}

function toResultsClosing(
  closing: ResultsClosing | undefined,
): State["resultsClosing"] {
  if (!closing) return undefined;
  return {
    deadline: Date.now() + closing.remainingMs,
    readyIds: closing.readyIds,
  };
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
  const label = displayNameInput.value.trim().slice(0, MAX_LABEL_LENGTH);
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

botPersonaSelect.addEventListener("change", renderBotHint);

addBotForm.addEventListener("submit", (event) => {
  event.preventDefault();
  socket?.send(
    JSON.stringify({ type: "add-bot", persona: botPersonaSelect.value }),
  );
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

// --- Results card ---------------------------------------------------------
//
// Rendered as soon as the results screen shows, because Safari only opens
// the share sheet if navigator.share is called synchronously in the tap
// handler: there's no time to render the image after the tap.

const resultCard: { blob?: Blob; file?: File; pending?: Promise<Blob> } = {};

const canCopyImage =
  typeof ClipboardItem !== "undefined" &&
  typeof navigator.clipboard?.write === "function";

function canShareFile(file: File): boolean {
  return (
    typeof navigator.share === "function" &&
    navigator.canShare?.({ files: [file] }) === true
  );
}

function clearResultCard() {
  resultCard.blob = undefined;
  resultCard.file = undefined;
  resultCard.pending = undefined;
}

function prepareResultCard() {
  clearResultCard();
  const word = state.revealResults[0]?.word ?? "";
  const path = state.path;
  const order = participantOrder(path, state.players);
  // Wait for the web fonts, or the canvas falls back to system fonts.
  const pending = document.fonts.ready.then(() =>
    renderResultCard(word, path, order),
  );
  resultCard.pending = pending;
  pending
    .then((blob) => {
      if (resultCard.pending !== pending) return;
      resultCard.blob = blob;
      const slug = word.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "results";
      resultCard.file = new File([blob], `mindmeld-${slug}.png`, {
        type: "image/png",
      });
      render();
    })
    .catch(() => {
      // Leave the share buttons hidden/disabled; the on-screen results remain.
    });
}

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const SERIF = '"Playfair Display", Georgia, serif';
const MONO = '"DM Mono", ui-monospace, monospace';
const SANS = 'Lato, system-ui, -apple-system, "Segoe UI", sans-serif';

function setFont(
  ctx: CanvasRenderingContext2D,
  size: number,
  family: string,
  weight = 400,
  style = "normal",
) {
  ctx.font = `${style} ${weight} ${size}px ${family}`;
}

// Largest size up to `max` at which `text` fits in `maxWidth`.
function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  max: number,
  min: number,
  family: string,
  weight: number,
): number {
  let size = max;
  setFont(ctx, size, family, weight);
  while (size > min && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    setFont(ctx, size, family, weight);
  }
  return size;
}

function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

// "Melded in round 7" -> "M E L D E D   I N   R O U N D   7", like the
// manual's spaced labels.
function letterSpace(text: string): string {
  return text
    .toUpperCase()
    .split(" ")
    .map((word) => word.split("").join(" "))
    .join("   ");
}

// Greedily packs whole units onto lines no wider than `maxWidth`, never
// splitting a unit. Returns undefined if it needs more than `maxLines`,
// unless `truncate` is set, in which case the last line ends in "…".
function packLines(
  ctx: CanvasRenderingContext2D,
  units: string[],
  sep: string,
  maxWidth: number,
  maxLines: number,
  truncate: boolean,
): string[] | undefined {
  const fitted = units.map((u) => ellipsize(ctx, u, maxWidth));
  const lines: string[] = [];
  let line = "";
  for (const unit of fitted) {
    const candidate = line ? `${line}${sep}${unit}` : unit;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = unit;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  if (!truncate) return undefined;
  const kept = lines.slice(0, maxLines);
  const rest = lines.slice(maxLines - 1).join(sep);
  kept[maxLines - 1] = ellipsize(ctx, rest, maxWidth);
  return kept;
}

const PATH_SEP = "  ·  ";
const PATH_MAX_SIZE = 34;
const PATH_MIN_SIZE = 24;
const ROW_PAD = 12;
const ROW_GAP = 6;
const MARKER_HEIGHT = 64;

type CardRow =
  | { kind: "round"; round: number; lines: string[] }
  | { kind: "more"; count: number };

function rowHeight(row: CardRow, size: number): number {
  const lines = row.kind === "round" ? row.lines.length : 1;
  return lines * Math.round(size * 1.3) + ROW_PAD;
}

function rowsHeight(rows: CardRow[], size: number): number {
  return rows.reduce((sum, row) => sum + rowHeight(row, size) + ROW_GAP, 0);
}

// One font size for the whole list: the largest that fits every round on at
// most two lines. Larger text wins over single lines, since the image is
// usually seen shrunk to phone width. Only at the smallest size do rounds get
// truncated or the middle of the path collapse into "+K more rounds".
function layoutPath(
  ctx: CanvasRenderingContext2D,
  rounds: { round: number; words: string[] }[],
  maxWidth: number,
  budget: number,
): { size: number; rows: CardRow[] } {
  const pack = (size: number, truncate: boolean): CardRow[] | undefined => {
    setFont(ctx, size, SANS, 400);
    const rows: CardRow[] = [];
    for (const r of rounds) {
      const lines = packLines(ctx, r.words, PATH_SEP, maxWidth, 2, truncate);
      if (!lines) return undefined;
      rows.push({ kind: "round", round: r.round, lines });
    }
    return rows;
  };
  for (let size = PATH_MAX_SIZE; size > PATH_MIN_SIZE; size -= 2) {
    const rows = pack(size, false);
    if (rows && rowsHeight(rows, size) <= budget) return { size, rows };
  }
  const size = PATH_MIN_SIZE;
  const rows = pack(size, true) ?? [];
  if (rowsHeight(rows, size) <= budget || rows.length <= 3) {
    return { size, rows };
  }
  // Keep the first rounds and the last two before the match; hide the
  // fewest middle rounds that makes it fit.
  for (let hidden = 1; hidden <= rows.length - 2; hidden++) {
    const head = rows.slice(0, rows.length - 2 - hidden);
    const collapsed: CardRow[] = [
      ...head,
      { kind: "more", count: hidden },
      ...rows.slice(-2),
    ];
    if (rowsHeight(collapsed, size) <= budget) return { size, rows: collapsed };
  }
  return {
    size,
    rows: [{ kind: "more", count: rows.length - 2 }, ...rows.slice(-2)],
  };
}

// Always the light palette, so the image looks the same whatever theme the
// sharer uses.
function renderResultCard(
  word: string,
  path: RoundResult[],
  order: Participant[],
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("no canvas"));

  const ink = "#1a1410";
  const body = "#3a3229";
  const paper = "#f5f0e8";
  const cream = "#ede8dc";
  const rust = "#c1440e";
  const gold = "#b8922a";
  const muted = "#6b6155";
  const faded = "rgba(245,240,232,0.6)";
  const pad = 96;
  const contentWidth = CARD_WIDTH - pad * 2;
  const center = CARD_WIDTH / 2;
  const band = 560;

  // Dark header band, like a printed manual's cover.
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, CARD_WIDTH, band);
  ctx.fillStyle = paper;
  ctx.fillRect(0, band, CARD_WIDTH, CARD_HEIGHT - band);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = gold;
  setFont(ctx, 28, MONO, 500);
  ctx.fillText("M I N D   M E L D", center, 140);

  ctx.fillStyle = faded;
  setFont(ctx, 40, SERIF, 400, "italic");
  ctx.fillText("We melded minds on", center, 250);

  ctx.fillStyle = paper;
  fitFont(ctx, word, contentWidth, 150, 48, SERIF, 700);
  ctx.fillText(ellipsize(ctx, word, contentWidth), center, 400);

  // The names double as the key: every round below lists words in this order.
  const rounds = `${path.length} round${path.length === 1 ? "" : "s"}`;
  const units = [rounds, ...order.map((p) => p.label)];
  ctx.fillStyle = faded;
  setFont(ctx, 32, SANS, 400);
  const oneLine = packLines(ctx, units, " · ", contentWidth, 1, false);
  if (oneLine) {
    ctx.fillText(oneLine[0], center, 480);
  } else {
    setFont(ctx, 30, SANS, 400);
    const lines = packLines(ctx, units, " · ", contentWidth, 2, true) ?? [];
    lines.forEach((line, i) => {
      ctx.fillText(line, center, 462 + i * 42);
    });
  }

  const last = path[path.length - 1];
  const drawMarker = (text: string, y: number, centered: boolean) => {
    ctx.fillStyle = cream;
    ctx.fillRect(pad, y, contentWidth, MARKER_HEIGHT);
    ctx.fillStyle = gold;
    ctx.fillRect(pad, y, 6, MARKER_HEIGHT);
    ctx.fillStyle = rust;
    setFont(ctx, 26, MONO, 500);
    ctx.textBaseline = "middle";
    ctx.textAlign = centered ? "center" : "left";
    ctx.fillText(text, centered ? center : pad + 32, y + MARKER_HEIGHT / 2);
    ctx.textBaseline = "alphabetic";
  };

  const bottom = CARD_HEIGHT - 135;
  if (path.length <= 1) {
    // Matched on the first round: no path to show.
    drawMarker(
      letterSpace("First try"),
      (band + bottom - MARKER_HEIGHT) / 2,
      true,
    );
  } else {
    ctx.fillStyle = rust;
    setFont(ctx, 26, MONO, 500);
    ctx.textAlign = "center";
    ctx.fillText("T H E   P A T H", center, band + 80);

    const top = band + 115;
    const textX = pad + 100;
    const textWidth = contentWidth - 140;
    const before = path
      .filter((r) => !r.matched)
      .map((r) => ({
        round: r.round,
        words: orderedWords(r, order).map((w) => w.word),
      }));
    const { size, rows } = layoutPath(
      ctx,
      before,
      textWidth,
      bottom - top - MARKER_HEIGHT,
    );
    const lineHeight = Math.round(size * 1.3);
    let y = top;
    ctx.textAlign = "left";
    for (const row of rows) {
      // First baseline sits ROW_PAD/2 below the row top, plus one line's ascent.
      const baseline = y + ROW_PAD / 2 + size;
      if (row.kind === "round") {
        ctx.fillStyle = muted;
        setFont(ctx, Math.round(size * 0.8), MONO, 400);
        ctx.fillText(String(row.round), pad + 32, baseline);
        ctx.fillStyle = body;
        setFont(ctx, size, SANS, 400);
        row.lines.forEach((line, i) => {
          ctx.fillText(line, textX, baseline + i * lineHeight);
        });
      } else {
        ctx.fillStyle = muted;
        setFont(ctx, size, SERIF, 400, "italic");
        ctx.fillText(
          `+${row.count} more round${row.count === 1 ? "" : "s"}`,
          textX,
          baseline,
        );
      }
      y += rowHeight(row, size) + ROW_GAP;
    }
    drawMarker(
      letterSpace(`Melded in round ${last?.round ?? path.length}`),
      y,
      false,
    );
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = muted;
  setFont(ctx, 30, SERIF, 400, "italic");
  ctx.fillText("mindmeld-game.com", center, CARD_HEIGHT - 80);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}

function showShareHint(text: string) {
  shareHint.textContent = text;
  flashHint(shareHint, 2500);
}

function downloadResultCard() {
  const { blob, file } = resultCard;
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file?.name ?? "mindmeld-results.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

shareResultsBtn.addEventListener("click", () => {
  const file = resultCard.file;
  if (!file) return;
  // Image only: a text or URL alongside it becomes extra bubbles in SMS.
  // Called synchronously, without awaiting anything first (see above).
  navigator.share({ files: [file] }).catch((err) => {
    if (err instanceof DOMException && err.name === "AbortError") return;
    showShareHint("Couldn't open sharing. Try Download image instead.");
  });
});

copyImageBtn.addEventListener("click", () => {
  const pending = resultCard.pending;
  if (!pending) return;
  // Pass the promise straight to ClipboardItem: Safari rejects a clipboard
  // write that starts after an await.
  navigator.clipboard
    .write([new ClipboardItem({ "image/png": pending })])
    .then(() => showShareHint("Image copied"))
    .catch(() => showShareHint("Couldn't copy. Try Download image instead."));
});

downloadResultsBtn.addEventListener("click", downloadResultCard);

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
