/**
 * The information leak, checked on the screen the Evil player actually looks at.
 *
 * `evilTeammatesOf` used to return every other Evil player's TRUE CHARACTER NAME, at every
 * player count. That is the whole script handed to a Minion in one payload, the moment the
 * game starts, before anyone has spoken.
 *
 * "You learn who the other Minions are" is a list of names, and only at 7 or more players.
 */
import { dealtTable, roster } from './lib.mjs';

const say = (s) => process.stdout.write(`${s}\n`);

/** The Evil player's own card on their own phone. */
const evilScreen = (t, name) =>
  t.windows[name]
    .evaluate(() => {
      const evil = [...document.querySelectorAll('.panel')].find((p) =>
        /Fellow Evil|Other Minions/i.test(p.querySelector('h3')?.textContent ?? '')
      );
      return {
        teammatesPanel: !!evil,
        text: evil ? (evil.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
        // The whole of this player's own private view, for a leak check.
        wholePage: (document.body.textContent ?? '').replace(/\s+/g, ' ').trim(),
      };
    })
    .catch(() => ({ teammatesPanel: false, text: null, wholePage: '' }));

const results = {};
let totalLeaks = 0;

for (const count of [6, 7]) {
  say(`\n=== ${count} PLAYERS ===`);
  const t = await dealtTable({ count, tag: `leak${count}` });
  const r = await roster(t);
  const evil = r.filter((p) => /evil/i.test(p.alignment ?? ''));
  say(`  evil seats: ${evil.map((p) => `${p.name}=${p.character}`).join(', ')}`);

  const leaks = [];
  for (const p of evil) {
    const view = await evilScreen(t, p.name);
    const others = evil.filter((e) => e.name !== p.name);
    // Does this player's OWN screen name any other Evil player's character? The whole page
    // is searched, not just the teammates panel, so a leak anywhere is caught.
    const named = others.filter((o) => view.wholePage.includes(o.character));
    say(
      `  ${p.name} (${p.character}): teammates panel = ${
        view.teammatesPanel ? `PRESENT — "${view.text}"` : 'absent'
      }`
    );
    if (named.length) {
      say(`    !! LEAK: their screen names ${named.map((o) => `${o.name}'s ${o.character}`).join(', ')}`);
      leaks.push({ viewer: p.name, named: named.map((o) => o.character) });
      totalLeaks += 1;
    } else {
      say(`    clean: no other evil player's character appears anywhere on their screen`);
    }
  }

  results[count] = { evilCount: evil.length, leaks };
  await t.close();
}

say('\n================ LEAK SUMMARY ================');
say(JSON.stringify(results, null, 2));
say(totalLeaks === 0 ? '\n>>> NO LEAK' : `\n>>> ${totalLeaks} LEAK(S) FOUND`);
