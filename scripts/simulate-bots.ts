// Offline bot-vs-bot games, for tuning the personas in src/bots.ts. Runs the
// same round loop as the server (history, used words, isMatch), then writes
// a report you can read: who played what in every round, why, and the
// candidates each bot was choosing between.
//
//   node scripts/simulate-bots.ts --personas bridge,categorizer,wildcard --games 5
//   node scripts/simulate-bots.ts --personas "categorizer,categorizer,categorizer;wildcard,stubborn,specifier"
//
// Separate lineups with ";". Output goes to sim-results/<time>[-label]/
// (report.md and results.json). Needs ANTHROPIC_API_KEY; without it bots
// play the built-in fallback words, which only checks the loop itself.
//
// --engine <path> runs another copy of bots.ts (for before/after
// comparisons); --no-judge skips the Haiku calls that label each move.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { BotCandidate, BotUsage, Move } from "../src/bots.ts";
import * as current from "../src/bots.ts";
import { isBotPersonaId, isMatch, type RoundResult } from "../src/shared.ts";

const JUDGE_MODEL = "claude-haiku-5-5";
// Targets for rounds-to-match, from how human games tend to go.
const TARGET_ROUNDS: [number, number] = [3, 6];

const { values } = parseArgs({
  allowNegative: true,
  options: {
    personas: { type: "string", default: "bridge,categorizer,specifier" },
    games: { type: "string", default: "3" },
    "max-rounds": { type: "string", default: "12" },
    engine: { type: "string" },
    judge: { type: "boolean", default: true },
    label: { type: "string" },
    out: { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});

type Engine = Pick<
  typeof current,
  "BOT_MODEL" | "BOT_PERSONAS" | "chooseBotWord"
>;
const engine: Engine = values.engine
  ? await import(pathToFileURL(resolve(values.engine)).href)
  : current;

const games = Number(values.games);
const maxRounds = Number(values["max-rounds"]);
const lineups = values.personas.split(";").map((lineup) =>
  lineup.split(",").map((raw) => {
    const id = raw.trim();
    if (!isBotPersonaId(id)) {
      console.error(
        `Unknown persona "${id}". Choose from: ${Object.keys(current.BOT_PERSONAS).join(", ")}`,
      );
      process.exit(1);
    }
    return id;
  }),
);
for (const lineup of lineups) {
  if (lineup.length < 2 || lineup.length > 6) {
    console.error("Each lineup needs 2–6 bots.");
    process.exit(1);
  }
}

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : undefined;
const judging = Boolean(client) && values.judge;
const maxCalls = lineups.reduce(
  (sum, lineup) => sum + lineup.length * games * maxRounds,
  0,
);
console.log(
  client
    ? `Model ${engine.BOT_MODEL}${values.engine ? ` (engine ${values.engine})` : ""}. At most ~${maxCalls} bot calls (up to 2x with retries)${
        judging
          ? ` and ~${lineups.length * games * maxRounds} ${JUDGE_MODEL} judge calls`
          : ""
      }; most games end sooner.`
    : "ANTHROPIC_API_KEY is not set: bots will use fallback words, no API calls.",
);

interface PlayedMove {
  botId: string;
  label: string;
  persona: string;
  word: string;
  why: string;
  // The move the bot's own candidate list tagged it with.
  selfMove?: Move;
  // The move the judge saw.
  judgedMove?: Move;
  source: "model" | "fallback";
  candidates: BotCandidate[];
}

interface Round {
  round: number;
  matched: boolean;
  moves: PlayedMove[];
}

interface Game {
  lineup: string;
  game: number;
  bots: { id: string; label: string; persona: string }[];
  rounds: Round[];
  matchedRound?: number;
  usage: BotUsage[];
  judgeUsage: BotUsage[];
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          player: { type: "string" },
          move: { type: "string", enum: [...current.MOVES] },
        },
        required: ["player", "move"],
        additionalProperties: false,
      },
    },
  },
  required: ["labels"],
  additionalProperties: false,
};

