/**
 * Plays a whole game through the real UI, one beat at a time.
 *
 *   node tools/playtest/play-game.mjs            # 5 players, 2 nights
 *   PLAYERS=7 NIGHTS=3 node tools/playtest/play-game.mjs
 *
 * Every action is a click in a real browser window. Every fact is read off a real
 * screen. There is no socket poking and no direct API call anywhere in this file.
 *
 * What it checks, at every single beat:
 *   - exactly one player is ever told to make a choice
 *   - nobody is told "close your eyes" twice in a row without a wake between
 *   - the Storyteller's spoken line never names a role (it is public information)
 *   - every control offered to a player is one the server will actually accept
 *   - the night's private results, for comparison against the official card text
 */
import { openTable, ALL_NAMES, PHONE } from './table.mjs';
// `roster` parses the Grimoire's CARD layout into objects; the harness's own
// `grimoire()` reads the table layout and returns raw strings.
import { roster } from './lib.mjs';

const PLAYERS = Number(process.env.PLAYERS ?? 5);
const NIGHTS = Number(process.env.NIGHTS ?? 2);
const tag = process.env.TAG ?? `p${PLAYERS}`;

const t = await openTable({ count: PLAYERS, tag, viewport: PHONE, names: ALL_NAMES.slice(0, PLAYERS) });

/** Everything the table was told, in order, so it can be read back afterwards. */
const announcements = [];
const results = [];
let lastSay = null;

// ---------------------------------------------------------------------------
// The night walk.
// ---------------------------------------------------------------------------

/**
 * Runs one night from "everyone close your eyes" to the table being woken up.
 * Returns the stage the flow ended on.
 */
