# AGENTS.md

Blood on the Clocktower companion app. A Storyteller hosts; players join from their own
device over a socket. The app replaces the real game's verbal rituals with one that knows
whose turn it is, what they may do, and what they learn. **Trouble Brewing only.**

## Commands

```bash
npm install
npm run build --workspace=packages/shared   # REQUIRED FIRST — see below
npm run dev:server                          # tsx watch, :3001
npm run dev:client                          # vite :5173, proxies /api + /socket.io to :3001
bash tools/playtest/restart-server.sh       # rebuild shared+server, restart detached :3001
```

`tools/playtest/restart-server.sh` is committed, so it survives a reboot. It **fails loudly on a
build error and kills the old `:3001` before starting a new one** — an earlier `/tmp` version
printed a success line even when the build had failed, which left a stale server answering while
the log claimed a fresh one. Do not go back to trusting a restart without checking the build ran.

Per-package tests (this is the form that works):

```bash
npx vitest run --root packages/shared    # 42 tests
npx vitest run --root packages/server    # 216 (19 files)
npx vitest run --root packages/client    # 70
```

Three traps:

- **`npm test` at the root is broken.** It fails on the client because
  `NODE_OPTIONS=--no-webstorage` (`packages/client/package.json:10`) is rejected by Node 22.21.1
  ("not allowed in NODE_OPTIONS"). Use `npx vitest run --root packages/client`.
- **The server consumes `packages/shared/dist`, not its source** — `@clocktower/shared` resolves
  through `main`/`types` to `dist`, and `dist/` is gitignored. On a fresh clone the server build
  and server tests fail until `npm run build --workspace=packages/shared` has run. A green server
  suite after editing `shared` means nothing if you skipped that build.

- **Run the server tests one file at a time, or with a single worker.** The full suite in one
  process peaked around 3.9 GB. `npx vitest run --root packages/server src/game/nightEngine.test.ts`
  is the form that survives.

There is **no lint or formatter** (no eslint/prettier anywhere). Typecheck is
`npm run typecheck --workspace=packages/<pkg>`; `npm run build --workspace=packages/client` runs
`tsc --noEmit` then `vite build`, so it is the full client gate.

## Architecture facts

- `packages/shared` — protocol, event names, Trouble Brewing data, zod schemas, and the *derived*
  state both sides agree on (`protocol/flow.ts`, `protocol/moment.ts`).
- `packages/server` — `session/store.ts` (in-memory `GameSession`), `gateway/` (socket handlers),
  `game/` (the night engine, abilities, rules, win conditions), `http/` (Express REST).
  Game logic is pure-ish functions in `game/*` that mutate the session; gateway handlers stay thin,
  start with `requireStoryteller`/`requirePlayer`, and are wrapped in `guarded()` so `ClocktowerError`
  and `ZodError` become typed error events instead of crashes.
- `packages/client` — `routes/PlayerGamePage.tsx` and `routes/StorytellerGamePage.tsx` are the two
  screens that matter. `HashRouter` at `#/play/:code` and `#/storyteller/:code`; session in
  `localStorage` under `botc:*` (see `api/storage.ts`).
- **No persistence.** `SessionStore` is a `Map`; a server restart loses every live game. Socket
  auth is an explicit `auth` message carrying a JWT, not a handshake. Join is
  `POST /api/sessions` → `{code, storytellerToken}`, then `POST /api/sessions/:code/join`.
- **One socket per player and per Storyteller.** `sendToPlayer`/`sendToStoryteller`
  (`game/broadcast.ts`) emit to a single `connectionId`, so a second tab silently steals that
  player's private night prompts. Known limitation, not fixed.

Conventions that differ from defaults:

- TypeScript imports carry the `.js` extension in source (`./store.js`) — the server is `NodeNext`.
- `tsconfig.base.json` sets `strict` **and `noUncheckedIndexedAccess`**, which is why tests are full
  of `players[0]!`. Do not relax it to make something compile.
- Styling is one hand-written stylesheet, `client/src/theme/tokens.css`, using semantic classes
  (`.panel`, `.btn`, `.faint`) plus inline `style={{}}`. No Tailwind, no CSS-in-JS. The playtest
  harness selects on `.panel`, so keep that class on panels.
