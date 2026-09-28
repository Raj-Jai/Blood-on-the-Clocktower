# AUDIT.md — second audit, by seven parallel reviewers

**Date:** 2026-09-28 · **Branch:** `feature/night-engine` @ `7881607` · **Baseline:** 42 shared / 216 server / 70 client tests, all green

This is a *rules and information-hiding* audit of the committed app, run by seven reviewers in
parallel, each given a disjoint slice. It is a different document from `PLAYTEST.md`, which is the
play-derived report and now records those 20 findings as closed.

**Neither document is a compliment.** The honest headline is in [What this found](#what-this-found).

Every finding below was reproduced by the reviewer who reported it, by driving the real engine
rather than by reading it. Where I could cheaply verify a claim myself I did, and I have marked
those **[verified]** — I read the code and confirmed the mechanism, not just the reviewer's summary.
Corroboration counts are given because they carry information: **two reviewers independently
reaching the same defect is much stronger than one**, and several of the worst ones are in code
written in the last three commits.

Nothing here is fixed. This is a report.

---

## What this found

**Twenty-eight distinct defects. Nine are P0 — the game is unplayable, or hands a team a win it
did not earn, or shows a player a secret.** Seven of the nine P0s are in code added or rewritten in
the last three commits, which is the single most uncomfortable number in this document.

The dominant failure mode is not a missing feature. It is **a fix written in one place while the
same question stayed spelled in another.** The same word describes five separate live bugs:

| The question | Where it is spelled correctly | Where it is spelled wrong |
|---|---|---|
| Is an execution waiting? | `session.pendingExecution` | `flow.executionPending`, `checkMayorWin`, `canNominate` |
| What character does the table know them to be? | — | `registeredCharacterNameFor`, `unmakeableSteps`, `teammates` |
| Can this player act tonight? | `wakerIsUnreliable` | the Monk's target, the Virgin, the Slayer |
| Is this step done? | `stepCountsAsOutstanding` | `pendingStepsForPlayer` (dead), `flow.awaitable` |
| Is this target legal? | the *rule* | the *filtered list shipped to the player* |

That is the same class of bug `AGENTS.md` has been documenting since before the night engine, and
the last three commits added three more instances of it while fixing the ones already listed.

A second theme, and it is the one worth internalising: **a large fraction of the suite passes
regardless of whether the rule holds.** Reviewers found tests that assert the buggy value, tests
that assert a *subset* so a wrong slot cannot fail them, tests that derive their input from the
thing they claim to check, and a test whose name claims a fix that is not in the code. `MEMORY.md`
already names this; below it is the evidence that it is still the dominant mode.

---

## P0 — the game is unplayable, or wrong, or leaking

### P0-1 — The Ravenkeeper's wake is unreachable, and it locks every later night permanently

**`packages/shared/src/protocol/moment.ts:130`** (with `packages/server/src/game/flow.ts:191-212`) — **[verified]**

```ts
if (ctx.alive && ctx.hasOpenNightPrompt && owesAChoice) {   // awake-choose
```

The Ravenkeeper is woken *because they died*, so they are dead — and a dead player can never reach
`awake-choose`. The server grants the wake, creates the step, and sends the `night_prompt`, and the
client renders no picker for it. The only other state that shows the prompt needs a night result
they do not have.

The consequences compound:

- The character has no reachable control, ever.
- `ravenkeeperWakePending` is cleared **only** in `submitNightChoice`. With the pick unreachable it
  is never cleared, so `buildNightOrder` re-adds the step on **every subsequent night**.
- `isNightFinished` is then permanently false, which also removes the Storyteller's primary
  *"Resolve the night"* control for the rest of the game.

This is a regression introduced by the Tier 6 Ravenkeeper work. The unit test
(`nightEngine.test.ts:393`) calls `submitNightChoice` directly — precisely the one action the UI
cannot perform. Two client tests assert the *opposite* of the character's rule, as though it were
correct.

### P0-2 — The Imp self-kill hands the new Demon every other Evil player's true character

**`packages/server/src/game/nightEngine.ts:809-816`** — **[verified]** · *reported by 2 reviewers*

```ts
teammates: [...session.players.values()]
  .filter((p) => p.playerId !== heir.playerId && p.alignment === 'evil')
  .map((p) => ({ playerId, displayName, character, characterName })),
```

The inheritance payload is hand-built instead of routed through `buildPlayerDistributionPayload`,
so it re-introduces **exactly the leak Tier 7 closed one file earlier**: the whole Evil script, by
name, to a player. It also filters on `alignment` rather than `characterType` (so it names the
Demon, which no one is granted), has no 7+ gate, and omits `bluff` while a comment claims it is
preserved. It typechecks because `sendToPlayer`'s payload parameter is `unknown`, so nothing forces
it to be an `OwnCharacterPayload`.

The same inheritance is produced by three code paths; the other two are safe. **Which payload the
new Demon receives depends on which button killed the Imp.**

### P0-3 — The 1-of-2 characters' target picker leaks the entire roster of their type

**`packages/server/src/game/abilities.ts:194-209` → `nightEngine.ts:1037-1039` → `NightPromptPanel.tsx:124`** — **[verified]** · *reported by 1 reviewer, measured*

Washerwoman, Librarian and Investigator carry a *type* restriction (`townsfolk` / `outsider` /
`minion`) on their legal targets. `legalTargetsFor` filters by **true** character type, and
`buildNightPrompt` ships the filtered list to the **player**, which renders it as buttons.

The reviewer measured the picker against the true roster across real deals at every player count:
**identical 100% of the time** (80/80 at 5p, 147/147 at 7p, 302/302 at 13p). The Investigator is
shown exactly who the Minion is before learning anything — which also makes the "1 of 2" a joke,
since the named character is always the one they picked.

`nightEngine.test.ts:195` **asserts the filtered list as correct.** The one test touching this
asserts the bug.

### P0-4 — "Resolve night" is live during the day, and opens a phantom night

**`packages/server/src/gateway/index.ts:469-472`** — **[verified]** · *reported by 2 reviewers*

```ts
const night = openNight(session);
if (session.phase !== 'night') { session.phase = 'night'; broadcastPhaseChanged(...); }
if (action === 'resolve') { const report = resolveNight(session, io); }
```

`openNight` is called unconditionally, so a click during the day **increments the night number,
expires all poison, re-arms the Soldier, and persists a step list** — then resolves it. The
`resolveNight` phase guard is neutralised two lines earlier by the same handler.

Poison is therefore cleared *during the day it is meant to cover*, the phase flips to night, and
the next dawn runs `resetForNewDay`, discarding the day's nominations, tallies and any pending
execution. The button is live because `isNightFinished()` returns `false` whenever there is no
`currentNight`, which is the entire day phase.

### P0-5 — A poisoned or drunk Virgin and Slayer keep their abilities, and it changes the winner

**`packages/server/src/game/abilities.ts:288-296` (Virgin), `:305-324` (Slayer)** — **[verified]** · *reported by 2 reviewers*

Neither predicate reads `statusEffects`. Poison therefore does nothing to the two day abilities
that **cause deaths**, while the app honours it for the Saint, the Mayor and the Butler.

Both directions of a wrong winner are reachable, and both were reproduced:

- **Poisoned Slayer** successfully nominates the Demon → the Demon dies → *"Good wins! The Slayer
  named the Demon"* for a Demon that was alive when it was nominated.
- **Poisoned Virgin** is nominated by the Mayor at 3 alive → the Mayor is executed → *"Evil wins!
  Only two players remain"* for an execution that should never have happened, denying Good the
  Mayor's dusk clause.

Neither `virginHasTriggered` nor `slayerHasUsed` should be spent when the ability fails to function.

### P0-6 — The Monk's protection is cancelled by the *target* being poisoned or drunk

**`packages/server/src/game/demonKill.ts:107-108`** — **[verified]** · *reported by 2 reviewers*

```ts
const protectedAndFunctioning =
  target.statusEffects.protected && !target.statusEffects.poisoned && !target.statusEffects.drunk;
```

`statusEffects.protected` is set by **two different sources** — the Soldier's always-on ability and
the Monk's action — and the kill check applies the *target's* state to both. So a healthy Monk
protecting a poisoned player protects nothing. The code's own comment claims to draw the distinction
correctly; it draws it the other way round.

**And it breaks the Drunk permanently:** `markDrunkStatus` sets `statusEffects.drunk = true` for
the whole game, so **the Monk can never save the Drunk, 100% of the time.**

The test that owns this line passes whether or not the bug exists — it sets `protected` on a
*poisoned Monk* (a state the engine cannot produce, since a poisoned Monk's choice never sets the
flag) rather than on a poisoned *target*.

### P0-7 — A Drunk whose cover is the Monk is told, on their own phone, that they are drunk

**`packages/server/src/game/nightEngine.ts:720-724`** — **[verified]** · *reported by 2 reviewers*

`abilityWorks` is derived from `wakerIsUnreliable`, which reads `statusEffects.drunk` — permanently
true for a Drunk. A Drunk running the Monk as their cover therefore takes the failure branch every
night and is sent:

> *"You are drunk/poisoned. Your protection did not work."*

`RULES_NOTE` in the same file is worded specifically to avoid naming the conditions
(*"even if you are drunk or poisoned"*) — and then the result text names them. The existing test
asserts only the **deal-time** payload, so the night-result channel is uncovered.

### P0-8 — The Spy's Grimoire is the Storyteller's Grimoire, and is never shown

**`packages/server/src/game/nightEngine.ts:710-717` · `packages/client/src/hooks/useSession.ts:194-207` · `NightPromptPanel.tsx:176-181`** — **[verified]** · *reported by 3 reviewers*

Two halves of one feature, both broken:

**(a) The payload is the Storyteller's projection, unmodified.** It carries every player's
`registration` (the Recluse/Spy lies), `drunkCoverCharacterId` (**identifies the Drunk, with
certainty, on night one**), `fortuneTellerRedHerringPlayerId`, `butlerChoice` (**identifies the
Butler and their master**) and `statusEffects` — fields the projection's own comment labels
*"Hidden-state decisions, Storyteller-only"*. A Spy's Grimoire is the script, not the host's
decisions.

It is also assembled at the Spy's step, which is order 9 — **after** the Imp at order 3 — so it is
built post-kill and contains the night's victim. Officially the Grimoire is the pre-dawn book.

**(b) The client discards it.** `useSession` drops `GrimoireUpdate` for any non-Storyteller, so the
Spy's screen shows the sentence *"Your Grimoire is shown on your own screen, below your result"* and
**nothing is below**. The character is inert on the screen while the wire says it worked.

The server test asserts `toHaveLength(5)` — the *length* of the Grimoire, and that a Good player did
not get it. It passes whether or not the Drunk is in there.

### P0-9 — Two spellings of "is an execution waiting?", and the Storyteller loses the Execute button

**`packages/server/src/game/flow.ts:53`** — **[verified]** · *reported by 2 reviewers*

```ts
executionPending: Boolean(session.nomination?.pendingExecution),   // the MOST RECENT nomination
```

while the *stage* at `flow.ts:337` is decided by `session.pendingExecution` — the day-scoped fact
that Tier 5 introduced precisely so a later nomination could not destroy a pending execution.
`StorytellerScript.tsx:239` gates the button on **both**, so when they disagree the button vanishes.

Reproduced: a passing vote, then a later nomination that fails to reach the threshold, gives
`stage = day-execution-pending`, `executionPending = false`, and **no Execute button** — while the
host's script reads *"Confirm the execution"* and the server would happily accept
`confirmExecution(nominationId)`. The only exits are a third nomination that qualifies, or dusk, where
`resetForNewDay` silently discards a vote the table passed.

The same wrong field is read in a second place: `checkMayorWin` (`winConditions.ts:185`), which will
let Good win at dusk with a passed vote still unexecuted.

**This is the Tier 5 bug, re-introduced through the new stage** — by a comment in the same function
that explains why the stage exists.

### P0-10 — `FlowState` ships character names to every player, twice

**`packages/server/src/game/flow.ts:42` (`byCharacterName`), `:155` and `:281` (`unmakeableSteps`)** — **[verified]** · *reported by 1 reviewer*

`FlowState` is broadcast to the room and read aloud, and the type's own header says it may **never
contain a character name**. Two fields do:

- **`unmakeableSteps[].characterName`** — reachable with a real deal: Trouble Brewing deals **0
  Outsiders at 5 and 7 players**, so a Librarian in that Townsfolk pool is unmakeable, and every
  player is told *"Librarian — There are no Outsiders in play"*. That is a role, plus another
  player's own nightly information, in every device on the table.
- **`immediateExecution.byCharacterName`** — the field added in Tier 6. For the Virgin, the app
  records **no nomination at all** (`nominate` returns `null`), so the only thing identifying the
  nominator is that the table watched it happen; shipping `"byCharacterName": "Virgin"` to every
  player hands them the connection as a string.

`assertSpeakableAnnouncement` is only ever applied to `flow.announcement`, never to the rest of the
object — and one test asserts the `unmakeableSteps` projection is *correct* while saying nothing
about who receives it.

---

## P1 — wrong rules outcomes, or controls the server refuses

| # | Defect | Where | Notes |
|---|---|---|---|
| **1** | The Undertaker is shown a character **type**, rendered as literally *"You learn that they are the ???"* — an executed Recluse registering as the Demon yields `"demon"` | `rules.ts:339-346` **[verified]** | My Tier 4 code. `registeredCharacterNameFor` returns `registration.characterType`; `renderCharacterInfo` then calls `getCharacterById('demon')` → `undefined` → `'???'`. The plain case works, which is why it survives play. The test is *named* "as the registered character" and asserts `'outsider'`. |
| **2** | After an execution, every player who has not nominated gets a **live Nominate control the server refuses**, and an error saying they already nominated | `PlayerGamePage.tsx:84` vs `rules.ts:56` | `canNominate` reads `nomination?.pendingExecution`; the server's guard is `executionHappenedToday`, which is never sent to the client. Lasts the rest of any day with an execution. 2 reviewers. |
| **3** | A dead Butler's single ghost vote is **spent by a vote the server then refuses** | `rules.ts:112-132` | `usedDeadVote = true` is written before the Butler check throws. The ghost is now unable to vote for the rest of the game having voted zero times, and the table is told they spent it. |
| **4** | The client's tie arithmetic is **off by one**: it tells the table a vote has carried when the server will refuse it | `VoteTally.tsx:20-28`, `moment.ts:340` | `max(threshold, highestTallyToday)` where the rule is `max(threshold, highestTallyToday + 1)`. Fires exactly after a tie — the one state the tie rule exists for. The panel's own second line is correct, so it contradicts itself. |
| **5** | A stale **"Resolve night"** click un-ends a finished game, and the table can then reach a second, **opposite** winner | `gateway/index.ts:456-473` | `requireGameNotEnded` is inside the `skipDelay` branch only; `resolve`/`next` then write `phase = 'night'` over `'ended'`. Reproduced end to end: Evil wins on the Saint, then the banner flips to *"Good wins! The Demon was executed."* |
| **6** | The Storyteller's **chosen Imp heir is discarded** and a *random* Minion inherits, while the log says no heir was chosen | `gateway/index.ts:912` | `impHeirChoice` is read by exactly one call site (the engine's), not this one. |
| **7** | **No `FlowState` is sent on auth**, and the function that would send it is dead code | `gateway/index.ts:324-363`; `flow.ts:375-378` | A player who refreshes sees *"Waiting for the game to start"* for the rest of the phase. `sendFlowToStoryteller` has **zero callers** — `MEMORY.md`'s own rule: wire it up or delete it. |
| **8** | `deriveStorytellerLine` **contradicts `flow.announcement`**, and the "next waker" control disappears | `shared/flow.ts:249` vs `flow.ts:236/247-249` | `resolvedCount` excludes auto-resolvers; `awaitable` includes them. The host reads *"Everyone is done, resolve the night"* while the cursor sits on a player who has not been woken — a **regression** of a previously-fixed bug. `flow.test.ts:103-112` blesses it. |
| **9** | A drunk/poisoned 1-of-2 player is told, in a **parenthetical**, that their information may be false | `liePolicy.ts:423` | `" (You are not certain which one.)"` appears on the unreliable branch only. Measured: 71% of Drunk games vs 0% of healthy ones. A perfect one-night Drunk detector, in the app built not to have one. |
| **10** | The 1-of-2 "other" player can be the chosen player, rendering **"P4 or P4"** | `nightEngine.ts:994-999` | When the type pool is exhausted, the fallback is the target itself. Measured at 6/8/11/14 players, where exactly one Outsider is dealt. |
| **11** | A poisoned Chef can be told a **pair count that is arithmetically impossible** at that table | `abilities.ts:87-90` | The ceiling bounds the *seating*, not the evil population. 40–55% of games at 5–9 players produce a count the table can disprove on sight. |
| **12** | The Storyteller's manual **Demon Kill** bypasses both the poisoned-Demon rule and the Ravenkeeper's wake | `gateway/index.ts:910-912` | The natural use is the Mayor's *"another player might die instead"* — the kill happens and the ability is silently deleted. |
| **13** | `Mark Dead` does not clear the **pending execution** | `gateway/index.ts:735` | The Execute button stays live over a corpse; every press errors; the dead nominee is told *"You are about to be executed"* for the rest of the day. |
| **14** | The Drunk-cover override **bypasses the usable-ability filter** and ignores the Storyteller's pick | `gateway/index.ts:636-652` | The panel can hand the Drunk the Soldier, Virgin or Slayer — the exact cover class Tier 7 excluded — and the handler never reads the `drunkCoverPlayerId` the client sends. 2 reviewers. |
| **15** | Nothing stops a nomination or vote **before the table has read the dead** | `gateway/index.ts:800, 825` | Gated on `phase === 'day'`, not `dayRevealed`. Also reachable *without* a crafted message: a reconnect does not re-broadcast the flow, so a stale client holds a stale stage. |
| **16** | A player **killed earlier in the night still wakes and acts** | `nightEngine.ts:566` | The resolve loop iterates a pre-kill snapshot and never checks `waker.alive`. The dead Butler's choice is still *written*, restricting a living player's vote tomorrow. |
| **17** | The Butler's vote restriction has **no client representation at all** | `PlayerGamePage.tsx:89-93`, `VoteTally.tsx:58-68` | A live, primary "Vote to Execute" that returns `BUTLER_MUST_FOLLOW`. Not fixable client-side — the client's choice is correctly secret — so it needs a server-published `mayVote`. |
| **18** | Two dialogs claim `aria-modal="true"` with **no Escape, no backdrop, no focus trap** | `RoleReferenceSection.tsx:24`, `RulesReferencePanel.tsx:12` | `PLAYTEST.md` records Escape as closed. The hook also *moves* focus but does not trap it, which its own doc claims. |
| **19** | Two **contrast** shortfalls | `tokens.css` `--danger` 4.13:1; `.btn-danger` 4.40:1 at the gradient bottom | Both measured, not inferred. Everything else passes AA. |

