/**
 * Measures the Tier 1 UI fixes on a real phone-sized screen, in a real game, and
 * writes the numbers to a report. Run after the Tier 1 CSS/copy changes:
 *
 *   node tools/playtest/tier1.mjs
 */
import { writeFileSync } from 'node:fs';
import { dealtTable, playNight, startDay, runNomination } from './lib.mjs';
import { join } from 'node:path';
import { SHOTS } from './table.mjs';

const say = (s) => console.log(s);
const report = [];
const record = (s) => {
  say('  ' + s);
  report.push(s);
};

/** sRGB relative luminance, for real WCAG contrast numbers rather than guesses. */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Reads the computed colour of a class as the browser resolves it. */
const colorOf = (t, selector, prop = 'color') =>
  t.windows[t.names[0]]
    .evaluate(
      ({ s, p }) => {
        const el = document.querySelector(s);
        if (!el) return null;
        return getComputedStyle(el).getPropertyValue(p).trim();
      },
      { s: selector, p: prop }
    )
    .catch(() => null);

const t = await dealtTable({ count: 6, tag: 'tier1' });

say('\n=== 1. CONTRAST, measured in the browser ===');
{
  const panelBg = await colorOf(t, '.panel', 'backgroundColor');
  const root = await t.windows[t.names[0]].evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      faint: cs.getPropertyValue('--text-faint').trim(),
      good: cs.getPropertyValue('--good-blue').trim(),
      evil: cs.getPropertyValue('--evil-red').trim(),
      muted: cs.getPropertyValue('--text-muted').trim(),
    };
  });
  say(`  panel background resolves to: ${panelBg}`);
  for (const [name, value] of Object.entries(root)) {
    const ratio = contrast(value, '#16151f');
    if (ratio === null) continue;
    record(
      `--${name} ${value} on #16151f = ${ratio.toFixed(2)}:1 ${ratio >= 4.5 ? 'PASS (AA small text)' : 'FAIL'}`
    );
  }
}

say('\n=== 2. VIEWPORT / SAFE AREA ===');
{
  const meta = await t.windows[t.names[0]].evaluate(() =>
    document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '(none)'
  );
  record(`viewport meta: "${meta}" ${meta.includes('viewport-fit=cover') ? '-> safe-area insets can resolve' : '-> MISSING'}`);
}

say('\n=== 3. THE LOBBY, as a host sees it ===');
{
  // Re-open a lobby by reading what a fresh join form looks like is not possible now,
  // so assert the code is rendered large and the copy is honest.
  const t2 = await (await import('./table.mjs')).openTable({ count: 5, tag: 'tier1-lobby' });
  const lobby = await t2.st.evaluate(() => {
    const code = document.querySelector('.panel strong');
    const players = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h2')?.textContent?.includes('Players')
    );
    return {
      code: code?.textContent?.trim() ?? null,
      codeSize: code ? getComputedStyle(code).fontSize : null,
      codeSpacing: code ? getComputedStyle(code).letterSpacing : null,
      copy: (players?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      hasCopyButton: [...document.querySelectorAll('button')].some((b) =>
        /copy code/i.test(b.textContent ?? '')
      ),
    };
  });
  record(`join code renders at ${lobby.codeSize} with ${lobby.codeSpacing} spacing, copy button present: ${lobby.hasCopyButton}`);
  record(`lobby copy: "${lobby.copy}"`);
  await t2.close();
}

say('\n=== 4. DIALOGS: Escape and backdrop tap ===');
{
  const before = await t.windows[t.names[0]].evaluate(() => !!document.querySelector('[data-testid="more-sheet"]'));
  await t.windows[t.names[0]].click('[data-testid="more-button"]');
  await t.nap(500);
  const open = await t.windows[t.names[0]].evaluate(() => !!document.querySelector('[data-testid="more-sheet"]'));
  const focusInside = await t.windows[t.names[0]].evaluate(() => {
    const sheet = document.querySelector('[data-testid="more-sheet"]');
    return !!(sheet && sheet.contains(document.activeElement));
  });
  await t.windows[t.names[0]].keyboard.press('Escape');
  await t.nap(400);
  const afterEsc = await t.windows[t.names[0]].evaluate(() => !!document.querySelector('[data-testid="more-sheet"]'));
  record(`More sheet: closed before=${before}, opens=${open}, focus moved inside=${focusInside}, Escape closes it=${!afterEsc}`);
  await t.shot('more-sheet');
}

say('\n=== 5. THE VOTE SCREEN: threshold number and wording ===');
{
  await playNight(t);
  await startDay(t);
  const alive = (await import('./lib.mjs')).living;
  const livingNow = await alive(t);
  const res = await runNomination(t, {
    nominator: livingNow[0].name,
    target: livingNow[1].name,
    yesNames: livingNow.slice(0, Math.ceil(livingNow.length / 2)).map((p) => p.name),
    execute: false,
  });
  record(`the tally panel now says: "${res.tallyBefore}"`);
  const momentCopy = await t.windows[t.names[0]].evaluate(
    () => document.querySelector('[data-testid="player-moment"] p')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  );
  record(`the player's vote instruction now says: "${momentCopy}"`);
  record(`"simple majority" still present anywhere on the player's screen: ${/simple majority/i.test(res.tallyBefore + momentCopy)}`);
  await t.shot('vote-with-threshold');
}

