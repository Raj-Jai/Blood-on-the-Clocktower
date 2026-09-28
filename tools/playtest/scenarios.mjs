/**
 * One rules question per table, answered by playing rather than by reading.
 *
 *   SCENARIO=vote      node tools/playtest/scenarios.mjs
 *   SCENARIO=half      node tools/playtest/scenarios.mjs
 *   SCENARIO=tiebreak  node tools/playtest/scenarios.mjs
 *   SCENARIO=scarlet   node tools/playtest/scenarios.mjs
 *   SCENARIO=saint     node tools/playtest/scenarios.mjs
 *   SCENARIO=mayor     node tools/playtest/scenarios.mjs
 *   SCENARIO=twice     node tools/playtest/scenarios.mjs
 *   SCENARIO=deadvote  node tools/playtest/scenarios.mjs
 *
 * Every expectation below is from the official rules, not from the code:
 *   execution   "the number of votes equals or exceeds half the number of alive
 *                players" (rulebook, The Day)
 *   tiebreak    "If both teams would win at the same time, good wins."
 *   scarlet     "If there are five or more players alive & the Demon dies, you
 *                become the Demon." (character text)
 *   saint       "If you die by execution, your team loses."
 *   mayor       "If only 3 players live & no execution occurs, your team wins."
 *   dead vote   "Each dead player may vote for only one player throughout the
 *                rest of the game."
 *   re-nominate "Each player may nominate only once per day, and each player may
 *                be nominated only once per day."
 */
import {
  dealtTable, roster, living, withCharacter, markDead, outcome, runNomination,
  playNight, startDay, ALL_NAMES,
} from './lib.mjs';

const WHICH = process.env.SCENARIO ?? 'vote';
const say = (s) => console.log(s);