---

## P2 — narrower, or disputed

- **A player may nominate themselves** (`rules.ts:26`) — "any player may nominate any *other* player". The only remaining way to vote for your own execution.
- **The Slayer's qualifying vote never becomes the day's floor** (`rules.ts:223-234`) — the branch returns *before* the `resolvedNominationsToday.push`, so a later *lower* tally is executed despite the Slayer's higher one. 2 reviewers.
- **Self-kill with no heir skips the Scarlet Woman takeover** via the manual Demon Kill button (`gateway/index.ts:941`) — `wasDemon` is hard-coded `false` on the branch where the victim *is* the Demon.
- **The Fortune Teller cannot choose themself or a dead player** (`troubleBrewing.ts:116`) — the official card permits both, including the dead-Demon read.
- **A pending Ravenkeeper wake is silently carried into the next night** (`endNight`) — the flag survives, so the wake fires about a night-N world.
- **The Ravenkeeper is told the *true* character while the Undertaker is told the *registered* one** (`nightEngine.ts:691` vs `:657`) — the same "what the table knew them to be" question with two answers in one file.
- **`pendingStepsForPlayer` is a fourth spelling of "is this step done" and is dead code** — exported, called by nothing but its own test. `MEMORY.md` says wire it up or delete it.
- **`submitNightChoice` resolves a step by `wakerPlayerId` alone** (`nightEngine.ts:449`) — a mid-game Drunk-cover change leaves two records and returns the stale one: a live control the server refuses, or a night-lock.
- **A red-herring hit bypasses the lie policy for an unreliable Fortune Teller** (`nightEngine.ts:666-676`) — a false answer is built before consulting `wakerIsUnreliable`, making it 100% truthful instead of ~30% for exactly the player the rule protects.
- **The Poisoner cannot poison themself** (`troubleBrewing.ts:268`) — official text permits it.
- The load-bearing **`ORDER IS LOAD-BEARING` docstring documents the old, pre-fix order** and argues for reverting the fix.

