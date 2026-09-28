/**
 * A real table of real browser windows, set up the way a real group sets one up.
 *
 * THE POINT OF THIS FILE: everything is done through the UI. The Storyteller
 * clicks "Create Game" on the home page. The join code is then READ OFF THE
 * SCREEN, exactly as a host reads it out. Each player types that code and their
 * name into the "Join a Game" form and clicks the button. Nothing is seeded into
 * localStorage and nothing calls the REST API directly.
 *
 * That is the whole reason this file exists rather than reusing a harness that
 * POSTs to /api/sessions. A driver that creates the session behind the app's back
 * cannot tell you what a first-time host sees on the home page, and never sees the
 * join flow at all — which is where half the friction in this app lives.
 *
 * TWO RULES, both learned the hard way (see ../../MEMORY.md):
 *
 *  1. NEVER open a second socket for a player or the Storyteller. Private night
 *     prompts are sent to a single connectionId, so a second socket STEALS that
 *     player's prompts and the browser then looks like it lost them. Every fact
 *     here is read from the real windows instead.
 *
 *  2. SCOPE every click to its own panel. Matching button text across a whole page
 *     hits the wrong control: the player's own "Nominate someone" line contains
 *     the word "Nominate" and sits above the Nominate panel's "Nominate" button.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(HERE, 'shots');
export const APP = process.env.APP_URL ?? 'http://localhost:5173';
export const SERVER_LOG = process.env.SERVER_LOG ?? '/tmp/otc-server.log';

export const PHONE = { width: 390, height: 844 };
export const BIG_PHONE = { width: 430, height: 932 };
export const TABLET = { width: 820, height: 1180 };
export const DESKTOP = { width: 1440, height: 900 };

export const ALL_NAMES = [
  'Ada', 'Bram', 'Cleo', 'Dev', 'Esme', 'Fay', 'Gus', 'Hal', 'Iris',
  'Jon', 'Kit', 'Lux', 'Mia', 'Ned', 'Ora',
];

export const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Playwright is not a dependency of this repo, so it is resolved from wherever it
 * happens to live rather than added to package.json for a test harness nobody runs
 * in CI. Override with PLAYWRIGHT_PATH if yours is somewhere else.
 */
async function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    'playwright-core',
    '/home/jai-raj/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const mod = await import(c);
      if (mod.chromium) return mod.chromium;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    'Could not load Playwright. Set PLAYWRIGHT_PATH to a playwright install, e.g.\n' +
      '  npx playwright install chromium && PLAYWRIGHT_PATH=$(npm root -g)/playwright/index.mjs node ...'
  );
}

/**
 * Builds a table: one Storyteller window and `count` player windows, all real
 * browser contexts, all joined through the real UI.
 *
 * `onbeat` gets called with a short narration string at every meaningful step, so
 * a run reads as a play-through rather than a wall of assertions.
 */