const JUDGE_SYSTEM = `You label moves in Mind Meld, a word game where players try to converge on the same word. Each round, every player looks at the previous round's words and plays a new word. For each player's new word, pick the one label that fits best:
${current.MOVES.map((m) => `- ${m}: ${current.MOVE_DESCRIPTIONS[m]}`).join("\n")}

Judge only from the words. Be strict about two labels:
- anchor: only when the new word is clearly closer to the player's own previous word than to the other players' words (a synonym, variant, part or sub-type of their own word) and doesn't really connect the others. A word that connects all of the previous words is not anchor, even if it also relates to the player's own word.
- drop-outlier: only when the new word plainly connects most of the previous words but not one of them. Name that left-out word to yourself before choosing this label.
If two labels fit, prefer them in this order: wordplay, specific, category, drop-outlier, link, anchor.`;

// One Haiku call labels every move in a round.
async function judgeRound(
  previous: RoundResult,
  round: Round,
  usage: BotUsage[],
): Promise<void> {
  if (!client) return;
  const ids = round.moves.map((_, i) => `P${i + 1}`);
  const lines = [
    `Previous round's words (all players): ${previous.words.map((w) => w.word).join(", ")}`,
    "",
    "New words:",
    ...round.moves.map((m, i) => {
      const own = previous.words.find((w) => w.playerId === m.botId)?.word;
      return `${ids[i]}: "${m.word}" (their own previous word was "${own}")`;
    }),
  ];
  try {
    const response = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 2000,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: JUDGE_SCHEMA },
      },
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: lines.join("\n") }],
    });
    usage.push({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    });
    if (response.stop_reason !== "end_turn") return;
    const text = response.content.find((b) => b.type === "text");
    if (text?.type !== "text") return;
    const { labels } = JSON.parse(text.text) as {
      labels: { player: string; move: Move }[];
    };
    for (const l of labels) {
      const move = round.moves[ids.indexOf(l.player)];
      if (move) move.judgedMove = l.move;
    }
  } catch (err) {
    console.warn("judge failed", err instanceof Error ? err.message : err);
  }
}

async function playGame(lineup: string[], n: number): Promise<Game> {
  const bots = lineup.map((persona, i) => ({
    id: `${persona}-${i + 1}`,
    label: `${current.BOT_PERSONAS[persona as keyof typeof current.BOT_PERSONAS].label.replace(/^The /, "")} #${i + 1}`,
    persona,
  }));
  const game: Game = {
    lineup: lineup.join(","),
    game: n,
    bots,
    rounds: [],
    usage: [],
    judgeUsage: [],
  };
  const history: RoundResult[] = [];
  const usedWords = new Set<string>();
  const judgeCalls: Promise<void>[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const choices = await Promise.all(
      bots.map((bot) =>
        engine.chooseBotWord(
          client,
          engine.BOT_PERSONAS[bot.persona as keyof Engine["BOT_PERSONAS"]],
          {
            round,
            history: [...history],
            selfId: bot.id,
            usedWords: new Set(usedWords),
          },
        ),
      ),
    );
    // An API error (no credit, bad key, outage) would turn the rest of the
    // run into fallback-word games that look like instant matches. Stop.
    const apiError = choices.find(
      (c) => c.source === "fallback" && /API error/.test(c.why),
    );
    if (client && apiError) {
      throw new Error(
        `Stopping: bot call failed with ${apiError.why}. Results so far are not written.`,
      );
    }
    const words = choices.map((c, i) => ({
      playerId: bots[i].id,
      label: bots[i].label,
      word: c.word,
    }));
    const matched = isMatch(words.map((w) => w.word));
    const r: Round = {
      round,
      matched,
      moves: choices.map((c, i) => ({
        botId: bots[i].id,
        label: bots[i].label,
        persona: bots[i].persona,
        word: c.word,
        why: c.why,
        selfMove: "move" in c ? c.move : undefined,
        source: c.source,
        candidates: "candidates" in c ? c.candidates : [],
      })),
    };
    game.rounds.push(r);
    for (const c of choices) game.usage.push(...c.usage);
    if (judging && history.length > 0) {
      judgeCalls.push(
        judgeRound(history[history.length - 1], r, game.judgeUsage),
      );
    }
    history.push({ round, words, matched });
    for (const w of words) usedWords.add(w.word.toLowerCase());

    if (!values.quiet) {
      console.log(`  Round ${round}${matched ? "  ✓ MATCH" : ""}`);
      for (const m of r.moves) {
        console.log(
          `    ${m.label.padEnd(18)} ${m.word.padEnd(18)} ${m.selfMove ?? ""}`,
        );
      }
    }
    if (matched) {
      game.matchedRound = round;
      break;
    }
  }
  await Promise.all(judgeCalls);
  return game;
}