---

## Test integrity — the suite passes whether or not the rule holds

This is the finding I would weight heaviest, because it is why the rest survived.

- **`nightEngine.test.ts:59`** is named *"returns the official First Night order"* and asserts a **7-subset of 10 slots** — Librarian, Investigator and Butler are absent, so a wrong slot cannot fail it. **`:154`** does the same with a **6-subset of 9**. Both are the tests that were already rewritten once for this exact problem.
- **`flow.test.ts:103-112`** asserts the host says *"Everyone, close your eyes"* for a state with `activePlayerName: 'Bram'` and `readyToResolve: false` — it **blesses P1-8**.
- **`shared/flow.test.ts:56-66`** is named *"agrees with the server: the panel never contradicts flow.announcement"* and **derives `activePlayerName` from the announcement**, so it is structurally incapable of producing a disagreement.
- **`rules.test.ts:188`** is named *"records the executed player for the Undertaker, **as the registered character**"* and asserts `'outsider'` — a type. The name and the assertion disagree, and the name is the one that reads as the rule (P1-1).
- **`nightEngine.test.ts:1579`** *"gives the Spy the Grimoire"* asserts **length** (P0-8).
- **`nightEngine.test.ts:1657`** *"kills a POISONED Soldier"* sets `protected` on a poisoned **Monk**, a state the engine cannot produce, and never tests a poisoned **target** (P0-6).
- **`NightPromptPanel.test.tsx:109`** asserts no `/drunk or poisoned/i` in the document while feeding a `rulesNote` that guarantees it — vacuous, and `nightEngine.ts:98-99` still contains the string it claims to police.
- **The Mayor's dusk placement has no gateway test.** Every Mayor test calls `checkMayorWin` directly. **They would pass unchanged if the call site were moved back to dawn** — which is `PLAYTEST.md` finding 8, marked fixed.
- **The Saint's execution-by-vote path is untested**; only `Mark Dead` and the bare predicate are covered.
- **The Butler's vote path is entirely untested.** `grep` for `butlerChoice` across every test file returns nothing.
- **Four functions with zero test references** that carry real logic: `renderPairInfo`, `generatePairInfo`, `fortuneTellerFindsDemon`, `maxPossibleEvilPairs` — three of the four are implicated above.
- One test named `'does not win with a drunk or poisoned Mayor'` sets only `poisoned`; one named `'…or at any other player count'` fails both of its guards at once, so a 2-alive table with a **living** Mayor — the state that would catch a count change — is never built.

