> # ⚠️ STALE — DO NOT USE AS A TASK LIST
>
> This audit was written at `a8b4687` and is roughly **19 commits out of date**. Every finding in
> it has since been fixed, and its `file:line` citations point at code that has moved, so the
> references cannot be followed.
>
> **The current bug report is [`PLAYTEST.md`](PLAYTEST.md)** — start there. It records all 20
> original findings as closed, says how each was verified, and explains which two turned out not to
> be bugs at all.
>
> Kept only as a record of what was wrong. If you are about to "fix" something listed below, check
> `git log` first — it is probably already done.

# Blood on the Clocktower — Issue Audit

**Repo:** `pragatiekumari/Blood-on-the-Clocktower`
**Audited commit:** `a8b4687` ("Add Open Discussion chat visible to everyone at the table")
**Stack:** TypeScript monorepo — `packages/shared` (protocol + script data), `packages/server` (Express + socket.io), `packages/client` (React 18 + Vite)
**Script:** Trouble Brewing only (22 roles), 5–15 players

---

## How this was verified

Every finding below was confirmed by reading the source, not inferred. Reported issues were
traced end-to-end (client component → hook → protocol → gateway → rules engine) and checked
against the official Blood on the Clocktower rulebook. Two `npm test` runs were also executed.

**Legend:** `file:line` references are exact. Severity: **P0** blocks or corrupts core play ·
**P1** high · **P2** medium · **P3** polish.

---

## Verdict on the three reported issues

| # | Reported issue | Verdict |
|---|---|---|
| 1 | Room code not visible once the game starts; player who leaves can't rejoin | **Confirmed — and worse than described.** The code is *structurally impossible* to display in-game (not in the client state model at all), and rejoin is blocked server-side for any game past the lobby. |
| 2 | Storyteller job can be automated (voiceovers, etc.) | **Confirmed.** 20 of 22 roles have **zero** mechanical implementation. The night order is a static `<ol>` of names. No narration/TTS/assets of any kind exist in the repo. |
| 3 | Missing rules and game flow for first-time players | **Confirmed.** The in-game "Rules" button renders the *same 4 etiquette lines* as the one-shot onboarding modal. It teaches zero mechanics, cannot be reopened, and the Storyteller never sees any onboarding at all. |

The investigation also surfaced **46 additional issues**, including 6 more P0s — one of which
(a nomination dead-end) makes the game literally unplayable after the first vote of the day.

---

# P0 — Critical

## N1. Only ONE nomination per day is possible — the game dead-ends after the first vote ⭐

**This is the most severe bug in the codebase.**

The server is correct: each player has their own `hasNominatedToday` (`server/src/game/rules.ts:13,26`),
so the table is allowed many nominations per day. But the **client blocks every nomination after the first**:

```tsx
// client/src/routes/PlayerGamePage.tsx:47
const canNominate = session.phase === 'day' && session.alive && !session.nomination;
```

```tsx
// client/src/routes/PlayerGamePage.tsx:165-180
{session.nomination ? (<VoteTally ... />) : (<NominationBar canNominate={canNominate} ... />)}
```

`session.nomination` is populated by `onNominationOpened`, `onNominationVoteUpdate` and
`onNominationClosed`, and is **nulled in exactly one place** — the phase-change handler:

```ts
// client/src/hooks/useSession.ts:109-117
const onPhaseChanged = (payload) => {
  setState((s) => ({ ...s, phase: ..., dayNumber: ..., phaseEndsAt: ..., nomination: null }));
};
```

Once a nomination closes — whether it passed *or* failed — `session.nomination` remains a
non-null object with `closed: true`. `VoteTally` then renders its closed state
(`client/src/components/voting/VoteTally.tsx:29-32`) and `NominationBar` is **never rendered again**.

**User-visible symptom:** once the first nomination of the day resolves, no living player can
nominate anyone else for the rest of that day. The Town Square is a dead end. Tie-breaks, second
nominations, and "we should try someone else" are all impossible. The game is unfinishable as
played. There is no error message, no hint — the Nominate button simply ceases to exist.

`NominationBar` is the *only* nomination entry point in the app, and the Storyteller cannot
nominate at all.

**Fix:** key the nomination UI off `closed` (render the bar when `!nomination || nomination.closed`),
track `hasNominatedToday` per player so the button disables with a reason, and clear
`session.nomination` on `NominationClosed` in the store.

---

## N2. `StorytellerConnectionStatus` is emitted to a room nobody is in

Sockets join a **prefixed** room:

```ts
// server/src/game/broadcast.ts:8-10
export function sessionRoom(code: string): string { return `session:${code}`; }
```
```ts
// server/src/gateway/index.ts:230
socket.join(sessionRoom(identity.session.code));
```

But the "Storyteller connected" broadcast uses the **raw code** as the room name:

```ts
// server/src/gateway/index.ts:233
io.to(identity.session.code).emit(ServerEvents.StorytellerConnectionStatus, { connected: true });
```

`gateway/index.ts:233` is the **only** raw-`.code` room emit in the entire codebase — every other
one correctly wraps in `sessionRoom()`, including the matching *disconnect* path at
`gateway/index.ts:542`. No socket ever joins a room named `FX7K2`, so this emit reaches an empty room.

**User-visible symptom:** players are never notified when the Storyteller connects, and the
disconnect notification (which uses the correct room) is the only half that works. This is
compounded by a second, independent defect: `storytellerConnected` is tracked in client state
(`client/src/hooks/useSession.ts:42,152-154`) and **read in zero components**. So if the
Storyteller's tab crashes or their connection drops mid-game, the table silently freezes at
"Day 3" with no banner, no error, and no explanation. A game-breaking failure with no signal.

**Fix:** wrap line 233 in `sessionRoom()`, and render the tracked flag as a persistent banner.

---

## N3. No phase gating in the rules engine — you can nominate and vote in the lobby, at night, and on a corpse

`nominate()` validates alive/target/already-nominated/existing-nomination and **never reads
`session.phase`**:

```ts
// server/src/game/rules.ts:7-14
export function nominate(session, nominatorId, targetId) {
  const nominator = session.players.get(nominatorId);
  const target = session.players.get(targetId);
  if (!nominator || !target) throw Errors.playerNotFound();
  if (!nominator.alive) throw Errors.nominatorDead();
  if (!target.alive) throw Errors.targetDead();
  if (nominator.hasNominatedToday) throw Errors.alreadyNominatedToday();
  if (session.nomination && !session.nomination.closed) throw Errors.nominationInProgress();
```

`castVote` (`rules.ts:31-51`) and `closeVote` (`rules.ts:66-69`) never check the phase either. The
gateway only calls `requireGameNotEnded` (`gateway/index.ts:392,403,414`).

All of the following are reachable:

- **Lobby nominations.** `store.addPlayer` initialises `alive: true` (`store.ts:137`), and
  `POST /join` still succeeds in the lobby (`routes.ts:59`). The whole table can open a nomination
  and vote — with **no characters assigned**.
- **Night-phase nominations.** Day→night does not clear `session.nomination`
  (`gateway/index.ts:298-304` only resets when `phase === 'day'`), so voting continues all night.
- **Voting on an executed nominee.** `confirmExecution` sets `target.alive = false`
  (`rules.ts:110`) but leaves the nomination open and votable.

The only phase check in the entire flow is client-side (`PlayerGamePage.tsx:47`) — and the client
is not the authority. N1 shows what happens when client and server disagree.

