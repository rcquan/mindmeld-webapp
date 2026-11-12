# Bots in Mind Meld

How bot players work, how their personas are built, how to evaluate them, and what tuning has taught us so far. The code is in `src/bots.ts`, the server side is `runBots` in `src/server.ts`, and the evaluation harness is `scripts/simulate-bots.ts`.

## How a bot plays a round

1. **One model call per bot per round** (`BOT_MODEL`, currently Claude Sonnet 5.5, low effort, structured JSON output). The bot sees only revealed rounds, never the current round's submissions.
2. **The model lists candidates.** It doesn't answer with one word. It lists 4 candidates in round 1 and 5 after that, each tagged with:
   - a **move type** (below);
   - an **obviousness** score from 1 (few people would say it) to 5 (most would);
   - a one-line reason.
3. **Code picks one.** The pick is weighted by how much the persona likes that move type and, scaled by conformity, how obvious the candidate is:
   `weight = moveWeight(move) ^ style × obviousness ^ (4 × conformity)`
   Candidates that were already played, or are too long or wordy, are filtered out first.
4. **Sloppiness.** Sometimes the bot plays a plausible plural or singular of the chosen word instead ("dog" for "dogs", "berries" for "berry"). That's the human near-miss.
5. **Think time.** The server waits out a persona-specific delay, minus the API time, then re-checks that the round is still open before submitting.

Splitting "what could I say" (model) from "what do I say" (code) is the core design. Asked for one word, identical bots all land on the model's single favorite word and match in round 2, and every persona slides into "say the most obvious word" within a few rounds. Weighted sampling over tagged candidates keeps bots distinct and makes the persona knobs mean something.

### Move types

| Move | Meaning |
|---|---|
| `category` | names the category or concept the words share |
| `specific` | one concrete member or example that fits (not the category name) |
| `link` | an everyday word associated with all the words, neither category nor member |
| `wordplay` | a pun, rhyme, set phrase, title or pop-culture reference |
| `anchor` | stays close to the bot's own previous word |
| `drop-outlier` | ignores the word that fits least and connects the rest |
| `free` | round 1 only, when there is nothing to connect |

### Round 1

With no history, every bot would open with the same model-favorite word. Each bot's round-1 prompt therefore gets a random topic ("the kitchen", "the night sky", …) and a random starting letter as a nudge.

### Fallback words

A bot plays from a built-in word list (`fallbackWord`) instead of calling the model when:
- there's no API key;
- the call fails twice or errors;
- the game is past `MAX_MODEL_ROUNDS` (20).

Round 1 fallback words differ per bot. Later rounds depend only on the previous words, so fallback bots agree with each other from round 2. That makes no-key dev and CI games end quickly, and it's also why fallback games say nothing about bot quality.

A bot turn always ends in a submission: if anything fails, the server plays an unused fallback word, so a round never waits forever on a bot.

## Personas

Each persona is a set of knobs (`BotKnobs`) plus three pieces of prompt text:
- a **belief**: why this player thinks its approach works;
- a **move**: what to do this round;
- a mid-game **example**.

The belief and move are restated in every round's prompt, not just the system prompt. Without that, personas fade into generic play as the history grows.

| Persona | Style (top move) | Conformity | Notes |
|---|---|---|---|
| The Bridge | none (balanced) | 0.85 | the most obvious word linking everything; the baseline "good player" |
| The Categorizer | `category` | 0.5 | always zooms out |
| The Specifier | `specific` | 0.4 | always zooms in; varied vocabulary |
| The Stubborn One | `anchor` | 0.5 | stays near its own last word |
| The Crowd Follower | `drop-outlier` | 0.9 | goes with the majority |
| The Wildcard | `wordplay` | 0.2 | puns and pop culture; least predictable |

The knobs:
- `abstraction` (−2 itemize … +2 categorize) and `looseness` (0 literal … 2 puns): set the move weights.
- `focus`: anchor-self or follow-majority.
- `vocabulary`.
- `conformity`: how strongly obviousness wins.
- `sloppiness`: the near-miss chance.
- `thinkMs`.

`moveWeights()` turns the knobs into a weight per move type. `preferredMoves()` reports the top move, used only for scoring adherence.

### Softening over a game

Real players get more willing to say the obvious word as a game drags on, and lean in when the table is close. Two mechanisms model this:

- **Fatigue**: `fatigue(round)` ramps from 0 at round 3 to 1 at round 8. It raises effective conformity and flattens the persona's move preferences (`style` drops from 1 to 0.5). The prompt also says the game is dragging.
- **Closeness**: if at least two players, and at least half the table, said nearly the same word last round (`closestGroup`, which ignores case and plural endings), conformity rises further. The prompt names the near-agreed word.

The candidate list also always includes "the word you think most of the table will say", so the pull toward agreement has something to pick.

## Cost limits

- At most `MAX_BOTS` (3) bots per room, enforced by the server.
- Only the host (the earliest-joined human) can add or remove bots.
- After round 20, bots play free fallback words.
- The API client times out after 15 seconds with one retry, then the bot falls back.

