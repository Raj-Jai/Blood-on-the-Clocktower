/**
 * Probe: after one player has been nominated, can the table nominate them again?
 *
 * Reads the actual DOM and the actual lobby payload, because the scenario driver
 * reported success and it may be the driver or the app.
 */
import { dealtTable, roster, living, playNight, startDay, runNomination } from './lib.mjs';

const say = (s) => console.log(s);
const t = await dealtTable({ count: 6, tag: 'p2x' });
const r = await roster(t);
say(`roster: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);

await playNight(t);
await startDay(t);
const alive = await living(t);
say(`alive: ${alive.map((p) => p.name).join(', ')}`);

// What does the client's lobby data actually contain?
const lobbyShape = await t.windows[t.names[0]].evaluate(() => {
  const el = document.querySelector('[data-testid="player-moment"]');
  return { momentPresent: !!el };
});
say(`probe: ${JSON.stringify(lobbyShape)}`);

const first = alive[0].name;
const target = alive[1].name;
say(`\n${first} nominates ${target}...`);
// Deliberately no votes, so the nomination FAILS and the day carries on. A vote that
// carried would end the day, since an execution ends the day.
const firstRun = await runNomination(t, {
  nominator: first,
  target,
  yesNames: [],
  execute: false,
});
say(`  opened: ${firstRun.nominated.ok}, closed without passing: ${/did not pass/i.test(firstRun.onTheBlock ?? '')}`);

const dump = async (label) => {
  const info = await t.windows[second].evaluate((name) => {
    const panel = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h3')?.textContent?.includes('Nominate')
    );
    const sel = document.querySelector('[data-testid="nominate-select"]');
    const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Nominate');
    return {
      text: (panel?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      selectDisabled: sel ? sel.disabled : 'no select',
      nominateButtonDisabled: btn ? btn.disabled : 'no button',
      options: sel ? [...sel.options].map((o) => o.textContent?.trim()) : [],
    };
  }, target);
  say(`  [${label}] ${JSON.stringify(info)}`);
  return info;
};

const second = alive[2].name;
await dump(`${second} before choosing`);
const sel = await t.windows[second].$('[data-testid="nominate-select"]');
if (sel) {
  const value = await sel.evaluate((s, want) => [...s.options].find((o) => o.textContent?.trim() === want)?.value ?? null, target);
  if (value) {
    await sel.selectOption(value);
    await t.nap(500);
    const after = await dump(`${second} after choosing ${target}`);
    const n2 = await t.nominate(second, target);
    say(`  second nomination of the same player: ok=${n2.ok}${n2.why ? ` (${n2.why})` : ''}`);
  }
}

say('\n>>> VERDICT: re-nominating the same player on the same day');
const finalInfo = await t.windows[second].evaluate(() => {
  const panel = [...document.querySelectorAll('.panel')].find((p) =>
    p.querySelector('h3')?.textContent?.includes('Nominate')
  );
  return (panel?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
});
say(`  the nominate panel now says: "${finalInfo}"`);
say('  official: "each player may be nominated only once per day"');

t.save();
await t.close();
process.exit(0);