/** Deals repeatedly until the roster contains `character`, so a scenario can be set up. */
async function tableWith(character, { count, tag, tries = 10 }) {
  for (let i = 1; i <= tries; i += 1) {
    const t = await dealtTable({ count, tag: `${tag}-try${i}` });
    const r = await roster(t);
    const who = r.find((p) => p.character === character);
    say(`  try ${i}: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
    if (who) return { t, who, roster: r };
    await t.close();
  }
  throw new Error(`never dealt a ${character} in ${tries} tries`);
}

const report = (title, verdict, detail) => {
  say(`\n>>> ${title}`);
  say(`    VERDICT: ${verdict}`);
  for (const line of detail) say(`      ${line}`);
};

// ===========================================================================

if (WHICH === 'vote') {
  say('\n=== SCENARIO vote: can a nomination ever be executed at all? ===');
  const t = await dealtTable({ count: 5, tag: 'sc-vote' });
  const r = await roster(t);
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  await playNight(t);
  await startDay(t);

  const alive = await living(t);
  say(`  alive going into the day: ${alive.map((p) => p.name).join(', ')}`);
  const yes = alive.map((p) => p.name);
  const res = await runNomination(t, {
    nominator: alive[0].name,
    target: alive[1].name,
    yesNames: yes,
  });
  report(
    'a nomination with EVERY living player voting yes',
    res.executed ? 'EXECUTION HAPPENED — the vote path works' : 'NO EXECUTION — the vote never reached the threshold',
    res.steps
  );
  await t.shot('after-vote');
  t.save();
  await t.close();
}

if (WHICH === 'half') {
  say('\n=== SCENARIO half: exactly how many votes carry an execution? ===');
  say('    official: "the number of votes equals or exceeds half the number of alive players"');
  say('    An execution cannot be confirmed at all (see SCENARIO vote), so the threshold is');
  say('    measured from what the host is told: "met the threshold" vs "did not pass".');
  const COUNT = Number(process.env.COUNT ?? 6);
  const t = await dealtTable({ count: COUNT, tag: 'sc-half' });
  const r = await roster(t);
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  await playNight(t);
  await startDay(t);
  const alive = await living(t);
  const n = alive.length;
  const official = Math.ceil(n / 2);
  say(`  alive: ${n}. official threshold = ceil(${n}/2) = ${official}`);
  say('  sweeping the number of hands raised, one nomination per count:');
  const found = [];
  for (let k = 1; k <= n; k += 1) {
    // Every player gets one nomination a day, so each sweep step needs a different
    // nominator. The target is held constant so only the vote count varies.
    const nominator = alive[(k - 1) % n];
    const target = alive.find((p) => p.name !== nominator.name);
    const res = await runNomination(t, {
      nominator: nominator.name,
      target: target.name,
      yesNames: alive.slice(0, k).map((p) => p.name),
      execute: false,
    });
    const met = /met the threshold/i.test(res.onTheBlock ?? '');
    found.push({ votes: k, met, nominator: nominator.name, target: target.name });
    say(`    ${k} vote(s) (by ${nominator.name} -> ${target.name}) -> ${met ? 'MET the threshold' : 'did not pass'}`);
    await t.nap(700);
  }
  const lowest = found.find((f) => f.met)?.votes ?? null;
  report(
    `lowest number of votes that carries an execution, out of ${n} alive`,
    lowest === official
      ? `CORRECT — ${lowest} carries it, which is ceil(${n}/2)`
      : `WRONG — ${lowest} carries it, the rules say ${official}`,
    [
      `measured: ${found.map((f) => `${f.votes}${f.met ? '*' : ''}`).join(' ')}  (* = carried)`,
      'official: "the number of votes equals or exceeds half the number of alive players"',
    ]
  );
  t.save();
  await t.close();
}



if (WHICH === 'tiebreak') {
  say('\n=== SCENARIO tiebreak: the Demon dies, leaving exactly 2 alive ===');
  say('    official: "If both teams would win at the same time, good wins."');
  const t = await dealtTable({ count: 6, tag: 'sc-tie' });
  const r = await roster(t);
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  const demon = r.find((p) => p.alignment === 'evil' && p.character === 'Imp') ?? r.find((p) => p.name && p.alignment === 'evil');
  const imp = withCharacter ? r.find((p) => p.character === 'Imp') : null;
  const target = imp ?? r[r.length - 1];
  say(`  the Demon is ${imp ? `${imp.name} (Imp)` : `NOT an Imp — the only evil is ${demon?.character}`}`);

  await playNight(t);
  await startDay(t);
  let alive = await living(t);
  say(`  alive at the start of the day: ${alive.length}`);

  // Thin the table with the Storyteller's own Mark Dead button until executing the
  // Demon would leave exactly 2 alive.
  while (alive.length > 3) {
    const victim = alive.find((p) => p.name !== (imp?.name ?? target.name));
    if (!victim) break;
    const ok = await markDead(t, victim.name);
    say(`  host marked ${victim.name} dead: ${ok}`);
    if (!ok) break;
    alive = await living(t);
  }
  say(`  alive now: ${alive.length} (${alive.map((p) => p.name).join(', ')})`);
  say(`  executing ${imp?.name ?? '?'} would leave ${alive.length - 1} alive`);

  const res = await runNomination(t, {
    nominator: alive.find((p) => p.name !== (imp?.name ?? target.name))?.name ?? alive[0].name,
    target: imp?.name ?? target.name,
    yesNames: alive.map((p) => p.name),
  });
  const good = /Good wins/i.test(res.outcome?.playerBanner ?? '');
  const evil = /Evil wins/i.test(res.outcome?.playerBanner ?? '');
  report(
    'the Demon is executed with 2 players left alive',
    good
      ? 'CORRECT — good wins the tie'
      : evil
        ? 'WRONG — evil won. The official tiebreak is "if both teams would win at the same time, good wins".'
        : 'INCONCLUSIVE — nobody won; see the steps',
    res.steps
  );
  t.save();
  await t.close();
}

if (WHICH === 'scarlet') {
  say('\n=== SCENARIO scarlet: the Demon dies with exactly 5 players alive ===');
  say('    official: "If there are five or more players alive & the Demon dies,');
  say('    you become the Demon." Five alive is the boundary and MUST trigger.');
  const { t, who: sw, roster: r } = await tableWith('Scarlet Woman', { count: 5, tag: 'sc-sw' });
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  const imp = r.find((p) => p.character === 'Imp');
  say(`  Scarlet Woman: ${sw.name}. Imp: ${imp?.name ?? 'none'}`);

  // Get to exactly 5 alive with both still in play, WITHOUT a night kill landing
  // on the Imp: deal, then immediately thin the table is wrong, so instead start the
  // game and let night one happen, then check who is alive.
  await playNight(t);
  await startDay(t);
  let alive = await living(t);
  say(`  alive after night 1: ${alive.length} (${alive.map((p) => `${p.name}=${p.character}`).join(', ')})`);

  // Put the table back to exactly 5 alive if night one thinned it.
  while (alive.length < 5) {
    say(`  only ${alive.length} alive — this scenario needs exactly 5, skipping`);
    await t.close();
    process.exit(0);
  }
  while (alive.length > 5) {
    const victim = alive.find((p) => p.name !== sw.name && p.name !== imp?.name);
    if (!victim) break;
    await markDead(t, victim.name);
    alive = await living(t);
  }
  say(`  alive now: ${alive.length} (${alive.map((p) => p.name).join(', ')})`);

  const nominator = alive.find((p) => p.name !== imp?.name)?.name;
  const res = await runNomination(t, {
    nominator,
    target: imp?.name,
    yesNames: alive.map((p) => p.name),
  });
  const after = await roster(t);
  const newDemon = after.find((p) => p.name === sw.name);
  const tookOver = newDemon?.character === 'Imp';
  const ended = /wins/i.test(res.outcome?.playerBanner ?? '');
  report(
    'the Imp is executed with exactly 5 players alive',
    tookOver
      ? 'CORRECT — the Scarlet Woman became the Demon'
      : ended
        ? 'WRONG — the game ended. With 5 alive the Scarlet Woman must become the Demon, so Good must NOT win yet.'
        : 'WRONG — the game did not end and the Scarlet Woman did not become the Demon',
    [
      ...res.steps,
      `the Grimoire afterwards: ${after.map((p) => `${p.name}=${p.character}${p.alive ? '' : ' (dead)'}`).join(', ')}`,
    ]
  );
  t.save();
  await t.close();
}

if (WHICH === 'saint') {
  say('\n=== SCENARIO saint: the Saint is executed ===');
  say('    official: "If you die by execution, your team loses."');
  const { t, who: saint, roster: r } = await tableWith('Saint', { count: 6, tag: 'sc-saint' });
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  await playNight(t);
  await startDay(t);
  const alive = await living(t);
  const res = await runNomination(t, {
    nominator: alive.find((p) => p.name !== saint.name)?.name,
    target: saint.name,
    yesNames: alive.map((p) => p.name),
  });
  const evil = /Evil wins/i.test(res.outcome?.playerBanner ?? '');
  report(
    'the Saint is executed',
    evil
      ? 'CORRECT — evil wins immediately'
      : 'WRONG — the game did not end in an evil win',
    [...res.steps, `outcome banner: ${res.outcome?.playerBanner}`]
  );
  t.save();
  await t.close();
}

if (WHICH === 'mayor') {
  say('\n=== SCENARIO mayor: 3 players alive, nobody executed ===');
  say('    official: "If only 3 players live & no execution occurs, your team wins."');
  const { t, who: mayor, roster: r } = await tableWith('Mayor', { count: 6, tag: 'sc-mayor' });
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  await playNight(t);
  await startDay(t);
  let alive = await living(t);
  while (alive.length > 3) {
    const victim = alive.find((p) => p.name !== mayor.name);
    if (!victim) break;
    await markDead(t, victim.name);
    alive = await living(t);
  }
  say(`  alive: ${alive.length} (${alive.map((p) => p.name).join(', ')})`);
  say(`  the Mayor is ${alive.some((p) => p.name === mayor.name) ? 'alive' : 'NOT alive — skipping'}`);
  if (!alive.some((p) => p.name === mayor.name)) {
    await t.close();
    process.exit(0);
  }
  say('  now advancing to dusk, with no execution having happened...');
  const switched = await t.stMoreClick('Switch to Night');
  say(`  host switched to night: ${switched}`);
  await t.nap(1500);
  const res = await outcome(t);
  const good = /Good wins/i.test(res.playerBanner ?? '');
  report(
    '3 players alive, no execution, the table goes to dusk',
    good
      ? 'CORRECT — the Mayor wins it for good'
      : 'WRONG — good did not win, or the game did not end',
    [`outcome banner: ${res.playerBanner ?? '(none)'}`, `stage: ${res.stage}`]
  );
  t.save();
  await t.close();
}

if (WHICH === 'twice') {
  say('\n=== SCENARIO twice: can the same player be nominated twice in one day? ===');
  say('    official: "each player may be nominated only once per day"');
  const t = await dealtTable({ count: 6, tag: 'sc-twice' });
  const r = await roster(t);
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  await playNight(t);
  await startDay(t);
  const alive = await living(t);

  // First nomination: let it FAIL by having nobody vote.
  const a1 = await runNomination(t, {
    nominator: alive[0].name,
    target: alive[1].name,
    yesNames: [],
    execute: false,
  });
  say(`  first nomination of ${alive[1].name}: ${a1.steps.join(' / ')}`);

  // Second nomination, same target, from a different player.
  const second = alive[2].name;
  const a2 = await t.nominate(second, alive[1].name);
  say(`  ${second} then nominated ${alive[1].name} again: ok=${a2.ok}${a2.why ? ` (${a2.why})` : ''}`);
  if (a2.ok) {
    await t.nap(900);
    const panel = await t.st
      .evaluate(() => {
        const p = document.querySelector('[data-testid="active-nomination"]');
        return p ? (p.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
      })
      .catch(() => null);
    say(`  the host's panel: ${panel}`);
  }
  report(
    'the same player is nominated a second time in one day',
    a2.ok
      ? 'WRONG — the rules say a player may be nominated only once per day'
      : 'CORRECT — the app refuses it',
    [`first vote: ${a1.onTheBlock}`, `second attempt: ok=${a2.ok} ${a2.why ?? ''}`]
  );
  t.save();
  await t.close();
}

if (WHICH === 'deadvote') {
  say('\n=== SCENARIO deadvote: how many votes does a dead player get? ===');
  say('    official: "Each dead player may vote for only one player throughout');
  say('    the rest of the game." One vote for the whole game, not one per day.');
  const t = await dealtTable({ count: 6, tag: 'sc-deadvote' });
  const r = await roster(t);
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  await playNight(t);
  await startDay(t);
  let alive = await living(t);

  // A vote that carries. An execution cannot actually be confirmed in this build
  // (see SCENARIO vote), so the death is administered with the Storyteller's own
  // "Mark Dead" button — the point of this scenario is the DEAD PLAYER's vote, not
  // how they died.
  const carried = await runNomination(t, {
    nominator: alive[0].name,
    target: alive[1].name,
    yesNames: alive.map((p) => p.name),
  });
  say(`  vote carried: ${/met the threshold/i.test(carried.onTheBlock ?? '')}; executed: ${carried.executed}`);
  if (!carried.executed) {
    say(`  (execution is impossible in this build, so the host marks ${alive[1].name} dead instead)`);
    await markDead(t, alive[1].name);
  }
  const dead = (await roster(t)).find((p) => !p.alive);
  say(`  ${dead?.name} is now dead. What are they told?`);
  const m = await t.moment(dead.name);
  say(`    "${m?.title}" — "${m?.detail}"`);

  // The dead player spends their one vote on day 1.
  const day1 = alive.filter((p) => p.name !== dead.name);
  const v1 = await runNomination(t, {
    nominator: day1[0].name,
    target: day1[1].name,
    yesNames: [dead.name],
    execute: false,
  });
  say(`  ${dead.name} voted on day 1: ${v1.steps.filter((s) => s.includes('vote:')).join(' / ')}`);
  await t.nap(600);
  const afterDay1 = await t.windows[dead.name].evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h3')?.textContent?.includes('Nomination:')
    );
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Vote to Execute')
    );
    return btn ? (btn.disabled ? 'vote button now DISABLED' : 'vote button still live') : 'no tally panel';
  });
  say(`  ${dead.name}'s own vote control after voting: ${afterDay1}`);

  // Next day, with the dead player still at the table.
  const switched = await t.stMoreClick('Switch to Night');
  say(`  host switched to night: ${switched}`);
  await t.nap(1200);
  await playNight(t);
  await startDay(t);
  const alive2 = await living(t);
  say(`  day 2. alive: ${alive2.map((p) => p.name).join(', ')}; ${dead.name} is dead`);

  const deadMoment = await t.moment(dead.name);
  say(`  ${dead.name} is told: "${deadMoment?.title}" — "${deadMoment?.detail}"`);
  const deadCanVote = await t.windows[dead.name].evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h3')?.textContent?.includes('Nomination:')
    );
    if (!panel) return 'no tally panel yet';
    const btn = [...panel.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Vote to Execute')
    );
    if (!btn) return 'no vote button';
    if (btn.disabled) return 'vote button DISABLED';
    btn.click();
    return 'voted again';
  });
  say(`  ${dead.name} voting on day 2: ${deadCanVote}`);
  report(
    'a dead player reaches the voting on a second day',
    /voted again/.test(deadCanVote)
      ? 'WRONG — the official rule is ONE vote for the rest of the game, and they already spent it on day 1'
      : 'CORRECT — the dead player has no vote left',
    [
      `day 1, told: "${m?.title}"`,
      `day 2, told: "${deadMoment?.title}" — "${deadMoment?.detail}"`,
      `day 2 vote control: ${deadCanVote}`,
      'official: "Each dead player may vote for only one player throughout the rest of the game."',
    ]
  );
  await t.shot('day2-dead-vote');
  t.save();
  await t.close();
}


process.exit(0);