async function playNight(night) {
  t.say(`\n########## NIGHT ${night} ##########`);

  // The Storyteller opens the night by telling the table to close their eyes.
  const briefing = t.stClick('Eyes are closed', { within: 'What to do now', timeout: 8000 });
  t.say(`  host: "Eyes are closed — start waking people" clicked: ${briefing}`);
  await t.nap(500);
  await t.shot(`n${night}-01-briefing`);

  // The night order the Storyteller is working from, for comparison with the
  // official Trouble Brewing night sheet. Read once, while nobody is waiting.
  const order = await t.nightOrder();
  t.say(`  night order the host is shown (${order?.items?.length ?? 0} steps):`);
  for (const line of order?.items ?? []) t.say(`      ${line}`);
  results.push({ kind: 'night-order', night, order: order?.items ?? [] });

  let beat = 0;
  let patience = 0;
  for (; beat < 120; beat += 1) {
    await t.nap(300);
    const s = await t.tableState();

    if (s.say && s.say !== lastSay) {
      announcements.push({ night, beat, say: s.say });
      t.say(`  [beat ${beat}] stage=${s.stage}  SAY: "${s.say}"`);
      lastSay = s.say;
    }

    if (['day-reveal', 'day-discussion', 'day-voting', 'ended'].includes(s.stage)) {
      t.say(`  night walk finished at stage=${s.stage}`);
      return s.stage;
    }
    if (s.stage === 'night-resolving' && s.canEndNight) {
      await t.stClick('Move to the day', { within: 'What to do now' });
      t.say('  host moved the table to the day');
      return 'day-reveal';
    }

    // A player who is awake and owes a choice. Read off the players' OWN screens,
    // then double-checked against the server's "who owes a choice" before clicking,
    // because a panel left over from an earlier waker still looks actionable.
    if (s.owesAChoice.length > 1) {
      t.problems.push(
        `night ${night} beat ${beat}: ${s.owesAChoice.length} players told to choose at once — ` +
          `${s.owesAChoice.join(', ')}`
      );
    }
    if (s.owesAChoice.length === 1) {
      const who = s.owesAChoice[0];
      const awake = (await t.awakePlayers()).find((a) => a.name === who);
      if (awake && !awake.submitted && awake.targets.length > 0) {
        const wanted = awake.targets.slice(0, Math.max(1, awake.needed));
        const r = await t.playerSubmit(who, wanted);
        t.say(`     ${who} (${awake.character || 'no picker'}) chose ${wanted.join(' + ')} — sent=${r.sent}`);
        if (!r.sent) {
          t.problems.push(`night ${night} beat ${beat}: ${who} could not send a choice. ${r.why ?? ''}`);
        }
        await t.shotOne(who, `n${night}-choice`);
        patience = 0;
        await t.nap(500);
        continue;
      }
      if (awake && awake.submitted) {
        // Submitted, so the wait is now on the Storyteller, not the player.
        t.say(`     ${who} has sent their choice; waiting for the host`);
      }
    }

    if (s.owesAChoice.length === 1) {
      patience += 1;
      if (patience < 12) {
        await t.nap(500);
        continue;
      }
      t.problems.push(
        `night ${night} beat ${beat}: ${s.owesAChoice[0]} is told to choose but has no usable control. ` +
          `say="${s.say}"`
      );
      await t.shot(`n${night}-stuck-owing`);
      return s.stage;
    }

    // The pause between wakers, so the table cannot time the order.
    if (s.gateRunning) {
      await t.stClick('Skip the wait', { within: 'What to do now', timeout: 2500 });
      await t.nap(250);
      continue;
    }

    if (s.canMoveOn) {
      const who = s.owesAChoice[0] ?? '(nobody owes a choice)';
      await t.stClick('dealt with', { within: 'What to do now', timeout: 2500 });
      t.say(`     host dealt with ${who}`);
      patience = 0;
      await t.nap(350);
      continue;
    }

    if (s.canResolve) {
      await t.stClick('Resolve the night', { within: 'What to do now', timeout: 3000 });
      t.say('     host resolved the night');
      patience = 0;
      // Read the private results HERE, while the night is still the current phase.
      // The app clears the live result slot at dawn on purpose, so a check that runs
      // after "Move to the day" sees nothing and wrongly reports that players are
      // never told anything.
      await t.nap(900);
      const info = await t.privateInfo();
      t.say('  what each player was told at the end of the night:');
      let any = false;
      for (const [who, r] of Object.entries(info)) {
        if (!r.result) continue;
        any = true;
        t.say(`      ${who}: ${r.result}`);
        results.push({ kind: 'night-result', night, player: who, text: r.result });
      }
      if (!any) t.say('      NOBODY received a result this night');
      continue;
    }

    if (s.canStartDay) {
      await t.stClick('read the dead', { within: 'What to do now', timeout: 3000 });
      t.say('     the table has read the dead; the day starts');
      await t.nap(700);
      continue;
    }

    t.problems.push(
      `night ${night} beat ${beat}: no usable control at stage=${s.stage}. ` +
        `say="${s.say}" moments=${JSON.stringify(s.players)}`
    );
    await t.shot(`n${night}-stuck`);
    return s.stage;
  }

  t.problems.push(`night ${night}: the walk never finished (${beat} beats)`);
  return 'timeout';
}

/** Everything the app privately told each player at the end of a night. */
async function collectResults(night) {
  const info = await t.privateInfo();
  t.say(`  what each player was told at the end of night ${night}:`);
  for (const [who, r] of Object.entries(info)) {
    if (r.result) t.say(`      ${who}: ${r.result}`);
  }
  results.push({ kind: 'night-results', night, info });
}

// ---------------------------------------------------------------------------
// The day.
// ---------------------------------------------------------------------------

/**
 * Runs the day as a state machine rather than a script, because the day genuinely
 * has several shapes: nobody has spoken, a vote is open, a vote passed, a vote
 * failed and somebody wants another go.
 */
