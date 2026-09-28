/**
 * Verification probe for the claims that matter most and are still in dispute.
 *
 * Every one of these is reachable through the real UI, which matters because the
 * vote path is dead in this build: the Storyteller's own "Mark Dead" button on the
 * Grimoire is the only way a player can currently die during the day, so it is the
 * lever these tests pull.
 *
 *   node tools/playtest/verify.mjs
 */
import { dealtTable, roster, living, markDead, outcome, runNomination, playNight, startDay } from './lib.mjs';

const say = (s) => console.log(s);
const find = async (tag, character, count) => {
  for (let i = 1; i <= 12; i += 1) {
    const t = await dealtTable({ count, tag: `${tag}-try${i}` });
    const r = await roster(t);
    const who = r.find((p) => p.character === character);
    say(`  deal ${i}: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
    if (who) return { t, who, roster: r };
    await t.close();
  }
  throw new Error(`no ${character} dealt`);
};

// ---------------------------------------------------------------------------
// 1. THE SCARLET WOMAN BOUNDARY. This is the disputed one.
// ---------------------------------------------------------------------------
// Official: "If there are five or more players alive & the Demon dies, you become
// the Demon" — counted JUST BEFORE the Demon dies, i.e. four or more still alive
// AFTER. Five alive is the boundary and MUST trigger.
// The code reads `if (livingPlayerCount(session) < 5) return null`, and that count
// is taken AFTER the death, so it demands five survivors — one more than the rules.
say('\n############ 1. SCARLET WOMAN at the 5-alive boundary ############');
{
  // Exactly 5 players. Marking the Imp dead leaves 4 — the boundary case.
  const { t, who: sw, roster: r } = await find('v-sw5', 'Scarlet Woman', 5);
  const imp = r.find((p) => p.character === 'Imp');
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  say(`  ${r.length} players are alive, the Imp is ${imp?.name}, the Scarlet Woman is ${sw.name}`);
  say(`  the host marks ${imp?.name} dead -> ${r.length - 1} alive afterwards`);
  await markDead(t, imp.name);
  const after = await roster(t);
  say(`  grimoire afterwards: ${after.map((p) => `${p.name}=${p.character}${p.alive ? '' : '(dead)'}`).join(', ')}`);
  const res = await outcome(t);
  const swNow = after.find((p) => p.name === sw.name);
  const tookOver = swNow?.character === 'Imp';
  say(`  ${sw.name} is now: ${swNow?.character} (${swNow?.alive ? 'alive' : 'dead'})`);
  say(`  game stage: ${res.stage}; banner: ${res.playerBanner ?? '(none)'}`);
  say(`\n  >>> VERDICT: ${
    tookOver
      ? 'CORRECT — with 5 alive before the Demon died, the Scarlet Woman became the Demon'
      : /wins/i.test(res.playerBanner ?? '')
        ? 'WRONG — the game ended. With 5 alive before the Demon died, the Scarlet Woman must become the Demon, so the game must NOT end. Good has been handed a win the rules say Evil did not earn.'
        : 'INCONCLUSIVE — no takeover and no ending'
  }`);
  say('  official: "five or more players alive just before the Demon dies" = 4 or more after the death');
  await t.shot('sw-5-alive');
  t.save();
  await t.close();
}

say('\n############ 1b. CONTROL: 6 alive before the Demon dies ############');
{
  // Same test one player higher. 6 alive -> 5 after, which is above the boundary
  // either way, so this MUST trigger. If it does not, the whole claim is wrong.
  const { t, who: sw, roster: r } = await find('v-sw6', 'Scarlet Woman', 6);
  const imp = r.find((p) => p.character === 'Imp');
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  say(`  ${r.length} alive; marking ${imp?.name} dead leaves ${r.length - 1}`);
  await markDead(t, imp.name);
  const after = await roster(t);
  const swNow = after.find((p) => p.name === sw.name);
  const res = await outcome(t);
  say(`  ${sw.name} is now: ${swNow?.character}; banner: ${res.playerBanner ?? '(none)'}`);
  say(`\n  >>> VERDICT: ${
    swNow?.character === 'Imp'
      ? 'CORRECT — the takeover fired above the boundary, as it must'
      : 'WRONG — 6 alive should unambiguously trigger the takeover'
  }`);
  t.save();
  await t.close();
}

// ---------------------------------------------------------------------------
// 2. THE TIEBREAK. "If both teams would win at the same time, good wins."
// ---------------------------------------------------------------------------
say('\n############ 2. TIEBREAK: the Demon dies, leaving exactly 2 alive ############');
{
  const t = await dealtTable({ count: 6, tag: 'v-tie' });
  const r = await roster(t);
  const imp = r.find((p) => p.character === 'Imp');
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  say(`  the Imp is ${imp?.name}`);
  // Thin the table to 3 alive, then kill the Imp: 2 remain.
  let alive = await living(t);
  while (alive.length > 3) {
    const victim = alive.find((p) => p.name !== imp.name);
    if (!victim) break;
    await markDead(t, victim.name);
    alive = await living(t);
  }
  say(`  alive: ${alive.length} (${alive.map((p) => p.name).join(', ')})`);
  say(`  now marking the Imp dead -> ${alive.length - 1} alive, both win conditions true at once`);
  await markDead(t, imp.name);
  const res = await outcome(t);
  say(`  banner: ${res.playerBanner ?? '(none)'} / ${res.storytellerBanner ?? '(none)'}`);
  const good = /Good wins/i.test(res.playerBanner ?? '');
  const evil = /Evil wins/i.test(res.playerBanner ?? '');
  say(`\n  >>> VERDICT: ${
    good
      ? 'CORRECT — good wins the tie, per the rulebook'
      : evil
        ? 'WRONG — evil won. The rulebook: "If both teams would win at the same time, good wins."'
        : 'INCONCLUSIVE — the game did not end'
  }`);
  await t.shot('tiebreak');
  t.save();
  await t.close();
}

// ---------------------------------------------------------------------------
// 3. THE DEAD PLAYER'S ONE VOTE, observed with a nomination actually open.
// ---------------------------------------------------------------------------
say('\n############ 3. A dead player\'s single vote, with a vote actually open ############');
{
  const t = await dealtTable({ count: 6, tag: 'v-ghost' });
  const r = await roster(t);
  say(`  roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  await playNight(t);
  await startDay(t);
  let alive = await living(t);
  say(`  alive after night 1: ${alive.map((p) => p.name).join(', ')}`);

  const victim = alive[alive.length - 1];
  await markDead(t, victim.name);
  alive = await living(t);
  const ghost = victim.name;
  say(`  ${ghost} is dead. The moment they are shown: ${JSON.stringify(await t.moment(ghost))}`);

  // First nomination, and the ghost votes.
  const first = await runNomination(t, {
    nominator: alive[0].name,
    target: alive[1].name,
    yesNames: [ghost],
    execute: false,
  });
  const ghostAfter1 = await t.windows[ghost].evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h3')?.textContent?.includes('Nomination:')
    );
    if (!panel) return 'no tally panel';
    const btn = [...panel.querySelectorAll('button')].find((b) => b.textContent?.includes('Vote to Execute'));
    return !btn ? 'no vote button' : btn.disabled ? 'DISABLED' : 'STILL LIVE';
  });
  say(`  ${ghost} voted on the first nomination. Their control afterwards: ${ghostAfter1}`);

  // Second nomination, on the same day.
  const second = alive[2];
  const res2 = await runNomination(t, {
    nominator: second.name,
    target: alive[1].name,
    yesNames: [ghost],
    execute: false,
  });
  const ghostVote2 = res2.steps.filter((s) => s.includes('vote:')).join(' / ');
  say(`  ${ghost} votes again on a second nomination: ${ghostVote2}`);
  const ghostAfter2 = await t.windows[ghost].evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h3')?.textContent?.includes('Nomination:')
    );
    if (!panel) return 'no tally panel';
    const btn = [...panel.querySelectorAll('button')].find((b) => b.textContent?.includes('Vote to Execute'));
    return !btn ? 'no vote button' : btn.disabled ? 'DISABLED' : 'STILL LIVE';
  });
  const toldOn2 = await t.moment(ghost);
  say(`  ${ghost} is told: "${toldOn2?.title}"`);
  say(`  ${ghost}'s control on the second nomination: ${ghostAfter2}`);
  await t.shot('ghost-second-vote');

  say(`\n  >>> VERDICT: ${
    ghostAfter2 === 'STILL LIVE' || /still live/i.test(ghostVote2)
      ? 'WRONG — a dead player gets ONE vote for the whole game, and the app offers a live button afterwards'
      : 'CORRECT — the second dead vote is refused'
  }`);
  say('  official: "Each dead player may vote for only one player throughout the rest of the game."');
  if (/vote left/i.test(toldOn2?.title ?? '')) {
    say(`  AND the copy "${toldOn2.title}" is being shown to a player who has already spent their vote.`);
  } else {
    say(`  NOTE: the ghost was told "${toldOn2?.title}" — the "one vote left" copy did not appear.`);
  }
  t.save();
  await t.close();
}

say('\n############ done ############');
process.exit(0);
