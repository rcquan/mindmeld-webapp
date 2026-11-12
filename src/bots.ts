// Bot players. Each round the model lists a few candidate words, each tagged
// with the kind of move it is; code then picks one, weighted by the persona.
// That keeps personas distinct after round 1, and keeps identical bots from
// all landing on the model's single most likely word.
//
// Used by the MindMeld Durable Object and by scripts/simulate-bots.ts, so it
// must not import any Worker or DO code. Imports use the `.ts` extension so
// Node can run this file directly.
import Anthropic from "@anthropic-ai/sdk";
import {
  BOT_PERSONA_OPTIONS,
  type BotPersonaId,
  MAX_WORD_LENGTH,
  type RoundResult,
} from "./shared.ts";

export const BOT_MODEL = "claude-sonnet-5-5";

// After this many rounds a game's bots stop calling the model and play the
// free fallback words, so a long or abandoned game can't run up the bill.
export const MAX_MODEL_ROUNDS = 20;

// The kinds of move a player can make after round 1. "free" is round 1.
export const MOVES = [
  "category",
  "specific",
  "link",
  "wordplay",
  "anchor",
  "drop-outlier",
] as const;
export type Move = (typeof MOVES)[number] | "free";

export const MOVE_DESCRIPTIONS: Record<(typeof MOVES)[number], string> = {
  category: "names the category or concept the words share",
  specific:
    "one specific, concrete member or example that fits the words (not the category name)",
  link: "an everyday word associated with all the words, that is neither their category nor a member of it",
  wordplay: "a pun, rhyme, set phrase, title or pop-culture reference",
  anchor: "stays close to your own previous word, bending only a little",
  "drop-outlier":
    "ignores the word that fits least and connects the remaining ones",
};

export interface BotKnobs {
  // -2 itemize (a specific member) … +2 abstract (the shared category).
  abstraction: -2 | -1 | 0 | 1 | 2;
  focus: "all" | "ignore-outlier" | "anchor-self" | "follow-majority";
  // 0 literal … 2 puns, phrases and pop-culture links.
  looseness: 0 | 1 | 2;
  vocabulary: "common" | "varied";
  // 0 … 1: how strongly the bot goes for the most obvious candidate rather
  // than a less obvious one. Lower means less agreeable tables.
  conformity: number;
  // Chance of playing a near-variant (plural/singular) of the chosen word,
  // the way people miss an exact match by one letter.
  sloppiness: number;
  // How long the bot takes to "think" in a real room, in ms.
  thinkMs: [number, number];
}

export interface BotPersona {
  id: BotPersonaId;
  label: string;
  description: string;
  knobs: BotKnobs;
  // Said to the bot every round after round 1, so the persona doesn't fade.
  belief: string;
  move: string;
  // A mid-game example of this persona's thinking.
  example: string;
}

interface PersonaSpec {
  knobs: BotKnobs;
  belief: string;
  move: string;
  example: string;
}

const EXAMPLE_HISTORY = `Round 1: apple, guitar (yours), ocean
Round 2: wave, strings (yours), tree`;

