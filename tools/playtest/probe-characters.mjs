/**
 * Tier 6: the two characters that had no behaviour at all.
 *
 * `virginTriggersExecution` and `slayerWouldKill` were written, exported, and called by
 * nothing. Nominating the Virgin did nothing. Slaying the Demon did nothing. Both
 * characters appear in most Trouble Brewing scripts, so this was not an edge case.
 *
 * The deal is random and there is no UI for forcing a script, so this deals repeatedly
 * until the character it needs turns up — which is the honest version of the test. It
 * clicks real buttons throughout and reads the real DOM.
 *
 * Two things it checks that unit tests cannot:
 *   1. the Storyteller is TOLD why somebody died, and
 *   2. the player who died is told, in their own window.
 */
import { dealtTable, roster, living, withCharacter, playNight, startDay, outcome } from './lib.mjs';

// Unbuffered, so a run that is interrupted still leaves a readable log.
const say = (s) => process.stdout.write(`${s}\n`);

/** What the Storyteller's script is currently showing. */
const stScreen = (t) =>
  t.st.evaluate(() => {
    const script = document.querySelector('[data-testid="storyteller-script"]');
    const immediate = document.querySelector('[data-testid="immediate-execution"]');
    return {
      stage: script?.getAttribute('data-stage') ?? null,
      say:
        [...(script?.querySelectorAll('p') ?? [])]
          .map((p) => (p.textContent ?? '').replace(/\s+/g, ' ').trim())
          .find((p) => p !== 'Say') ?? '',
      immediate: immediate ? (immediate.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
      buttons: [...(script?.querySelectorAll('button') ?? [])].map((b) => ({
        text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
        disabled: b.disabled,
      })),
    };
  });

/** Everyone's own screen, in their own words. */
const whatTheySee = async (t) => {
  const out = {};
  for (const p of t.names) {
    out[p] = await t.windows[p]
      .evaluate(() => {
        const moment = document.querySelector('[data-testid="player-moment"]');
        const banner = [...document.querySelectorAll('[role="alert"]')]
          .map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim())
          .find((x) => /executed|died|dead|slain/i.test(x));
        const body = moment ? (moment.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
        return { moment: body, banner: banner ?? null };
      })
      .catch(() => ({ moment: null, banner: null }));
  }
  return out;
};

/**
 * Deals until `wanted` is in the script, because the UI has no "use this script" control.
 *
 * Returns the LIVE table, not just the player. Re-dealing closes the previous browser, and
 * the first version of this reassigned a local `t` and returned only the player — so the
 * caller carried on holding a closed table and died on the very next call. The deal is
 * random, which makes a probe that quietly loses its table look exactly like a probe that
 * keeps failing to find the character.
 */
async function dealWith(startTable, wanted, attempts = 10) {
  let t = startTable;
  for (let i = 1; i <= attempts; i++) {
    const found = await withCharacter(t, wanted);
    if (found) return { t, found, attempt: i };
    say(`  (attempt ${i}: no ${wanted} in the deal, dealing again)`);
    if (i === attempts) break;
    await t.close();
    // Re-deals skip onboarding: the modal has been seen, dismissed, and screenshotted
    // already, and at ~35s a table it was the whole cost of this probe.
    t = await dealtTable({ count: t.names.length, tag: t.tag, skipOnboarding: true });
  }
  return { t, found: null, attempt: attempts };
}

const results = {};

// ---------------------------------------------------------------------------
// 1. The Virgin
// ---------------------------------------------------------------------------
{
  say('\n=== THE VIRGIN — nominating them should execute the NOMINATOR, immediately ===');
  const deal = await dealWith(await dealtTable({ count: 7, tag: 'virgin' }), 'virgin');
  const t = deal.t;
  const virgin = deal.found;
  const attempt = deal.attempt;
  if (!virgin) {
    say('  SKIPPED: no Virgin turned up in 10 deals (the deal is random; the point is proven by tests)');
  } else {
    say(`  the Virgin is ${virgin.name} (deal ${attempt})`);
    // The night has to happen first: a freshly dealt table sits at `night-briefing`, and
    // the first version of this probe tried to nominate into it, so both characters were
    // reported as broken when nothing had actually been tested.
    await playNight(t);
    await startDay(t);
    const r0 = await roster(t);
    const virginNow = r0.find((p) => p.name === virgin.name);
    if (!virginNow?.alive) {
      say('  SKIPPED: the Virgin died at night, so there is nothing to nominate.');
      results.virgin = { skipped: 'the Virgin died at night' };
    } else {
    const alive = await living(t);
    // A Townsfolk nominator. If the only nominator available is Evil the ability correctly
    // does not fire, so pick a good-looking player and report what actually happened.
    const nominator = alive.find((p) => p.name !== virgin.name && /Good/i.test(p.alignment ?? ''))
      ?? alive.find((p) => p.name !== virgin.name);
    say(`  ${nominator.name} (${nominator.character}, ${nominator.alignment}) nominates ${virgin.name}`);

    const nominated = await t.nominate(nominator.name, virgin.name);
    say(`  the nomination click: ok=${nominated.ok}${nominated.why ? ` (${nominated.why})` : ''}`);
    await t.nap(1400);
    // `t.nominate` silently falls back to any offered name when the one asked for is not
    // offered, so it is checked that the nomination really is for the Virgin. The first
    // run of this probe reported a broken Virgin when it had in fact nominated somebody
    // else entirely, because the Virgin had been killed the night before.
    const onTheBlock = await t.st
      .evaluate(() => {
        const p = document.querySelector('[data-testid="active-nomination"]');
        return p ? (p.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
      })
      .catch(() => null);
    const panelText = onTheBlock ?? "(none — the Virgin's ability resolved on the click)";
    say(`  the host's nomination panel: ${panelText}`);
    if (onTheBlock && !onTheBlock.includes(virgin.name)) {
      say(`  ABORT: the nomination is not for ${virgin.name}, so this proves nothing`);
      results.virgin = { aborted: `nominated somebody other than the ${virgin.name}` };
    } else {

    const r = await roster(t);
    const nowDead = r.filter((p) => !p.alive).map((p) => p.name);
    say(`  dead now: ${nowDead.length ? nowDead.join(', ') : 'NOBODY'}`);
    const nomAlive = r.find((p) => p.name === nominator.name)?.alive;
    const virAlive = r.find((p) => p.name === virgin.name)?.alive;
    say(`  nominator ${nominator.name} alive? ${nomAlive}   (expected: NO)`);
    say(`  virgin    ${virgin.name} alive? ${virAlive}   (expected: YES)`);

    const screen = await stScreen(t);
    say(`  the host's stage: ${screen.stage}`);
    say(`  the host is told: "${screen.say}"`);
    say(`  the host's panel: ${screen.immediate ? `"${screen.immediate}"` : 'NOTHING'}`);
    const buttons = screen.buttons.map((b) => b.text).join(' | ');
    say(`  the host's controls: ${buttons || 'none'}`);

    const seen = await whatTheySee(t);
    for (const [name, v] of Object.entries(seen)) {
      const bit = [v.moment, v.banner].filter(Boolean).join(' + ');
      if (bit) say(`    ${name}: ${bit.slice(0, 150)}`);
    }
    await t.shot(`tier6-virgin-${virgin.name}`);

    results.virgin = {
      ok: nomAlive === false && virAlive === true && screen.immediate !== null,
      nominatorDied: nomAlive === false,
      virginSurvived: virAlive === true,
      hostInformed: screen.immediate !== null,
      stage: screen.stage,
    };
    }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The Slayer
// ---------------------------------------------------------------------------
{
  say('\n=== THE SLAYER — nominating the Demon should kill them, immediately ===');
  const deal = await dealWith(await dealtTable({ count: 7, tag: 'slayer' }), 'slayer');
  const t = deal.t;
  const slayer = deal.found;
  const attempt = deal.attempt;
  const demon = await withCharacter(t, 'imp');
  if (!slayer || !demon) {
    say(`  SKIPPED: ${!slayer ? 'no Slayer' : 'no Imp'} in the deal`);
  } else {
    say(`  the Slayer is ${slayer.name}, the Imp is ${demon.name} (deal ${attempt})`);
    await playNight(t);
    await startDay(t);
    const rd = await roster(t);
    if (!rd.find((p) => p.name === demon.name)?.alive) {
      say('  SKIPPED: the Imp died at night, so there is no Demon to Slay.');
      results.slayer = { skipped: 'the Imp died at night' };
    }
    const alive = await living(t);
    const need = Math.ceil(alive.length / 2);
    say(`  ${slayer.name} nominates ${demon.name}; ${need} of ${alive.length} hands up`);

    const res = await t.nominate(slayer.name, demon.name);
    say(`  the nomination click: ok=${res.ok}${res.why ? ` (${res.why})` : ''}`);
    await t.nap(1200);
    /*
     * Cast a SPARE over the threshold, and report which clicks landed.
     *
     * Casting exactly the threshold made this probe a coin toss: one click that did not
     * take left the vote one short, the Slayer correctly did not fire, and the run
     * reported a broken character. A vote that misses by one is not evidence about the
     * Slayer, so the harness has to make sure it cannot produce one by accident.
     */
    const voters = alive.slice(0, Math.min(need + 2, alive.length));
    const landed = [];
    for (const voter of voters) {
      const clicked = await t.windows[voter.name].evaluate(() => {
        const panel = [...document.querySelectorAll('.panel')].find((p) =>
          p.querySelector('h3')?.textContent?.includes('Nomination:')
        );
        const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
          b.textContent?.includes('Vote to Execute')
        );
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      });
      if (clicked) landed.push(voter.name);
      await t.nap(300);
    }
    say(`  hands up: ${landed.length} of ${voters.length} clicked (need ${need}) -> ${landed.join(', ')}`);
    if (landed.length < need) say('  WARNING: the vote did not reach the threshold, so nothing below is evidence');
    say('  the host closes the vote');
    await t.stClick('Close the vote', { within: 'What to do now', timeout: 6000 });
    await t.nap(1500);

    const r = await roster(t);
    const demonAlive = r.find((p) => p.name === demon.name)?.alive;
    say(`  the Imp alive? ${demonAlive}   (expected: NO)`);

    const screen = await stScreen(t);
    say(`  the host's stage: ${screen.stage}`);
    say(`  the host's panel: ${screen.immediate ? `"${screen.immediate}"` : 'NOTHING'}`);
    const hasExecute = screen.buttons.some((b) => /^Execute/.test(b.text) && !b.disabled);
    say(`  host offered an Execute button? ${hasExecute}   (expected: NO — "immediately")`);

    const seen = await whatTheySee(t);
    for (const [name, v] of Object.entries(seen)) {
      const bit = [v.moment, v.banner].filter(Boolean).join(' + ');
      if (bit) say(`    ${name}: ${bit.slice(0, 150)}`);
    }
    await t.shot(`tier6-slayer-${demon.name}`);

    const o = await outcome(t);
    say(`  outcome: stage=${o.stage} ${o.playerBanner ?? o.storytellerBanner ?? ''}`);

    results.slayer = {
      ok: demonAlive === false && !hasExecute,
      demonKilled: demonAlive === false,
      noExecuteButton: !hasExecute,
      hostInformed: screen.immediate !== null,
      outcome: o.stage,
    };
  }
}

say('\n================ TIER 6 CHARACTER SUMMARY ================');
say(JSON.stringify(results, null, 2));
