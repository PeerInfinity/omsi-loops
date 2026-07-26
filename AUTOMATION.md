# Advanced Automation — how the queue planner works

This document explains the fork's Advanced Automation feature in detail: what
it does, how each stage of a planning round works, why it is built the way it
is, and where its current limits are. Code references are to `planner.js`
(the algorithm), `planner-worker.js` (the Web Worker host), and
`automation.js` (the in-page controller and the Stats-panel view).

## 1. What it is

A **generic queue planner**: every loop, it builds the action queue for the
next loop by measuring the game with the game's own engine, generating
candidate queues from generic templates, and picking the candidate whose
*actually simulated* outcome scores best against a weighted objectives model.

Design commitments, in order of importance:

1. **Zero hand-scripted game knowledge.** The planner never contains "smash
   pots, then buy glasses". Everything it knows — what actions yield, what
   locked actions require, what travel costs — it discovers at runtime by
   probing and measuring. This is what lets the same planner code keep
   working when the Archipelago randomizer later rewires what actions do.
2. **The engine is ground truth.** Every candidate that can win is first
   *played* on a rolled-back copy of the real game engine. Models
   (the Koviko predictor) are used only to cheaply rank candidates and as a
   cross-check, never as the basis for a commitment.
3. **Determinism.** Given the same state and settings, planning produces the
   same queue, byte for byte. No randomness enters generation or scoring;
   ties break on stable order. Headless runs of the full planner reproduce a
   reference playthrough exactly (see §8).
4. **The live game is never rolled back.** All rollback-based work happens in
   a Web Worker on the worker's *own copy* of the game state, restored from a
   save snapshot. The real game only ever receives the winning queue.

## 2. Where it runs

- **In the browser**: `automation.js` hooks the loop boundary
  (`prepareRestart`). In *Suggest* mode each boundary computes a plan and
  displays it; *Apply Suggestion* installs it. In *Auto* mode the planner
  owns the queue; with *Pause while planning* (default) the game holds at the
  boundary until the plan for the next loop arrives, so the planner plays
  exactly the loop it planned. Manual queue edits always win: Auto detects a
  hand-edited queue at the boundary and disengages to Suggest.
- **Headless**: the same `planner.js` runs in Node (`test/harness.mjs` boots
  the full sim in a `node:vm` with ~40 lines of DOM stubs) for tests and for
  the stats harness that produces the reference numbers below.

## 3. One planning round, end to end

`planRound(sess, P)` — `P` is the persistent planning state (knowledge table,
thresholds, last committed queue, previous capacity/pump pair).

### 3.1 Read (`plReadState`)