const SPECS: Record<BotPersonaId, PersonaSpec> = {
  bridge: {
    knobs: {
      abstraction: 0,
      focus: "all",
      looseness: 0,
      vocabulary: "common",
      conformity: 0.85,
      sloppiness: 0.05,
      thinkMs: [2500, 6000],
    },
    belief:
      "You believe the group gets there fastest when everyone says the single most obvious word linking all of the words.",
    move: "Find the true midpoint: the one word an ordinary person would connect with every word from last round.",
    example: `${EXAMPLE_HISTORY}\nYou'd play: "music" (strings and wave both lead there, and a tree of guitars is a stretch)`,
  },
  categorizer: {
    knobs: {
      abstraction: 2,
      focus: "all",
      looseness: 0,
      vocabulary: "common",
      conformity: 0.5,
      sloppiness: 0.05,
      thinkMs: [2000, 5000],
    },
    belief:
      "You believe the group gets there fastest when everyone names the category the words belong to, so you always zoom out.",
    move: "Name the category or concept that last round's words belong to. Your answer should be a category name, not an example of one.",
    example: `${EXAMPLE_HISTORY}\nYou'd play: "nature" (wave and tree are both nature, and strings are the odd one in)`,
  },
  specifier: {
    knobs: {
      abstraction: -2,
      focus: "all",
      looseness: 0,
      vocabulary: "varied",
      conformity: 0.4,
      sloppiness: 0.1,
      thinkMs: [3000, 7000],
    },
    belief:
      "You believe categories are too vague to meet on, so you always pick one concrete, specific thing that fits all the words.",
    move: "Pick one specific, concrete thing (an object, place, person, brand or title) that fits all of last round's words. Never the category name.",
    example: `${EXAMPLE_HISTORY}\nYou'd play: "harp" (it has strings, it's made of wood from a tree, and its sound comes in waves)`,
  },
  stubborn: {
    knobs: {
      abstraction: 0,
      focus: "anchor-self",
      looseness: 0,
      vocabulary: "common",
      conformity: 0.5,
      sloppiness: 0.1,
      thinkMs: [1500, 4000],
    },
    belief:
      "You believe your own last word was a good meeting point and the others should come toward you.",
    move: "Stay close to your own previous word. Bend toward the others only as much as you have to.",
    example: `${EXAMPLE_HISTORY}\nYou'd play: "acoustic" (stays right next to your strings, and only nods to wave and tree)`,
  },
  follower: {
    knobs: {
      abstraction: 0,
      focus: "follow-majority",
      looseness: 0,
      vocabulary: "common",
      conformity: 0.9,
      sloppiness: 0.1,
      thinkMs: [4000, 8000],
    },
    belief:
      "You believe the fastest way to agree is to go with what most of the words already share and ignore whoever is off on their own.",
    move: "Find the word that fits least with the others, ignore it, and connect the rest.",
    example: `${EXAMPLE_HISTORY}\nYou'd play: "beach" (drop strings, the odd one out; wave and tree meet at the beach)`,
  },
  wildcard: {
    knobs: {
      abstraction: 1,
      focus: "all",
      looseness: 2,
      vocabulary: "varied",
      conformity: 0.2,
      sloppiness: 0.15,
      thinkMs: [2000, 6000],
    },
    belief:
      "You believe the best links are the clever ones, and that the others will see the joke too.",
    move: "Connect last round's words with a pun, rhyme, set phrase, title or pop-culture reference.",
    example: `${EXAMPLE_HISTORY}\nYou'd play: "Surfin' USA" (wave plus strings: surf rock)`,
  },
};

export const BOT_PERSONAS: Record<BotPersonaId, BotPersona> =
  Object.fromEntries(
    BOT_PERSONA_OPTIONS.map((o) => [
      o.id,
      {
        id: o.id,
        label: o.label,
        description: o.description,
        ...SPECS[o.id],
      },
    ]),
  ) as Record<BotPersonaId, BotPersona>;

// How much each kind of move appeals to a persona, from its knobs.
export function moveWeights(
  knobs: BotKnobs,
): Record<(typeof MOVES)[number], number> {
  const a = knobs.abstraction;
  return {
    category: a > 0 ? 1 + 2 * a : a < 0 ? 0.2 : 1,
    specific: a < 0 ? 1 - 2 * a : a > 0 ? 0.2 : 1,
    link: knobs.looseness === 2 ? 0.7 : 1.5,
    wordplay: [0.1, 0.7, 5][knobs.looseness],
    anchor: knobs.focus === "anchor-self" ? 5 : 0.2,
    "drop-outlier":
      knobs.focus === "follow-majority" || knobs.focus === "ignore-outlier"
        ? 5
        : 0.5,
  };
}

