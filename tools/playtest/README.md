# tools/playtest — playing the app for real

This harness drives **real browser windows through the real UI**. It exists because unit tests
cannot tell you whether a game is playable, and because the failures that actually bite a table are
a missing control, a button that is disabled at the moment it is needed, and a panel that says the
wrong thing.

It found every P0 in [`PLAYTEST.md`](../../PLAYTEST.md).

## The setup is through the UI too

The Storyteller clicks **Create Game** on the home page. The join code is then **read off the
lobby screen**, exactly as a host reads it out. Each player types that code and their name into the
join form and clicks the button.

Nothing is seeded into `localStorage` and nothing calls the REST API to set a game up. A harness
that `POST`s to `/api/sessions` behind the app's back cannot tell you what a first-time host sees,
and never exercises the join flow at all — which is where half the friction lives.

## Two rules. Do not break these.

Both were learned by wasting an hour, and both are in `MEMORY.md`.

1. **Never open a second socket for a player or the Storyteller.** Private night prompts are sent
   to a single `connectionId`, so a second socket **steals** that player's prompts and the browser
   then looks exactly like it lost them. Every fact is read from the real windows instead. The
   harness deliberately opens no socket at all.

2. **Scope every click to its own panel.** Matching button text across a whole page hits the wrong
   control: the moment card's "Nominate someone" contains the word "Nominate" and sits above the
   Nominate panel's own "Nominate" button. `clickIn()` takes a `within` heading for this reason.

## Running

Servers first — Vite on `:5173` and the game server on `:3001`:

```bash
npm install
npm run build --workspace=packages/shared   # the server consumes shared's dist
npm run dev:server
npm run dev:client
```

Then:

```bash
node tools/playtest/smoke.mjs                              # harness self-test. Run this first.
PLAYERS=5 NIGHTS=2 node tools/playtest/play-game.mjs       # a whole game, beat by beat
PLAYERS=7 NIGHTS=3 node tools/playtest/play-game.mjs
SCENARIO=vote   node tools/playtest/scenarios.mjs          # can an execution happen at all?
SCENARIO=half COUNT=6 node tools/playtest/scenarios.mjs    # exactly where is the threshold?
SCENARIO=twice  node tools/playtest/scenarios.mjs          # re-nominating the same player
SCENARIO=mayor  node tools/playtest/scenarios.mjs          # 3 alive, no execution
SCENARIO=saint  node tools/playtest/scenarios.mjs
node tools/playtest/probe-results.mjs                      # does anyone ever see a night result?
node tools/playtest/verify.mjs                             # Scarlet Woman boundary, tiebreak, ghost vote
```

| file | what it does |
|---|---|
| `table.mjs` | builds a table of real browser windows through the UI, and all the readouts |
| `lib.mjs` | `roster`, `markDead`, `runNomination`, `playNight`, `startDay` — one rules question per table |
| `smoke.mjs` | can the harness set a table up at all? |
| `play-game.mjs` | plays a whole game, narrating and screenshotting every beat |
| `scenarios.mjs` | `SCENARIO=` one rules question per table |
| `probe-results.mjs` | watches all windows at six beats for a night result |
| `verify.mjs` | the disputed and boundary cases |

Screenshots and per-run logs go to `shots/`.

## Playwright

Not a dependency of this repo, so it is resolved from wherever it happens to live rather than added
to `package.json` for a harness nobody runs in CI. Override with `PLAYWRIGHT_PATH`:

```bash
npx playwright install chromium
PLAYWRIGHT_PATH=$(npm root -g)/playwright/index.mjs node tools/playtest/smoke.mjs
```

## Adding a check

Read state from a screen, never from the server. If a fact you want is not on any screen, that is
itself a finding — write it up in `PLAYTEST.md` rather than working around it in the harness.

## Output

Probes write screenshots and per-run logs to `shots/`, which is **gitignored** — a full
sweep is a few hundred MB. The handful of screenshots `summary.html` embeds are copied to
`report-shots/`, which is committed, so the fix log renders from a clean clone.

## Probes

| Probe | What it proves |
|---|---|
| `probe-execution.mjs` | a passing vote can be executed, and everybody finds out |
| `probe-characters.mjs` | the Virgin and the Slayer both resolve, with no Execute button |
| `probe-evil-leak.mjs` | an Evil player's own screen names no other Evil character |
| `probe-results.mjs` | night results are shown at resolve and at dawn |
| `probe-renominate.mjs` | a player cannot be nominated twice in one day |
| `probe-vote.mjs` | a nomination must beat the day's highest earlier tally |

The deal is random and the app has no "use this script" control, so `probe-characters.mjs`
deals repeatedly until the character it needs turns up. That is slow, and it is the honest
version of the test: the app's randomness is part of what is being relied on.
