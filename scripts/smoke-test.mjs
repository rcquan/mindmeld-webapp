// Headless smoke test: starts `wrangler dev` and plays a 2-player game over
// WebSockets. Covers the core of the /verify skill; UI, play-again, room-full
// and disconnect handling are still checked by hand.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PartySocket from "partysocket";

const PORT = 8799;
const HOST = `127.0.0.1:${PORT}`;
const STARTUP_TIMEOUT_MS = 60_000;
const MESSAGE_TIMEOUT_MS = 5_000;

const sockets = [];
let output = "";

function startServer(persistDir) {
  const child = spawn(
    "node_modules/.bin/wrangler",
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--inspector-port",
      "9239",
      "--persist-to",
      persistDir,
    ],
    {
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    output += d;
  });
  return child;
}

async function waitForServer(child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://${HOST}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start in time");
}

async function createRoom() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const res = await fetch(`http://${HOST}/parties/main/${code}`, {
      method: "POST",
    });
    const info = await res.json();
    if (info.created) return code;
  }
  throw new Error("could not create a room after 5 attempts");
}

// Every message is queued from the moment the socket exists, so waitFor
// can't miss one that arrived before it was called.
function connect(room, id, label, options = {}) {
  const ws = new PartySocket({
    host: HOST,
    room,
    id,
    query: { label },
    ...options,
  });
  ws.queue = [];
  ws.waiters = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    ws.queue.push(msg);
    for (const w of [...ws.waiters]) w();
  });
  sockets.push(ws);
  return ws;
}

function waitFor(ws, type, pred = () => true, ms = MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const i = ws.queue.findIndex((m) => m.type === type && pred(m));
      if (i === -1) return false;
      const [msg] = ws.queue.splice(i, 1);
      ws.waiters = ws.waiters.filter((w) => w !== check);
      clearTimeout(timer);
      resolve(msg);
      return true;
    };
    const timer = setTimeout(() => {
      ws.waiters = ws.waiters.filter((w) => w !== check);
      const seen = ws.queue.map((m) => m.type).join(", ") || "nothing";
      reject(
        new Error(`${ws.id}: timed out waiting for "${type}" (queue: ${seen})`),
      );
    }, ms);
    if (!check()) ws.waiters.push(check);
  });
}