// The move that defines a persona (its top weight, if that's at least 3),
// for measuring whether it stays in character. Empty for The Bridge, which
// has no single style.
export function preferredMoves(persona: BotPersona): Move[] {
  const w = moveWeights(persona.knobs);
  const top = Math.max(...MOVES.map((m) => w[m]));
  return top >= 3 ? MOVES.filter((m) => w[m] === top) : [];
}

// Whether two words are the same up to case and a plural ending, using the
// same rules as nearVariant plus plain "-s"/"-es" ("bus"/"buses").
function sameWordish(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return (
    nearVariant(x) === y ||
    nearVariant(y) === x ||
    long === `${short}s` ||
    long === `${short}es`
  );
}

// Groups last round's words that are the same up to case and plural, and
// returns the biggest group, so "landscaping" and "Landscaping" or "star"
// and "stars" count as players nearly agreeing.
export function closestGroup(
  ctx: BotContext,
): { word: string; count: number } | undefined {
  const last = ctx.history[ctx.history.length - 1];
  if (!last) return undefined;
  const groups: { word: string; count: number }[] = [];
  for (const w of last.words) {
    const g = groups.find((g) => sameWordish(g.word, w.word));
    if (g) g.count++;
    else groups.push({ word: w.word, count: 1 });
  }
  return groups.sort((a, b) => b.count - a.count)[0];
}

// How far a long game has worn the persona down, 0 … 1. Real players get
// more willing to just say the obvious word as a game drags on.
export function fatigue(round: number): number {
  return Math.max(0, Math.min(1, (round - 3) / 5));
}

// The table is close when at least two players, and at least half, said
// (nearly) the same word last round.
function tableIsClose(ctx: BotContext): boolean {
  const group = closestGroup(ctx);
  const players = ctx.history[ctx.history.length - 1]?.words.length ?? 0;
  return !!group && group.count >= 2 && group.count * 2 >= players;
}

// Conformity rises with fatigue, and again when the table is close.
export function effectiveConformity(
  persona: BotPersona,
  ctx: BotContext,
): number {
  let c = persona.knobs.conformity;
  c += (1 - c) * 0.6 * fatigue(ctx.round);
  if (tableIsClose(ctx)) c += (1 - c) * 0.5;
  return c;
}

export interface BotContext {
  round: number;
  // Revealed rounds only: bots never see the current round's submissions.
  history: RoundResult[];
  selfId: string;
  // Lowercased words already played in this game.
  usedWords: Set<string>;
}

export interface BotUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface BotCandidate {
  word: string;
  move: Move;
  // 1 (unusual) … 5 (what most people would say).
  obviousness: number;
  why: string;
}

export interface BotChoice {
  word: string;
  // The bot's reasoning, for logs and the simulation. Never sent to clients.
  why: string;
  move?: Move;
  source: "model" | "fallback";
  // Every candidate the model offered, for the simulation report.
  candidates: BotCandidate[];
  usage: BotUsage[];
}

const RULES = `You are playing Mind Meld, a word game for 2 to 6 players.

Rules:
- Every round, each player secretly submits one word (or a very short phrase). All words are revealed at once.
- The group wins when every player submits exactly the same word in the same round (case-insensitive, exact spelling).
- In round 1 nobody has seen anything yet, so every player just says any word.
- In every later round, players look at the words from the previous round and each tries to find where they meet. People disagree about how best to do that, and you have your own firm view.
- A word that anyone has already played in this game can never be played again.

You are one of the players, a real person with the personality below. You don't answer with a single word: you list the candidate words you're torn between, and tag each one.

Kinds of move:
${MOVES.map((m) => `- ${m}: ${MOVE_DESCRIPTIONS[m]}`).join("\n")}

For each candidate give: the word; its kind of move ("free" in round 1); how obvious it is from 1 (few people would say it) to 5 (most people would say it); and one short sentence of why.`;

const ABSTRACTION_TEXT: Record<BotKnobs["abstraction"], string> = {
  [-2]: "You think in concrete examples, never in categories.",
  [-1]: "You lean toward concrete, specific things rather than broad categories.",
  0: "You go for whatever word an ordinary person would most likely say.",
  1: "You lean toward naming the broader idea or category.",
  2: "You think in categories and concepts, and zoom out rather than in.",
};

