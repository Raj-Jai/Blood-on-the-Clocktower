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

Unit tests cannot tell you whether a game is playable. `/tmp/play` holds a harness
that drives real browser windows through real games, clicking the real UI and
reading the real DOM at every beat.

- `/tmp/play/ui.mjs` — opens the windows, seeds each one's `localStorage`, and
  exposes scoped helpers (`playerSubmit`, `nominateFrom`, `state`, `stMoreClick`, …).
- `/tmp/play/ui-game.mjs` — plays whole games: night, dawn, nomination, vote, death.
  `NIGHTS=3 node ui-game.mjs` from `/tmp/play`.
- `/tmp/play/ui-sizes.mjs` — the same at 5, 6 and 7 players. `SIZES=5,6,7 NIGHTS=3`.
- `/tmp/play/sweep.mjs` — a fast socket-only sweep of every legal table size,
  5 to 15. No browsers, so it covers the whole range in seconds and can play many
  games. `SIZES=5,15 GAMES=2 MAX_NIGHTS=25 node sweep.mjs`.
- `/tmp/play/moments.mjs`, `st-views.mjs` — screenshot every distinct moment, for
  judging the UI by looking at it rather than by reading the JSX.
- `/tmp/play/probe-*.mjs` — single-purpose probes written while chasing a bug.

This is what found essentially every real bug in the recent work. A test that
passes 170 times and then fails on a random roster is usually telling you the
product has two defensible answers and the test picked one.

Two hard-won rules for that harness:

1. **Never open a second socket for a player or the Storyteller.** `sendToPlayer`
   and `sendToStoryteller` (in `game/broadcast.ts`) emit to a single
   `connectionId`, so a second socket *steals* that player's private night prompts
   and the browser then looks like it lost them. This manufactured an hour of
   chasing a bug that did not exist. Read state from the real windows instead.
2. **Scope every click to its panel.** Matching button text across a whole page
   hits the wrong control: the TurnGuide's "Nominate someone" contains "Nominate"
   and sits above the Nominate panel's own "Nominate" button.

Driver assertions that are *correct app behaviour* and not bugs, learned the hard
way: the Fortune Teller picks two players so "Send my choice" stays disabled after
one click; a dead player cannot nominate; a nomination left open blocks the next
one; and a step can still read "waiting on a choice" at `night-resolving`, because
resolving with a choice missing is allowed and logged rather than blocked.

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

The pattern: **a control that the server would refuse is a bug even when the server
refuses it correctly.** The client is the thing that has to know.

## Known limitations (not bugs, deliberate)

- **One connection per player and per Storyteller.** A second tab, or a phone as
  well as a laptop, silently stops receiving private night prompts and the
  Storyteller's night order. Room-based delivery would fix it. Found while building
  the simulator; not yet fixed.
- Character art and audio are out of scope.