---

## Disputed — needs a decision, not a fix

- **The Fortune Teller's red herring. My earlier verdict was wrong.** I recorded this as *"NOT A BUG — it is assigned and read."* Two reviewers disagreed, and they are right: `assignRedHerring` writes `fortuneTellerRedHerringPlayerId` while `fortuneTellerFindsDemon` reads `perceivedAs(...).characterType`, which comes from `registration`. **[verified]** — the write and the read use different fields, so the red herring reads as their own type and the "yes" essentially never fires. The night log claims otherwise on every single game. This is precisely the failure I warned about in that same document, and I then committed the error.
- **The Spy's position in the night order.** One reviewer argues the data is wrong (Spy belongs immediately after the Poisoner) and that a third-party sheet agrees with the app. The other says the app's order is official. Sources genuinely disagree; it needs a ruling, and it is what makes P0-8's Grimoire post-kill.
- **Does poison stop the Scarlet Woman inheriting?** The almanac phrasing reads as an event triggered by the Demon's death; the card is written as an ability and most implementations gate it. No strong evidence either way.
- **Should the Monk be restricted to "good"?** It is deliberate and documented, but it means the Monk cannot protect the Demon, and it reads *perceived* alignment. A divergence from the printed card the same app renders.
- **A Butler whose Master died at night** is locked to voting no all day. Defensible, and a real one-line decision.
- **Severity of the room-wide `FlowState` leaks** depends on whether the invariant is "must not be *spoken*" or "must not be *sent*". The app's own stated threat model is payload-based, which is how P0-10 is rated P0.