const LOOSENESS_TEXT: Record<BotKnobs["looseness"], string> = {
  0: "You make literal, meaning-based connections.",
  1: "You sometimes connect words through common phrases or idioms.",
  2: "You love lateral leaps: puns, rhymes, set phrases, song and movie titles, and pop-culture references.",
};

const VOCABULARY_TEXT: Record<BotKnobs["vocabulary"], string> = {
  common: "You use everyday, common words.",
  varied: "You don't mind a less common or more colorful word.",
};

export function systemPrompt(persona: BotPersona): string {
  const k = persona.knobs;
  return `${RULES}

Your personality (${persona.label}: ${persona.description}):
- ${persona.belief}
- ${ABSTRACTION_TEXT[k.abstraction]}
- ${LOOSENESS_TEXT[k.looseness]}
- ${VOCABULARY_TEXT[k.vocabulary]}

An example of how you play, mid-game:
${persona.example}`;
}

const SEED_TOPICS = [
  "the kitchen",
  "the ocean",
  "sports",
  "weather",
  "animals",
  "music",
  "school",
  "travel",
  "the night sky",
  "a city street",
  "the garden",
  "childhood",
  "holidays",
  "the office",
  "movies",
  "the forest",
  "machines",
  "colors",
  "clothing",
  "the body",
];
const SEED_LETTERS = "abcdefghiklmnoprstw";

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function userPrompt(
  persona: BotPersona,
  ctx: BotContext,
  rejection?: string,
): string {
  const lines: string[] = [`This is round ${ctx.round}.`];
  if (ctx.history.length === 0) {
    // Without a nudge every bot opens with the same model-favorite word.
    lines.push(
      `Nobody has played yet, so any word goes. Let your first thoughts come from ${pick(
        SEED_TOPICS,
      )}, and if it helps, things starting with "${pick(
        SEED_LETTERS.split(""),
      ).toUpperCase()}".`,
      "",
      `List 4 candidate words, all with move "free".`,
    );
  } else {
    lines.push("", "Previous rounds (oldest first):");
    for (const r of ctx.history) {
      const words = r.words
        .map((w) => (w.playerId === ctx.selfId ? `${w.word} (yours)` : w.word))
        .join(", ");
      lines.push(`Round ${r.round}: ${words}`);
    }
    // Restated every round: in a long history the persona otherwise fades
    // into "find the most obvious word".
    lines.push(
      "",
      `Remember who you are: ${persona.belief}`,
      `Your move this round: ${persona.move}`,
    );
    const group = closestGroup(ctx);
    if (group && tableIsClose(ctx)) {
      lines.push(
        `The table is close: ${group.count} players said "${group.word}" (or nearly) last round. You're tempted to just go where you think everyone will land next.`,
      );
    } else if (fatigue(ctx.round) > 0) {
      lines.push(
        "This game is dragging on. You still see things your way, but you're getting more willing to say whatever you think the others will say.",
      );
    }
    lines.push(
      "",
      "List 5 candidate words you're torn between. At least 3 should be your kind of move; the rest can be other kinds you're tempted by. Include the word you think most of the table will say this round, whatever kind of move it is.",
    );
  }
  if (ctx.usedWords.size > 0) {
    lines.push(
      "",
      `Already played, so not allowed: ${[...ctx.usedWords].join(", ")}`,
    );
  }
  if (rejection) {
    lines.push("", `Your last list was rejected: ${rejection} Try again.`);
  }
  return lines.join("\n");
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          move: { type: "string", enum: [...MOVES, "free"] },
          obviousness: { type: "integer", enum: [1, 2, 3, 4, 5] },
          why: { type: "string" },
        },
        required: ["word", "move", "obviousness", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
};