- Client tests use jsdom + Testing Library (`test-setup.ts` just imports jest-dom).

## Invariants — the bugs that keep coming back

- **One definition of "is this step done?"** `stepCountsAsOutstanding(session, step)` in
  `game/nightEngine.ts` is the *only* definition. `wakerIsFinished` asks the same question for the
  wake walk; `isNightFinished` = `passComplete && nothing outstanding`. `resolved` and `passComplete`
  are different flags and must stay different (a Ravenkeeper woken by the kill ends the pass but not
  the night). `findStoredStep` repairs a missing record rather than letting call sites disagree.
  Two spellings of this question shipped three bugs. If you add a fifth, route it through
  `stepCountsAsOutstanding` or comment why it can't.
- **The wake walk** runs on one cursor, `night.wakeIndex` — *not* the stepper's `activeIndex`, which
  is presentation only. `finishWake` opens a server-owned `wakeGate` pause between wakers
  (`tickNightGate` releases it) so the table cannot time the order. "Next" advances one waker and
  never skips somebody who still owes a choice.
- **`deriveStorytellerLine` (`shared/protocol/flow.ts`)** is what the host reads aloud. Public
  information by construction: may name a person, never a role, and must never contradict the
  server-computed `flow.announcement`. A test asserts they agree — keep it agreeing.
- **Screens: one thing to do now, its control directly beneath it, everything else behind "More".**
  Players have **no tabs**. `PlayerMomentCard` takes the moment's control as a child so "in view" is
  structural. A `PlayerMoment` must never name a place — `shared/src/protocol/moment.test.ts` fails
  on any tab/panel/button word, and that coupling is what made the prompt-behind-a-tab bug possible.
  Nothing renders twice: two identical controls on one screen is a coin toss, not redundancy.
- **A control the server would refuse is a bug, even when the server refuses it correctly.** The
  client is the thing that has to know. Same for stale UI: if the server changed state, it must
  rebroadcast (`broadcastLobby`) or a spent control stays live.
- **Information hiding:** anything per-player and secret goes out only through `sendToPlayer`, and
  secrets are hidden on the server, not with CSS. Detection abilities read `perceivedAs()` /
  `registration`, never `alignment` — a Recluse is Good while registering as evil. TTS is opt-in,
  off by default, local `window.speechSynthesis` only, and never reads the Grimoire or another
  player's data; night info is not in an `aria-live` region.
- **A test has to drive the path the bug actually lived on.** A duplicate-log bug survived because
  the test called the resolver directly and skipped the line that duplicated it.
- **Dead code does not fail, it just looks correct.** `virginTriggersExecution` and `slayerWouldKill`
  were written, exported and called by *nothing* for the app's whole life. The instant the Slayer was
  wired up it broke the day's central mechanic, because the predicate never checked that the player
  nominating *was* the Slayer. If a predicate has no caller, either wire it up or delete it — and
  when you wire it up, the existing end-game tests are the thing that will tell you.
- **One owner for the execution bookkeeping.** `applyExecution` in `game/rules.ts` spends the day's
  one execution and writes `executedToday`, so the Mayor, the Undertaker and the vote path cannot
  disagree. The Virgin's ability routes through it because its text is *"executed immediately"*; the
  Slayer's kill deliberately does **not**, because a character ability is not a town execution, and
  conflating the two hands Evil a win they did not earn.
- **What a payload may never carry is enforced by its type, not by discipline.**
  `OwnCharacterPayload.teammates` has a `playerId` and a `displayName` and deliberately **no
  character field** — "you learn who the other Minions are" is a list of names, and only at 7+
  players. Every Evil player used to be sent every other Evil player's true character name. Keep
  `buildPlayerDistributionPayload` returning `OwnCharacterPayload` and not the wider
  `DistributionPayload` union: the wide type is why that field was untouchable and therefore untested.
- **A test whose name asserts a rule it does not check is worse than no test.** One was called
  *"returns the official First Night order"* and asserted an order that put the Poisoner fifth of
  seven, after every information role had been told the truth — so it made the bug look like a
  decision. Three more held stale copies of the Empath's ability strings, which is how the app
  drifted to British "neighbours" while the official card says "neighbors". Assert against the thing
  the app actually reads, never a copy of it.

