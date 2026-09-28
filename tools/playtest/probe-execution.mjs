/**
 * The test this whole repository has been failing: can a nomination actually be
 * executed, through the real UI, and does everybody find out?
 *
 * Plays to a qualifying vote, screenshots the Storyteller's screen at the exact moment
 * the button should exist, clicks it, and then checks what each player is told.
 */
import { dealtTable, roster, living, playNight, startDay, runNomination, outcome } from './lib.mjs';

const say = (s) => console.log(s);
const t = await dealtTable({ count: 6, tag: 'exec' });
const r = await roster(t);
say(`roster: ${r.map((p) => `${p.name}=${p.character}${p.alive ? '' : '(dead)'}`).join(', ')}`);

await playNight(t);
await startDay(t);
const alive = await living(t);
say(`alive: ${alive.length} — ${alive.map((p) => `${p.name}=${p.character}`).join(', ')}`);

const need = Math.ceil(alive.length / 2);
say(`\nnomination with ${need} of ${alive.length} hands up (the threshold)...`);
// execute: false — the point of this probe is to see the button BEFORE it is pressed.
const res = await runNomination(t, {
  nominator: alive[0].name,
  target: alive[1].name,
  yesNames: alive.slice(0, need).map((p) => p.name),
  execute: false,
});
say(`  vote closed. the host was told: "${res.onTheBlock}"`);
await t.nap(800);

// Is the Execute button actually on the screen now?
const stScreen = await t.st.evaluate(() => {
  const script = document.querySelector('[data-testid="storyteller-script"]');
  return {
    stage: script?.getAttribute('data-stage') ?? null,
    say: [...(script?.querySelectorAll('p') ?? [])]
      .map((p) => (p.textContent ?? '').replace(/\s+/g, ' ').trim())
      .find((p) => p !== 'Say') ?? '',
    buttons: [...(script?.querySelectorAll('button') ?? [])].map((b) => ({
      text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
      disabled: b.disabled,
    })),
  };
});
say(`  the host's screen: stage=${stScreen.stage}`);
say(`  the host is told to SAY: "${stScreen.say}"`);
say(`  the host's controls: ${JSON.stringify(stScreen.buttons)}`);

const hasExecute = stScreen.buttons.some((b) => /^Execute/.test(b.text) && !b.disabled);
say(`\n>>> EXECUTE BUTTON PRESENT: ${hasExecute ? 'YES' : 'NO'}`);

// What is every player told right now?
say('\nwhat each player is shown while the vote is waiting to be carried out:');
for (const p of t.names) {
  const m = await t.moment(p);
  const nom = await t.windows[p]
    .evaluate(() => {
      const panel = [...document.querySelectorAll('.panel')].find((x) =>
        x.querySelector('h3')?.textContent?.includes('Nomination:')
      );
      const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Vote to Execute'));
      return panel ? { hasTally: true, canVote: btn ? !btn.disabled : false } : { hasTally: false };
    })
    .catch(() => ({}));
  say(`  ${p}: ${m?.kind} | "${m?.title}" | "${m?.detail}" | tally:${JSON.stringify(nom)}`);
}
await t.shot('vote-passed');

// Carry it out.
if (hasExecute) {
  say('\nclicking Execute...');
  const clicked = await t.st.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^Execute /.test(b.textContent?.trim() ?? '') && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  });
  say(`  clicked: ${clicked}`);
  await t.nap(1500);
}

const after = await roster(t);
say(`\nroster after: ${after.map((p) => `${p.name}=${p.character}${p.alive ? '' : '(dead)'}`).join(', ')}`);
say(`\nwhat each player is shown after the execution:`);
for (const p of t.names) {
  const m = await t.moment(p);
  const banner = await t.windows[p]
    .evaluate(() => {
      const el = [...document.querySelectorAll('[role="alert"]')].find((x) => /executed/i.test(x.textContent ?? ''));
      return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
    })
    .catch(() => null);
  say(`  ${p}: ${m?.kind} | "${m?.title}"${banner ? ` | banner: "${banner}"` : ' | (no banner)'}`);
}
const o = await outcome(t);
say(`\noutcome: stage=${o.stage} ${o.playerBanner ?? '(no win yet)'}`);
say(`session.executionHappenedToday is server-side; ${after.filter((x) => !x.alive).length} player(s) dead by execution`);
await t.shot('after-execution');

say('\n>>> VERDICT');
const died = after.filter((x) => !x.alive);
say(`  the execution happened: ${died.length >= 1 ? 'YES' : 'NO'}`);
say(`  the host's Grimoire updated: ${/dead/i.test(JSON.stringify(after)) ? 'YES' : 'NO'}`);
say('  official: a nomination that reaches half or more of the living players is executed, once.');

t.save();
await t.close();
process.exit(0);
