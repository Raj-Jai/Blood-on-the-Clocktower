/**
 * Composable helpers for asking one rules question per table.
 *
 * Every one of these still works by clicking the real UI. "Killing a player" is
 * the Storyteller's own "Mark Dead" button on the Grimoire; "executing" is a real
 * nomination, real votes, a real close and a real confirm. Nothing reaches around
 * the app.
 */
import { ALL_NAMES, PHONE, openTable } from './table.mjs';

/** Opens a table and deals the roles, returning the roster the host can see. */
export async function dealtTable({ count = 5, tag, viewport = PHONE, names, skipOnboarding = false } = {}) {
  const roster = names ?? ALL_NAMES.slice(0, count);
  const t = await openTable({ count: roster.length, tag, viewport, names: roster, skipOnboarding });
  const started = await t.stClick('Start Distribution', { timeout: 12000 });
  if (!started) throw new Error('could not deal the roles');
  await t.nap(1200);
  return t;
}

/**
 * The Grimoire as the Storyteller's screen shows it, parsed.
 *
 * Scoped to `.grimoire-cards` on purpose: the component also renders a <table> of
 * the same data for wide screens, so an unscoped read returns every player twice.
 */
export const roster = (t) =>
  t.st
    .evaluate(() => {
      const host = document.querySelector('.grimoire-cards');
      if (!host) return [];
      const out = [];
      for (const card of host.querySelectorAll(':scope > div > .panel')) {
        const name = card.querySelector('strong')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const state = card.querySelector('p.muted')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const [character, life] = state.split('—').map((s) => s.trim());
        out.push({
          name,
          character: character ?? '',
          alive: life === 'Alive',
          alignment: card.querySelector('div > span')?.textContent?.trim() ?? '',
        });
      }
      return out;
    })
    .catch(() => []);

export const living = async (t) => (await roster(t)).filter((p) => p.alive);
/**
 * Case-insensitive on purpose. The Grimoire card renders the character as the data spells
 * it — "Virgin", "Slayer" — so an exact `=== 'virgin'` silently matched nothing and every
 * "no Virgin in the deal" was really "this comparison never matches". Six re-deals went
 * by on that before it was noticed.
 */
export const withCharacter = async (t, character) => {
  const want = character.trim().toLowerCase();
  return (await roster(t)).find((p) => (p.character ?? '').trim().toLowerCase() === want);
};

/**
 * The Storyteller's own "Mark Dead" control on the Grimoire, followed by its
 * confirmation. It takes two clicks now that it asks before killing somebody, which
 * is the point: it used to be one unconfirmed irreversible click.
 */
export const markDead = async (t, name) => {
  const click = (label) =>
    t.st.evaluate(
      ({ want, playerName }) => {
        const host = document.querySelector('.grimoire-cards');
        for (const card of host?.querySelectorAll('.panel') ?? []) {
          const cardName = card.querySelector('strong')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          if (cardName !== playerName) continue;
          const btn = [...card.querySelectorAll('button')].find(
            (b) => b.textContent?.includes(want) && !b.disabled
          );
          if (!btn) return false;
          btn.click();
          return true;
        }
        return false;
      },
      { want: label, playerName: name }
    );
  const armed = await click('Mark Dead');
  if (!armed) return false;
  await t.nap(250);
  const confirmed = await click(`Kill ${name}`);
  await t.nap(700);
  return armed && confirmed;
};

/** Reads the flow stage and, if the game is over, who won and why. */
export const outcome = async (t) => {
  const s = await t.tableState();
  const banner = await t.windows[t.names[0]]
    .evaluate(() => {
      const el = [...document.querySelectorAll('[role="alert"]')].find((p) =>
        /wins/i.test(p.querySelector('h2')?.textContent ?? '')
      );
      if (!el) return null;
      return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    })
    .catch(() => null);
  const stBanner = await t.st
    .evaluate(() => {
      const el = [...document.querySelectorAll('[role="alert"]')].find((p) =>
        /wins/i.test(p.querySelector('h2')?.textContent ?? '')
      );
      return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
    })
    .catch(() => null);
  return { stage: s.stage, playerBanner: banner, storytellerBanner: stBanner };
};

/**
 * Runs a nomination to its conclusion through the UI and reports what the app did.
 *
 * `yesNames` is exactly who casts a hand up, so a threshold can be probed to the
 * vote rather than by arithmetic.
 */