---

## What the reviewers verified as correct

Worth stating, because it bounds the damage: the **end-game decision logic is sound**. There is
exactly one definition of "is the step done", one owner of the execution bookkeeping, one
`handlePostDeath` funnel reached by all four death sites, and the Good-wins-ties tiebreak is
correctly ordered in the one function that decides the two generic conditions. All seven
end-condition pairs were enumerated; the only reachable conflicts resolve correctly.

Also confirmed correct: the Chef's pair arithmetic (exhaustively verified, including the dead-player
subtlety); the Empath's living-neighbour rule; the distribution table against the official chart
for **every** count 5–15; the Baron's `+2 Outsiders` modifier; the Poisoner's ordering and exact
duration; the Scarlet Woman's boundary; the Drunk's deal-time payload (the word "Drunk" appears
nowhere, including in field names); `broadcastLobby` carrying no secret; every genuinely private
channel going through `sendToPlayer`; TTS reading nothing but the player's own information; the
night-walk cursor; and `findStoredStep` making a night-lock from an unpersisted step impossible.

**The architecture is in much better shape than it was.** The live defects are not in the decision
logic — they are in what the app is *willing to accept* and what it *forgets to consult*.

---

## Not covered

- Nothing was played in a browser. Every finding here is from code and the harness; the play-derived
  class lives in `PLAYTEST.md`.
- No accessibility audit beyond contrast, `aria-modal` and the live-region question — no screen
  reader, no keyboard walkthrough.
- 10–15 player tables were checked for distribution and the Baron, not played.
- Nothing has been fixed. This document is a report.
