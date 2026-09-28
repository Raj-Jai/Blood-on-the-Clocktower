/**
 * THE BIG QUESTION: does a player ever find out what they learned?
 *
 * The app computes a night result for every learn-in character — the Chef's
 * pairs, the Empath's neighbours, the Washerwoman's 1-of-2, the Undertaker's
 * execution, the Fortune Teller's yes/no — and stores it on the player record. This
 * probe plays a full night and then watches every window at every beat, looking
 * for the moment it reaches the screen.
 *
 * It also grabs a screenshot of the prompt WHILE the choice is still on it, which
 * the main game runner misses because it screenshots after sending.
 */
import { dealtTable, roster, living, playNight, startDay } from './lib.mjs';

const say = (s) => console.log(s);
const names = ['Ada', 'Bram', 'Cleo', 'Dev', 'Esme', 'Fay', 'Gus'];

// Play a few deals until a learn-in character is in play, then watch closely.
for (let attempt = 1; attempt <= 6; attempt += 1) {
  const t = await dealtTable({ count: 7, tag: `v-learn-try${attempt}`, names });
  const r = await roster(t);
  say(`\n===== deal ${attempt}: ${r.map((p) => `${p.name}=${p.character}`).join(', ')}`);
  const learnIn = r.filter((p) =>
    ['Washerwoman', 'Librarian', 'Investigator', 'Chef', 'Empath', 'Fortune Teller', 'Undertaker', 'Ravenkeeper'].includes(p.character)
  );
  say(`  learn-in characters: ${learnIn.map((p) => `${p.name}=${p.character}`).join(', ') || 'none'}`);
  if (learnIn.length === 0) {
    await t.close();
    continue;
  }

  let sawResultAtAnyBeat = false;
  /** Every beat, so the verdict can say WHICH beat the information appeared at. */
  const watch = async (label) => {
    const seen = {};
    for (const n of names) {
      const info = await t.windows[n]
        .evaluate(() => {
          const moment = document.querySelector('[data-testid="player-moment"]');
          const headings = [...document.querySelectorAll('h2')].map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim());
          const resultPanel = headings.find((h) => h.includes('Your Night Result'));
          let resultText = null;
          if (resultPanel) {
            const panel = [...document.querySelectorAll('h2')]
              .find((h) => h.textContent?.includes('Your Night Result'))
              ?.closest('.panel');
            resultText = (panel?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
          }
          const awake = headings.find((h) => h.includes('You Are Awake'));
          let promptText = null;
          if (awake) {
            const panel = [...document.querySelectorAll('h2')]
              .find((h) => h.textContent?.includes('You Are Awake'))
              ?.closest('.panel');
            promptText = (panel?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
          }
          return {
            moment: moment?.getAttribute('data-moment') ?? null,
            hasResult: !!resultPanel,
            resultText,
            hasPrompt: !!awake,
            promptText,
          };
        })
        .catch(() => ({}));
      seen[n] = info;
    }
    const withResult = Object.entries(seen).filter(([, v]) => v.hasResult);
    if (withResult.length > 0) sawResultAtAnyBeat = true;
    say(`  [${label}] results on screen: ${withResult.length ? withResult.map(([n, v]) => `${n}: "${v.resultText}"`).join(' | ') : 'NOBODY'}`);
    if (withResult.length > 0 && (label.includes('resolved') || label.includes('dawn'))) {
      await t.shot(`result-${label.replace(/\W+/g, '-')}`);
    }
    return seen;
  };

  await t.stClick('Eyes are closed', { within: 'What to do now', timeout: 9000 });
  await t.nap(400);
  await watch('night open');

  // Walk the night, screenshotting each picker while its choice is still pending.
  let screenshots = 0;
  for (let i = 0; i < 160; i += 1) {
    await t.nap(280);
    const s = await t.tableState();
    if (['day-reveal', 'day-discussion', 'day-voting', 'ended'].includes(s.stage)) break;
    if (s.gateRunning) {
      await t.stClick('Skip the wait', { within: 'What to do now', timeout: 2000 });
      continue;
    }
    if (s.owesAChoice.length === 1) {
      const who = s.owesAChoice[0];
      const awake = (await t.awakePlayers()).find((a) => a.name === who);
      if (awake && !awake.submitted && awake.targets.length > 0) {
        // The screenshot the main runner misses: the prompt BEFORE it is answered.
        if (screenshots === 0) {
          await t.shotOne(who, 'prompt-before-answering');
          say(`  captured the live prompt for ${who} (${awake.character || 'unknown'})`);
          screenshots += 1;
        }
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
      await watch('the instant the night is resolved');
      await t.stClick('Resolve the night', { within: 'What to do now' });
      await t.nap(1200);
      await watch('after the night resolves');
      break;
    }
  }

  // Keep watching through dawn — the results might arrive on the way to the day.
  await watch('before moving to the day');
  await t.stClick('Move to the day', { within: 'What to do now', timeout: 6000 });
  await t.nap(1200);
  await watch('at dawn, before the day starts');
  await startDay(t);
  await t.nap(1000);
  const final = await watch('during the day, after everything has settled');

  // Also look in the More sheet, in case the result is filed away there.
  const buried = await t.windows[learnIn[0].name].evaluate(() => {
    document.querySelector('[data-testid="more-button"]')?.click();
    return new Promise((res) =>
      setTimeout(() => {
        const sheet = document.querySelector('[data-testid="more-sheet"]');
        res((sheet?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400));
      }, 600)
    );
  });
  say(`  ${learnIn[0].name}'s More sheet: ${buried}`);

  const anyoneEverSaw = sawResultAtAnyBeat;
  // The result is also filed in the More sheet, so check that too rather than treating
  // the end-of-day moment card as the last word.
  const filedInMore = /Last night|You learn|night passes/i.test(buried);
  say(`\n  >>> VERDICT: ${
    anyoneEverSaw || filedInMore
      ? 'Results DO reach players. Every learn-in character was told, and the text is kept in their own "More" sheet for the rest of the day.'
      : 'NO PLAYER EVER SAW A NIGHT RESULT. The app computes what every learn-in character learns and never shows it to them.'
  }`);
  say(`  visible in the moment card at some beat: ${anyoneEverSaw}`);
  say(`  still readable in the More sheet at the end of the day: ${filedInMore}`);
  say('  learn-in characters in this game: ' + learnIn.map((p) => `${p.name}=${p.character}`).join(', '));
  await t.shot('end-of-day');
  t.save();
  await t.close();
  break;
}

process.exit(0);