// Strips wrapping quotes and trailing punctuation, but keeps the final dot
// of an abbreviation like "E.T." or "Dr.".
export function cleanWord(raw: string): string {
  let word = raw
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[!?,;:]+$/, "")
    .trim();
  if (
    /\.$/.test(word) &&
    !/\.\S*\.$/.test(word) &&
    !/^[A-Z][a-z]?\.$/.test(word)
  ) {
    word = word.replace(/\.+$/, "");
  }
  return word.trim();
}

// Returns why `word` can't be played, or undefined if it can.
export function rejectWord(
  word: string,
  usedWords: Set<string>,
): string | undefined {
  if (!word) return "it was empty.";
  if (word.length > MAX_WORD_LENGTH)
    return `it is longer than ${MAX_WORD_LENGTH} characters.`;
  if (word.split(/\s+/).length > 3)
    return "it should be one word or a very short phrase.";
  if (usedWords.has(word.toLowerCase())) return `"${word}" was already played.`;
  return undefined;
}

// Picks a candidate at random, weighted by how much the persona likes its
// kind of move and, scaled by conformity, by how obvious it is. As the game
// drags on, the persona's taste in moves flattens and conformity rises.
export function pickCandidate(
  candidates: BotCandidate[],
  persona: BotPersona,
  ctx: BotContext,
  random: () => number = Math.random,
): BotCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const moveW = moveWeights(persona.knobs);
  const sharpness = 4 * effectiveConformity(persona, ctx);
  const style = 1 - 0.5 * fatigue(ctx.round);
  const weights = candidates.map((c) => {
    const kind =
      ctx.round === 1 || c.move === "free"
        ? 1
        : (moveW[c.move] ?? 0.5) ** style;
    const obvious = Math.max(1, Math.min(5, c.obviousness));
    return kind * obvious ** sharpness;
  });
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// Nouns people don't pluralize, so a near-miss on them would look like a typo.
const UNCOUNTABLE = new Set([
  "music",
  "water",
  "money",
  "space",
  "news",
  "rice",
  "information",
  "advice",
  "furniture",
  "weather",
  "love",
  "art",
  "fun",
  "nature",
  "time",
  "food",
  "fire",
  "light",
  "sound",
  "snow",
  "rain",
  "air",
  "magic",
  "history",
  "science",
]);

// A near-variant of `word` that a person could plausibly type instead, the
// human near-miss: "dog" vs "dogs", "berry" vs "berries". Returns undefined
// for words where the variant would look like a typo rather than a choice.
export function nearVariant(word: string): string | undefined {
  // Lowercase single words only: no phrases, names or abbreviations.
  if (!/^[a-z]{3,}$/.test(word) || UNCOUNTABLE.has(word)) return undefined;
  // Gerunds, abstract nouns and adjectives have no natural plural.
  if (/(ing|ness|ism|ity|tion|sion|ics|ful|ous|ive|al|ic|ed|ly)$/.test(word))
    return undefined;
  // Plural to singular.
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (/(oes|ves|ss|us|is|es)$/.test(word)) return undefined;
  if (/s$/.test(word)) return word.slice(0, -1);
  // Singular to plural.
  if (/(ch|sh|x|z)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(o|f|fe|um)$/.test(word)) return undefined;
  return `${word}s`;
}

function applySloppiness(
  word: string,
  persona: BotPersona,
  usedWords: Set<string>,
  round: number,
): string {
  // Round 1 can't near-miss anything.
  if (round === 1 || Math.random() >= persona.knobs.sloppiness) return word;
  const variant = nearVariant(word);
  if (!variant || rejectWord(variant, usedWords)) return word;
  return variant;
}