say('\n=== 6. document.title as the alarm ===');
{
  const title = await t.windows[t.names[0]].evaluate(() => document.title);
  record(`document.title right now: "${title}"`);
  // And the night one, which is the case that matters.
  await t.stMoreClick('Switch to Night');
  await t.nap(1500);
  await t.stClick('Eyes are closed', { within: 'What to do now', timeout: 9000 });
  await t.nap(600);
  for (let i = 0; i < 60; i += 1) {
    await t.nap(280);
    const s = await t.tableState();
    if (s.owesAChoice.length === 1) {
      const who = s.owesAChoice[0];
      const titleNow = await t.windows[who].evaluate(() => document.title);
      record(`${who} is awake and their tab title reads: "${titleNow}"`);
      const awake = (await t.awakePlayers()).find((a) => a.name === who);
      if (awake && !awake.submitted && awake.targets.length > 0) {
        const disabledCopy = await t.windows[who].evaluate(() => {
          const panel = [...document.querySelectorAll('h2')]
            .find((h) => h.textContent?.includes('You Are Awake'))
            ?.closest('.panel');
          const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
            b.textContent?.includes('Send my choice')
          );
          if (!btn) return 'no submit button';
          const cs = getComputedStyle(btn);
          return `disabled=${btn.disabled} colour=${cs.color} background=${cs.backgroundColor} opacity=${cs.opacity}`;
        });
        record(`the disabled submit button: ${disabledCopy}`);
        await t.shotOne(who, 'awake-disabled-submit');
      }
      break;
    }
    if (s.gateRunning) {
      await t.stClick('Skip the wait', { within: 'What to do now', timeout: 2000 });
      continue;
    }
    if (s.canMoveOn) {
      await t.stClick('dealt with', { within: 'What to do now', timeout: 2000 });
      continue;
    }
  }
}

say('\n=== 7. MARK DEAD is now confirmed ===');
{
  const before = await t.grimoire();
  const victim = (await (await import('./lib.mjs')).living(t))[0];
  const clickedOnce = await t.st.evaluate((name) => {
    const host = document.querySelector('.grimoire-cards');
    for (const card of host?.querySelectorAll('.panel') ?? []) {
      if ((card.querySelector('strong')?.textContent ?? '').trim() !== name) continue;
      const b = [...card.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Mark Dead');
      if (!b) return 'no button';
      b.click();
      return 'clicked';
    }
    return 'no card';
  }, victim.name);
  await t.nap(350);
  const stillAlive = (await t.grimoire()).some((r) => r.includes(`${victim.name}`) && /Alive/.test(r));
  const armedLabel = await t.st.evaluate((name) => {
    const host = document.querySelector('.grimoire-cards');
    for (const card of host?.querySelectorAll('.panel') ?? []) {
      if ((card.querySelector('strong')?.textContent ?? '').trim() !== name) continue;
      return [...card.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ');
    }
    return '(card gone)';
  }, victim.name);
  record(`one click on "Mark Dead": ${clickedOnce}. ${victim.name} still alive: ${stillAlive}`);
  record(`the card now offers: ${armedLabel}`);
  await t.shot('mark-dead-armed');
  // Put them back the way we found them, via the confirm.
  const confirmed = await t.st.evaluate((name) => {
    const host = document.querySelector('.grimoire-cards');
    for (const card of host?.querySelectorAll('.panel') ?? []) {
      if ((card.querySelector('strong')?.textContent ?? '').trim() !== name) continue;
      const b = [...card.querySelectorAll('button')].find((x) => x.textContent?.includes(`Kill ${name}`));
      if (!b) return false;
      b.click();
      return true;
    }
    return false;
  }, victim.name);
  await t.nap(600);
  const nowDead = !(await t.grimoire()).some((r) => r.includes(`${victim.name}`) && /Alive/.test(r));
  record(`confirming "Kill ${victim.name}": ${confirmed}. Now dead: ${nowDead}`);
}

say('\n=== 8. No place names in player-facing copy ===');
{
  const leaks = await t.windows[t.names[0]].evaluate(() => {
    const text = document.body.textContent ?? '';
    return [...new Set(['tab', 'Town Square', 'the panel below', 'click on'].filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)))];
  });
  record(`place-name words on the player screen: ${leaks.length ? leaks.join(', ') : 'none'}`);
}

writeFileSync(join(SHOTS, 'tier1-report.txt'), report.join('\n'));
say(`\nwrote tools/playtest/shots/tier1-report.txt (${report.length} measurements)`);
t.save();
await t.close();
process.exit(0);