// --- metrics ---------------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const pct = (n: number, d: number) =>
  d ? `${Math.round((100 * n) / d)}%` : "n/a";

interface Summary {
  lineup: string;
  games: number;
  matched: number;
  roundsToMatch: number[];
  inTarget: number;
  round2Matches: number;
  // Distinct words ÷ players, averaged over rounds 2+ that didn't match.
  spread: number | undefined;
  adherence: {
    persona: string;
    preferred: Move[];
    judged: [number, number];
    selfTagged: [number, number];
  }[];
  calls: number;
  fallbacks: number;
  judgeCalls: number;
  perCall: BotUsage;
}

function summarize(lineup: string, results: Game[]): Summary {
  const rounds = results
    .map((g) => g.matchedRound)
    .filter((r): r is number => r !== undefined);
  const spreads = results.flatMap((g) =>
    g.rounds
      .filter((r) => r.round > 1 && !r.matched)
      .map(
        (r) =>
          new Set(r.moves.map((m) => m.word.toLowerCase())).size /
          r.moves.length,
      ),
  );
  const personas = [...new Set(lineup.split(","))];
  const adherence = personas.map((persona) => {
    const preferred = current.preferredMoves(
      current.BOT_PERSONAS[persona as keyof typeof current.BOT_PERSONAS],
    );
    const moves = results.flatMap((g) =>
      g.rounds
        .filter((r) => r.round > 1)
        .flatMap((r) => r.moves.filter((m) => m.persona === persona)),
    );
    const judged = moves.filter((m) => m.judgedMove);
    const tagged = moves.filter((m) => m.selfMove);
    return {
      persona,
      preferred,
      judged: [
        judged.filter((m) => preferred.includes(m.judgedMove as Move)).length,
        judged.length,
      ] as [number, number],
      selfTagged: [
        tagged.filter((m) => preferred.includes(m.selfMove as Move)).length,
        tagged.length,
      ] as [number, number],
    };
  });
  const usage = results.flatMap((g) => g.usage);
  const calls = usage.length;
  const avg = (k: keyof BotUsage) =>
    calls ? Math.round(usage.reduce((s, u) => s + u[k], 0) / calls) : 0;
  return {
    lineup,
    games: results.length,
    matched: rounds.length,
    roundsToMatch: rounds,
    inTarget: rounds.filter(
      (r) => r >= TARGET_ROUNDS[0] && r <= TARGET_ROUNDS[1],
    ).length,
    round2Matches: rounds.filter((r) => r <= 2).length,
    spread: spreads.length
      ? spreads.reduce((a, b) => a + b, 0) / spreads.length
      : undefined,
    adherence,
    calls,
    fallbacks: results.reduce(
      (s, g) =>
        s +
        g.rounds.reduce(
          (t, r) => t + r.moves.filter((m) => m.source === "fallback").length,
          0,
        ),
      0,
    ),
    judgeCalls: results.reduce((s, g) => s + g.judgeUsage.length, 0),
    perCall: {
      inputTokens: avg("inputTokens"),
      outputTokens: avg("outputTokens"),
      cacheReadTokens: avg("cacheReadTokens"),
      cacheWriteTokens: avg("cacheWriteTokens"),
    },
  };
}

function summaryLines(s: Summary): string[] {
  const r = s.roundsToMatch;
  return [
    `- Matched: ${s.matched}/${s.games} games` +
      (r.length
        ? ` · rounds to match ${r.join(", ")} (mean ${(r.reduce((a, b) => a + b, 0) / r.length).toFixed(1)}, median ${median(r)})`
        : ""),
    `- Within the ${TARGET_ROUNDS[0]}–${TARGET_ROUNDS[1]} round target: ${s.inTarget}/${s.games} · matched by round 2: ${s.round2Matches}/${s.games}`,
    `- Spread (distinct words ÷ players, unmatched rounds 2+): ${s.spread === undefined ? "n/a" : s.spread.toFixed(2)}`,
    ...s.adherence.map((a) =>
      a.preferred.length
        ? `- ${a.persona} in character (${a.preferred.join("/")}), rounds 2+: judge ${a.judged[0]}/${a.judged[1]} (${pct(...a.judged)})` +
          (a.selfTagged[1]
            ? ` · self-tagged ${a.selfTagged[0]}/${a.selfTagged[1]} (${pct(...a.selfTagged)})`
            : "")
        : `- ${a.persona}: no single style to measure`,
    ),
    `- ${s.calls} bot calls, ${s.fallbacks} fallback words, ${s.judgeCalls} judge calls · per bot call: ${s.perCall.inputTokens} input, ${s.perCall.outputTokens} output, ${s.perCall.cacheReadTokens} cache read, ${s.perCall.cacheWriteTokens} cache write tokens`,
  ];
}

