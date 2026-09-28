/**
 * Smoke test for the harness itself: can it build a table through the UI at all?
 * Run this first — if it fails, nothing downstream is trustworthy.
 */
import { openTable } from './table.mjs';

const t = await openTable({ count: 5, tag: 'smoke' });

t.say('\n--- what the host sees in the lobby ---');
const lobby = await t.st.evaluate(() => ({
  panels: [...document.querySelectorAll('.panel')].map((p) => ({
    heading: p.querySelector('h1, h2')?.textContent?.trim() ?? '',
    text: (p.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
  })),
}));
for (const p of lobby.panels) t.say(`  [${p.heading}] ${p.text}`);

t.say('\n--- what a player sees in the lobby ---');
const pl = await t.windows.Ada.evaluate(() => ({
  panels: [...document.querySelectorAll('.panel')].map((p) => ({
    heading: p.querySelector('h1, h2')?.textContent?.trim() ?? '',
    text: (p.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
  })),
}));
for (const p of pl.panels) t.say(`  [${p.heading}] ${p.text}`);

t.say('\n--- can the host start? ---');
const startBtn = await t.st.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Start Distribution'));
  return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
});
t.say(`  ${JSON.stringify(startBtn)}`);
/*
 * The real invariant, checked against the actual player count.
 *
 * This used to assert "below 5 players the button should be disabled" while running at
 * exactly 5 — where the button is correctly ENABLED — so the harness's own self-test
 * printed WRONG on a healthy app. A check whose label does not describe the state it runs in
 * is worse than no check: it trains you to ignore it.
 */
const count = t.names.length;
const shouldBeEnabled = count >= 5;
const isEnabled = startBtn?.disabled === false;
t.say(
  `  at ${count} players the button should be ${shouldBeEnabled ? 'enabled' : 'disabled'}: ${
    isEnabled === shouldBeEnabled ? 'correct' : 'WRONG'
  }`
);
if (isEnabled !== shouldBeEnabled) {
  t.problems.push(
    `at ${count} players "Start Distribution" was ${isEnabled ? 'enabled' : 'disabled'}, expected the opposite`
  );
}

await t.shot('05-lobby-all');

t.say('\n=== problems ===');
if (t.problems.length === 0) t.say('  none');
for (const p of t.problems) t.say('  !! ' + p);

t.save();
await t.close();
process.exit(0);