## Verifying real behaviour

Unit tests cannot tell you whether a game is playable. `tools/playtest/` drives real browser
windows through the real UI, clicking real buttons and reading real DOM. It is committed, and
`tools/playtest/README.md` lists the probes and what each one proves. Start the server (`:3001`)
and the client (`:5173`) first.

```bash
node tools/playtest/smoke.mjs                                  # harness self-test; run first
PLAYERS=7 NIGHTS=3 node tools/playtest/play-game.mjs           # whole games, real UI
SCENARIO=vote node tools/playtest/scenarios.mjs
```

Playwright is not a dependency; `table.mjs` resolves it from `PLAYWRIGHT_PATH` or the npx cache and
throws with instructions if it can't. The older socket-only harness that used to live in `/tmp/play`
is **gone** — do not go looking for it. `tools/playtest/scenarios.mjs` and `sweep`-style coverage
are the replacements; the UI-only rule below is why a socket-only harness was never a substitute.

Probes write screenshots to `tools/playtest/shots/`, which is **gitignored** — a sweep is a few
hundred MB. The five the fix log embeds are copied to `tools/playtest/report-shots/` and committed,
so `summary.html` renders from a clean clone.

Harness rules, both learned by wasting an hour:

1. **Never open a second socket** for a player or the Storyteller. It steals their private prompts
   and looks exactly like a lost-prompt bug. Read state from the real windows instead.
2. **Scope every click to its panel.** Whole-page text matching hits the wrong control — the moment
   card's "Nominate someone" contains "Nominate" and sits above the Nominate panel's own button.

And: **a game that makes no progress is the harness's fault until proven otherwise.** Derive health
from what the engine recorded (the night log), not from a broadcast that may not have arrived. Also
assume the driver is right about the app: Fortune Teller needs two picks, a dead player cannot
nominate, an open nomination blocks the next, and a step can read "waiting on a choice" at
`night-resolving` because resolving with a choice missing is allowed and logged.

## Env and deploy

Server: `PORT` (default 3001), `CLIENT_ORIGIN` (comma-separated allow-list; CORS *and* Socket.IO),
`CLOCKTOWER_JWT_SECRET` (the process **refuses to start** in production without it). Client:
`VITE_SERVER_URL` (empty in dev so the Vite proxy is used). CI builds only the client to GitHub
Pages with `GITHUB_PAGES_BASE=/<repo>/` and `VITE_SERVER_URL` from repo variables; the server
deploys separately by hand. `npm run build` at the root orders shared → server → client — keep it.

## Repo docs: what to trust

- `MEMORY.md` — current working standards and the reasoning behind them. Read it; keep it accurate.
- `PLAYTEST.md` — **the play-derived bug report, and the record of what is fixed.** All 20 findings
  from the original audit are closed; the summary table's `Status` column says how, and the detail
  sections are kept as a record of what was wrong rather than as current behaviour. Start here.
- `ISSUES.md`, `PROMPT-issue2-night-engine.md` — **untracked, historical, and now banner-marked
  stale.** `ISSUES.md` is an audit written ~19 commits ago whose `file:line` citations are wrong and
  whose findings are all fixed; the issue-2 prompt was executed and superseded. Don't follow either
  as a task list. Two rules from the prompt still bind: the information-hiding invariant and the
  TTS/accessibility rules.
- `.kiro/specs/clocktower-web-app/` — frozen initial spec, contradicted by the code (it scopes out
  ability logic the Night Engine now owns, and specifies a player tab bar that was deliberately
  removed). Not a source of truth.
- **There are no open gaps tracked in code any more.** This file used to end by pointing at a
  `FIXME` for the Scarlet Woman threshold and at a Storyteller-connect broadcast that emitted to the
  raw session code. Both are fixed, so ignore any recollection of them; `git log` has the commits.

Branch note: work happens on `feature/night-engine`, which is **19 commits ahead of `main`** and has
no upstream. `main` is an ancestor, so it is a clean fast-forward rather than a merge — but `main`
does not contain the night engine or anything above it, so do not assume `main` has the app.