// --- report ----------------------------------------------------------------

// Escapes backslashes first, so a word ending in "\" can't swallow the
// escaping of a following "|".
const cell = (text: string) =>
  text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

function gameMarkdown(g: Game): string {
  const out: string[] = [
    `### ${g.lineup} · game ${g.game} · ${
      g.matchedRound ? `matched in round ${g.matchedRound}` : "no match"
    }`,
    "",
    `| Round | ${g.bots.map((b) => cell(b.label)).join(" | ")} |`,
    `|---|${g.bots.map(() => "---").join("|")}|`,
  ];
  for (const r of g.rounds) {
    const cells = r.moves.map((m) => {
      const tags = [
        m.selfMove && m.selfMove !== "free" ? m.selfMove : "",
        m.judgedMove && m.judgedMove !== m.selfMove
          ? `judge: ${m.judgedMove}`
          : "",
        m.source === "fallback" ? "fallback" : "",
      ].filter(Boolean);
      return `**${cell(m.word)}**${tags.length ? `<br>_${tags.join(" · ")}_` : ""}`;
    });
    out.push(`| ${r.round}${r.matched ? " ✓" : ""} | ${cells.join(" | ")} |`);
  }
  out.push("", "<details><summary>Reasoning and candidates</summary>", "");
  for (const r of g.rounds) {
    out.push(`**Round ${r.round}**`, "");
    for (const m of r.moves) {
      out.push(`- **${m.label}** played **${m.word}**: ${m.why}`);
      if (m.candidates.length) {
        const list = m.candidates
          .map((c) => {
            const name = `${c.word} (${c.move}, ${c.obviousness})`;
            return c.word.toLowerCase() === m.word.toLowerCase()
              ? `**${name}**`
              : name;
          })
          .join(", ");
        out.push(`  - candidates: ${list}`);
      }
    }
    out.push("");
  }
  out.push("</details>", "");
  return out.join("\n");
}

const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir =
  values.out ??
  join("sim-results", values.label ? `${stamp}-${values.label}` : stamp);

const allGames: Game[] = [];
const summaries: Summary[] = [];
for (const lineup of lineups) {
  const name = lineup.join(",");
  const results: Game[] = [];
  for (let n = 1; n <= games; n++) {
    if (!values.quiet) console.log(`\n[${name}] game ${n}/${games}`);
    results.push(await playGame(lineup, n));
  }
  allGames.push(...results);
  summaries.push(summarize(name, results));
}

const report = [
  `# Bot simulation ${values.label ?? ""}`.trim(),
  "",
  `${started.toISOString()} · engine ${values.engine ?? "src/bots.ts"} · ${games} games per lineup · max ${maxRounds} rounds${
    judging ? ` · judge ${JUDGE_MODEL}` : " · no judge"
  }`,
  "",
  "Cells show the word played, the kind of move the bot said it was making, and the judge's label when it disagrees. ✓ marks the matching round.",
  "",
  "## Summary",
  "",
  ...summaries.flatMap((s) => [`### ${s.lineup}`, "", ...summaryLines(s), ""]),
  "## Games",
  "",
  ...allGames.map(gameMarkdown),
].join("\n");

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "report.md"), report);
await writeFile(
  join(outDir, "results.json"),
  JSON.stringify(
    { engine: values.engine, summaries, games: allGames },
    null,
    2,
  ),
);

console.log(`\n=== Summary (max ${maxRounds} rounds) ===`);
for (const s of summaries) {
  console.log(`\n${s.lineup}`);
  for (const line of summaryLines(s)) console.log(`  ${line.slice(2)}`);
}
console.log(`\nReport: ${join(outDir, "report.md")}`);
