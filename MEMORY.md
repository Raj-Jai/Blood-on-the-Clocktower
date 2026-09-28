# MEMORY

Working notes for this repository. Keep this file accurate: it is the first thing
to read when picking the work up cold.

## What this is

A Blood on the Clocktower companion app. A Storyteller hosts a game; every player
joins from their own device over a socket. It replaces the verbal rituals of the
real game with an app that knows whose turn it is, what they are allowed to do, and
what they learn.

- `packages/shared` — protocol, event names, characters, and the *derived* game
  state that both sides agree on (see "One source of truth" below).
- `packages/server` — session store, socket gateway, and the night engine.
- `packages/client` — React app. `routes/PlayerGamePage.tsx` and
  `routes/StorytellerGamePage.tsx` are the two screens that matter.

## Running it

```bash
npm run build                      # shared + server + client
bash /tmp/restart-otc.sh           # rebuild and restart the API on :3001
npm run dev --workspace=packages/client   # Vite on :5173
```

A throwaway game: `POST /api/sessions` returns `{ code, storytellerToken }`, then
`POST /api/sessions/:code/join` with `{ displayName }` returns
`{ playerId, playerToken }`. Socket auth is an explicit `auth` message carrying the
token, not a handshake. Routes are `#/storyteller/:code` and `#/play/:code`, and
each client seeds `botc:sessionCode`, `botc:playerId`, `botc:playerToken`,
`botc:storytellerToken`, `botc:onboarding:seen` into `localStorage`.

## Tests

```bash
npx vitest run --root packages/shared
npx vitest run --root packages/server
npx vitest run --root packages/client
npm run build
```

The server imports `@clocktower/shared` from its **built** output. After changing
anything in `packages/shared`, run `npm run build --workspace=packages/shared` or
the server tests will pass against stale code and tell you nothing.

## The game simulator

Unit tests cannot tell you whether a game is playable. The harness lives in the repo at
`tools/playtest/` and drives real browser windows through real games, clicking the real UI
and reading the real DOM at every beat. Start the server (`:3001`) and the client (`:5173`)
first.

- `table.mjs` / `lib.mjs` — the table harness. The Storyteller clicks **Create Game**, the
  join code is read off the lobby screen, and each player types that code and their name
  into the join form. **No session is ever created by calling the REST API.**
- `play-game.mjs` — plays whole games: night, dawn, nomination, vote, death.
  `PLAYERS=7 NIGHTS=2 node tools/playtest/play-game.mjs`.
- `scenarios.mjs` — named scenarios. `SCENARIO=vote node tools/playtest/scenarios.mjs`.
- `smoke.mjs` — harness self-test; run this first.
- Probes, one per finding, each reading a real screen: `probe-execution.mjs`,
  `probe-characters.mjs` (the Virgin and the Slayer), `probe-evil-leak.mjs`,
  `probe-results.mjs`, `probe-renominate.mjs`, `probe-vote.mjs`.
- `summary.html` — the fix log, written for the table rather than for us.
  `restart-server.sh` — rebuild shared + server, kill the old `:3001`, wait for the port.
- Screenshots and per-run logs land in `tools/playtest/shots/`.

Harness rules, both learned by wasting an hour:

1. **Never open a second socket** for a player or the Storyteller. It steals their private
   prompts and looks exactly like a lost-prompt bug. Read state from the real windows.
2. **Scope every click to its panel.** Whole-page text matching hits the wrong control — the
   moment card's "Nominate someone" contains "Nominate" and sits above the Nominate panel's
   own button.

Playwright is not a dependency; `table.mjs` resolves it from `PLAYWRIGHT_PATH` or the npx
cache and throws with instructions if it cannot.

**A harness that quietly loses its table looks exactly like a harness proving a bug.** Two
of the probes reported working characters as broken: one compared `'virgin'` against the
Grimoire's `"Virgin"` and re-dealt six tables finding nothing, and one reassigned a local
table variable so the caller kept a closed browser. When a probe says a thing is broken,
check the probe.