function send(ws, message) {
  ws.send(JSON.stringify(message));
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function step(name) {
  console.log(`✓ ${name}`);
}

async function playRound(a, b, wordA, wordB, expectMatch) {
  send(a, { type: "submit-word", word: wordA });
  await waitFor(b, "submission-progress", (m) => m.submittedCount === 1);
  send(b, { type: "submit-word", word: wordB });
  const [ra, rb] = await Promise.all([
    waitFor(a, "round-revealed"),
    waitFor(b, "round-revealed"),
  ]);
  assert(ra.matched === expectMatch, `A sees matched=${expectMatch}`);
  assert(rb.matched === expectMatch, `B sees matched=${expectMatch}`);
  assert(ra.results.length === 2, "reveal includes both words");
}

// One human plus a bot. CI has no ANTHROPIC_API_KEY, so the bot plays the
// built-in fallback words after its think delay (Stubborn One: 1.5–4s).
async function runBotGame() {
  const BOT_TIMEOUT_MS = 15_000;
  const room = await createRoom();
  const h = connect(room, "smoke-human", "Hana");
  await waitFor(h, "joined");

  send(h, { type: "add-bot", persona: "not-a-persona" });
  send(h, { type: "add-bot", persona: "stubborn" });
  const added = await waitFor(h, "players-update", (m) =>
    m.players.some((p) => p.bot),
  );
  assert(added.players.length === 2, "only the valid persona adds a bot");
  const bot = added.players.find((p) => p.bot);
  assert(bot.bot.persona === "stubborn", "bot has its persona");
  step("bot added");

  // Three bots is the cap (MAX_BOTS): the fourth add is ignored, so removing
  // the two extras brings the room back to 2 players, not 3.
  send(h, { type: "add-bot", persona: "categorizer" });
  send(h, { type: "add-bot", persona: "wildcard" });
  const capped = await waitFor(
    h,
    "players-update",
    (m) => m.players.length === 4,
  );
  send(h, { type: "add-bot", persona: "follower" });
  for (const extra of capped.players.filter((p) => p.bot && p.id !== bot.id)) {
    send(h, { type: "remove-bot", playerId: extra.id });
  }
  await waitFor(h, "players-update", (m) => m.players.length === 2);
  step("bots capped at 3 and removed");

  // Only the host (earliest-joined human) manages bots, and nobody can
  // connect with a bot's id.
  const g = connect(room, "smoke-guest", "Gus");
  await waitFor(g, "joined");
  await waitFor(h, "players-update", (m) => m.players.length === 3);
  send(g, { type: "add-bot", persona: "wildcard" });
  send(g, { type: "remove-bot", playerId: bot.id });
  // A socket using the bot's id: its messages are ignored, and closing it
  // doesn't mark the bot disconnected.
  const impostor = connect(room, bot.id, "Impostor", { maxRetries: 0 });
  await new Promise((r) => impostor.addEventListener("open", r));
  send(impostor, { type: "set-label", label: "Hijacked" });
  impostor.close();
  g.close();
  const afterGuest = await waitFor(h, "players-update", (m) =>
    m.players.some((p) => p.id === "smoke-guest" && !p.connected),
  );
  const botNow = afterGuest.players.find((p) => p.id === bot.id);
  assert(botNow.connected, "bot is still connected after the impostor left");
  assert(botNow.label !== "Hijacked", "impostor couldn't rename the bot");
  assert(
    !h.queue.some((m) => m.type === "players-update" && m.players.length !== 3),
    "guest's add-bot and remove-bot were ignored",
  );
  step("only the host manages bots; bot ids are ignored");

  send(h, { type: "start-game" });
  await waitFor(h, "round-start");
  send(h, { type: "submit-word", word: "zebra" });
  const reveal = await waitFor(h, "round-revealed", () => true, BOT_TIMEOUT_MS);
  assert(reveal.results.length === 2, "reveal includes the bot's word");
  const botWord = reveal.results.find((r) => r.playerId === bot.id)?.word;
  assert(botWord && botWord !== "zebra", "bot submitted a word");
  step(`bot played "${botWord}"`);
  h.close();
}

async function run() {
  const room = await createRoom();
  step(`created room ${room}`);

  const a = connect(room, "smoke-a", "Alice");
  const joinedA = await waitFor(a, "joined");
  assert(joinedA.status === "lobby", "room starts in lobby");

  const b = connect(room, "smoke-b", "Bob");
  const joinedB = await waitFor(b, "joined");
  assert(joinedB.players.length === 2, "B's joined message lists 2 players");
  await waitFor(a, "players-update", (m) => m.players.length === 2);
  step("two players joined");

  send(a, { type: "start-game" });
  await Promise.all([waitFor(a, "round-start"), waitFor(b, "round-start")]);
  step("game started");

  // Malformed input must be ignored without crashing the Durable Object
  // (an uncaught error would show up in the wrangler output check).
  send(a, { type: "submit-word", word: 123 });
  send(a, { type: "set-label", label: null });
  send(a, { type: "submit-word", word: "x".repeat(200_000) });
  const rejected = await waitFor(a, "word-rejected");
  assert(/at most 40/.test(rejected.message), "oversized word is rejected");
  step("malformed and oversized input rejected");

  await playRound(a, b, "apple", "banana", false);
  step("round 1 revealed without a match");

  send(a, { type: "next-round" });
  await Promise.all([
    waitFor(a, "round-start", (m) => m.round === 2),
    waitFor(b, "round-start", (m) => m.round === 2),
  ]);
  await playRound(a, b, "cherry", "cherry", true);
  step("round 2 matched");

  const late = connect(room, "smoke-late", "Late", { maxRetries: 0 });
  const lateErr = await waitFor(late, "error");
  assert(lateErr.code === "already-started", "late joiner is rejected");
  step("late joiner gets already-started");

  await runBotGame();

  const ghost = connect("000000", "smoke-ghost", "Ghost", { maxRetries: 0 });
  const ghostErr = await waitFor(ghost, "error");
  assert(ghostErr.code === "not-found", "uncreated room is not-found");
  step("uncreated room gets not-found");
}

const persistDir = await mkdtemp(join(tmpdir(), "mindmeld-smoke-"));
const child = startServer(persistDir);
let failed = false;
try {
  await waitForServer(child);
  step("wrangler dev is up");
  await run();
  // Give the server a moment to flush any late error logs.
  await new Promise((r) => setTimeout(r, 500));
  if (/Uncaught|✘ \[ERROR\]/.test(output)) {
    throw new Error("wrangler dev logged an error during the test");
  }
  console.log("\nSmoke test passed.");
} catch (err) {
  failed = true;
  console.error(`\nSmoke test failed: ${err.message}`);
  console.error(`\n--- wrangler dev output ---\n${output}`);
} finally {
  for (const ws of sockets) ws.close();
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await rm(persistDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
