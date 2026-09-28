# PLAYTEST.md — playing the game in the real UI, and what felt wrong

**Date:** 2026-09-28 · **Branch:** `feature/night-engine` @ `d2c09e1` · **Servers:** Vite `:5173`, game server `:3001`

This document is not a code review. Every finding under **Confirmed by playing** was reached by
clicking through the real app in a real browser window and watching what happened. Findings marked
**Confirmed by reading** come from a static audit and have *not* been reproduced end to end — treat
those as leads, not verdicts.

> **STATUS: all 20 findings are now closed.** Every one has been fixed, covered by a test, and
> re-verified by playing it in the browser. The `Status` column in the summary says how. The write-ups
> below are kept as the record of what was wrong — do not read them as current behaviour.
> See [What was fixed](#what-was-fixed-and-how-it-was-verified) for the current state.

The harness is in `tools/playtest/` and is described at the bottom. It is UI-only: the Storyteller
clicks **Create Game** on the home page, the join code is read off the lobby screen, and each player
types that code and their name into the join form. No session is ever created by calling the REST API.

---

## Headline — as first written

**The game cannot be played.** Not "has a rough edge" — cannot. Across full 5-, 6- and 7-player
games, two independent things make a completed game impossible:

1. **A nomination that passes the vote can never be executed.** The Storyteller is shown
   *"This nomination met the threshold. Execute them when the table is ready."* and is given no
   button to do it. There is no other execution control anywhere in the app.
2. **No player ever finds out what they learned at night.** The engine computes the Chef's pairs,
   the Empath's neighbours, the Washerwoman's 1-of-2, the Fortune Teller's yes/no — stores it on the
   player record — and the client never renders it. Not at resolve, not at dawn, not in the day, not
   behind "More".

A third problem means the game can end in the *wrong winner*: with 5 players alive and the Imp dying,
the app announced **"🏆 Good wins! The Demon was executed."** when the rules say the Scarlet Woman
becomes the Demon and the game continues.

Everything below is the detail.

---

## Summary

| # | Finding | Severity | Evidence |
|---|---|---|---|---|
|---|---|---|---|
| 1 | An execution can never be confirmed | **P0** | played | | **FIXED** T5 — the game is playable end to end |
| 2 | Players never see their night result | **P0** | played | | **FIXED** T2 — a `night-result` moment, at resolve and at dawn |
| 3 | Scarlet Woman boundary off by one → Good wins Evil's game | **P0** | played | | **FIXED** T3 — 4+ after the Demon dies, and the heir is told |
| 4 | "Good wins ties" is inverted → Evil wins Good's game | **P0** | played | | **FIXED** T3 — Good wins simultaneous end conditions |
| 5 | Poisoner acts *after* every info role | **P0** | order played, effect read | | **FIXED** T2 — official order; the bad expectation was in a test named "official" |
| 6 | Virgin and Slayer have no implementation at all | **P0** | read | | **FIXED** T6 — the Virgin and the Slayer now work; one of them hid a worse bug |
| 7 | "More votes than any other nomination today" not implemented | **P0** | read | | **FIXED** T4 — a nomination must strictly beat the day's best |
| 8 | Mayor can win *after* an execution; checked at dawn not dusk | **P0** | read | | **FIXED** T4 — evaluated at dusk, once, before the day resets |
| 9 | Two executions in one day are possible | **P1** | read | | **FIXED** T4 — `executionHappenedToday` makes a second execution unreachable |
| 10 | A player can be nominated repeatedly in one day | **P1** | played | | **FIXED** T4 — once nominated, once nominated *at* |
| 11 | The threshold is described wrongly and never shown as a number | **P1** | played | | **FIXED** T1 — the number is shown and the wording is right |
| 12 | A dead player is never told they have a vote | **P1** | played | | **FIXED** T4 — `usedDeadVote` is published, spent votes offer nothing |
| 13 | Undertaker is always told nobody died by execution | **P1** | read | | **FIXED** T4 — the Undertaker reads a real execution record |
| 14 | Ravenkeeper wakes on later nights and after a daytime death | **P1** | read | | **FIXED** T6 — the wake is one-shot and never fires for an execution |
| 15 | A poisoned Soldier survives the Imp | **P1** | read | | **FIXED** T6 — a poisoned or drunk Soldier dies to the Imp |
| 16 | The 1-of-2 roles name a second, sometimes false, character | **P1** | read | | **FIXED** T2 — the false second character is gone |
| 17 | Fortune Teller's red herring is inert but the log claims it works | **P1** | read | | **NOT A BUG** — the red herring is assigned and read; the audit was wrong |
| 18 | A tie deletes the floor instead of raising it | **P1** | read | | **FIXED** T4 — a tie keeps the record and invalidates the earlier execution |
| 19 | The Drunk is shown a sentence about being drunk | **P2** | played | | **FIXED** T1 — the Drunk is never told they are drunk |
| 20 | Nominations and votes are accepted during the night phase | **P1** | read | | **FIXED** T4 — nominations and votes are refused outside the day |

Plus a UI/UX section, including two colour-contrast failures and the absence of any way to know your
phone was woken at night.

---

## What was fixed, and how it was verified

All 20 findings are closed. The UI/UX section is closed too: two WCAG contrast failures, tap targets
under 44px, the un-honoured Escape key, a silent phone at night, an unconfirmable **Mark Dead**, an
uncopyable join code, and a player stuck on "mark a dead player alive".

Each tier was: **fix → unit test → restart the server → play it in the browser**. Nothing was called
done on the strength of a test alone, and the tests were written to drive the path the bug actually
lived on — a predicate that nothing calls cannot be tested by calling the predicate.

| Tier | What it closed | Verified by |
|---|---|---|
| **1** | Contrast, tap targets, dialog dismissal, wake alerts, copy, vote wording, threshold number | `tier1.mjs` in the browser |
| **2** | Night results shown; 1-of-2 no longer lies; official night order | `probe-results.mjs`; a test named *"the official order"* had encoded the wrong order |
| **3** | Good wins ties; Scarlet Woman boundary; the heir is told and re-dealt | a full game won by Good in the browser |
| **4** | The day's rules: beat the day's best, one nomination each, dusk Mayor, Undertaker, dead votes, no day actions at night | `probe-vote.mjs`, `probe-renominate.mjs` |
| **5** | **The game is playable** — a `day-execution-pending` stage, an Execute button, and a pending execution that survives a later nomination | `probe-execution.mjs`; a completed 6-player game, correct winner |
| **6** | The Virgin, the Slayer, the Ravenkeeper's one wake, a poisoned Soldier, a poisoned Spy, and the Butler's legal targets | `probe-characters.mjs`; both characters played in the browser |
| **7** | Evil was being sent every other Evil player's true character; the Drunk could hold a cover with no ability; hand-killing the Saint did not lose the game; "neighbours" → "neighbors" | `probe-evil-leak.mjs`; 6- and 7-player Evil screens read in the browser |

### Three things worth keeping

**Two dead predicates were hiding a worse bug.** `virginTriggersExecution` and `slayerWouldKill` were
written, exported, and called by nothing. Wiring `slayerWouldKill` up immediately turned it into *any
player who successfully nominates the Demon kills them instead of being executed* — the game's central
day mechanic, silently broken, and the predicate never checked that the player doing the nominating
**was** the Slayer. The existing `winFlow` tests caught it within a run. It had been invisible for the
whole life of the app precisely because it was never called.

**Two rules are not the same kind of death.** The Virgin's text is *"they are executed immediately"*,
so it spends the day's one execution, the Undertaker learns the victim, and a Saint nominator loses
the game for Good on the spot. The Slayer's kill is a character ability, not a town execution, so it
does none of those — a Recluse registering as the Demon can be Slain, and that is not a Demon death.
One shared function (`applyExecution`) now owns that bookkeeping, because two copies of it is how the
Undertaker and the Mayor end up disagreeing about the same day.

**A test whose name asserts a rule it does not check is worse than no test.** The night-order test was
called *"returns the official First Night order"* and asserted an order that put the Poisoner fifth of
seven — after every information role had been told the truth, so poisoning anybody did nothing. It
made the bug look like a decision. The same applies to the two `**Confirmed by reading**` findings that
turned out to be wrong: the Fortune Teller's red herring is assigned in `distribution.ts` and read in
the resolve path, and poison correctly *outlives* the Poisoner, because poison is a duration
("tonight and tomorrow day") and not a standing effect.

### Known, deliberate, and out of scope

- **One socket per player and per Storyteller.** A second tab steals that player's private prompts.
  Unfixed, and it is a limitation rather than a bug.
- **No persistence.** A server restart loses every live game.
- **The legal-target picker is a filtered list of names.** For a character whose choice is restricted
  by hidden information — the Butler may not choose a Minion or the Demon — the player can infer who
  was excluded. This is inherent to the app's approach, it predates this work, and narrowing it is a
  design change rather than a fix.

---

# Confirmed by playing

## 1. P0 — An execution can never be confirmed

**What I did.** 5 players, dealt the roles, played night 1 through to dawn, then nominated somebody
and had every living player vote yes.

**What happened.**

```
tally panel before any votes: "Nomination: Bram / Nominated by Cleo / Votes for execution: 0"
4 players click "Vote to Execute"
tally panel after 4 vote(s):  "Nomination: Bram / Nominated by Cleo / Votes for execution: 4"
host clicks "Close the vote"
host's panel:  "On the block — Bram was nominated by Cleo. 4 votes for execution.
                This nomination met the threshold. Execute them when the table is ready."
host offered "Execute": false
flow stage: day-discussion
```

The server did the right thing — the vote qualified. The client then has no control to finish it.
Screenshot: `tools/playtest/shots/sc-vote-after-vote-ST.png`. The Storyteller's screen says
*"This nomination met the threshold. Execute them when the table is ready."* in red, and the panel
above it says **"Anyone can nominate. Otherwise, discuss."** The only button anywhere is
*🔊 Say it again*.

**Why.** Two conditions that can never both be true:

- `packages/server/src/game/flow.ts:272` — the stage is `day-voting` only while the nomination is
  **open**: `if (session.nomination && !session.nomination.closed)`.
- `packages/server/src/game/rules.ts:90,101` — `closeVote` sets `closed = true` and
  `pendingExecution = true` together.
- `packages/client/src/components/flow/StorytellerScript.tsx:239` — the Execute button needs
  `flow.stage === 'day-voting' && flow.executionPending`.

`StorytellerScript.tsx:244` is the only `StorytellerConfirmExecution` emit in the whole client, so this
is not a misplaced button — the feature has no reachable trigger.

**Knock-on effects, all confirmed in the same game:**

- **Close the vote is on the same gate**, so a nomination opened at night can never be closed.
- **Players never see the verdict.** `VoteTally` unmounts the instant the vote closes
  (`PlayerGamePage.tsx:67`), so *"This nomination met the threshold"* — the one line that tells the
  table anything — is shown to nobody. Bram, the nominee, saw only *"Talk it over. Nominate if you
  have a reason."* with a live Nominate button.
- **Every win condition that needs an execution is unreachable:** demon-executed, Saint-executed, and
  the Mayor's "no execution occurred" clause.
- In a 5-player, 2-day game: **5 nominations, 10 votes, 0 executions.**

**Fix direction.** Gate the button on the fact that means it — `flow.executionPending` alone — or give
the flow an explicit `day-execution-pending` stage so "closed, qualifying, awaiting execution" has a
name. Do this *after* findings 7, 8 and 9, or the app will execute the wrong player, twice in a day.

## 2. P0 — Players never see their night result

**What I did.** 7 players, dealt an Empath, a Fortune Teller, a Monk, a Butler, a Baron, an Imp and a
Drunk. Played a complete night, then watched **all seven windows at six separate beats**.

**What happened.** The string `You learn` appeared **zero times** in any window, at any beat:

```
[night open]                        results on screen: NOBODY
[the instant the night is resolved]  results on screen: NOBODY
[after the night resolves]           results on screen: NOBODY
[before moving to the day]           results on screen: NOBODY
[at dawn, before the day starts]     results on screen: NOBODY
[during the day, after it settled]   results on screen: NOBODY
Empath's own "More" sheet: "Everything else / Close / Your character / Empath / Townsfolk / GOOD /
  Each night, you learn how many of your 2 alive neighbours are evil. / Who is sitting where / ..."
```

The last line is the sting: the Empath's character card *describes* the information, and the
information itself is nowhere.

**Why.** `PlayerGamePage.tsx:119-133` renders `<NightPromptPanel>` only when `moment.showNightPrompt`
is true, and `shared/src/protocol/moment.ts` sets `showNightPrompt: true` in exactly one branch —
`awake-choose`, the state where a player still owes a choice. The result is delivered by the server
when the night resolves, at which point the player no longer owes a choice, so the only component
that can render a result is unmounted. The Chef and Empath, who never get a prompt at all, can never
see theirs by construction.

**What this means for the product.** The app's stated job is that it knows *whose turn it is, what
they may do, and what they learn*. Two of those three are broken. A table running this app learns
nothing at night, which is the entire information economy of the game.

## 3. P0 — The Scarlet Woman boundary is off by one, and Good wins a game Evil did not

**What I did.** Re-dealt 5-player tables until the roster contained a Scarlet Woman, then used the
Storyteller's own **Mark Dead** button on the Imp. With 5 players that leaves 4 alive — the exact
boundary the rulebook names.

**What happened.**

```
roster: Esme=Imp, Ada=Scarlet Woman, Bram=Investigator, Cleo=Librarian, Dev=Virgin
5 players are alive, the Imp is Esme, the Scarlet Woman is Ada
the host marks Esme dead -> 4 alive afterwards
grimoire afterwards: Esme=Imp(dead), Ada=Scarlet Woman, ...
Ada is now: Scarlet Woman (alive)
game stage: ended
banner: 🏆 Good wins! The Demon was executed.
```

**Expected.** *"If there are five or more players alive & the Demon dies, you become the Demon"* —
counted just before the Demon dies, i.e. **four or more still alive after**. Five was alive. Ada must
become the Imp and the game must continue. Instead the app handed Good the win.

**Why.** `packages/server/src/game/winConditions.ts:38` reads
`if (livingPlayerCount(session) < 5) return null;`, and that count is taken **after** the Demon is
marked dead, so it demands five survivors — one more than the rules require. The FIXME three lines
above it describes exactly this and is correct about the symptom, but its proposed fix
(`>= 5`) would have made the off-by-one *permanent*, since the code already implements `>= 5`.

> **Note for whoever fixes this:** two of the three auditors I ran concluded this was *not* a bug,
> because they tested at 6 alive (5 after) rather than at the boundary. The boundary case is the only
> one that matters and it fails. Do not "fix" the FIXME to `>= 5`.

**Still to pin down.** A control run at 6 alive (5 surviving) also left the Grimoire showing
`Scarlet Woman` and announced no outcome at all. Either the takeover did not fire, or it fired and
neither the player nor the host was told. Both are wrong; the mechanism needs one more check.

## 4. P0 — "If both teams would win, good wins" is implemented backwards

**What I did.** 6 players, thinned the table to 3 alive with Mark Dead, then marked the Imp dead.

**What happened.**

```
roster: Cleo=Imp, Bram=Spy, Ada=Soldier, Dev=Fortune Teller, Fay=Monk, Esme=Butler
alive: 3 (Cleo, Fay, Esme)
now marking the Imp dead -> 2 alive, both win conditions true at once
banner: 🏆 Evil wins! Only two players remain.
```

**Expected.** The rulebook is explicit: *"If both teams would win at the same time, good wins. For
example, if the Demon dies but that leaves only two players left, the good team wins."*

**Why.** `winConditions.ts:77` tests `livingPlayerCount(session) <= 2` **first** and returns
immediately, so it always beats the no-Demon check at `:81`. There is no code path in the repo that
lets a Good win take precedence. `winConditions.test.ts:73` asserts the current behaviour in a test
named *"prioritizes the two-players-left Evil win over a simultaneous no-Demon Good win"* — the test
name documents the bug as though it were the rule, which is why the suite is green.

## 5. P0 — The Poisoner acts after every information role

Read straight off the Storyteller's own Night Order panel during play.

```
night 1:  3. Investigator — Bram    8. Poisoner — Esme    10. Imp — Dev
night 2:  4. Monk — Cleo           7. Poisoner — Esme     9. Imp — Dev
```

Official Trouble Brewing, first night: **Poisoner first**, then Washerwoman, Librarian, Investigator,
Chef, Empath, Fortune Teller, Butler, Spy. Other nights: **Poisoner, Monk, Scarlet Woman, Imp**,
then Ravenkeeper, Empath, Fortune Teller, Undertaker/Butler, then **Spy last**.

The app's night order is close to the **reverse**: information roles first, the Minion actions last,
with the Imp last of all on night 1 and second-to-last afterwards. The Minions and Demon are woken
first in the official order precisely so the Storyteller knows what may safely be told before anyone
acts on it.

**Consequence, confirmed by reading:** poisoning someone that night does nothing, because everyone has
already received their information and already applied their ability before the Poisoner picks. A
poisoned Chef is told the true pair count, and the night log records them as a healthy waker.

Two smaller deviations in the same data: the **Butler never wakes on night 1** (`firstNightOrder: null`
where the official sheet has a Butler slot), and the **Empath acts before the Imp**, so the Empath
counts a neighbour who is about to die — officially dead neighbours are skipped.

## 10. P1 — The same player can be nominated over and over in one day

**What I did.** Nominated Dev, let the vote fail with nobody voting, then had a different player
nominate Dev again.

**What happened.**

```
first nomination of Dev:  "This nomination did not pass. Nothing happens — a player who has not
                           yet nominated can try again."
Cleo then nominated Dev again: ok=true
host's panel: "On the block — Dev was nominated by Cleo. 0 votes for execution. Voting is open."
```

The rules are explicit: *"Each player may nominate only once per day, and **each player may be
nominated only once per day**."* In the threshold sweep the same player was nominated three times in
succession, and the app allowed all three. The nominee side is unenforced in `rules.ts:9-32` and there
is no `hasBeenNominatedToday` field on the player record at all.

This is not cosmetic: it lets a table re-run a vote on a player until it sticks, and it makes
finding 7 (comparing today's tallies) impossible to reason about.

## 11. P1 — The threshold is described wrongly, and the number is never shown

The moment card, shown to every living player every time a vote opens:

> **Vote: hands up if you are in.**
> *"A simple majority of the living players executes. You can change your vote until the Storyteller
> closes it."*

**The rule is not a simple majority.** It is *"the number of votes equals or exceeds half the number
of alive players"*. On any even table the two disagree:

| players alive | half or more (correct) | simple majority (what the app says) |
|---|---|---|
| 6 | 3 | 4 |
| 8 | 4 | 5 |
| 10 | 5 | 6 |

So on 6, 8, 10, 12 and 14-player tables the app executes on 50% while telling every player a majority
is needed. A player who has counted four of six and concluded they are one short will sit on their
hand — and the vote will carry anyway.

**The engine itself is correct.** I swept the vote count at 5 alive and measured exactly where the line
falls:

```
1 vote  -> did not pass
2 votes -> did not pass
3 votes -> MET the threshold
4 votes -> MET the threshold
5 votes -> MET the threshold

>>> lowest number of votes that carries an execution, out of 5 alive
    CORRECT — 3 carries it, which is ceil(5/2)
```

So this is purely a communication bug. The tally panel shows `Votes for execution: 4` with no
denominator, and the outcome line is a bare *"met the threshold"*. The number a player needs is
rendered in **zero** places in the app. The tie rule (*"a nominated player must exceed this tied
number of votes"*) is likewise never stated, and a tie is reported with the same words as an ordinary
failure.

## 12. P1 — A dead player is never told they have a vote

**What I did.** Played a night, killed a player with Mark Dead, then carried them into a second day.

**What they are shown, both days:**

```
"You are dead. Listen." — "You cannot act today, but you can still ask the Storyteller a question."
```

The app has good copy for this and almost never shows it. *"You are dead — but you have one vote
left"* only appears at the `day-voting` stage, so a ghost sitting in discussion is never told the vote
exists at all, and nothing anywhere says the vote is **once for the rest of the game** rather than once
a day. `usedDeadVote` is not in the lobby payload, so the client cannot know whether to offer the
button.

> My check of whether a *second* dead vote is refused was inconclusive — I inspected the tally panel
> after the vote had closed, by which point the app has already unmounted it. The server's refusal is
> correct by reading (`rules.ts:42-50`); the client offering a live button that always errors is the
> open question.

## 19. P2 — The Drunk is shown a sentence about being drunk

Cleo was the Drunk, with their cover character (Investigator) shown correctly — the Drunk leak is
genuinely handled. But the prompt's rules note, shown to that player, reads:

> *"This is how your own ability works — that part is always accurate, even if you are drunk or
> poisoned. What you are told about other players may not be."*

To a Drunk that is a nudge towards the one secret the app is supposed to protect hardest. Low
severity, trivial to fix: the note does not need to name the conditions.

## 10b. P1 — The 1-of-2 prompt promises information the rules do not grant

> *"Choose a player. You will learn which player, and which Minion, 1 of 2 players is."*

The card says *"You start knowing that 1 of 2 players is a particular Minion."* The official
information is **the character, not which of the two players it is** — the Wiki is explicit that the
Washerwoman does not learn who is playing them. The app promises the stronger version and, per
finding 2, delivers nothing at all.

---

# Confirmed by reading

Not reproduced through the UI. Each of these came from a static audit of the server and client against
the official rules. They are the right next things to test.

### 6. P0 — The Virgin and the Slayer do not exist

Both predicates are written and correct (`abilities.ts:254`, `:271`) and both wrappers exist
(`rules.ts:145`, `:150`). **Nothing calls either one.** There is no socket event, no gateway call and
no client control for either. Nominating the Virgin runs an ordinary vote, and there is no way at all
to use the Slayer. Two of the 22 characters are dealt, shown to players with their ability text, and
cannot be honoured.

The Virgin is trivially testable through the UI and should be next.

### 7. P0 — "More votes than any other nomination today" is not implemented

`closeVote` (`rules.ts:95`) tests only for an **exact tie** against an earlier tally. A nomination
that clears the threshold with *fewer* votes than an earlier one today is flagged as fully
qualifying. A real day is a descending ladder — 5 hands, then 4 — and the app would execute the player
with fewer votes while the player with more walks.

### 8. P0 — The Mayor's win fires at the wrong time and in the wrong place

The rule triggers **at dusk**. `checkMayorWin` is called from exactly two places: at **dawn**, right
after `resetForNewDay` has cleared the record it depends on, and after **every closed vote**. The
dusk branch of the phase switch contains no win check at all. Two consequences:

- At dawn, "no execution today" is true *by construction*, so a 3-alive table with a living Mayor ends
  the game before anyone opens their eyes — while the table still has a decision to make that would
  hand Evil a win.
- After any execution, `confirmExecution` deletes the day's nomination record (`rules.ts:140`), which
  is the only thing `checkMayorWin` inspects. So the Mayor can win **after** an execution occurred.

### 9. P1 — Two executions in one day are possible

There is no day-scoped "an execution has occurred" flag. `nomination.executed` guards a single
nomination, and `pendingExecution` is deliberately never cleared. Currently unreachable behind
finding 1; **it becomes live the moment the Execute button is restored**, which makes this the finding
most likely to be shipped by accident.

### 13. P1 — The Undertaker is always told nobody died by execution

`executedPlayerToday()` reads the day's nomination record, and `confirmExecution` deletes that record
the moment it executes — the very record it needs. With a second defect that it returns the *true*
character rather than the registered one.

### 14. P1 — The Ravenkeeper wakes on every night after dying, however they died

`buildNightOrder` appends every dead Ravenkeeper with no death-cause check and no once-per-game guard.
Executed on day 1, they wake on night 2, night 3, and every night after.

### 15. P1 — A poisoned Soldier survives the Imp

Protection is applied with no poison check on either side, and the official ruling is the opposite: a
poisoned Soldier **does** die to the Imp.

### 16. P1 — The 1-of-2 roles name a second character, sometimes false

The result appends *"The other is the X."* where X is drawn from real in-play characters of the
waker's own type, independent of the player actually shown. The auditor's harness produced:

> *"You learn that 1 of 2 players — P5 or P1 — is the **Investigator**. The other is the Soldier."*

The Investigator is being told their own character is in play. A related type-comparison bug means the
Librarian is handed a Townsfolk name, and the Investigator is too.

### 17. P1 — The Fortune Teller's red herring is inert, and the log says it works

`chooseRedHerring` picks a Good player but nothing ever sets their registration to Demon. Picking
only the red herring returns *"You learn that neither of them is the Demon"* while the Storyteller's
night log reads *"Player6 registers as the Demon to the Fortune Teller."* The Fortune Teller is a
coin flip every night and can be provably always-no — the most identifiable player in the script.

### 18. P1 — A tie deletes the floor instead of raising it

On a tie the earlier record is **removed** from the list, so a third nomination with the identical
count then executes. The rule is that the tied number must be *exceeded* for the rest of the day.

### 20. P1 — Nominations and votes are accepted during the night phase

`PlayerNominate` and `castVote` never check `session.phase`. The client hides the controls, so this
needs a stale client or a crafted message — but it is the same class of problem: the server trusts
the client for the phase.

### Also worth knowing

- ~~**5- and 6-player tables leak.**~~ **FIXED.** Every Evil player was sent every other Evil
  player's true character name at deal time. "You learn who the other Minions are" is a list of
  *names*, and only at 7+ players. The character is now absent from the payload type entirely, so it
  cannot be added back without the type changing.
- ~~**The Butler is never told who their Master is.**~~ **NOT A BUG — this entry was wrong.** The
  Butler is not supposed to learn who their Master is; the Storyteller enforces the restriction
  silently. Correcting this entry is what led to the real Butler problem, which was that they could
  not choose an Outsider at all.
- ~~**The Drunk's cover can be Soldier, Virgin or Slayer.**~~ **FIXED.** (The Mayor was never a
  possible cover — the pool filters to Townsfolk.) Those three do nothing on their own, so such a
  Drunk is shown ability text at night and can never once use it.
- ~~Ability text says "neighbours".~~ **FIXED.** Now "neighbors", as the official cards spell it.
  Three tests held stale copies of the old strings, which is how it drifted unnoticed.
- ~~`StorytellerMarkDead` bypasses the Saint check.~~ **FIXED.** Hand-killing the Saint was a free
  kill for the Storyteller; the same death by nomination ended the game. It still does not put the
  player in `executedToday` or spend the day's execution, because correcting the board is not a vote
  that resolved — so the Undertaker and the Mayor are unaffected. A *poisoned* Saint still does not
  trigger, which is the other half of that ruling and is now tested too.

---

# Checked and correct

Recording these because a playtest that only lists faults is not evidence of a working one.

- **The execution threshold is `ceil(alive / 2)`**, measured by sweeping the vote count: 3 of 5
  carries, 2 does not. Exactly half, as the rulebook requires.
- **The Drunk is never told they are the Drunk.** Their cover character is shown, their night step
  runs under the cover's prompt, and their information is unreliable. Confirmed on screen.
- **The distribution table matches the official Trouble Brewing table** for 5–15, and the **Baron's
  `+2 Outsiders`** modifier is applied correctly (6 players with the Baron dealt 1 Townsfolk,
  3 Outsiders, 1 Minion, 1 Demon).
- **The Chef's adjacent-pairs model is right** — 2 adjacent evil is 1 pair, a contiguous run of *k*
  contributes *k−1*, counted against registration. The wording "pairs of adjacent evil players" is
  correct and should not be "changed".
- **The wake walk never skips anyone.** Across every night played, the sequence was strictly
  `wake → close your eyes → wake → close your eyes`, with nobody told to sleep twice in a row and
  never two players told to choose at once. This is the bug class `MEMORY.md` says has bitten three
  times, and it is holding.
- **The pause between wakers works**, including "Skip the wait".
- **Dead players' identities are never revealed** — the Grimoire is Storyteller-only and the
  Graveyard shows a name with no role.
- **The public announcement never leaks a role or an alignment**, and it never contradicted the
  spoken line.
- **The first-run join flow is genuinely frictionless.** Type the code, type the name, you're in.
- **The player's moment card does what it claims.** Measured at 390×844, the one action and its
  control sit inside the first viewport with room to spare, the prompt is a structural child of the
  card, and there are no tabs.

---

# UI and UX

Judged by looking at 480 screenshots at 390×844, and by measuring the live DOM.

## The screen that is genuinely wrong

The stuck execution state is the worst screen in the app, and it is a *design* failure as much as a
code one. The app's own rule is "one thing to do now, its control directly beneath it". Here the one
thing to do is **execute someone**, the panel says so in red, and the control does not exist. The
panel above cheerfully says *"Anyone can nominate. Otherwise, discuss."* — actively inviting the
Storyteller to do the wrong thing.

Worse, the *only* thing the table can do is keep nominating, which overwrites the pending execution.
Fixing the button without locking nomination while `pendingExecution` is true turns a dead end into a
silent data-loss bug.

## Rules the app teaches wrongly, or not at all

This is the part I would fix first, because no amount of polish matters if the app is the only
rules reference a new player has.

The complete rules text a player can reach in this app is four etiquette lines — *"Talk freely"*,
*"Don't peek"*, *"Ask the Storyteller anything"*, *"Play kindly"* — under a heading called **"The
Rules"**, followed by one sentence describing that the game alternates between day and night. That
is all of it. `RulesReferencePanel` ("How this works") shows the same four lines and less.

So the app teaches **nothing** about:

- how a nomination carries (and states it wrongly when it does — finding 11);
- that a dead player gets **one** vote for the whole game (finding 12);
- that the **Mayor** and the **Saint** each have a win condition — the only mention of either in the
  entire app is a line in the end-game banner, so a player holding the Saint does not know they are one
  nomination from losing;
- what *"registers as"* means. The best explanation in the codebase is on the **Storyteller's** screen
  (`NightDiscretionPanel`), which a Recluse never sees. What a Recluse gets is the jargon
  *"You might register as evil & as a Minion or Demon"* with no definition;
- that you find out what you learned **the next morning**, which is the single most common
  misunderstanding in a first game;
- that you are woken **by name, one at a time**, and that being woken with nothing to pick is normal.

The Storyteller route in `App.tsx` renders **no onboarding at all**. The one person at the table who
is required to know the rules gets the app with no explanation of it.

## Two colours fail contrast, and they are the two that matter

Computed from `tokens.css` against the actual panel backgrounds:

| colour | on panel | on tinted panel | carries |
|---|---|---|---|
| `.faint` `#6f6a85` | **3.51:1** | **2.79:1** | every explanatory line in the app |
| `.alignment-evil` `#c23b3b` | **3.43:1** | **3.08:1** | *"Execute them when the table is ready."* |

Both need 4.5:1. `.faint` is the class that explains what is happening — the ability rules note, the
vote instructions, "This nomination did not pass", "Questions can be asked during the day" — and it
is the hardest text on every screen. `.alignment-evil` is used for the single most important sentence
in the game. One-line fixes that the palette already contains: `--text-faint: #938daa` (5.71:1) and
`--evil-red: #e35a5a` (5.06:1), the value `.badge-demon` already uses.

## Disabled controls are nearly invisible

`.btn:disabled { opacity: 0.45 }` renders the label at about 3.9:1 and turns the gold gradient to olive.
That matters more than usual here, because **a disabled control is the client telling the player no**,
and the app's own standard is that the client is the thing that has to know. A player who cannot see
it was told nothing. Replace the blanket opacity with an explicit disabled palette (~6:1, still
obviously inert) and, better, say why: the disabled *Send my choice* should read *"Pick 1 player
first"*, not just sit grey.

## Nothing tells a player they have been woken

Grepped the whole client: zero uses of `document.title`, `Notification`, `vibrate`, or any audio. The
browser has all three and the app never touches them.

So the complete set of signals a player gets when the Storyteller wakes them at night is: the card's
border turns gold, the emoji changes, and two words change. If the phone is face-down, in a pocket,
on silent, or the app is backgrounded, they receive **nothing** — and the Storyteller has to shout
the name, which is precisely the ritual the app exists to replace.

The cheapest fix with the most value is `document.title`, which shows in the app switcher and the
tab bar with no permission prompt: `'⚡ YOU ARE AWAKE'` while a choice is owed. Then `navigator.vibrate`
behind an opt-in toggle, then a web notification requested from a "wake me at night" switch the player
turns on during onboarding.

Related: the spoken-information toggle is **off by default and sits last on the card**, below the
character, the ability text, the instruction and the button, at 0.85rem next to a 13×13px checkbox. In
practice the accessibility feature is off for every player, on every night.

## Smaller things, with the fix

| Problem | Fix |
|---|---|
| The join code exists only in the lobby, and a dropped player can never rejoin (`routes.ts:59`) | Show the code in the More sheet with a copy button; let the Storyteller bring back a disconnected player |
| The join code runs into the sentence below it and is easy to misread when read aloud | Put it on its own line at 2rem with character spacing, and add a copy button |
| `Players (5/15)` implies 15 is the target when 5 is the minimum | `Players — 5 (anywhere from 5 to 15)` |
| The onboarding modal is a mandatory, unskippable, 3-step block **over the lobby**, with no backdrop tap, no Escape and no close button | One gate: *"I know this game"* / *"Show me how it works"* |
| Onboarding shows both the Good and Evil goals in green and red, in the lobby, **before roles are dealt** | Render it in neutral text until the character arrives — a phone lying face-up should not preview an alignment |
| `NightPromptPanel` tells the Spy *"Your Grimoire is on your Character tab"* — **there are no tabs**; that view was deleted | *"Your Grimoire is shown on your own screen."* Then widen `moment.test.ts` to cover rendered text, not just the derived strings, so this cannot come back |
| The Storyteller's "Mark Dead" is one unconfirmed, irreversible click that kills a player | Require a confirm naming the player |
| Six dialogs have no Escape, no backdrop tap and no focus trap, while claiming `aria-modal` | One shared hook for all six |
| The Grimoire's poison/drunk/protected checkboxes are 18×18px — 21 of them | Wrap the label as the tap target, min 44px |
| Seating move arrows are 25×23px because inline styles beat the mobile media query | Remove the inline styles; the CSS rule already exists |
| `viewport-fit=cover` is missing, so `env(safe-area-inset-bottom)` is always 0 and the "More" button sits under a notched phone's home indicator | Add it to the viewport meta |
| Both chat panels never auto-scroll, so a player scrolled up watches new messages arrive invisibly | Pin to the bottom on new messages, or show a "↓ 3 new" pill |
| The Storyteller's phase switch and night order live behind "More" on a 4-screen page | A one-line status strip under the script: day, alive count, poisoned, nomination, questions waiting |
| The Grimoire is 2.4 screens tall on a phone | A collapsible "Table" panel, collapsed under 600px, with a summary line: *7 alive · poisoned: none · drunk: Dev · Imp: Fay* |

---

# Reproducing this

```bash
npm install
npm run build --workspace=packages/shared
npm run dev:server        # :3001
npm run dev:client        # :5173

node tools/playtest/smoke.mjs                          # harness self-test, run first
PLAYERS=5 NIGHTS=2 node tools/playtest/play-game.mjs   # a whole game, beat by beat
SCENARIO=vote  node tools/playtest/scenarios.mjs        # can an execution happen at all?
SCENARIO=half  COUNT=6 node tools/playtest/scenarios.mjs  # where exactly is the threshold?
SCENARIO=twice node tools/playtest/scenarios.mjs        # re-nominating the same player
node tools/playtest/probe-results.mjs                  # does anyone ever see a night result?
node tools/playtest/verify.mjs                         # Scarlet Woman boundary, tiebreak, ghost vote
```

Screenshots and per-run logs land in `tools/playtest/shots/`.

**Two rules the harness lives by**, both learned the hard way and both in `MEMORY.md`:

1. **Never open a second socket for a player or the Storyteller.** Private night prompts go to a
   single connection, so a second socket steals them and the browser then looks like it lost them.
   Every fact here is read from the real windows.
2. **Scope every click to its own panel.** Matching button text across a page hits the wrong control —
   the moment card's "Nominate someone" sits above the Nominate panel's own "Nominate" button.

## What I did not cover

- **Tables of 8–15 players.** Played at 5, 6 and 7. The static audit exercised larger rosters.
- **The Virgin, the Slayer, the Saint, the Mayor and the Soldier by play** — all read-only findings.
  The Virgin is the easiest to test next and is the most alarming of them.
- **Reconnect, second-tab and server-restart behaviour.** Read only, not played.
- **The 1-of-2 and Empath result text**, because finding 2 means no result ever reaches a screen to
  check.
- **Audio output** — the servers run headless, so nothing was actually spoken.
