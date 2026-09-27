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
that drives six real browser windows through real games, clicking the real UI and
reading the real DOM at every beat.

- `/tmp/play/ui.mjs` — opens the windows, seeds each one's `localStorage`, and
  exposes scoped helpers (`playerSubmit`, `nominateFrom`, `orderFromUi`, …).
- `/tmp/play/ui-game.mjs` — plays whole games: night, dawn, nomination, vote.
  `NIGHTS=3 node ui-game.mjs` from `/tmp/play`.
- `/tmp/play/probe-*.mjs` — single-purpose probes written while chasing a bug.

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

## Known limitations (not bugs, deliberate)

- **One connection per player and per Storyteller.** A second tab, or a phone as
  well as a laptop, silently stops receiving private night prompts and the
  Storyteller's night order. Room-based delivery would fix it. Found while building
  the simulator; not yet fixed.
- Character art and audio are out of scope.