A JSON snapshot of everything scoring and generation will look at: per-skill
exp/levels, per-town progress exp and limited-item ledgers
(`good`/`checked`/`total`), and for every action of every *unlocked* town:
visibility, unlockedness, gold cost, travel destinations, and its **adjusted
mana cost** (`plAdjCost`, mirroring the engine's `setAdjustedTicks`: base
`manaCost()` × the stat mana multipliers). Reads are taken at loop
boundaries, *after* `restart()` — so stat levels are at their per-loop reset
values, and adjusted costs move only through *persistent* inputs (town
progress like Old Shortcut's level, Imbuement, buffs). That property is what
makes cost deltas between reads meaningful (§3.7).

### 3.2 Threshold probing (`plProbeThresholds`)

The engine's `visible()`/`unlocked()` closures are pure functions of town
progress exp, skill levels, resources and story flags (verified: 1,812 calls
across all 157 actions consume zero RNG). So unlock requirements can be
*discovered exactly* by perturbation:

- **Pass A** — for each locked action, raise one dimension at a time to its
  max, leaving the others at current values. If the action unlocks, binary
  search the minimal passing level. This captures the last missing dimension
  and sum-clauses (e.g. Combat+Magic ≥ 35).
- **Pass B** — if no single dimension flips it, set *all* dimensions to max
  (does it unlock at all? if not it is story-gated → `probeable: false`),
  then lower one at a time to find each dimension's floor. This captures
  conjunctions.

Probing saves and restores every perturbed value; a selftest asserts the
full state snapshot is bit-identical before and after. Results feed the
frontier scoring term and push timing. Re-probed every loop by default
(stale thresholds mis-time unlock pushes — measured, not assumed).

Both sides of a progress dimension speak **raw** level (`getRawLevel` to
read, `expForLevel` to write, `regionMaxLevel || 100` as the ceiling). That
matters only under the substrate's per-region Explore rescale, where
`getLevel` returns a compressed *effective* level: reading one ladder and
writing the other seeded the binary search from the wrong floor and reported
levels the exp cap forbids. Raw is also the unit `reqFraction` converts
`need` back to exp in, so it is the view that survives the whole round trip.
`test()` stays effective-driven — that is what the predicates read — and
effective is monotone in raw, so the searches are unaffected. Vanilla has no
rescale, so raw ≡ effective and this is byte-inert. (`plProbePoolCap` is raw
on both sides too, but for the opposite reason: its read side is
`total<Var>`, a raw-level `<totalDiscovered>` consumer.)

### 3.3 Knowledge refresh (`refreshKnowledge` / `measureAction`)

The knowledge table maps action name → an empirical profile: execs achieved,
ticks per exec, mana/gold/reputation per exec, resource grants, gold-cost
reductions, pool discovery rates, skill/talent/progress exp rates.

Measurement of one action = **run one rolled-back engine loop** whose queue
is just that action (batched), with *injected* resources: a large mana budget
(25,000) so nothing starves, plus any resources its `canStart` needs (probed
by `plProbeCanStartNeeds`: raise each resource to huge/true one at a time,
then cumulatively for conjunctions), plus gold if it has a price. Injection
makes converters, purchases and price reducers measurable *long before they
are affordable in play*. The loop is rolled back afterwards; profiles are
deltas against the pre-state.

Details that matter:

- **Out-of-town actions** (multi-town mode): every loop starts in town 0, so
  a town-N action is unreachable from loop start. Its probe queue gets the
  committed-play *route as a prefix*, and the measurement is differenced
  against a **prefix-only baseline run** under identical injections — the
  subtraction isolates the action's own contribution from the prefix's side
  effects, making profiles route-independent by construction. Baselines are
  cached per (route, injection-signature), so a refresh wave runs a few
  baseline loops per town, not one per action.
- **Staleness**: profiles re-measure every 40 loops, sooner if the action
  never executed (exec = 0) or its bank materially changed.
- **Vacuous-execution retry**: an action that measures "does nothing" gets
  one retry with universal consumables (gold, reputation) injected — it may
  have been silently gated.
- **Pair probes**: some purchases (Buy Supplies) have no `goldCost()` method
  — their price lives inside `canStart`/`finish`, so price *reductions*
  (Haggle) are invisible to single-action measurement. Suspicious "no-yield
  consumers" are probed in a pair queue with each measured purchase, and the
  purchase's actual gold spend is compared.

### 3.4 Predictor priors and the divergence log

The fork ships the Koviko predictor, whose hand-maintained per-action effect
model covers all nine towns. The planner may read it as a **prior**
(`seedPredictorPrior`) — a fork feature legitimately reads its own game's
data — but priors never drive decisions: empirical measurement stays
authoritative. Instead, predictor-vs-engine disagreements are **recorded**
(`recordDivergence`) as a correctness canary. This "third oracle" flags
predictor model bugs, engine changes, and — later — Archipelago-randomized
data that a compile-time model cannot know about.

### 3.5 Candidate generation (`generateCandidates`)

All generators are generic — driven by state metadata and measured knowledge:

- **Economy core** (`buildEconomy`): harvest mana engines (banked items whose
  measured mana yield exceeds their tick cost), then harvest gold pools
  interleaved with the best measured converter, tracked by a modeled cushion
  so the queue never starves; optional gold/reputation reserves ride along
  for purchases. This is the base of almost every candidate.
- **Grind variants**: economy + pour a share of the remaining cushion into
  the cheapest action that raises a *frontier dimension* (a dimension locked
  actions need, ranked by proximity-weighted demand across all probed
  thresholds). Single-dim at two shares, plus a split across the top two.
- **Investment**: economy + spend cushion *checking* unchecked limited items,
  weighted by each bank's measured per-item value (banked items pay out every
  future loop).
- **Discovery**: economy + batch the best measured pool-discoverer (actions
  whose execs grow limited-item totals — future banks).
- **Travel pushes** (`buildPushes`): for each travel edge whose *destination*
  is locked: route to the edge's origin, resolve each hop's `canStart` needs
  to measured grantors (per hop, placed in the latest segment whose town can
  host them), price the grantors, generate Haggle-style reducer variants
  (h0 … hMax, capped by what reputation-yielding banks can fund), and build
  an economy that structurally reserves the densest gold for the purchase
  right before the travel tail. The travel action must be queue-terminal
  (engine tail-pinning); everything else can sit mid-queue.