**Fix:** a phase state machine with guards in `nominate`/`castVote`/`closeVote`/`resolveDemonKill`;
reject no-op transitions.

---

## N4. The Drunk is told they are the Drunk

```ts
// server/src/game/distribution.ts:117-130
const def = player.character ? getCharacterById(player.character) : undefined;
// ...
characterName: def.name, characterType: player.characterType, ability: def.ability,
```

The payload is built straight from the character definition, and the client renders it verbatim:

```tsx
// client/src/routes/PlayerGamePage.tsx:125-130
<CharacterCard characterName={distribution.characterName} ... ability={distribution.ability} />
```

The Drunk's own ability text reads *"You do not know you are the Drunk. You think you are a
Townsfolk character, but you are not."* (`shared/src/scriptData/troubleBrewing.ts:143-150`) — and
the app renders the heading **"Drunk"**.

**User-visible symptom:** the single most damaging possible information leak to that player, and
the exact inverse of the printed card. It also breaks the Drunk's entire function, since a Drunk
who knows they are the Drunk will knowingly lie rather than unknowingly lie.

**Fix:** a lie layer in `buildPlayerDistributionPayload` for the Drunk (and any other
"you don't know" role), driven by data rather than hardcoded.

---

## N5. Scarlet Woman is off by one — Good wins when the official rules say the game continues

```ts
// server/src/game/winConditions.ts:31-32
export function tryScarletWomanTakeover(session, deadDemonId) {
  if (livingPlayerCount(session) < 5) return null;
```

This runs **after** the Demon is already dead (`rules.ts:110` sets `alive = false`, then
`gateway/index.ts:431` → `:171`). The official rule is *"5 or more players alive **just before**
the Demon dies — that is, 4 or more players left alive **after** the Demon dies."*

The code requires 5 alive *after* the death, so the correct guard is `< 4`.

**User-visible symptom:** in a 5-player game, executing the Imp leaves 4 survivors → the guard
returns `null` → `checkWinCondition` finds no living Demon → **Good wins and the game ends**,
even though a living Scarlet Woman should have been promoted to Imp and play should continue.
The most dramatic possible ending, decided by an off-by-one.

This is locked in by tests, so CI will not catch it:
- `server/src/game/winConditions.test.ts:87-89` — *"6 total so that AFTER the Demon's death, 5
  players are still alive"* with a comment asserting the post-death reading
- `server/src/gateway/winFlow.test.ts:183-184` — *"…and 5+ players remaining triggers takeover"*
  uses a 6-player game

**Fix:** change to `< 4` and update both tests.

---

## N6. "Must beat the day's previous highest tally" is missing → wrong player executed, two executions per day

The only cross-nomination rule implemented is an **exact** tie:

```ts
// server/src/game/rules.ts:78-91
if (qualifies) {
  const tiedWithEarlier = session.resolvedNominationsToday.some((r) => r.tally === votesFor);
  if (tiedWithEarlier) { ... } else {
    nomination.pendingExecution = true;
    session.resolvedNominationsToday.push({ targetId: nomination.targetId, tally: votesFor });
  }
}
```

Two concrete rule violations:

**1. A lower tally executes while the higher one is silently discarded.** 7 players → threshold 4.
Nomination A gets 5 yes → `pendingExecution = true`, recorded as `{A, 5}`. Nomination B gets 4 yes →
qualifies, `4 !== 5`, so `pendingExecution = true` as well. The Storyteller now has **two
"Confirm Execution" candidates for the 4-vote nominee**, while the 5-vote nominee is unreachable —
`nominate()` overwrites the single `session.nomination` slot (`rules.ts:27`).

**2. Two executions in a single day.** The official rule is *"Once each day, the town may execute
a resident."* `confirmExecution` actively **erases** the record of the earlier tally so no
comparison is possible:

```ts
// server/src/game/rules.ts:111-112
session.resolvedNominationsToday = session.resolvedNominationsToday.filter((r) => r.targetId !== nomination.targetId);
```

After executing A, a fresh nomination B that merely meets the threshold (against the now-lower
living count) is immediately pending and can be executed the same day. There is no
`executionsToday` counter anywhere in `GameSession` (`store.ts:53-74`).

The exact-tie path itself is correct and does match *"On a tie between players, neither player is
executed"* (`rules.ts:81-84`).

**Fix:** compare against the day's highest qualifying tally and require a strict greater; add a
one-execution-per-day guard.

---

## N7. Hardcoded fallback JWT secret — forgeable god-mode token

```ts
// server/src/session/tokens.ts:3-18
const DEV_SECRET = 'dev-secret-not-for-shared-hosting';
function resolveSecret(): string {
  const configured = process.env.CLOCKTOWER_JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CLOCKTOWER_JWT_SECRET must be set in production …');
  }
  return DEV_SECRET;
}
const SECRET = resolveSecret();
```

The hard failure only fires when `NODE_ENV === 'production'`. **Any deployment that does not
explicitly set that variable** — staging, preview, most PaaS defaults — starts with a publicly
known HS256 secret that is committed to the repository.

**Attack path:** forge a payload matching `signStorytellerToken` (`tokens.ts:33-36`) to obtain
Storyteller god-mode over any session whose 5-character code you can guess. Session codes are
brute-forceable (N32), and the lookup endpoints are unauthenticated and return distinguishable
404 vs 200/403, giving a clean enumeration oracle.

`jwt.verify(token, SECRET)` with a string secret is otherwise sound (no `alg: none` /
algorithm-confusion issue).

**Fix:** fail closed on a missing secret in **every** environment.

---

# Reported Issue 1 — Room code and rejoin

## R1a. The room code is displayed *only* in the lobby

The code is rendered in exactly one place in the entire client:

```tsx
// client/src/routes/LobbyPage.tsx:22
Join code: <strong style={{ fontSize: 22, letterSpacing: '0.1em' }}>{code}</strong>
```

…and `LobbyPage` is swapped out the moment the phase changes:

```tsx
// client/src/App.tsx:26-30 (storyteller) and :57-60 (player)
{session.phase === 'lobby' ? (<LobbyPage code={code} ... />) : (<StorytellerGamePage ... />)}
```

Neither `PlayerGamePage` nor `StorytellerGamePage` receives a `code` prop, and **the code is not
even present in the client data model** — `SessionState` (`useSession.ts:30-53`) has no `roomCode`
field, and the `AuthOk` payload doesn't carry one:

```ts
// server/src/gateway/index.ts:245-251
socket.emit(ServerEvents.AuthOk, {
  role, phase, dayNumber, phaseEndsAt, gameResult,
});
```

**User-visible symptom:** the instant the Storyteller clicks "Start Distribution", the code
vanishes from every screen — **including the Storyteller's own screen**. For the next two hours
of real play, if a player asks "what's the code?" or "I need to switch phones," nobody in the
game can answer. This also breaks the physical convention of writing the code on a whiteboard.

## R1b. Rejoining mid-game is blocked server-side

```ts
// server/src/http/routes.ts:59-61
if (session.phase !== 'lobby') {
  throw Errors.lobbyClosed();
}
```

There is **no rejoin endpoint**. The only path back in is the token in `localStorage`:

```tsx
// client/src/App.tsx:39,49
const validToken = stored.playerToken && stored.code === code ? stored.playerToken : null;
if (!validToken) return <Navigate to="/" replace />;
```