## One source of truth: "is this step done?"

The single most expensive bug class in this codebase is **two pieces of code asking
"is this step finished?" in slightly different words.** It has produced three
separate shipped bugs (a night that reported itself resolved while a player still
owed a choice; a walk that deadlocked on an unmakeable character; a prompt that was
never sent). The rule now:

- `stepCountsAsOutstanding(session, step)` in `game/nightEngine.ts` is the only
  definition. A step is outstanding only if it is not submitted, is possible, and
  has a target count.
- `wakerIsFinished(session, playerId)` asks the same question for the wake walk.
- `isNightFinished(session)` = `passComplete && nothing outstanding`.
- `resolved` and `passComplete` are two different flags and must stay that way: a
  Ravenkeeper woken by the night kill means the pass is done while the night is not
  finished.
- `findStoredStep` **repairs** a missing record rather than letting call sites
  disagree about what a missing one means.

If you add a fifth question like these, route it through
`stepCountsAsOutstanding` or write down why it cannot.

## The line the table hears

`deriveStorytellerLine` in `shared/protocol/flow.ts` produces the sentence the host
device reads aloud. It is public information by construction: it may name a person,
never a role. It must never contradict `flow.announcement`, which the server
computes — when the two disagree the table is told two different things about who is
awake, and that was a real bug ("it said Dev close your eyes then Ada close your
eyes"). There is a test asserting they agree.

## The wake walk

One cursor (`night.wakeIndex`), not the stepper's `activeIndex` — the stepper is
presentation only and clicking it fast used to skip auto-resolving characters
entirely. `finishWake` opens a server-owned pause (`wakeGate`) between wakers so
the table cannot time the order; `tickNightGate` releases it. "Next" never advances
more than one waker and never moves past somebody who still owes a choice.

## The screens

Both pages follow one rule: **the one thing to do now, with its control directly
beneath it, and everything else behind a single "More" button.**

- A player has no tabs. There used to be five, rendered twice with different labels,
  and the night prompt sat above the tab bar while the instruction said "your prompt
  is below". `PlayerMomentCard` takes the moment's single control as a child, so
  "in view" is structural rather than a promise.
- A `PlayerMoment` never names a place — no "the Town Square tab". There is a test
  that fails if a tab, panel or button word appears in any state. That coupling is
  what made the prompt-behind-a-tab bug possible in the first place.
- The Storyteller leads with `StorytellerScript`, keeps the Grimoire and seating in
  view because they are needed all night, and puts the manual overrides, timer, night
  order, discretion, free-text sender, questions and chats behind More.
- Nothing is rendered twice. Two identical controls on one screen is not "belt and
  braces", it is a coin toss.

## Things the app used to get wrong, all found by playing

Worth remembering because each looked like a wording problem and was a rules problem:

- An auto-resolving or unmakeable character was told to close their eyes while the
  Storyteller stood there ready to tell them their information. In the real game you
  ARE woken for those.
- A player who had submitted was told "You're awake. Do the thing below" over a picker
  where every button was disabled. The server clears a waker's prompt only at dawn, so
  "has a prompt" is not the same as "owes a choice".
- A failed execution vote locked every player out of nominating for the rest of the
  day, because the client required no nomination at all rather than no OPEN one.
- The Storyteller's "Execute X" button never went away, and the server would run the
  same execution again, because `pendingExecution` stays true all day.
- An executed player was never told they had died: the night-kill path sends
  `PlayerSelfUpdate { alive: false }` and the execution path did not.
- The clients never learned that a nomination or a dead player's single vote had
  been spent, because the lobby was not rebroadcast, so a spent control stayed live.

- One save was logged twice, in two different wordings, so the audit trail the
  Storyteller is meant to trust showed one protection arriving as two lines. The
  existing test called the resolver directly, which skipped the line that duplicated
  it. A test has to drive the path the bug actually lived on.

- Two predicates were written, exported and never called, which is how the Virgin, the
  Slayer, and — hiding behind the Slayer — a rule that broke the day's central mechanic
  survived every test run.
- A test called *"returns the official First Night order"* asserted an order with the
  Poisoner fifth of seven, after every information role had been told the truth. A test whose
  name asserts a rule it does not check is worse than no test: it makes the bug look like a
  decision.
- Three tests held stale copies of the Empath's ability strings, which is how the app
  drifted to British "neighbours" while the official card says "neighbors".

The pattern: **a control that the server would refuse is a bug even when the server
refuses it correctly.** The client is the thing that has to know.

And the pattern above all: **tests that copy production strings or call a resolver directly
drift, and drift silently.** Assert against the thing the app actually reads.

And the recurring lesson from the sweeps: **a game that makes no progress is the
harness's fault until proven otherwise.** Both "nobody died in 20 nights" and "8
players never finished" were the sweep picking the first legal target for every
character, so the Monk protected exactly whoever the Imp was about to attack, and
the game could never get anywhere. Deriving health from what the ENGINE recorded
(the night log) rather than from a broadcast that may or may not arrive is what made
the real problem visible underneath it.

## Characters that act on their own

The Virgin and the Slayer were dead code for the app's whole life: the predicates existed,
were exported, and were called by **nothing**. Wiring `slayerWouldKill` up immediately
turned it into *any player who successfully nominates the Demon kills them instead of being
executed* — it never checked that the player nominating **was** the Slayer. Dead code does
not fail; it just looks correct. Existing end-game tests caught it on the first run.

Both now resolve the instant their condition is met, with no vote to confirm and no Execute
button, and both are published on `session.immediateExecution` and read by the flow.

**One kind of death, two very different deaths.** The Virgin's text is *"they are executed
immediately"* — a real execution, so `applyExecution` runs: it spends the day's one
execution, the Undertaker learns the victim, and a Saint nominator loses the game for Good
on the spot. The Slayer's kill is a character ability, so it does **none** of that: it is
its own `demon-slain` end reason, a Recluse registering as the Demon can be Slain, and that
is not a Demon death. `applyExecution` is the single owner of that bookkeeping, because two
copies of it is how the Undertaker and the Mayor end up disagreeing about the same day.

**Two more "one wake / one protection" facts worth not re-deriving:**

- The Ravenkeeper's wake is one-shot and is granted by the night that killed them, never by
  an execution. The step has to be visible in `buildNightOrder` — `isNightFinished` and the
  Storyteller's outstanding list both enumerate it, and a deferred step the order cannot see
  is a night that never finishes. So the condition is the `ravenkeeperWakePending` flag, which
  distinguishes died-at-night-and-unwoken from executed and from already-woken. `alive`
  cannot: it is the same value in all three.
- Protection is from the **Demon's ability**, and the Soldier is only protected while their
  ability works, so a poisoned or drunk Soldier dies to the Imp. The Monk is unaffected:
  theirs is an action already taken, so there is nothing for poison to undo.

## What must never be in a payload

`OwnCharacterPayload.teammates` is identities — a `playerId` and a `displayName`, and
deliberately **no character field**. "You learn who the other Minions are" is a list of
names, and only at 7+ players. Every Evil player used to be sent every other Evil player's
true character name, which is the whole script in one payload at the moment the game starts.

This is why the type is the guarantee: a character name cannot be added to that payload
without the type changing, and `buildPlayerDistributionPayload` returns `OwnCharacterPayload`
rather than the wider `DistributionPayload` union precisely so the field stays reachable and
therefore tested.

## Known limitations (not bugs, deliberate)

- **One connection per player and per Storyteller.** A second tab, or a phone as
  well as a laptop, silently stops receiving private night prompts and the
  Storyteller's night order. Room-based delivery would fix it. Found while building
  the simulator; not yet fixed.
- Character art and audio are out of scope.