- **Expeditions**: travel to an *unlocked* town t > 0 and work there — grind
  its frontier dims, invest in its pools, run its best discoverer, or bare
  backstop. Bounded to "frontier towns" (towns owning a global-top-4 unmet
  dimension, plus the highest unlocked town). Tail batches are generous:
  queue entries past the realized budget simply never run, so overrun is
  free — under-filling is what silently kills variants.
- **Repeat**: the last committed queue, verbatim (cheap insurance).
- **Bare backstop**: cheapest progress action ×99 (early game, no knowledge).

Candidates are deduped by queue content. At `townsUnlocked = [0]` the
multi-town generators produce nothing and the candidate set equals the
original town-0 planner's, byte for byte (a frozen golden asserts this).

### 3.6 Predictor screen (`screenCandidates`)

Every candidate is scored cheaply by the predictor (productive mana within
budget) and only the top **K = 8** go to engine confirmation. Pushes and
repeat always survive the screen (model-gap insurance). K is calibrated, not
just a compute saver: the screen is a *regularizer* — wider K lets myopic
candidates past it, and the measured full-run result gets *worse* at K = 16
as well as at K = 4.

### 3.7 Engine confirmation, capacity probe, scoring

Each screened candidate is **played** on the rolled-back engine
(`evalLoop`), producing its post-state. From that post-state a **capacity
probe** runs one more rolled-back loop that harvests every bank (walking
banked towns in route order in multi-town states, buying hop needs before
each town's spend-all converter flushes) — its realized budget is the
candidate's *next-loop capacity*, and the mana its actions consumed is the
**pump cost**. The probe is what makes investment visible to an otherwise
one-loop-greedy scorer: banked items only pay off in the *next* loop.

`scoreOutcome(pre, post, …)` then sums weighted terms (all weights are
options):

| Term | Default | What it prices |
|---|---|---|
| town | 1e12 | Unlocking a town wins the loop outright |
| unlockAction / visibleAction | 1000 / 300 | Actions newly unlocked / visible |
| frontier | 4000 | Exp-fraction progress toward probed unlock thresholds |
| mana | 800 | Log-growth of realized per-loop capacity |
| bank | 30 | Mana-equivalent value of newly *banked* items (pays every future loop); checking is credited by the ledger's own good/checked ratio |
| bankPot | 15 | *Expected* pool discovery (measured per-exec rates × execs — realized totals only spike on level-ups, which makes discovery lose ties) |
| travelRelief | 3 | Multi-town only: permanent cheapening of routes to other towns — the delta of summed cheapest-route costs (pure adjusted-cost arithmetic). Prices Old Shortcut → Continue On (8000 − 60/level) |
| headroom | 1 | Multi-town only: growth of disposable per-loop mana = capacity − pump cost, vs the last committed loop. Capacity is bank-limited at plateaus (log term reads 0) while stat growth keeps cutting the pump's cost — the disposable slice is what funds expeditions and town pushes |
| talent | 0.01 | Long-horizon tie-break |

The two multi-town terms are **gated on the pre-state having more than one
town unlocked** — at `[0]` neither computes, preserving byte-exactness
against the reference playthrough (§8). The lineage matters: this is the
third generation of "greedy scoring fixates without explicit delayed-payoff
terms" (first the capacity probe, then discovery expectation, now
price/headroom for the travel horizon).

### 3.8 Commit

The best-scoring candidate wins. Headless, the driver *restores the
winner's already-simulated post-state* (planning and play are the same
simulation). In the browser, the worker returns the queue and the live game
plays it for real — which is why worker and game must share options that
affect the sim (e.g. the experience gain multiplier is forwarded with every
plan request).

## 4. The travel layer (multi-town)

- **Travel graph**: nodes = towns; edges = travel actions, destination =
  `townNum + delta` from `getPossibleTravel`. Backward edges (Open Portal
  6→1) and skip edges (Hitch Ride 0→2) fall out of the representation for
  free. Dynamic edges (Face Judgement — destination depends on reputation)
  are excluded from deterministic routing.
- **Routing** (`routeTo`): BFS by hop count over usable (visible + unlocked
  + static) edges, ties broken by estimated mana cost then by name (stable).
  Works purely on the read state (`sess = null`) for scoring, or with needs
  probing for queue construction.