**User-visible symptom:** a player who switches devices, clears browser data, uses a different
browser, or opens a private window is **permanently locked out** of a game in progress. They cannot
rejoin, and there is no recovery flow for the Storyteller to re-seat them.

Worse, re-entering the code on the home screen does **not** rejoin — it mints a *brand-new* player:

```tsx
// client/src/routes/HomePage.tsx:58-59
const { playerId, playerToken } = await joinSession(code, displayName.trim());
savePlayerSession(code, playerId, playerToken);
```

The server rejects it (`lobbyClosed`) *if* the game started. So the player is stuck between two
dead ends: no token (locked out), and retyping the code (rejected, or a duplicate empty-handed
player if the game somehow hasn't started).

## R1c. One token slot for the whole app — joining a game destroys your Storyteller session

```ts
// client/src/api/storage.ts:15-27
export function saveStorytellerSession(code, token) {
  storage().setItem(SESSION_CODE_KEY, code);
  storage().setItem(STORYTELLER_TOKEN_KEY, token);
  storage().removeItem(PLAYER_TOKEN_KEY);   // ← wipes player session
  storage().removeItem(PLAYER_ID_KEY);
}
export function savePlayerSession(code, playerId, token) {
  storage().setItem(SESSION_CODE_KEY, code);
  storage().setItem(PLAYER_TOKEN_KEY, token);
  storage().setItem(PLAYER_ID_KEY, playerId);
  storage().removeItem(STORYTELLER_TOKEN_KEY);  // ← wipes storyteller session
}
```

**User-visible symptoms:**
- On a device that has hosted a game, joining **any** game as a player erases the Storyteller
  token; `App.tsx:21` then redirects the host out of their own game with no warning.
- Storage is a single flat slot (`botc:sessionCode`), not per-game, so joining a second game
  silently orphans the first.
- `clearStoredSession()` (`storage.ts:37`) is **never called from application code** — only from
  its own test. There is no "Leave game" or "Log out" anywhere in the UI.

## R1d. A server restart destroys the game irrecoverably

```ts
// server/src/session/store.ts:80
private sessions = new Map<string, GameSession>();
```

All state is in-process memory. A restart, crash, scale event, or free-tier host recycle makes
every token resolve to `undefined` → `Errors.invalidJoinCode()` (`socketAuth.ts:22-25`). Because
`routes.ts:59-61` blocks joins once the phase leaves the lobby, **players cannot rejoin to
recover — the game is gone.** No database, no Redis, no snapshot.

## R1e. Related: joining is not idempotent, seats leak

`SessionStore.addPlayer` (`store.ts:129-147`) does not enforce `MAX_PLAYERS` (only `routes.ts:68`
does) and there is **no `removePlayer`**. A player who joins the lobby and vanishes permanently
consumes a seat, a `seatIndex`, and a character from the distribution — with no way for the
Storyteller to remove them or free the slot.

---

# Reported Issue 2 — Storyteller automation

## R2a. 20 of 22 roles have no implementation at all

Only two roles have any mechanical behaviour:
- **Imp** — `server/src/game/demonKill.ts`
- **Scarlet Woman** — `server/src/game/winConditions.ts:31-50`

Grepping the server for role ids returns nothing outside those two files. Every other ability —
Washerwoman, Librarian, Investigator, Chef, Empath, Fortune Teller, Undertaker, Monk, Ravenkeeper,
Virgin, Slayer, Soldier, Mayor, Butler, Drunk, Recluse, Saint, Poisoner, Spy, Baron — is delivered
as **free text the Storyteller types by hand** into a single box:

```tsx
// client/src/routes/StorytellerGamePage.tsx:276-297  "Share an Ability Result"
<input className="input" placeholder="Result text to share with them" ... />
```
```ts
// server/src/gateway/index.ts:352-361
sendToPlayer(io, player, ServerEvents.PlayerSelfUpdate, { abilityResult: text });
```

There is no ability-resolution engine, no auto-suggested result, no validation, and no per-target
UI. The Storyteller is the entire rules engine.

## R2b. The night order is a static list of names

```tsx
// client/src/components/grimoire/NightOrderPanel.tsx:22-27
<ol style={{ paddingLeft: 20, lineHeight: 1.6 }}>
  {ordered.map((c) => (<li key={c.id}>{c.name}</li>))}
</ol>
```

A read-only `<ol>`. **No** checkbox, **no** completion state, **no** per-role prompt, **no** target
picker, **no** "who woke tonight" roster, **no** "already done" marker, **no** undo. The
Storyteller runs the night from memory on a piece of paper.

## R2c. There is no automation metadata in the data model to build on

```ts
// shared/src/scriptData/types.ts:4-12
export interface CharacterDefinition {
  id: string; name: string; type: CharacterType; alignment: Alignment;
  ability: string; firstNightOrder: number | null; otherNightOrder: number | null;
}
```

That is the entire schema. Grepping for `nightPrompt|prompt|suggestion|reminder` across
`shared/src` and `client/src` returns **zero** matches. Missing, per role: the prompt text, how
many players to choose, target restrictions ("not yourself", "any 2"), `registerAs` info
(Recluse/Spy), and the *type* of information delivered (character / count / yes-no /
good-vs-evil). Without these, no amount of UI work can automate the night.

## R2d. No voiceover, narration, or any media whatsoever

Grep for TTS / `speechSynthesis` / `SpeechSynthesisUtterance` / `audio` / `.mp3` / `.ogg` returns
**zero hits**. There is no `public/` directory, no `<img>`, no SVG, no icon set. Iconography is
100% emoji (`🕛 🪑 📜 🎭 💀 🔔 🏆 ⚠️ 🌙 ☀️`) and `index.html:5-6` has no favicon, guaranteeing a 404.

## R2e. Specific automation gaps and bugs

| Gap | Evidence |
|---|---|
| **No once-per-night tracking** — the ST can send the same ability result repeatedly | `StorytellerGamePage.tsx:63-67` has no guard and only clears the textbox |
| **No bulk "clear all poison at dawn"** | absent from the whole codebase |
| **No end-of-night summary or "night complete" gate** | absent |
| **The Imp is missing from Night 1** | `troubleBrewing.ts:219` — `firstNightOrder: null` on the Imp, so `NightOrderPanel.tsx:12` filters it out. The app tells the ST *not* to wake the Demon on Night 1. (13 roles have `firstNightOrder: null`; for the 12 with `*` that's correct — the Imp is the bug.) |
| **Imp self-kill heir is picked at random by the server** | `demonKill.ts:51-57` `const [heir] = shuffle(candidates);` — the official rule is *"**choose** an alive Minion"*, a Storyteller decision. The UI even advertises the bug: *"hands the role to a **random** living Minion"* (`StorytellerGamePage.tsx:184`) |
| **The new Demon's bluff is stale** | `demonKill.ts:57-60` doesn't clear `bluffCharacterId` and `assignBluffs` isn't re-run, so a promoted Minion keeps their pre-Minion bluff |
| **Night kill is not gated to the night phase** | `gateway/index.ts:436-446` has no `session.phase === 'night'` check; the button renders whenever the game is live (`StorytellerGamePage.tsx:158-181`). The ST can fire a night kill at noon. |
| **No night-order enforcement** | Poisoner → Spy → Townsfolk → Imp ordering is never checked |
| **The Spy never receives the Grimoire** | `broadcast.ts:53-55` sends it only via `sendToStoryteller` — the Spy's defining ability is impossible |
| **Baron's [+2 Outsiders] never applied** | `distributionTable.ts:28-34` is static and `distribution.ts:46-52` never inspects whether the Baron was drawn. A 10-player game with the Baron draws 0 Outsiders when it must draw 2. |
| **No Butler field exists** | "You may only vote if they are voting too" is unenforceable |
| **No Recluse/Spy registration model** | "might register as evil & as a Minion or Demon, even if dead" — the Fortune Teller / Investigator / Chef / Empath cannot be served consistently |
| **Virgin and Slayer are unmodelled** | Good can execute a nomination of the Virgin with no consequence |
| **Timer is purely cosmetic** | `phaseEndsAt` is written (`gateway/index.ts:275,304,316`) and only read for the payload (`:99-103`); the server's only interval is session cleanup (`index.ts:28`). Phases never auto-advance and a vote deadline never closes a vote. |
| **Two server events have no UI** | `StorytellerRedistribute` and `StorytellerSetPlayerAlignment` exist (`events.ts:5,10`) and are implemented (`gateway/index.ts:282-291`, `:363-375`) but are used in **zero** client files. The ST cannot re-roll a bad distribution or fix a mis-assigned alignment. |
| **The ST page is one unbroken ~300-line scroll** | `StorytellerGamePage.tsx:159-303` — Game Control, timer, seating, grimoire, night order, nomination, ability result, Q&A, and both chats stacked vertically with no tabs, anchors, or sticky nav. The Q&A queue and chats sit below a 20-row grimoire table you must scroll past every time. |
| **Evil teammates revealed with true characters** | `distribution.ts:105-114` includes `character`/`characterName`, rendered at `PlayerGamePage.tsx:143-146`. The standard is that evil learns *who*, not exact roles — and a ST who decided to bluff a Minion is actively misled. |

## R2f. `redistribute` leaves the session in an inconsistent, joinable state

```ts
// server/src/gateway/index.ts:282-291
if (session.phase !== 'lobby') throw Errors.distributionAlreadyDone();
resetDistribution(session);
distributeRoles(session);
broadcastDistribution(io, session);
```

It never changes `phase`, and `routes.ts:59-61` only blocks joins when `phase !== 'lobby'`. So
after this emit, players hold real characters while the session is *still a lobby*, and more
players can join. A newcomer gets `character: null` (`store.ts:133`), receives **no**
`game:distributed` on auth (`gateway/index.ts:240` gates on `character`), yet is `alive: true` —
so they can nominate and vote with no character, landing on `PlayerGamePage` with
`distribution: null` and a blank character tab.

---

# Reported Issue 3 — Missing rules and game flow

## R3a. The entire "rules" content is four etiquette lines

```ts
// shared/src/content/onboarding.ts:16-21
export const CORE_RULES: string[] = [
  'Talk freely, whenever you want.',
  "Don't peek at anyone else's character or the Grimoire.",
  "Ask the Storyteller anything — that's what they're there for.",
  'Play kindly. Win or lose with grace.',
];
```

No mechanics. And the in-game **"Rules" button** renders the *same four lines*:

```tsx
// client/src/routes/PlayerGamePage.tsx:95-97
<button className="btn btn-inline" onClick={() => setShowRules(true)}>Rules</button>
```
```tsx
// client/src/components/onboarding/RulesReferencePanel.tsx:29
{CORE_RULES.map((rule) => (<li key={rule}>{rule}</li>))}
```

**Never taught anywhere in the app:**
- What a nomination is, or that you get **one per player per day**
- The **50% execution threshold** — the single most important number in the game
- That **dead players get exactly one vote**, ever
- The step-by-step **day/night cycle** (beyond one sentence: `onboarding.ts:23-25`)
- That **the Storyteller wakes you at night** and you may **lie then**
- What **poisoned / drunk / protected** mean
- **Seat order and neighbours** as a concept
- The full **win conditions** (beyond one line each, `onboarding.ts:11-14`)
- That your **teammates know you** if you're Evil

## R3b. The execution threshold is never shown to players

The server computes it correctly:

```ts
// server/src/game/rules.ts:53-56
export function executionThreshold(session: GameSession): number {
  return Math.ceil(livingPlayerCount(session) / 2);
}
```

…but it is **never included in the payload**. `ActiveNominationView`
(`shared/src/protocol/session.ts:63-70`) carries only `votes`, `closed`, `pendingExecution`. So
the player sees a bare number:

```tsx
// client/src/components/voting/VoteTally.tsx:27
Votes for execution: <strong>{yesVotes}</strong>
```

**User-visible symptom:** a player staring at "Votes for execution: 2" has no denominator and no
target — they cannot tell whether the nominee is winning or losing. The game's central decision is
being made blind. Only the Storyteller can compute it.

Related: `VoteTally.tsx:31` says *"This nomination met the threshold"* without ever saying what
the threshold was.

## R3c. Onboarding is one-shot, per-browser, and permanently unreachable

```tsx
// client/src/App.tsx:42,62-70
const [showOnboarding, setShowOnboarding] = useState(!hasSeenOnboarding());
// …rendered ONLY in PlayerRoute…
{showOnboarding && (<OnboardingModal ... />)}
```

- Dismiss it once and `THEME_STEP`, `GOAL_STEP_GENERIC` (the **only** win-condition text in the
  app) and `DAY_NIGHT_SUMMARY` (the **only** day/night explanation) are **unreachable forever**.
- The "Rules" button opens `RulesReferencePanel`, **not** the modal.
- `hasSeenOnboarding()` is keyed on `localStorage` (`storage.ts:44-50`) — so it is **per-browser,
  not per-player**. A second player on a shared device never sees it; a returning player in a new
  game never sees it again.
- The **Storyteller route has no onboarding, no rules link, and no guide of any kind**
  (`App.tsx:14-34`) — yet the ST is the person who most needs to know the rules.

## R3d. Onboarding opens in the lobby, before roles exist, and flashes the enemy win condition

`alignment` is `null` until `GameDistributed` arrives:

```tsx
// client/src/App.tsx:52
const alignment = session.distribution?.role === 'player' ? session.distribution.alignment : null;
```

With `alignment === null`, `OnboardingModal` takes the `else` branch and renders **both**
alignments:

```tsx
// client/src/components/onboarding/OnboardingModal.tsx:62-71
) : (<>
  <p className="alignment-good">{GOAL_STEP_GENERIC.good}</p>
  <p className="alignment-evil">{GOAL_STEP_GENERIC.evil}</p>
</>)}
```

**User-visible symptom:** a brand-new player's *first screen* is an opaque modal over a
"Connecting to the game server…" banner and an empty lobby — before they have a character — and
it tells Good players the Evil win condition.

## R3e. Additional onboarding gaps

- **Players are never told their own vote.** `VoteTally.tsx:18` computes `myVote` and uses it
  *only* in `disabled` expressions (`:37,42`) — it is never rendered. The only feedback after
  voting is a button greying out.
- **The "Retract / No" label is a lie.** `VoteTally.tsx:43` is labelled `Retract / No`, but the
  server consumes a ghost vote at cast time "regardless of later retraction"
  (`rules.ts:44-46`). A **dead** player who clicks it silently burns their one vote for the entire
  game, with no warning. `usedDeadVote` exists in the payload (`protocol/session.ts:29`) but is
  never rendered by `GrimoireTable` and is absent from `OwnCharacterPayload`, so the player can't
  see it either.
- **Seat numbers are never displayed to anyone.** `SeatingCircle.tsx:93` renders
  `displayName.slice(0,2).toUpperCase()`; `GrimoireTable.tsx:59-65` columns are Player / Character /
  Alignment / Living Neighbors / Status / Alive. Seat-based abilities (Washerwoman "even if dead",
  Poisoner "left neighbour", Thief "right neighbour") can't be discussed by number — a core table
  convention is missing.
- **The role-reveal moment has no banner.** `PlayerGamePage.tsx:123-131` — the character card
  simply appears on the default tab. Compare `ExecutionBanner` (🔔, 6s, `role="alert"`) and
  `GameEndedBanner` (🏆, persistent). A player who glances away when roles land **misses their own
  role permanently** — no replay, no "You are the…" modal, no sound.
- **`CharacterCard` has no tap-to-hide.** It is 32 lines of pure text with no image and no conceal
  affordance, so a player cannot hide their character on a shared screen — a hard requirement when
  the physical game forbids peeking.
- **No "How to play" on the home page.** `HomePage.tsx:70-73` is a title and one sentence. There is
  no way for a first-time visitor to learn what the game is *before* joining.
- **Dead players are never taught anything.** The only dead-state indicator is one line in a
  scrolling header (`PlayerGamePage.tsx:86`).

---

# P1 — High

## N8. No state resync on reconnect → desync and lost game state

```ts
// server/src/gateway/index.ts:245-251
socket.emit(ServerEvents.AuthOk, { role, phase, dayNumber, phaseEndsAt, gameResult });
```

No nomination, no `alive`, no last execution, no ST's current-nomination state. The reconnect path
is otherwise well built (re-auth on every connect, correct stale-socket guard at `:539-549`), but:

- **Refresh during a nomination:** the server keeps `session.nomination` and the whole vote Map,
  but the client never learns the `nominationId` — so the player **cannot vote or retract at all**.
  `useSession.ts:128-136` only populates from live events, and `onPhaseChanged` actively nulls it.
- **Dead player refreshes:** `alive` defaults to `true` (`useSession.ts:69`) and
  `OwnCharacterPayload` carries no `alive` field (`protocol/session.ts:38-49`). The client renders
  a fully-alive UI — `canNominate` computes `true` — until the server pushes an update, then
  rejects the action with `NOMINATOR_DEAD`. The "You are dead" banner is lost entirely.
- **Storyteller refreshes:** the grimoire is resent (`:234`) but the Active Nomination panel is
  **not**, so `closeVote`/`confirmExecution` (`StorytellerGamePage.tsx:69-79`) are unreachable —
  **a passed execution can be lost by a page refresh.**

## N9. `abilityResult` can never be cleared — stale private info leak

```ts
// client/src/hooks/useSession.ts:121-127
const onSelfUpdate = (payload) => {
  setState((s) => ({ ...s,
    alive: payload.alive ?? s.alive,
    abilityResult: payload.abilityResult ?? s.abilityResult,   // ← never resets
  }));
};
```

Once set, `abilityResult` is never cleared — not on phase change, not on day rollover
(`onPhaseChanged` at `:109-117` doesn't touch it). It renders at `PlayerGamePage.tsx:131-136`.

**User-visible symptom:** Night 1's private result ("You are the Washerwoman; Bob is the Butler")
stays pinned on the Character tab through Day 1, Night 2, Day 2 and the rest of the game,
indistinguishable from tonight's information. On a shared screen this is a serious accidental
information leak, and the player has no way to dismiss it.

## N10. The game starts in "Day 1", not Night 1 — and every day number is off by one

```ts
// server/src/gateway/index.ts:272-275
distributeRoles(session);
session.phase = 'day';
session.dayNumber = 1;
```

The real game begins at **Night 1**. As implemented:
- The app announces "Day 1" before the Imp has ever killed, and (per N3) players can nominate and
  vote immediately with a full grimoire and no night.
- When the ST finally switches to `day`, `gateway/index.ts:301` increments `dayNumber` → the
  **first real day is labelled "Day 2"**, and every subsequent day is shifted
  (`PlayerGamePage.tsx:84`, `StorytellerGamePage.tsx:143`).
- `NightOrderPanel`'s `isFirstNight` only works by accident of the manual step
  (`StorytellerGamePage.tsx:252`: `session.dayNumber <= 1 && session.phase === 'night'`).

## N11. Tab state and half-typed messages are destroyed on every phase change

`PlayerGamePage` is conditionally mounted on `phase === 'lobby'` (`App.tsx:57-60`), so **every
day↔night flip unmounts and remounts it**. Consequences:
- The active tab resets to `'character'` (`PlayerGamePage.tsx:39`).
- **Any half-typed chat or question text is lost** — `text` state is local to `OpenChatPanel.tsx:12`,
  `EvilChatPanel.tsx:12`, `QuestionQueuePanel.tsx:19`, `StorytellerQuestionPanel.tsx:11`.
- Tab state is never persisted to `localStorage`.

A player deep in a theorycrafting conversation in the Talk tab is yanked back to their character
card the moment night falls, mid-sentence.

## N12. No double-submit guards; a duplicate day transition is destructive

Every `socket.emit` is fire-and-forget with **no acknowledgement and no in-flight disable**:
`PlayerGamePage.tsx:50-58`, `StorytellerGamePage.tsx:35-40,89-93`, `LobbyPage.tsx:45`.

- **Double-clicking "Switch to Day"** calls `resetForNewDay` twice (`gateway/index.ts:298-302`) →
  **double-increments `dayNumber`** *and* **resets `hasNominatedToday` mid-day**, granting every
  player an extra nomination.
- A redundant `day → day` emit (also reachable by any ST client bug) calls `resetForNewDay`, which
  sets `session.nomination = null` (`rules.ts:121`) — **dropping a nomination that already has
  `pendingExecution === true`**. A passed execution is silently lost.
- `NominationBar.tsx:36-39` clears the selection immediately on emit, so a server rejection leaves
  the player with a vanished selection and a 5-second toast.

## N13. `confirmExecution` is not idempotent

`rules.ts:101-114` never sets `pendingExecution = false` and `ActiveNomination` has no `executed`
flag (`store.ts:25-34`). Emitting `storyteller:confirmExecution` twice with the same
`nominationId` passes the `!closed || !pendingExecution` guard **both** times, re-runs
`target.alive = false`, and re-enters `handlePostDeath` (`gateway/index.ts:422-434`) — a second
`broadcastGrimoire` and a second `tryScarletWomanTakeover` attempt.

## N14. Chat never auto-scrolls, is unbounded, and has no unread indicator

`EvilChatPanel.tsx:19-36` and `OpenChatPanel.tsx:20-37` set `maxHeight` + `overflowY: 'auto'` but
contain **no `useEffect`/ref scroll-to-bottom**. Meanwhile `useSession.ts:141,147` append forever
with no cap, no virtualisation, and no unread badge on the Talk/Chat tabs.

**User-visible symptom:** a player who has scrolled up to read history does not see new messages
arrive — they append silently below the fold. A player on the Town tab, or a dead player, has no
indication that discussion is happening at all. Chat history is capped server-side at 200
(`store.ts:76`) but that cap is never signalled.

## N15. `ConnectionBanner` gives false reassurance on a *first* connection failure

```ts
// client/src/hooks/useGameSocket.ts:60
socket.on('connect_error', () => setStatus(hasConnectedOnce ? 'reconnecting' : 'disconnected'));
```
```tsx
// client/src/components/shared/ConnectionBanner.tsx:16
const isInitialConnect = status === 'connecting';
```

`'disconnected'` is therefore treated as a reconnect. **A player whose very first connection fails**
(server asleep, wrong `VITE_SERVER_URL`, offline) is told *"Reconnecting — your connection dropped,
don't worry, your game state is safe."* They never connected, there is no state, and there is no
retry button, no error detail, and no timeout — the UI sits on a reassuring lie indefinitely.

## N16. Chat has no auto-scroll, and Storyteller messages are indistinguishable from player messages

```tsx
// client/src/components/chat/OpenChatPanel.tsx:33  (and EvilChatPanel.tsx:32)
{senderName}
```

The Storyteller posts into the same channels players use (`StorytellerGamePage.tsx:301`), rendered
with the same styling. **When the Storyteller types in Open Chat it looks exactly like a player
claim** — a real integrity hazard in a social-deduction game.

## N17. `poisoned` / `drunk` / `protected` are dead data — enforced nowhere

Grepping `statusEffects` across the server returns only: the type (`protocol/session.ts:5-9,28`),
the schema (`schemas.ts:18-25`), initialisation (`store.ts:139`, `distribution.ts:99`), the ST
write (`gateway/index.ts:322-332`), and the ST read for display (`broadcast.ts:43`).
**No game-logic file reads them.** Consequences:

- `resolveDemonKill` kills unconditionally — `demonKill.ts:45` `target.alive = false;` with no
  `protected` check → **the Monk and the Soldier do absolutely nothing**. The UI checkboxes at
  `GrimoireTable.tsx:181-188` are cosmetic.
- `castVote` and `closeVote` never consult `poisoned` → **the Poisoner has no mechanical effect**
  and the app cannot be used to deliver a lie.
- No Butler field exists, so "you may only vote if they are voting too" is unenforceable.
- `drunk` is not a status effect in this data model — it's a *character* (`troubleBrewing.ts:143`),
  so that checkbox is meaningless even as a label.

## N18. Missing Trouble Brewing win conditions: Saint and Mayor

`winConditions.ts:64-79` implements exactly two conditions, and `GameEndReason`
(`protocol/session.ts:85-89`) has no variants for the missing ones.

- **Saint** — *"If you die by execution, your team loses."* `confirmExecution`
  (`rules.ts:101-114`) never inspects the target's character, so **Good routinely wins by
  executing the Saint**.
- **Mayor** — *"If only 3 players live & no execution occurs, your team wins."* Never checked, so a
  game that should have been won at 3-alive is carried on until Evil hits 2.

Also, **precedence is inverted**: `living <= 2` is checked *before* the no-Demon check, so a
simultaneous Demon death + 2-alive resolves as an **Evil** win. Official adjudication is the
opposite — Good wins the instant the Demon dies. This is locked in by
`winConditions.test.ts:73-82`.

## N19. `Mark Dead` is a single unconfirmed, irreversible click

```tsx
// client/src/components/grimoire/GrimoireTable.tsx:103-105
<button className="btn" onClick={() => onMarkDead(entry.playerId)}>Mark Dead</button>
```

No confirmation, no undo, no revive — unlike "End Game…", which correctly uses a two-step confirm
(`StorytellerGamePage.tsx:189-206`). One mis-tap permanently kills a player, and the only recovery
is ending the game.

## N20. Zero rate limiting; unauthenticated unbounded session creation

No `express-rate-limit`, no `helmet`, no throttle anywhere in the repo.

- `routes.ts:24-32` — `POST /api/sessions` requires no auth and no captcha, and each call inserts a
  `GameSession` that lives up to **6 hours** (`store.ts:77`). **Unbounded memory growth from a
  single script.**
- Socket handlers are unthrottled. `player:vote` (`gateway/index.ts:400-409`) re-broadcasts
  `NominationVoteUpdate` **to the whole room** per emit — cheap amplification.
- `sendQuestionQueueUpdates` (`gateway/index.ts:126-134`) is **O(players × queue)** per question,
  and `questionQueue` is unbounded within a day (`questions.ts:14-48`).
- Conversely, the 6-hour reaper is trivially defeated forever by any authenticated socket pinging
  every 20s (`gateway/index.ts:220-223`).

## N21. No leave / kick / forfeit / vote-to-eject affordance anywhere

Combined with R1c, a player is captive in whatever game their `localStorage` points at. There is no
way out and no way for the ST to remove a problem player.

---

# P2 — Medium

## N22. Accessibility

- **`PhaseTimer` interrupts screen readers every second.** `role="timer"` + `aria-live="polite"`
  (`PhaseTimer.tsx:21,33-34`) with a 1-second `setInterval` → a screen reader announces
  "Day ends in 4:59", "4:58", "4:57"… for the entire phase, making the app unusable with AT.
- **No Escape handler and no focus trap in any of the four modals** (`OnboardingModal.tsx:21-34`,
  `RulesReferencePanel.tsx:12-25`, `RoleReferenceSection.tsx:24-37`,
  `PlayerGamePage.tsx:229-242`). Grep for `Escape`/keydown returns only four Enter handlers;
  grep for `.focus()`/`autoFocus`/`tabIndex`/`inert` returns **zero hits**. Background buttons stay
  focusable behind every overlay.
- **No accessible name on any dialog.** All four set `aria-modal="true"` with no `aria-label` /
  `aria-labelledby`.
- **No `:focus-visible` on any button.** `theme/tokens.css:135-137` defines an outline for
  `.input:focus` only — none for `.btn`, `.tab-bar button`, `.bottom-tab-bar button`.
- **Tab bars aren't tabs.** `PlayerGamePage.tsx:103-121,200-218` are five plain `<button>`s in a
  `div` with no `role="tablist"`/`role="tab"`, no `aria-selected`, no arrow-key navigation.
  Selected state is conveyed by CSS class alone.
- **Every input is `placeholder`-only.** `HomePage.tsx:86-99`, both chat panels, both question
  panels, `StorytellerGamePage.tsx:287-292`. Only **two** `<label>` elements exist in the whole
  client. Placeholder text also vanishes on focus, so sighted keyboard users lose the prompt too.
- **No `<form>` anywhere** → pressing Enter in the join-code field does nothing.
- `ConnectionDot` puts `aria-label` on a role-less `<span>` (`GrimoireTable.tsx:156-169`) — ignored
  by most AT; the 8px colour dot is the only signal, which also fails for colour-blind users.
- `SeatingCircle.tsx:73,93` — dead players are a bare `💀` at `opacity: 0.45` with no `aria-label`,
  and the initials are *replaced* by the emoji. A screen reader announces the string "💀".
- **Touch targets below minimum.** Seat-reorder buttons are ~19px (`SeatingCircle.tsx:111-126`,
  `padding: '2px 6px', fontSize: 11`); the poisoned/drunk/protected checkboxes are 18×18 on mobile
  and *unsized browser defaults* on desktop (the rule lives inside the `max-width: 768px` block,
  `tokens.css:323-327`).

## N23. Four measured WCAG AA contrast failures — on the two colours the game is built around

| Pair | Ratio | AA | Used for |
|---|---|---|---|
| `--evil-red #c23b3b` on `--bg-panel #16151f` | **3.43** | FAIL | `.alignment-evil`: "You are dead" (`PlayerGamePage.tsx:86`), the nominee's name (`VoteTally.tsx:23`), the `EVIL` label (`CharacterCard.tsx:25`), "Evil wins!" (`GameEndedBanner.tsx:28`) |
| `--text-faint #6f6a85` on `--bg-panel` (13px) | **3.51** | FAIL | `.faint`: "You can't nominate right now" (`NominationBar.tsx:25`), "Waiting for the Storyteller to answer…" (`QuestionQueuePanel.tsx:71`), "Share this code with your group" (`LobbyPage.tsx:24`) |
| `.btn-danger` text `#200606` on `--danger #d64545` | **4.40** | FAIL | "Confirm Nomination" (`NominationBar.tsx:35`), "Confirm Execution" (`StorytellerGamePage.tsx:267`) — the two highest-stakes buttons in the game |
| `--good-blue #3f7fd6` on `--bg-panel` | **4.49** | FAIL (marginal) | `.alignment-good`: the `GOOD` label (`CharacterCard.tsx:25`) |

## N24. `displayName` allows impersonation primitives

`schemas.ts:83-85` is `z.string().trim().min(1).max(30)`. Control characters, zero-width joiners and
RTL overrides are all permitted, so a player can render a name **visually identical** to another
player in the seating circle and in chat. `isDisplayNameTaken` (`store.ts:121-127`) only does
`trim().toLowerCase()`, so homoglyph/fullwidth variants collide visually but not logically.
Name-squatting all 15 names is trivial.

## N25. No token revocation, no logout; 24h token vs 6h session

`tokens.ts:35,40` use `expiresIn: '24h'` with no `jti`, no rotation, no revocation list and no
logout endpoint. `socketAuth.ts:27-30` compares the raw ST token, so there is exactly **one
god-mode token per session, valid for 24 hours**, stored in `localStorage`
(`client/src/api/storage.ts:15-20`) — the highest-value secret in the system sitting in
script-readable storage.

## N26. Dead players can keep using the private Storyteller Q&A

```tsx
// client/src/routes/PlayerGamePage.tsx:187
canAsk={session.phase === 'day'}
```

No `session.alive` check — contrast `canNominate` at `:47`, which does check. The server has no
check either (`gateway/index.ts:509-517`). Dead players can extract private information from the
Storyteller all game, which directly contradicts the panel's own text: *"This is private between
you and the Storyteller"* (`QuestionQueuePanel.tsx:31`).

## N27. Stale state on phase change

`onPhaseChanged` (`useSession.ts:109-117`) resets only `phase`, `dayNumber`, `phaseEndsAt` and
`nomination`. So:
- `questionQueue` is **not** cleared client-side → the ST's panel shows **yesterday's unanswered
  questions** mixed into today's queue (`StorytellerQuestionPanel.tsx:12` picks the first unanswered).
- `abilityResult` is not cleared (see N9).
- `lastExecutedPlayerId` / `executionEventId` are never reset, so the execution banner can re-fire.

## N28. Malformed JSON returns 500, not 400

`app.ts:10` `express.json()` throws a `SyntaxError`, which is not a `ClocktowerError`, so it falls
through to the generic handler at `app.ts:17-24` → client-visible 500s and log noise for trivial
bad input.

## N29. Session codes are brute-forceable

```ts
// server/src/session/store.ts:4-5
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 to avoid confusion
const generateCode = customAlphabet(CODE_ALPHABET, 5);
```

5 chars from a 32-symbol alphabet = **33,554,432** combinations. `GET /api/sessions/:code`
(`routes.ts:34-49`) and `POST /api/sessions/:code/join` (`:51-81`) are unauthenticated and
unrated, and return distinguishable 404 vs 200/403 — a clean enumeration oracle. Chained with N7
(known dev secret) this is a direct path to forging a Storyteller token for someone else's game.

## N30. XSS posture: no exploitable sink, but also no server-side sanitisation

Grep for `dangerouslySetInnerHTML|innerHTML` returns **zero** matches and all dynamic text goes
through JSX children, so React escapes it — **no XSS found**. However the server stores and fans out
raw strings with no normalisation (`chat.ts:38-41,60-63`, `questions.ts:22`, `routes.ts:66`).
`ChatSendSchema` (`schemas.ts:53-55`) caps length only. Worth a defence-in-depth pass.

## N31. Test and build tooling is broken at the repo root

`npm test` fails out of the box, in two independent ways:

1. **Server tests run before `packages/shared` is built** → 12 test files fail with
   `Failed to resolve entry for package "@clocktower/shared"`. You must first run
   `npm run build --workspace=packages/shared`.
2. **The client test script is rejected by Node.**
   `packages/client/package.json` → `"test": "NODE_OPTIONS=--no-webstorage vitest run"`.
   On Node v22.21.1 this is a hard failure:
   `node: --no-webstorage is not allowed in NODE_OPTIONS` (exit 9).

**Baseline once worked around:** `shared` + `server` = **79 tests pass**; `client` = **11 tests
pass** (90 total).

**Coverage gaps:** there are **no tests** for `PlayerGamePage`, `StorytellerGamePage`,
`LobbyPage`, `HomePage`, `App`, `useSession`, `useGameSocket`, or any component other than
`GrimoireTable`. Nothing covers the nomination dead-end (N1), the room code, phase gating (N3), the
Storyteller room-name bug (N2), or the Drunk leak (N4).

## N32. Smaller UI defects

- **No error boundary.** `main.tsx` renders `<App/>` bare; any render-time throw leaves a blank
  white page with no recovery and no way back Home.
- **Join button enabled with empty fields**, no validation message, no Enter-to-submit. The shared
  `busy` flag also makes the Join button read *"Joining…"* while a **Create** request is in flight
  and vice versa (`HomePage.tsx:54,79,100-101`).
- **`GrimoireTable` renders two full copies of the data**, both always mounted and toggled purely by
  CSS (`GrimoireTable.tsx:56,115`), and logs a React key warning for every row (a bare fragment
  inside `.map()` at `:72`).
- **ErrorToast is 5 seconds, no dismiss, no history**, and `lastError` overwrites on every error
  (`ErrorToast.tsx:17`, `useSession.ts:155-157`). *"You have already nominated today"* flashes and
  is gone forever.
- **`NominationBar` gives a reason-free dead end** — one string, *"You can't nominate right now."*
  (`NominationBar.tsx:25`), for four distinct causes (not day / you're dead / already nominated /
  nomination open). A player who has already nominated thinks the game is broken.
- **No "was nominated today" tracking.** The official rule is that each player may be nominated once
  per day; no field for it exists in `store.ts:7-23`.
- **Self-nomination inconsistency** — the server allows it (no `targetId !== nominatorId` check in
  `rules.ts`), but the UI filters self out of the candidate list (`NominationBar.tsx:14`).
- **Seat-reorder `↺ / ↻`** is the only way to change seats, with no drag, no numeric seat display,
  and no confirmation.

---

# P3 — Polish / latent

## N33. Misleading documentation that could cause a future secret leak

```ts
// shared/src/protocol/session.ts:72
/** A single entry in the post-night question queue (**public** — who asked and the answer are visible to all). */
```

The implementation is **deliberately private** (`gateway/index.ts:118-134`, with a 7-line comment
explaining exactly why). A maintainer trusting this comment could broadcast every question and
answer to the whole room.

## N34. Ability-text fidelity errors vs the real cards

- `troubleBrewing.ts:15` **Washerwoman**: *"You start knowing that 1 of 2 players is a particular
  Townsfolk."* — the official text ends *"**of your choice**."* The ST cannot know who the player
  picked, so they cannot run the role correctly.
- `troubleBrewing.ts:24` **Librarian** and `:33` **Investigator** both drop **"in play"**, producing
  text that reads as a self-contradiction (*"a particular Outsider. (Or that zero are in play.)"*).
- The `*` suffix convention (Undertaker / Monk / Imp = *"not on the first night"*) is **never
  explained** anywhere in the data or the UI.

## N35. Dead code

- `PlayerRecord.onboardingSeen` (`store.ts:18,141`) is initialised and **never read** — the client
  uses `localStorage` instead.
- `clearStoredSession()` (`client/src/api/storage.ts:37`) is exported and unit-tested but **never
  called from application code**.
- `getSessionInfo()` (`client/src/api/rest.ts:34`) is exported and **never used**.
- `client/src/components/reference/RoleReferenceSection.tsx` and `GrimoireTable.test.ts` exist, but
  the "was nominated today" and `sampleCharacters` guard paths are untested.

## N36. Minor server issues

- `distribution.ts:28-31` throws a bare `new Error(...)` instead of a `ClocktowerError`, so the
  intended `distributionRange` message surfaces as a generic 500 / `INTERNAL_ERROR`
  (`gateway/index.ts:91-94`).
- `handlePostDeath` is called with `'executed'` from `StorytellerMarkDead`
  (`gateway/index.ts:346`) even when the death was a night kill — a mislabel that feeds the
  `demon-executed` vs `demon-self-killed` win reason.
- `setPlayerAlignment` (`gateway/index.ts:363-376`) doesn't re-run `assignBluffs`, so flipping a
  player to evil can leave `bluffCharacterId: null` and the payload with `bluff: undefined`.
- `demonKill.ts:43` rejects a dead target, but the official Imp may target a dead player. Locked in
  by `demonKill.test.ts:133-143`.
- `store.ts:149-156` deletes any session idle > 6h and `deleteSession` is called from nowhere else;
  there's no `DELETE` route, so an abandoned in-progress game can only vanish, never be cleaned up
  deliberately.

---

# What is done well

Worth preserving through any refactor:

- **The reconnect story is genuinely well engineered.** Websocket→polling fallback with tuned
  backoff (`useGameSocket.ts:36-41`), a `ConnectionBanner`, a 20s keep-alive
  (`useGameSocket.ts:63-65`) matched by a real server handler (`gateway/index.ts:220-223`), and a
  correct guard against the stale-socket race on refresh (`gateway/index.ts:539-549`, tested in
  `reconnect.test.ts:39-74`).
- **Per-recipient secret delivery is correctly architected.** `sendToPlayer` is the only path for
  anything sensitive (`broadcast.ts:16-25`), `buildPlayerDistributionPayload` omits
  `teammates`/`bluff` for Good players (`distribution.ts:131-139`, tested), the Grimoire is only
  ever sent to the Storyteller (`broadcast.ts:53-55`), and **every** `storyteller:*` handler calls
  `requireStoryteller(socket)` first (`gateway/index.ts:70-74`) — a player cannot emit storyteller
  events or read the Grimoire.
- **Distribution is solid.** All 22 roles present and correctly typed; the table matches the
  official Trouble Brewing table for all 11 supported counts; roles and players are both shuffled
  before pairing so an evil player can never draw their own character; bluff selection is provably
  safe (`distribution.ts:78-87`) and stable across reconnects because it's stored on `PlayerRecord`.
- **The execution threshold and ghost-vote semantics are correct.**
  `Math.ceil(livingPlayerCount / 2)` with dead voters correctly excluded from the denominator but
  their votes still counted (`rules.ts:53-64`), and the ghost vote is consumed at cast time and
  never refunded (`rules.ts:39-47`, preserved across days by `rules.ts:117-123`, tested).
- **`livingNeighborsOf`** (`store.ts:195-220`) implements "nearest *living* neighbour over a fixed
  circle" correctly — a genuinely subtle rule that many implementations get wrong.
- **`PhaseTimer` ticks locally from a server timestamp** rather than per-second network traffic.
- **Listener teardown in `useSession.ts:188-208` is complete and symmetric** — no leaks.
- **The `guarded()` wrapper** (`gateway/index.ts:83-96`) correctly converts every throw into a
  scoped `error` event, and `disconnect` correctly preserves state across reconnects.

---

# Suggested fix order

**Phase 1 — makes the game playable and correct (do these first)**
1. **N1** — unblock nominations after a closed one. Single highest-impact fix in the repo.
2. **N3** — phase-gate `nominate`/`castVote`/`closeVote`/`resolveDemonKill`; reject no-op transitions.
3. **N5** — Scarlet Woman guard `< 5` → `< 4`; update the two tests that encode the bug.
4. **N6** — "beat the day's highest tally" + one execution per day; make `confirmExecution` idempotent (N13).
5. **N4** — stop telling the Drunk they are the Drunk.
6. **N2** — `sessionRoom()` on line 233; render `storytellerConnected`.
7. **N7** — fail closed on a missing `CLOCKTOWER_JWT_SECRET` in every environment.

**Phase 2 — stops leaking information and losing state**
8. **N9** — clear `abilityResult` on phase change; add an explicit dismiss.
9. **N8** — a full state snapshot in `AuthOk` (nomination, `alive`, grimoire for the ST, last execution).
10. **N10** — start at Night 1; give the Imp a `firstNightOrder` (`troubleBrewing.ts:219`).
11. **N17** — enforce `statusEffects` in the demon kill and voting, **or delete the checkboxes**.
12. **N18** — add Saint and Mayor; fix the simultaneous-death precedence.
13. **N27** — clear `questionQueue` and execution state on phase change.

**Phase 3 — the two features you asked about**
14. **Reported Issue 1** — add `roomCode` to `SessionState` + `AuthOk`; render a persistent
    copyable code chip on both game pages; add a `POST /sessions/:code/reclaim` endpoint keyed on
    display name; make storage per-game (`botc:session:<code>`) so tokens stop clobbering each
    other; add a "Leave game" button that actually calls `clearStoredSession()`.
15. **Reported Issue 2** — extend `CharacterDefinition` with `nightPrompt`, `targetCount`,
    `targetRestrictions`, `infoType` and `registerAs`; add a `registration` field to
    `PlayerRecord` for Recluse/Spy; build a stepped Night Order runner with per-role prompts,
    target pickers, once-per-night tracking, a "who woke tonight" roster, a bulk clear-poison at
    dawn, and an ST-chosen Imp heir. Add optional TTS narration for prompts and results.
16. **Reported Issue 3** — replace `CORE_RULES` with a real rules reference (nomination, threshold,
    ghost vote, day/night cycle, status effects, win conditions); make onboarding **re-openable**
    from the game page and available to the Storyteller; key `hasSeenOnboarding` per player, not
    per browser; show the threshold and the player's own vote; add seat numbers; add a role-reveal
    banner; add a "How to play" section to `HomePage`.

**Phase 4 — hardening & polish**
17. N19/N20/N29 — rate limiting, longer codes, session persistence.
18. N22–N26, N32 — accessibility, contrast, focus management, error boundary, mobile touch targets.
19. N31 — fix `npm test` (build `shared` first; replace the unsupported `--no-webstorage` flag) and
    add the missing `PlayerGamePage` / `useSession` / gateway tests that would have caught N1–N4.
20. N33–N36 — correct the misleading comment, the ability text, and remove dead code.
