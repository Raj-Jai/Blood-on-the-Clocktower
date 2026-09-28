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
bash /tmp/restart-otc.sh                    # rebuild shared+server, restart detached :3001
```

Per-package tests (this is the form that works):

```bash
npx vitest run --root packages/shared    # 35 tests
npx vitest run --root packages/server    # 171
npx vitest run --root packages/client    # 70
```

Two traps:

- **`npm test` at the root is broken.** It fails on the client because
  `NODE_OPTIONS=--no-webstorage` (`packages/client/package.json:10`) is rejected by Node 22.21.1
  ("not allowed in NODE_OPTIONS"). Use `npx vitest run --root packages/client`.
- **The server consumes `packages/shared/dist`, not its source** — `@clocktower/shared` resolves
  through `main`/`types` to `dist`, and `dist/` is gitignored. On a fresh clone the server build
  and server tests fail until `npm run build --workspace=packages/shared` has run. A green server
  suite after editing `shared` means nothing if you skipped that build.

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

## Verifying real behaviour

Unit tests cannot tell you whether a game is playable. `tools/playtest/` (untracked, actively being
built — check what is there) drives real browser windows through the real UI, clicking real buttons
and reading real DOM. Start the server (`:3001`) and the client (`:5173`) first.

```bash
node tools/playtest/smoke.mjs                                  # harness self-test; run first
PLAYERS=7 NIGHTS=3 node tools/playtest/play-game.mjs           # whole games, real UI
SCENARIO=vote node tools/playtest/scenarios.mjs
```

Playwright is not a dependency; `table.mjs` resolves it from `PLAYWRIGHT_PATH` or the npx cache and
throws with instructions if it can't. An older socket-only harness still lives in `/tmp/play`
(`SIZES=5,15 GAMES=2 node /tmp/play/sweep.mjs`, `NIGHTS=3 node /tmp/play/ui-game.mjs`) — outside the
repo, so it may be gone.

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

- `MEMORY.md` — current working standards and the reasoning behind them. Read it; keep it accurate
  (it is a bit behind on the harness, which has partly moved into `tools/playtest/`).
- `ISSUES.md`, `PROMPT-issue2-night-engine.md` — **untracked, historical.** `ISSUES.md` is an audit
  written ~11 commits ago and its `file:line` citations are now wrong; the issue-2 prompt was
  executed and superseded (its checkboxes are unticked but the work is committed). Don't follow
  either as a task list. Two rules from the prompt still bind: the information-hiding invariant and
  the TTS/accessibility rules.
- `.kiro/specs/clocktower-web-app/` — frozen initial spec, contradicted by the code (it scopes out
  ability logic the Night Engine now owns, and specifies a player tab bar that was deliberately
  removed). Not a source of truth.
- Open gaps are tracked in code, not in those docs: `FIXME(issue #2 follow-up)` in
  `server/src/game/winConditions.ts:33` (Scarlet Woman threshold — official text is "5 or more"),
  and the Storyteller-connect broadcast at `server/src/gateway/index.ts:273` still emits to the raw
  session code instead of `sessionRoom()`, so players get no connection signal.

Branch note: work happens on `feature/night-engine`; `main` is 17 commits behind and does not
contain the night engine. Do not assume `main` has the app.