- **Economics**: reaching town 2 costs supplies (gold that *forgoes* its
  converter value ≈ 50 mana/gold), hop mana, and Continue On's 8000-minus-
  Shortcut cost — against the loop's disposable headroom. The planner's
  push/expedition budgets reproduce this arithmetic exactly; travel is a
  per-loop expense (every loop starts at town 0; supplies re-buy each loop).

## 4a. Targeted mode and the two-tier priority list

The default **heuristic** strategy scores whatever candidate loop looks best
right now. The **targeted** strategy (Automation view → Strategy) instead
pursues an ordered goal list you author, and only falls back to the heuristic
when nothing on the list can be advanced.

- **Goals (Tier 1)**: an *action* goal ("make Start Journey execute") or a
  *value* goal ("reach reputation/buff/soulstone/progress value V"). Goals
  are a JSON list behind the row editor (option `plannerTargets`); the first
  entry is the active goal and stays **sticky across loops** until achieved
  or abandoned.
- **Setup rounds are goal-LIST-scoped (§B, session 29).** When the top
  goal's push is infeasible, the planner walks the WHOLE list in order and
  spends the loop on the first goal with an installable setup leaf. A dead
  top goal (no providers, never progresses) therefore no longer shadows
  the goals below it — measured on the Round-20 donor: dead goal + Start
  Journey escaped in 9 loops with abandon fully disabled, where the old
  top-goal-scoped path was a DNF. Abandon still prunes dead entries at
  `goalStallK` (default 20) stalled rounds, but it is list hygiene now,
  not the escape mechanism.
- **A LOCKED goal's abandon clock runs on its unlock dims (§U, session
  29, armed).** While a kind-a goal's action is locked, progress is
  measured as the mean unlock-requirement fraction (the frontier term's
  arithmetic over the probed thresholds). The clock stays FROZEN until the
  dims first move during the goal's tenure — on the reference run
  Combat/Magic sit at zero for ~236 loops before the first grind, so any
  flat-window accrual would false-abandon Start Journey on every fresh
  run. Once armed, rising rounds reset the clock and flat rounds accrue
  it, abandoning at `unlockStallK` (default 64; the healthy armed window's
  worst flat stretch measures 25 rounds). Goals with unprobeable
  (story-gated) unlock dims keep the unconditional freeze.
- **Sub-priorities (Tier 2)**: for the active goal the planner derives a
  prerequisite chain by regressing over its measured graph (e.g. Start
  Journey ⇐ cheaper supplies ⇐ Haggle depth ⇐ reputation ⇐ Long Quest pool ⇐
  Secrets). Expand a goal row (▶) to see the current auto-derived chain
  read-only. Switching the row to **user** mode flattens the chain into an
  editable ordered list (reorder / remove / optional "≥ value" stop per
  entry); auto and user lists are stored separately, so switching back is
  lossless. A "setup loop" — a loop spent growing a prerequisite because the
  goal push isn't achievable yet — falls out of this pursuit automatically,
  and each setup round is accepted only if it measurably moves its target
  dimension.
- **A user pin can build toward a still-LOCKED goal** — the auto finder
  can't (it only analyzes unlocked actions). Pinning a known-useful grind
  (say Secrets) under a goal whose action hasn't unlocked yet is a
  legitimate play the automation itself would not discover.
- **Ordering is strict, by design — mind the stop values.** The consume
  semantics honor your order literally: entry 1 keeps installing setup
  rounds for as long as its dimension keeps measurably progressing, so a
  value-less first entry can *monopolize* the run long past the point the
  auto chain would have moved on (measured: a pinned Secrets grind ran 44
  loops where the auto finder adapted after 4). If you don't want that, put
  a "≥ value" stop on each entry — a reached stop retires the entry and the
  planner advances down your list, then falls back to the auto chain. A pin
  that can't install at all (nothing reachable grows it) is skipped
  harmlessly; a stale override never dead-ends the run.

## 5. Observing it live

Enable Advanced Automation (Extras menu), then switch the Stats panel to the
**Automation** view: compact stats, all planner settings, and a live
internals dump — the last plan round's candidates with per-term score
breakdowns (including capacity and pump cost per candidate), the full
knowledge table, probed thresholds, and predictor divergences. It refreshes
after every plan; the tooltips on each element are the short version of this
document.