The system prompt is cached. A typical call is about 1,050 cached input tokens, 275 uncached and 235 output.

## Evaluating bots: the simulation

```bash
node scripts/simulate-bots.ts --personas "bridge,bridge,bridge;categorizer,specifier,stubborn,follower,wildcard" --games 5 --max-rounds 10 --label my-change
```

It plays offline bot-vs-bot games with the same round loop as the server (history, used words, `isMatch`). Each run makes real API calls and costs money, roughly $3 for 15 games on Opus 5.5; Sonnet 5.5 is cheaper. It needs `ANTHROPIC_API_KEY` in the environment, and it stops on any API error rather than quietly playing fallback words. A run full of fallback games looks like instant matches.

Options:
- `--personas`: a comma-separated lineup; separate several lineups with `;`.
- `--games`, `--max-rounds`: games per lineup, and the round limit.
- `--engine <path>`: run another copy of `bots.ts` for a before/after comparison on the same lineups.
- `--no-judge`: skip the judge calls.
- `--label`, `--out`, `--quiet`.

Output goes to `sim-results/<time>[-label]/` (gitignored):
- `report.md`: per game, a round-by-round table of who played what, the move type each bot claimed, and the judge's label where it disagrees. Under each game, the reasoning and every candidate each bot was choosing between.
- `results.json`: the same data, for scripting.

### Metrics

- **Matched games** and **rounds to match.** The target is 3–6 rounds, roughly how human games go. "Matched by round 2" counts games that are too easy.
- **Spread**: distinct words divided by players, over unmatched rounds 2 and later. 1.0 means nobody agreed with anyone.
- **Persona adherence**: how often a bot's moves after round 1 were its persona's top move, measured two ways:
  - **self-tagged**, using the move the bot claimed;
  - **judged**, by a Claude Haiku 5.5 call per round that labels each move from the words alone, seeing all players' previous words.

  Self-tags run high because the bot labels its own homework. Judged numbers are the honest signal, but the judge has blind spots (below).
- **Calls, fallbacks and tokens per call**, for cost.

## Tuning history and insights

All runs below are 5 games per lineup with a 10-round limit, on Claude Opus 5.5. The bots haven't been simulated on Sonnet 5.5 yet, and that's the first thing to rerun.

| Engine | 3× Bridge | 3× Categorizer | 5-persona mix |
|---|---|---|---|
| v0: one word per call, persona only in the system prompt | 5/5, median 2 rounds | 5/5, median 2 | 3/5, rounds 5–6 |
| v1: tagged candidates, persona restated each round | 2/5 (rounds 6, 7) | 3/5 | 0/5 |
| v2: plus fatigue, closeness, plausible near-misses | 4/5 (3, 5, 5, 9) | 4/5 (3, 5, 9, 9) | 0/5 |

What we've learned:

- **v0 was too agreeable.** Identical bots matched in round 2 almost every time, and personas decayed: by round 3 or so the Categorizer, Wildcard and Specifier all played the obvious word. Judged adherence in the mix was 3–53%.
- **v1 held personas better (judged adherence in the mix rose to 42–67% for most personas) but overcorrected.** Tables stalled at two out of three: two bots agreed every round and the third went elsewhere. Pure styles never meet in the middle, while real people soften.
- **v2 fixed same-persona tables.** Fatigue and closeness bring matches into the 3–9 round range. Mixed tables still don't match in 10 rounds but get close: four of five said "Anna", "gorilla", "constellation" or "North Star" in the same round. The **Categorizer is usually the holdout** in mixed tables, because it names a category when everyone else names a thing. Mixed games also tend to lock onto one theme (Frozen, outer space) and wander inside it. Five different styles may simply need more than 10 rounds.
- **Near-misses must be real word forms.** Naive "add or drop an s" produced "landscapings", "gardenings" and "bushe". `nearVariant` now skips gerunds, abstract nouns, uncountable nouns, names and phrases, and handles -ies/-es. It still can't tell adjectives from nouns ("dark" → "darks").
- **Judge blind spots.** The judge over-labeled `anchor` until its rule was tightened to "clearly closer to your own previous word than to the others, and not connecting them". `drop-outlier` is nearly invisible from the words alone (2% judged versus 91% self-tagged for the Crowd Follower), so read the Follower's self-tags. The Stubborn One's judged `anchor` rate fell from 67% to 24% under the stricter rule, which is probably more accurate.
- **Asking for candidates costs about 6× the output tokens** of asking for one word (about 240 versus 40 per call). It's worth it: it's the only approach that kept personas distinct.

Open ideas, not yet tried:
- give the Categorizer a stronger pull toward a member when the table is close;
- private per-bot backgrounds, so identical personas think about different things;
- simulated attention noise;
- a longer round limit for 5- and 6-player tables.

## API key

Bots read `ANTHROPIC_API_KEY` from the Worker environment. Without it, bots play fallback words, so dev, CI and the smoke test work without a key. Setting or changing the production key changes production, so confirm with the user first.