async function playDay(night) {
  t.say(`\n########## DAY after night ${night} ##########`);
  let beat = 0;
  let nominated = 0;
  // How many players in a row have been found with a live nominate control and then
  // turned out to have spent it. One player's spent control is not a dead table, so the
  // driver moves on to the next; a long run of them means the day really is over.
  let refusedNominators = 0;

  for (; beat < 45; beat += 1) {
    await t.nap(400);
    const s = await t.tableState();
    if (s.stage === 'ended') {
      t.say('  the game ended during the day');
      return 'ended';
    }

    if (s.canExecute) {
      const name = s.say;
      await t.stClick('Execute ', { within: 'What to do now', timeout: 3000 });
      t.say(`  host executed the nominee (${name})`);
      // The execution banner is a timed banner, and when the execution also ends the
      // game the phase flips to `ended` in the same beat, so give the broadcasts a moment
      // to land before reading what anybody was told.
      await t.nap(1500);
      await t.shot(`n${night}-day-executed`);
      // Who was told, in their own window, that they had died.
      const told = [];
      for (const n of t.names) {
        const m = await t.moment(n);
        const banner = await t.windows[n]
          .evaluate(() => {
            const el = [...document.querySelectorAll('[role="alert"]')].find((x) =>
              /executed/i.test(x.textContent ?? '')
            );
            return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
          })
          .catch(() => null);
        t.say(`     ${n}: ${m ? `${m.kind} — "${m.title}"` : '?'}${banner ? `  banner: "${banner}"` : '  (no banner)'}`);
        if (banner || m?.kind === 'dead' || m?.kind === 'ended') told.push(n);
      }
      t.say(`     players whose own screen acknowledges the death: ${told.join(', ') || 'NOBODY'}`);
      results.push({ kind: 'execution', night, acknowledgedBy: told });
      continue;
    }

    if (s.canCloseVote) {
      const tally = await t.tallyOn(t.names[0]);
      t.say(`  vote open. the tally panel says: "${tally?.text ?? '(no tally)'}"`);
      results.push({ kind: 'tally-copy', night, text: tally?.text ?? null });
      // Some players deliberately abstain so the threshold can be tested.
      const yes = Number(process.env.VOTE_YES ?? PLAYERS);
      const voters = t.names.slice(0, yes);
      const { voters: n, refused } = await t.allVote({ except: t.names.slice(yes) });
      t.say(`  ${n} voted to execute; could not vote: ${refused.join(', ') || 'nobody'}`);
      await t.nap(600);
      await t.stClick('Close the vote', { within: 'What to do now', timeout: 3000 });
      t.say('  host closed the vote');
      await t.nap(900);
      await t.shot(`n${night}-day-vote-closed`);
      continue;
    }

    // Has anybody got a live nomination control?
    let nominator = null;
    for (const n of t.names) {
      const live = await t.windows[n].evaluate(
        () => !!document.querySelector('[data-testid="nominate-select"]:not([disabled])')
      );
      if (live) {
        nominator = n;
        break;
      }
    }

    if (nominator) {
      // Nominate a LIVING player who is not the nominator AND has not already been
      // nominated today. The app enforces all three now — the dead are dropped from
      // the list, and a player may be nominated only once per day — so picking by
      // index alone aims at an illegal nomination and the refusal is the harness's
      // fault, not the app's.
      // `nominate` tries each candidate until the app accepts one, because the app now
      // refuses a player who has already been nominated today and a driver that always
      // picks the same name would keep aiming at a refusal.
      const who = await roster(t);
      const order = who.filter((r) => r.alive && r.name !== nominator).map((r) => r.name);
      if (order.length === 0) {
        t.say('  nobody else is alive to nominate');
        break;
      }
      const r = await t.nominate(nominator, order);
      nominated += 1;
      t.say(`  ${nominator} nominated ${r.target ?? order[0]} — ok=${r.ok}${r.why ? ` (${r.why})` : ''}`);
      if (!r.ok) {
        // This player has spent their nomination. Try the next one rather than
        // abandoning the day — one player's spent control is not a dead table.
        refusedNominators += 1;
        if (refusedNominators > 12) {
          t.problems.push(`day ${beat}: ${nominator} could not nominate anybody. ${r.why}`);
          break;
        }
        continue;
      }
      refusedNominators = 0;
      await t.nap(1000);
      await t.shot(`n${night}-day-nominated`);
      continue;
    }

    // Nobody can nominate. That is either the end of the day (everyone has spent
    // theirs, or the vote passed) or a real dead-end. Tell them apart.
    const moments = {};
    for (const n of t.names) {
      const m = await t.moment(n);
      moments[n] = m ? `${m.kind}/${m.action}` : '?';
    }
    const blocked = await t.windows[t.names[0]].evaluate(() => {
      const panel = [...document.querySelectorAll('.panel')].find((p) =>
        p.querySelector('h3')?.textContent?.includes('Nominate')
      );
      return (panel?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    });
    t.say(`  nobody can nominate. the nominate panel says: "${blocked}"`);
    t.say(`     every player's moment: ${JSON.stringify(moments)}`);
    results.push({ kind: 'nomination-blocked', night, blocked, moments, nominations: nominated });

    if (s.stage === 'day-voting' && s.canCloseVote) continue;
    if (beat > 5) {
      t.say('  the day has run out of things anybody can do');
      return s.stage;
    }
    await t.nap(700);
  }

  t.problems.push(`day after night ${night}: never settled (${beat} beats)`);
  return 'timeout';
}

// ---------------------------------------------------------------------------
// Deal, play, collect.
// ---------------------------------------------------------------------------

t.say('\n=== THE HOST DEALS THE ROLES ===');
const dealt = await t.stClick('Start Distribution', { timeout: 10000 });
t.say(`  clicked "Start Distribution": ${dealt}`);
await t.nap(1200);
await t.shot('n0-dealt');

const stState = await t.tableState();
t.say(`  flow stage after dealing: ${stState.stage} — "${stState.say}"`);
t.say(`  the host is told: "${(await t.script())?.buttons.map((b) => b.text).join(' | ')}"`);

const g = await t.grimoire();
t.say('  the Grimoire the host can see:');
for (const row of g ?? []) t.say(`      ${row}`);
results.push({ kind: 'grimoire', night: 1, rows: g ?? [] });

for (let night = 1; night <= NIGHTS; night += 1) {
  const stage = await playNight(night);
  if (stage === 'ended') break;
  const after = await t.tableState();
  if (after.stage === 'ended') {
    t.say('  the game has ended');
    break;
  }
  // Dawn: read the dead, then start the day.
  for (let i = 0; i < 20; i += 1) {
    const s = await t.tableState();
    if (s.stage === 'ended') break;
    if (s.canEndNight) {
      await t.stClick('Move to the day', { within: 'What to do now' });
      continue;
    }
    if (s.canStartDay) {
      await t.stClick('read the dead', { within: 'What to do now' });
      await t.nap(700);
      continue;
    }
    break;
  }
  await t.shot(`n${night}-dawn`);
  const dayStage = await playDay(night);
  if (dayStage === 'ended') break;

  if (night < NIGHTS) {
    const switched = await t.stMoreClick('Switch to Night');
    t.say(`  host switched the phase to night: ${switched}`);
    await t.nap(1400);
  }
}

// ---------------------------------------------------------------------------
// The write-up.
// ---------------------------------------------------------------------------

t.say('\n=== EVERY LINE THE TABLE WAS TOLD, IN ORDER ===');
for (const a of announcements) t.say(`  n${a.night} b${a.beat}: ${a.say}`);

t.say('\n=== SKIPPED WAKE-UPS ===');
let skipped = 0;
for (let i = 1; i < announcements.length; i += 1) {
  const prev = announcements[i - 1].say;
  const cur = announcements[i].say;
  if (!/, close your eyes\.$/.test(prev)) continue;
  if (/Everyone, (close|open) your eyes/.test(cur)) continue;
  if (/, wake up\.$/.test(cur)) continue;
  skipped += 1;
  t.problems.push(`"${prev}" then "${cur}" — somebody was skipped in the walk`);
}
t.say(`  ${skipped}`);

t.say('\n=== PROBLEMS ===');
if (t.problems.length === 0) t.say('  none');
for (const p of t.problems) t.say('  !! ' + p);

t.say('\n=== OBSERVATIONS ===');
if (t.observations.length === 0) t.say('  none');
for (const o of t.observations) t.say('  · ' + o);

t.save();
t.writeResults = true;
const { writeFileSync } = await import('node:fs');
const { join: pathJoin } = await import('node:path');
const { SHOTS } = await import('./table.mjs');
writeFileSync(pathJoin(SHOTS, `${tag}-results.json`), JSON.stringify(results, null, 2));
t.say(`\n  raw results -> tools/playtest/shots/${tag}-results.json`);

await t.close();
process.exit(0);