## 6. Testing multipliers (fork option)

`expGainMultiplier` (Extras → Testing) multiplies experience gains ONLY —
town progress exp, skill exp, stat exp/talent — at the three engine funnels
all call sites flow through (`Town.finishProgress`, `addSkillExp`,
`addExp`). Resources, item pools, multipart progress, buffs and soulstones
are deliberately untouched, so the game's economy stays real in boosted test
runs. 1 is byte-inert. Note the predictor's effect model does not know the
multiplier, so the screen under-ranks exp-heavy candidates at high values;
engine confirmation remains ground truth.

## 6a. "Lootable first" and the plan/play contract

The per-resource "Lootable first" checkboxes are DOM state the worker cannot
see, and the engine's fallback without them is loot-first while the browser
default is check-first — historically the worker could plan a different
game than the one you play. The `plannerControlLootFirst` option (default
on) resolves it: ON, the automation sets every box to its own loot-first
model whenever it plans; OFF, your current checkbox states are forwarded to
the worker, whose sim honors them (plans are then computed under your
settings — note the queue-construction heuristics model loot-first, so
check-first plans lean more on engine confirmation to rank correctly).

## 7. Known limitations

- **Scoring horizon**: one loop + capacity probe + explicit delayed-payoff
  terms. Payoffs that need *chains* of loops to materialize are priced only
  via the explicit terms; multiparts/dungeons are measured as opaque actions
  and unassessed as a progression strategy.
- **RNG in live play**: town-1+ reward paths can consume RNG (soulstones,
  dungeons). Headless runs seed and roll back the RNG stream; the live
  browser cannot roll back reality, so plans touching RNG-bearing content
  are advisory rather than exactly replayed.
- **Predictor screen at high gain multipliers**: see §6.
- **Story-gated actions** are correctly recognized as unprobeable and never
  targeted (e.g. Hitch Ride before its story flag).

## 8. Determinism and the reference playthrough

With seed 12345 and default settings, the headless planner reaches Forest
Path (town 1) in **461 loops / 5,195,188 ticks / final-state hash
`9d9952e68bc8373c`**, still beating the fork's 646-loop scripted baseline with
zero hand-scripted knowledge. This exact triple is re-verified after every
planner change — new planner features must keep it byte-identical or explain
themselves.

**Weight recalibration re-baseline (2026-07-16).** The previous reference
**535 / 5,965,890 / `e23f020400162f9a`** was deliberately retired by the
calibration pass that Part A had queued: with the accurate town-0 capacity
model in place, DEFAULT_WEIGHTS moved `bank` 30 → 45 and `bankPot` 15 → 8
(the sweep winner under BOTH metrics on the predictor screen: −13.8% loops,
−12.9% ticks; the combo's bank 20–60 neighborhood is a healthy plateau,
while bank10+bankPot8 and bank55-alone are fixation holes the DNF-aware
sweeps flagged). The §11.8 piece-3 scored channels (efficiency / buff /
soulstone / invest / grindTalent) all ship at 0 — none has any town-0
signal to calibrate against (see the SUMMARY Round-19 notes); they get
values when the town-2+ arcs run. An exact-count tail trim was prototyped
and REJECTED by measurement: it cuts ~9% of per-loop ticks but the lost
per-tick stat/talent exp compounds into more loops, losing BOTH metrics on
the new defaults (515 / 6,117,370 vs 461 / 5,195,188).

**Part A re-baseline (§11.9, 2026-07-13).** This reference was deliberately
re-frozen from the original **500 / 5,432,753 / `54506b48ec1758af`**. Part A
un-gated the town-0 interleaved capacity probe (A1): the town-0 probe had been
reporting `prevTimeNeeded` 5,250 while committed loops realize 27k–35k, a ~7×
understated capacityHint that mis-sized every economy/push candidate. Fixing it
reshapes the healthy trajectory (500 → 535 loops, +9.8% ticks) AND melts the
**bank:20 fixation hole** — previously a DNF at 1,200 loops with zero escapes,
now escaping to town 1 at loop 538 under the plain heuristic (no anti-fixation
guard needed). The +35-loop healthy cost was accepted as the price of the
bank:20 headline-gate fix (user ruling 2026-07-13). The two prior weight-sweep
cross-checks (frontier:1000 → 502, bank:10 → 632) predate Part A and no longer
reproduce byte-exact; they are re-measured in the calibration re-baseline
(handoff item 5), not here.
