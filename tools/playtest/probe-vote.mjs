/**
 * Probe: why did no nomination ever result in an execution?
 *
 * Plays to a single nomination, then reads the state at every step: the player's
 * own tally, the Storyteller's "On the block" panel, and the controls the
 * Storyteller is offered. Everything is read off real screens.
 */
import { openTable, ALL_NAMES, PHONE } from './table.mjs';

const t = await openTable({ count: 5, tag: 'probe-vote', viewport: PHONE, names: ALL_NAMES.slice(0, 5) });

const say = t.say;

async function dealAndClearNight() {
  say('\n--- dealing ---');
  await t.stClick('Start Distribution', { timeout: 10000 });
  await t.nap(1200);
  const g = await t.grimoire();
  for (const row of g ?? []) say(`  ${row}`);

  say('\n--- night 1, walked through ---');
  await t.stClick('Eyes are closed', { within: 'What to do now', timeout: 8000 });
  for (let i = 0; i < 90; i += 1) {
    await t.nap(300);
    const s = await t.tableState();
    if (s.canEndNight) {
      await t.stClick('Move to the day', { within: 'What to do now' });
      break;
    }
    if (s.gateRunning) {
      await t.stClick('Skip the wait', { within: 'What to do now', timeout: 2000 });
      continue;
    }
    if (s.owesAChoice.length === 1) {
      const who = s.owesAChoice[0];
      const awake = (await t.awakePlayers()).find((a) => a.name === who);
      if (awake && !awake.submitted && awake.targets.length > 0) {
        await t.playerSubmit(who, awake.targets.slice(0, Math.max(1, awake.needed)));
        await t.nap(400);
        continue;
      }
    }
    if (s.canMoveOn) {
      await t.stClick('dealt with', { within: 'What to do now', timeout: 2000 });
      continue;
    }
    if (s.canResolve) {
      await t.stClick('Resolve the night', { within: 'What to do now' });
      await t.nap(900);
      continue;
    }
  }
  for (let i = 0; i < 20; i += 1) {
    const s = await t.tableState();
    if (s.canStartDay) {
      await t.stClick('read the dead', { within: 'What to do now' });
      await t.nap(800);
      break;
    }
    await t.nap(400);
  }
  const s = await t.tableState();
  say(`  flow is now at stage=${s.stage}`);
  return s;
}

const stPanel = () =>
  t.st
    .evaluate(() => {
      const p = document.querySelector('[data-testid="active-nomination"]');
      const script = document.querySelector('[data-testid="storyteller-script"]');
      return {
        onTheBlock: p ? (p.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
        scriptButtons: [...(script?.querySelectorAll('button') ?? [])].map((b) => ({
          text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
          disabled: b.disabled,
        })),
      };
    })
    .catch(() => ({}));

await dealAndClearNight();

// ---------------------------------------------------------------- the nomination
say('\n--- nominating ---');
const nominator = 'Ada';
const target = 'Bram';
const r = await t.nominate(nominator, target);
say(`  ${nominator} -> ${target}: ${JSON.stringify(r)}`);
await t.nap(1200);

say('\n--- state right after the nomination ---');
let st = await stPanel();
say(`  the Storyteller's "On the block" panel: ${JSON.stringify(st.onTheBlock)}`);
say(`  the Storyteller's controls: ${JSON.stringify(st.scriptButtons)}`);
for (const n of t.names) {
  const tally = await t.tallyOn(n);
  say(`  ${n}'s own tally panel: ${JSON.stringify(tally)}`);
}

// ---------------------------------------------------------------- voting, one at a time
say('\n--- voting, one player at a time, reading the count after each ---');
for (const voter of t.names) {
  const clicked = await t.windows[voter].evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h3')?.textContent?.includes('Nomination:')
    );
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.includes('Vote to Execute')
    );
    if (!btn) return { ok: false, why: 'no button' };
    if (btn.disabled) return { ok: false, why: 'button disabled' };
    btn.click();
    return { ok: true };
  });
  await t.nap(500);
  const mine = await t.tallyOn(voter);
  const host = await stPanel();
  say(`  ${voter} clicked=${JSON.stringify(clicked)}`);
  say(`      their own panel: ${JSON.stringify(mine?.text)}`);
  say(`      host sees:      ${host.onTheBlock}`);
}

// ---------------------------------------------------------------- closing
say('\n--- closing the vote ---');
await t.stClick('Close the vote', { within: 'What to do now', timeout: 4000 });
await t.nap(1200);
st = await stPanel();
say(`  the Storyteller's "On the block" panel: ${JSON.stringify(st.onTheBlock)}`);
say(`  the Storyteller's controls: ${JSON.stringify(st.scriptButtons)}`);
const s = await t.tableState();
say(`  flow stage: ${s.stage}, canExecute=${s.canExecute}, canCloseVote=${s.canCloseVote}`);
for (const n of t.names) {
  const tally = await t.tallyOn(n);
  say(`  ${n}'s tally after closing: ${JSON.stringify(tally?.text)}`);
}
await t.shot('after-close');

say('\n--- what every player is told right now ---');
for (const n of t.names) {
  const m = await t.moment(n);
  say(`  ${n}: ${m ? `${m.kind} | "${m.title}" | "${m.detail}"` : '?'}`);
}

say('\n=== problems ===');
for (const p of t.problems) say('  !! ' + p);
if (t.problems.length === 0) say('  none');

t.save();
await t.close();
process.exit(0);