export async function openTable({
  count = 5,
  tag = 'table',
  viewport = PHONE,
  headed = false,
  names = ALL_NAMES.slice(0, count),
  screenshots = true,
  /** Set when re-dealing for a specific character: skips the first-run onboarding modal. */
  skipOnboarding = false,
} = {}) {
  const chromium = await loadChromium();
  mkdirSync(SHOTS, { recursive: true });

  const log = [];
  const problems = [];
  const observations = [];
  const say = (s) => {
    log.push(s);
    console.log(s);
  };
  /** A judgement call, not a failure. Kept apart from `problems` on purpose. */
  const note = (s) => {
    observations.push(s);
    say(`  · ${s}`);
  };

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });

  const windows = {};
  const seenWarnings = new Set();

  const openWindow = async (who, viewportOverride) => {
    const ctx = await browser.newContext({
      viewport: viewportOverride ?? viewport,
      // Phone-like input: anything sized for a mouse-only layout shows up here as a
      // tap target that is too small, or as two that overlap.
      hasTouch: true,
      isMobile: (viewportOverride ?? viewport).width < 700,
      deviceScaleFactor: 2,
    });
    /*
     * Skip the first-run onboarding modal.
     *
     * It is a real modal and the harness used to dismiss it on every single join, which is
     * both slow and irrelevant once it has been seen once. It is seeded here rather than
     * clicked, because the modal is about to be screenshotted and asserted on in the tier-1
     * probe — this flag is only set when the caller says the table is being re-dealt.
     */
    if (skipOnboarding) {
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('botc:onboarding:seen', '1');
        } catch {}
      });
    }
    const page = await ctx.newPage();
    page.on('pageerror', (e) => {
      problems.push(`${who}: uncaught page error — ${e.message}`);
      console.log(`  !! ${who} PAGEERROR ${e.message}`);
    });
    page.on('console', (m) => {
      const text = m.text();
      // React Router's v7 future-flag notices are framework noise.
      if (text.includes('React Router Future Flag')) return;
      if (m.type() !== 'error' && !text.includes('Warning:')) return;
      const key = `${who}:${text.slice(0, 80)}`;
      if (seenWarnings.has(key)) return;
      seenWarnings.add(key);
      problems.push(`${who}: console — ${text.split('\n')[0].slice(0, 200)}`);
      console.log(`  !! ${who} CONSOLE ${text.split('\n')[0].slice(0, 160)}`);
    });
    windows[who] = page;
    return page;
  };

  const shotOne = async (who, beat) => {
    if (!screenshots || !windows[who]) return;
    await windows[who].screenshot({ path: `${SHOTS}/${tag}-${beat}-${who}.png` }).catch(() => {});
  };
  const shot = async (beat) => {
    for (const who of Object.keys(windows)) await shotOne(who, beat);
  };

  // -------------------------------------------------------------- the setup --

  say(`\n=== SETTING UP A ${count}-PLAYER TABLE THROUGH THE UI ===`);
  say(`  viewport ${viewport.width}x${viewport.height}, ${names.join(', ')}`);

  const st = await openWindow('ST');
  await st.goto(`${APP}/#/`);
  await st.waitForSelector('button:has-text("Create Game")', { timeout: 15000 });
  await shotOne('ST', '00-home');

  await st.click('button:has-text("Create Game")');
  // The lobby is the proof the host actually got a game. Read the code off the page.
  await st.waitForSelector('text=/Join code/i', { timeout: 20000 });
  await nap(700);
  const code = await st.evaluate(() => {
    const el = [...document.querySelectorAll('strong')].find((s) => /^[A-Z0-9]{4,8}$/.test(s.textContent?.trim() ?? ''));
    return el?.textContent?.trim() ?? null;
  });
  if (!code) throw new Error('Could not read a join code off the lobby screen.');
  say(`  host clicked "Create Game" -> lobby shows join code ${code}`);
  await shotOne('ST', '01-lobby-empty');

  for (const displayName of names) {
    const page = await openWindow(displayName);
    await page.goto(`${APP}/#/`);
    await page.waitForSelector('input[placeholder*="Join code"]', { timeout: 15000 });
    await page.fill('input[placeholder*="Join code"]', code);
    await page.fill('input[placeholder="Your name"]', displayName);
    await shotOne(displayName, '02-join-form');
    await page.click('button:has-text("Join Game")');

    // The onboarding modal lands on top of the lobby for a brand-new player. It is
    // part of the first-run experience, so it gets looked at rather than skipped.
    await page.waitForSelector('text=/Join code/i', { timeout: 20000 });
    await nap(500);
    const modal = await page.$('div[role="dialog"]');
    if (modal) {
      await shotOne(displayName, '03-onboarding');
      const pages = await page.$$eval('div[role="dialog"] .step-indicator span', (els) =>
        els.map((e) => e.textContent?.trim() ?? '')
      );
      note(`${displayName}: first-run onboarding modal appears over the lobby (${pages.join(' -> ')})`);
      for (let i = 0; i < 6; i += 1) {
        const done = await page.evaluate(() => {
          const b = [...document.querySelectorAll('div[role="dialog"] button')].find(
            (x) => x.textContent?.trim() === "Let's Play" && !x.disabled
          );
          if (!b) return false;
          b.click();
          return true;
        });
        if (done) break;
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('div[role="dialog"] button')].find(
            (x) => x.textContent?.trim() === 'Next' && !x.disabled
          );
          b?.click();
        });
        await nap(220);
      }
    }
    await nap(400);
    say(`  ${displayName} typed the code and their name, clicked "Join Game"`);
  }

  // The lobby the host sees with everyone in it.
  await st.waitForSelector(`text=${names[names.length - 1]}`, { timeout: 15000 });
  await nap(600);
  await shotOne('ST', '04-lobby-full');
  const lobbyRead = await st.evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((p) =>
      p.querySelector('h2')?.textContent?.includes('Players')
    );
    return {
      heading: panel?.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      names: [...(panel?.querySelectorAll('li') ?? [])].map((li) => (li.textContent ?? '').trim()),
      startDisabled: !!panel?.parentElement?.querySelector('button[disabled]'),
    };
  });
  say(`  host sees: ${lobbyRead.heading} -> ${lobbyRead.names.join(', ')}`);
  note(
    `lobby is the ONLY place the join code appears in the app; a player who is already ` +
      `in the game has no way to show it to a replacement player`
  );

  // ------------------------------------------------------------- primitives --

  /** Every button on a page, with its text and whether it is live right now. */
  const buttons = (who) =>
    windows[who]
      .evaluate(() =>
        [...document.querySelectorAll('button')].map((b) => ({
          text: (b.textContent ?? '').trim().replace(/\s+/g, ' '),
          disabled: b.disabled,
          visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
        }))
      )
      .catch(() => []);

  const stButtons = () => buttons('ST');

  /**
   * Clicks a button by its visible text, scoped to a panel whose heading matches
   * `within`. Scoping is not optional — see rule 2 at the top of this file.
   */
  const clickIn = async (who, within, text, { timeout = 4000, exact = false } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = await windows[who]
        .evaluate(
          ({ within, text, exact }) => {
            const panels = [...document.querySelectorAll('.panel')];
            const pool = within
              ? panels.filter((p) =>
                  [...p.querySelectorAll('h2, h3, h4')].some((h) =>
                    (h.textContent ?? '').toLowerCase().includes(within.toLowerCase())
                  )
                )
              : panels;
            // A dialog is not a .panel, so fall back to the whole document.
            const scopes = pool.length > 0 ? pool : [document];
            const want = text.toLowerCase();
            for (const scope of scopes) {
              const btn = [...scope.querySelectorAll('button')].find((b) => {
                const t = (b.textContent ?? '').replace(/\s+/g, ' ').trim();
                return exact ? t === text : t.toLowerCase().includes(want);
              });
              if (!btn || btn.disabled) continue;
              if (!(btn.offsetWidth || btn.offsetHeight || btn.getClientRects().length)) continue;
              btn.click();
              return true;
            }
            return false;
          },
          { within, text, exact }
        )
        .catch(() => false);
      if (hit) return true;
      await nap(120);
    }
    return false;
  };

  const stClick = (text, o) => clickIn('ST', o?.within, text, o);
  const playerClick = (who, text, o) => clickIn(who, o?.within, text, o);

  /** Opens the Storyteller's "More" sheet, clicks, and closes it again. */
  const stMoreClick = async (text) => {
    await st.evaluate(() => document.querySelector('[data-testid="st-more-button"]')?.click());
    await nap(400);
    const hit = await st.evaluate((t) => {
      const sheet = document.querySelector('[data-testid="st-more-sheet"]');
      const want = t.toLowerCase();
      const btn = [...(sheet?.querySelectorAll('button') ?? [])].find(
        (b) => (b.textContent ?? '').replace(/\s+/g, ' ').toLowerCase().includes(want) && !b.disabled
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, text);
    await nap(450);
    await st.evaluate(() => document.querySelector('[data-testid="st-more-close"]')?.click());
    await nap(300);
    return hit;
  };

  /** Opens a player's "More" sheet, clicks, and closes it again. */
  const playerMoreClick = async (who, text) => {
    await windows[who].evaluate(() => document.querySelector('[data-testid="more-button"]')?.click());
    await nap(400);
    const hit = await windows[who].evaluate((t) => {
      const sheet = document.querySelector('[data-testid="more-sheet"]');
      const want = t.toLowerCase();
      const btn = [...(sheet?.querySelectorAll('button') ?? [])].find(
        (b) => (b.textContent ?? '').replace(/\s+/g, ' ').toLowerCase().includes(want) && !b.disabled
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, text);
    await nap(400);
    await windows[who].evaluate(() => document.querySelector('[data-testid="more-close"]')?.click());
    await nap(300);
    return hit;
  };

  // ------------------------------------------------------------- the readouts --

  /** What this window is telling its player to do right now. */
  const moment = (who) =>
    windows[who]
      .evaluate(() => {
        const el = document.querySelector('[data-testid="player-moment"]');
        if (!el) return null;
        return {
          kind: el.getAttribute('data-moment'),
          action: el.getAttribute('data-action'),
          title: el.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          detail: el.querySelector('p')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
      })
      .catch(() => null);

  /** The Storyteller's "What to do now" panel: the stage, the line, the controls. */
  const script = () =>
    st
      .evaluate(() => {
        const el = document.querySelector('[data-testid="storyteller-script"]');
        if (!el) return null;
        const ps = [...el.querySelectorAll('p')].map((p) => (p.textContent ?? '').replace(/\s+/g, ' ').trim());
        return {
          stage: el.getAttribute('data-stage'),
          progress: el.querySelector('.muted')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          say: ps.find((t) => t !== 'Say') ?? '',
          buttons: [...el.querySelectorAll('button')].map((b) => ({
            text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
            disabled: b.disabled,
          })),
        };
      })
      .catch(() => null);

  /**
   * The whole table's live situation, assembled from what the real windows show.
   * This is the only honest way to read state: no second socket, no server poke.
   */
  const tableState = async () => {
    const s = await script();
    const players = {};
    let owesAChoice = [];
    let awakeNoChoice = [];
    for (const n of names) {
      const m = await moment(n);
      players[n] = m ? `${m.kind}/${m.action}` : '?';
      if (m?.kind === 'awake-choose') owesAChoice.push(n);
      if (m?.kind === 'awake-listen') awakeNoChoice.push(n);
    }
    const on = (re) => s?.buttons.some((b) => re.test(b.text) && !b.disabled) ?? false;
    return {
      stage: s?.stage ?? null,
      say: s?.say ?? '',
      progress: s?.progress ?? '',
      players,
      owesAChoice,
      awakeNoChoice,
      gateRunning: !!(await st.$('[data-testid="wake-countdown"]')),
      canStartWalk: on(/Eyes are closed/i),
      canSkip: on(/Skip the wait/i),
      canMoveOn: on(/dealt with/i),
      canResolve: on(/Resolve the night/i),
      canEndNight: on(/Move to the day/i),
      canStartDay: on(/read the dead/i),
      canExecute: on(/^Execute /i),
      canCloseVote: on(/Close the vote/i),
    };
  };

  /** Who has a night prompt on screen, what they must choose, and what they chose. */
  const awakePlayers = async () => {
    const out = [];
    for (const n of names) {
      const r = await windows[n]
        .evaluate(() => {
          const h = [...document.querySelectorAll('h2')].find((x) => x.textContent?.includes('You Are Awake'));
          if (!h) return null;
          const panel = h.closest('.panel');
          const text = (panel?.textContent ?? '').replace(/\s+/g, ' ');
          return {
            text: text.slice(0, 220),
            submitted: /Choice sent/.test(text),
            // "Choose 2 players (0/2 chosen)" — the Fortune Teller picks two, so a
            // driver that clicks one target and expects Send to enable is wrong.
            needed: Number(text.match(/\((\d+)\/(\d+) chosen\)/)?.[2] ?? 0) || 0,
            chosen: Number(text.match(/\((\d+)\/(\d+) chosen\)/)?.[1] ?? 0) || 0,
            character: text.match(/— ([A-Z][A-Za-z ]+)$/)?.[1] ?? '',
            targets: [...(panel?.querySelectorAll('button') ?? [])]
              .map((b) => (b.textContent ?? '').replace(/^[\s\u2713]*/, '').trim())
              .filter((t) => t && !/Send my choice|Choice sent|Go to my prompt/.test(t)),
          };
        })
        .catch(() => null);
      if (r) out.push({ name: n, ...r });
    }
    return out;
  };

  /**
   * Clicks targets in the player's OWN night prompt and sends. Scoped to the panel
   * because the same display name appears in the seating list and the grimoire too.
   */
  const playerSubmit = async (who, targetNames) => {
    const names = Array.isArray(targetNames) ? targetNames : [targetNames];
    const picked = await windows[who].evaluate((wanted) => {
      const h = [...document.querySelectorAll('h2')].find((x) => x.textContent?.includes('You Are Awake'));
      const panel = h?.closest('.panel');
      if (!panel) return { ok: false, why: 'no prompt panel' };
      const label = (b) => (b.textContent ?? '').replace(/^[\s\u2713]*/, '').trim();
      for (const n of wanted) {
        const btn = [...panel.querySelectorAll('button')].find((b) => label(b) === n && !b.disabled);
        if (!btn) return { ok: false, why: `no enabled target "${n}"` };
        btn.click();
      }
      return { ok: true };
    }, names);
    if (!picked.ok) return { picked: false, sent: false, why: picked.why };
    await nap(250);
    const sent = await windows[who].evaluate(() => {
      const h = [...document.querySelectorAll('h2')].find((x) => x.textContent?.includes('You Are Awake'));
      const panel = h?.closest('.panel');
      const btn = [...(panel?.querySelectorAll('button') ?? [])].find((b) =>
        (b.textContent ?? '').includes('Send my choice')
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    });
    return { picked: true, sent };
  };

  /**
   * N nominates somebody, the whole way through the confirmation.
   *
   * `targetName` may be a list, in which case each is tried in turn and the first one
   * the app actually accepts is used. That is not laziness: the app now enforces that a
   * living player may be nominated only once per day, so a driver that always picks the
   * first name will eventually aim at an illegal nomination and report the app's
   * correct refusal as a failure.
   */
  const nominate = async (who, targetName) => {
    const sel = await windows[who].$('[data-testid="nominate-select"]');
    if (!sel) return { ok: false, why: 'no nominate control on screen' };
    if (await sel.evaluate((s) => s.disabled)) return { ok: false, why: 'nominate control disabled' };
    const offered = await sel.evaluate((s) => [...s.options].map((o) => o.textContent?.trim() ?? ''));
    const candidates = Array.isArray(targetName) ? targetName : [targetName];
    const order = [
      ...candidates.filter((n) => offered.includes(n)),
      ...offered.filter((n) => n && !candidates.includes(n)),
    ];
    for (const name of order) {
      // Re-check on every attempt: the control disables itself once THIS player has
      // spent their nomination, and Playwright's selectOption waits forever on a
      // disabled element rather than failing.
      if (await sel.evaluate((s) => s.disabled)) return { ok: false, why: 'nominate control disabled' };
      const value = await sel.evaluate((s, want) => {
        const opt = [...s.options].find((o) => o.textContent?.trim() === want);
        return opt?.value ?? null;
      }, name);
      if (!value) continue;
      // Playwright's own select handling, not a dispatched event: a synthetic 'change'
      // does not reliably reach React's onChange for a controlled <select>.
      try {
        await sel.selectOption(value, { timeout: 1500 });
      } catch {
        continue; // it went disabled under us; the next candidate may still work
      }
      await nap(250);
      const armed = await windows[who].evaluate(() => {
        const panel = [...document.querySelectorAll('.panel')].find((p) =>
          p.querySelector('h3')?.textContent?.includes('Nominate')
        );
        const btn = [...(panel?.querySelectorAll('button') ?? [])].find(
          (b) => b.textContent?.trim() === 'Nominate' && !b.disabled
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!armed) continue; // the app refused this one; try the next
      await nap(250);
      const confirmed = await windows[who].evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.includes('Confirm Nomination') && !b.disabled
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (confirmed) return { ok: true, value, target: name };
    }
    return { ok: false, why: 'the app refused every candidate it offered' };
  };

  /** Everyone who is able to vote, votes. Returns how many hands went up. */
  const allVote = async ({ except = [] } = {}) => {
    let voters = 0;
    const refused = [];
    for (const n of names) {
      if (except.includes(n)) continue;
      const ok = await windows[n].evaluate(() => {
        const panel = [...document.querySelectorAll('.panel')].find((p) =>
          p.querySelector('h3')?.textContent?.includes('Nomination:')
        );
        const btn = [...(panel?.querySelectorAll('button') ?? [])].find(
          (b) => b.textContent?.includes('Vote to Execute') && !b.disabled
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (ok) voters += 1;
      else refused.push(n);
      await nap(130);
    }
    return { voters, refused };
  };

  /** The vote tally as each player is being shown it. */
  const tallyOn = async (who) =>
    windows[who]
      .evaluate(() => {
        const panel = [...document.querySelectorAll('.panel')].find((p) =>
          p.querySelector('h3')?.textContent?.includes('Nomination:')
        );
        if (!panel) return null;
        return {
          text: (panel.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
          canVote: !![...panel.querySelectorAll('button')].find(
            (b) => b.textContent?.includes('Vote to Execute') && !b.disabled
          ),
          canRetract: !![...panel.querySelectorAll('button')].find(
            (b) => b.textContent?.includes('Retract') && !b.disabled
          ),
        };
      })
      .catch(() => null);

  /** The Storyteller's Grimoire, as the ST's own screen shows it. */
  const grimoire = () =>
    st
      .evaluate(() => {
        const panel = [...document.querySelectorAll('.panel')].find((p) =>
          p.querySelector('h2')?.textContent?.trim() === 'Grimoire'
        );
        if (!panel) return null;
        return [...panel.querySelectorAll('tr, li')].map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim());
      })
      .catch(() => null);

  /** The Storyteller's night order list, for comparing against the official sheet. */
  const nightOrder = async () => {
    await st.evaluate(() => document.querySelector('[data-testid="st-more-button"]')?.click());
    await nap(400);
    const order = await st
      .evaluate(() => {
        const sheet = document.querySelector('[data-testid="st-more-sheet"]');
        const panel = [...(sheet?.querySelectorAll('.panel') ?? [])].find((p) =>
          /order/i.test(p.querySelector('h2, h3')?.textContent ?? '')
        );
        return {
          heading: panel?.querySelector('h2, h3')?.textContent?.replace(/\s+/g, ' ').trim() ?? '(no order panel)',
          items: [...(panel?.querySelectorAll('li') ?? [])].map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim()),
        };
      })
      .catch(() => null);
    await st.evaluate(() => document.querySelector('[data-testid="st-more-close"]')?.click());
    await nap(250);
    return order;
  };

  /** Every private bit of information the app is currently showing a player. */
  const privateInfo = async () => {
    const out = {};
    for (const n of names) {
      out[n] = await windows[n]
        .evaluate(() => {
          const panel = [...document.querySelectorAll('.panel')].find((p) =>
            p.querySelector('h2')?.textContent?.includes('Your Night Result')
          );
          const charCard = [...document.querySelectorAll('h3, h2')].find((h) => /character/i.test(h.textContent ?? ''));
          return {
            result: panel
              ? (panel.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
              : null,
            hasCharacterCard: !!charCard,
          };
        })
        .catch(() => ({}));
    }
    return out;
  };

  /** What the app says about connection state, which players cannot always see. */
  const connectionState = async () => {
    const out = {};
    for (const who of Object.keys(windows)) {
      out[who] = await windows[who]
        .evaluate(() => {
          const b = [...document.querySelectorAll('.panel, [role="alert"], .banner')].find((p) =>
            /reconnect|connect|offline|disconnect/i.test(p.textContent ?? '')
          );
          return b ? (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) : null;
        })
        .catch(() => null);
    }
    return out;
  };

  return {
    code, names, players: names.map((displayName) => ({ displayName })),
    browser, windows, st, viewport, tag,
    log, problems, observations, say, note, nap,
    buttons, stButtons, clickIn, stClick, playerClick, stMoreClick, playerMoreClick,
    moment, script, tableState, awakePlayers, playerSubmit, nominate, allVote, tallyOn,
    grimoire, nightOrder, privateInfo, connectionState, shot, shotOne,
    logSize() {
      try {
        return statSync(SERVER_LOG).size;
      } catch {
        return 0;
      }
    },
    save() {
      writeFileSync(join(SHOTS, `${tag}-log.txt`), log.join('\n'));
      writeFileSync(
        join(SHOTS, `${tag}-findings.txt`),
        [
          '=== PROBLEMS (things that look wrong) ===',
          problems.length ? problems.join('\n') : '(none)',
          '',
          '=== OBSERVATIONS (judgement calls) ===',
          observations.length ? observations.join('\n') : '(none)',
        ].join('\n')
      );
    },
    async close() {
      await browser.close().catch(() => {});
    },
  };
}