export async function runNomination(t, { nominator, target, yesNames, execute = true }) {
  const out = { nominator, target, yesNames, steps: [] };
  const n = await t.nominate(nominator, target);
  out.nominated = n;
  out.steps.push(`nominate: ok=${n.ok}${n.why ? ` (${n.why})` : ''}`);
  if (!n.ok) return out;
  await t.nap(1100);

  out.tallyBefore = (await t.tallyOn(t.names[0]))?.text ?? null;
  out.steps.push(`tally panel before any votes: "${out.tallyBefore}"`);

  for (const voter of yesNames) {
    const clicked = await t.windows[voter].evaluate(() => {
      const panel = [...document.querySelectorAll('.panel')].find((p) =>
        p.querySelector('h3')?.textContent?.includes('Nomination:')
      );
      const btn = [...(panel?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent?.includes('Vote to Execute')
      );
      if (!btn) return 'no button';
      if (btn.disabled) return 'disabled';
      btn.click();
      return 'clicked';
    });
    out.steps.push(`  ${voter} vote: ${clicked}`);
    await t.nap(350);
  }
  out.tallyAfter = (await t.tallyOn(t.names[0]))?.text ?? null;
  out.steps.push(`tally panel after ${yesNames.length} vote(s): "${out.tallyAfter}"`);

  await t.stClick('Close the vote', { within: 'What to do now', timeout: 5000 });
  await t.nap(1000);
  out.onTheBlock = await t.st
    .evaluate(() => {
      const p = document.querySelector('[data-testid="active-nomination"]');
      return p ? (p.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
    })
    .catch(() => null);
  out.steps.push(`after closing, the host's panel says: ${out.onTheBlock}`);

  const s = await t.tableState();
  out.offersExecute = s.canExecute;
  out.steps.push(`host offered "Execute": ${s.canExecute}`);

  if (s.canExecute && execute) {
    await t.stClick('Execute ', { within: 'What to do now', timeout: 5000 });
    await t.nap(1300);
    out.executed = true;
    out.steps.push('host confirmed the execution');
    // Who was told, in their own window, that they died?
    out.told = [];
    for (const p of t.names) {
      const m = await t.moment(p);
      const banner = await t.windows[p]
        .evaluate(() => {
          const el = [...document.querySelectorAll('[role="alert"]')].find((x) =>
            /has been executed/i.test(x.textContent ?? '')
          );
          return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
        })
        .catch(() => null);
      if (banner || (m && m.kind === 'dead')) {
        out.told.push(`${p}: ${m?.kind ?? '?'}${banner ? ` + banner "${banner}"` : ' (no banner)'}`);
      }
    }
    out.steps.push(`players told they died: ${out.told.join(' | ') || 'NOBODY'}`);
  }
  out.outcome = await outcome(t);
  out.steps.push(`outcome: stage=${out.outcome.stage} ${out.outcome.playerBanner ?? ''}`);
  return out;
}

/** Walks a night from the briefing to the table being woken, choosing targets blindly-but-legally. */
export async function playNight(t, { collectResults = true } = {}) {
  await t.stClick('Eyes are closed', { within: 'What to do now', timeout: 9000 });
  await t.nap(400);
  const order = await t.nightOrder();

  let resolved = false;
  for (let i = 0; i < 140; i += 1) {
    await t.nap(280);
    const s = await t.tableState();
    if (['day-reveal', 'day-discussion', 'day-voting', 'ended'].includes(s.stage)) break;
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
      await t.nap(800);
      // Read the private results NOW: the app clears a waker's prompt at dawn, so
      // anything collected after "Move to the day" has already been thrown away.
      if (collectResults && !resolved) {
        resolved = true;
        const info = await t.privateInfo();
        t.nightResults = info;
      }
      continue;
    }
  }
  return order;
}

/** Moves the table out of the dawn beat and into the day. */
export async function startDay(t) {
  for (let i = 0; i < 25; i += 1) {
    const s = await t.tableState();
    if (s.stage === 'ended' || s.stage === 'day-discussion' || s.stage === 'day-voting') return s.stage;
    if (s.canStartDay) {
      await t.stClick('read the dead', { within: 'What to do now' });
      await t.nap(700);
      continue;
    }
    await t.nap(400);
  }
  return (await t.tableState()).stage;
}

export { ALL_NAMES, PHONE };