const FALLBACK_WORDS = [
  "sun",
  "water",
  "house",
  "music",
  "tree",
  "light",
  "road",
  "fire",
  "friend",
  "game",
  "paper",
  "ocean",
  "bread",
  "time",
  "city",
  "dream",
  "stone",
  "garden",
  "storm",
  "color",
  "story",
  "party",
  "money",
  "summer",
  "night",
  "animal",
  "school",
  "family",
  "phone",
  "winter",
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Used without an API key or when the model fails. Round 1 differs per bot;
// later rounds depend only on the previous words, so fallback bots agree
// with each other from round 2 on (handy for no-key dev and CI).
export function fallbackWord(ctx: BotContext): string {
  const last = ctx.history[ctx.history.length - 1];
  const key = last
    ? `${ctx.round}:${last.words
        .map((w) => w.word.toLowerCase())
        .sort()
        .join(",")}`
    : `${ctx.round}:${ctx.selfId}`;
  const start = hash(key) % FALLBACK_WORDS.length;
  for (let i = 0; i < FALLBACK_WORDS.length; i++) {
    const word = FALLBACK_WORDS[(start + i) % FALLBACK_WORDS.length];
    if (!ctx.usedWords.has(word)) return word;
  }
  return `word${ctx.round}-${hash(ctx.selfId) % 1000}`;
}

async function askModel(
  client: Anthropic,
  persona: BotPersona,
  ctx: BotContext,
  rejection: string | undefined,
): Promise<{ candidates?: BotCandidate[]; error: string; usage: BotUsage }> {
  const response = await client.beta.messages.create({
    model: BOT_MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: [
      {
        type: "text",
        text: systemPrompt(persona),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt(persona, ctx, rejection) }],
  });
  const usage: BotUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
  };
  if (response.stop_reason !== "end_turn") {
    return { error: `stop_reason ${response.stop_reason}`, usage };
  }
  const text = response.content.find((b) => b.type === "text");
  if (text?.type !== "text") return { error: "no text block", usage };
  try {
    const parsed = JSON.parse(text.text) as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) {
      return { error: "no candidates", usage };
    }
    const candidates: BotCandidate[] = parsed.candidates
      .filter(
        (c): c is BotCandidate =>
          typeof c === "object" && c !== null && typeof c.word === "string",
      )
      .map((c) => ({
        word: cleanWord(c.word),
        move: c.move,
        obviousness: Number(c.obviousness) || 3,
        why: typeof c.why === "string" ? c.why : "",
      }));
    return { candidates, error: "", usage };
  } catch {
    return { error: "unparseable JSON", usage };
  }
}

export async function chooseBotWord(
  client: Anthropic | undefined,
  persona: BotPersona,
  ctx: BotContext,
): Promise<BotChoice> {
  const usage: BotUsage[] = [];
  const offered: BotCandidate[] = [];
  const fallback = (why: string): BotChoice => ({
    word: fallbackWord(ctx),
    why: `fallback (${why})`,
    source: "fallback",
    candidates: offered,
    usage,
  });
  if (!client) return fallback("no API key");
  if (ctx.round > MAX_MODEL_ROUNDS)
    return fallback(`past round ${MAX_MODEL_ROUNDS}`);

  let rejection: string | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await askModel(client, persona, ctx, rejection);
      usage.push(answer.usage);
      if (!answer.candidates) {
        rejection = undefined;
        if (attempt === 1) return fallback(answer.error);
        continue;
      }
      offered.push(...answer.candidates);
      const valid = answer.candidates.filter(
        (c) => !rejectWord(c.word, ctx.usedWords),
      );
      const chosen = pickCandidate(valid, persona, ctx);
      if (chosen) {
        return {
          word: applySloppiness(chosen.word, persona, ctx.usedWords, ctx.round),
          why: chosen.why,
          move: chosen.move,
          source: "model",
          candidates: offered,
          usage,
        };
      }
      rejection = answer.candidates.length
        ? `every word was already played or too long (${answer.candidates
            .map((c) => c.word)
            .join(", ")}).`
        : "it was empty.";
    }
    return fallback(`rejected twice: ${rejection}`);
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.warn(`bot ${persona.id}: API error ${err.status}`, err.message);
      return fallback(`API error ${err.status}`);
    }
    console.warn(`bot ${persona.id}: request failed`, err);
    return fallback("request failed");
  }
}
