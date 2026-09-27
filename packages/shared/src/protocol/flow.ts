import type { GamePhase } from './session.js';

/**
 * THE GAME FLOW.
 *
 * The complaint this solves: the app had tabs, a character card and a voting
 * box, and no idea what anybody was supposed to be doing. A player opening their
 * phone could not tell whether they were asleep, awake, expected to act, or done.
 * The Storyteller had a static list of role names and their own memory.
 *
 * So the flow is modelled EXPLICITLY and lives on the server, because the whole
 * table has to agree on where they are — and because a reconnecting player must
 * be able to work out what they were doing without asking.
 *
 * THE LEAK INVARIANT, which is the only thing that matters here
 * -----------------------------------------------------------
 * `FlowState` is broadcast to EVERY socket in the room, and on the host device
 * it is read ALOUD. It may therefore contain:
 *
 *   - display names (the real game shouts "Bram, wake up" across a table),
 *   - numbers (how many steps, how many votes),
 *   - public verbs and stage names.
 *
 * It may NEVER contain a character name, a role, an alignment, an ability
 * result, or the Grimoire. `announcement` is the string that gets spoken, so it
 * is the highest-risk field in the app; `assertSpeakableAnnouncement` enforces
 * the rule and the test suite runs it over a whole generated night.
 *
 * Note what is deliberately NOT here: "Bram, wake up — you're the Poisoner."
 * The wake-up is public; the role is not. Private information never enters this
 * object at all, so there is nothing to leak.
 */

export type FlowStage =
  /** Lobby, before the roles are dealt. */
  | 'setup'
  /** Night is open, nobody has been woken yet. */
  | 'night-briefing'
  /** A specific player is awake and owes a choice. */
  | 'night-step'
  /** The engine has applied the night; the table is being woken. */
  | 'night-resolving'
  /** Dawn: the table is looking at the dead before talk starts. */
  | 'day-reveal'
  /** Free discussion, nominations allowed. */
  | 'day-discussion'
  /** A nomination is open and being voted on. */
  | 'day-voting'
  | 'ended';

export interface FlowState {
  stage: FlowStage;
  phase: GamePhase;
  dayNumber: number;
  nightNumber: number;
  /**
   * The public, speakable line. Display names, numbers and public verbs only —
   * never a role, alignment, ability result or the Grimoire.
   */
  announcement: string;
  /** The waker the Storyteller's cursor is currently on, if any. */
  activePlayerId: string | null;
  activePlayerName: string | null;
  /** The first player who still owes a night choice, if any. Drives "you are awake". */
  needsChoiceFromPlayerId: string | null;
  needsChoiceFromName: string | null;
  /** 1-based position in the night order. */
  stepNumber: number | null;
  totalSteps: number;
  resolvedCount: number;
  /**
   * Every choice that CAN be made has been made, so the engine can resolve. A
   * picking step with no legal target is not outstanding — it is unmakeable, and
   * waiting for it would deadlock the night.
   */
  readyToResolve: boolean;
  /** Steps that cannot be made at all, with the reason. Storyteller-facing. */
  unmakeableSteps: { characterName: string; reason: string }[];
  nominationId: string | null;
  /** The nomination is open and votes are being cast. */
  votingOpen: boolean;
  /** A qualifying nomination awaits the Storyteller's execution confirmation. */
  executionPending: boolean;
  executedPlayerName: string | null;
  /** The server's clock when this was built, so a countdown needs no offset maths. */
  now: number;
  /**
   * Epoch ms before which no new player may be woken, or null when nobody is
   * waiting. The pause between consecutive wakers exists so the table cannot time
   * them — see the rulebook's note on the small wait at dawn.
   */
  wakeBlockedUntil: number | null;
  /** The waker who has just finished and is being told to close their eyes. */
  closingPlayerName: string | null;
  /** The Storyteller's chosen pause between wakers, in seconds. */
  delaySeconds: number;
}

export const EMPTY_FLOW_STATE: FlowState = {
  stage: 'setup',
  phase: 'lobby',
  dayNumber: 0,
  nightNumber: 0,
  announcement: '',
  activePlayerId: null,
  activePlayerName: null,
  needsChoiceFromPlayerId: null,
  needsChoiceFromName: null,
  stepNumber: null,
  totalSteps: 0,
  resolvedCount: 0,
  readyToResolve: false,
  unmakeableSteps: [],
  nominationId: null,
  votingOpen: false,
  executionPending: false,
  executedPlayerName: null,
  now: 0,
  wakeBlockedUntil: null,
  closingPlayerName: null,
  delaySeconds: 0,
};

// ---------------------------------------------------------------------------
// The Storyteller's spoken line and action.
// ---------------------------------------------------------------------------

export interface StorytellerLine {
  /** Client clock, so a countdown can be rendered without trusting a server offset. */
  /** What to say out loud. Safe to speak: public information only. */
  say: string;
  /** What to do on the device, in plain language. */
  action: string;
  /** True when a single control moves the flow forward from here. */
  canAdvance: boolean;
  /** How many steps through the night this is, for progress. */
  progress: string | null;
  /** Client clock, so the countdown above can be rendered. */
  now: number;
}

/**
 * Derives the ONE thing the Storyteller should be doing right now.
 *
 * The real game runs on the Storyteller saying the right sentence at the right
 * moment, and the app had no memory of those sentences. This is that memory,
 * derived rather than stored, so it cannot drift out of sync with the state.
 */
export function deriveStorytellerLine(flow: FlowState): StorytellerLine {
  switch (flow.stage) {
    case 'setup':
      return {
        say: '',
        action: 'Deal the roles when everyone has joined the table.',
        canAdvance: false,
        progress: null,
        now: flow.now,
      };
    case 'night-briefing':
      return {
        say: 'Everyone, close your eyes.',
        action: 'Nobody speaks, and nobody looks at a screen, until the first wake-up.',
        canAdvance: true,
        progress: 'Night briefing',
        now: flow.now,
      };
    case 'night-step': {
      // The pause between wakers. Saying "close your eyes" here is what tells the
      // player who just acted that they are done, and it is the same beat the
      // rulebook describes at dawn.
      if (flow.closingPlayerName) {
        const seconds = Math.max(0, Math.ceil(((flow.wakeBlockedUntil ?? 0) - flow.now) / 1000));
        return {
          say: `${flow.closingPlayerName}, close your eyes.`,
          action:
            seconds > 0
              ? `Wait ${seconds}s before waking anyone, so the table cannot time the order. Skip the wait if you need to.`
              : 'Wait a moment before waking anyone, so the table cannot time the order.',
          canAdvance: true,
          progress:
            flow.totalSteps > 0 ? `${flow.resolvedCount} of ${flow.totalSteps} steps in` : 'Between wakers',
          now: flow.now,
        };
      }
      if (flow.needsChoiceFromName) {
        return {
          say: `${flow.needsChoiceFromName}, wake up.`,
          action: 'Wait for them to submit their choice on their own screen. Nothing else is needed from you.',
          canAdvance: false,
          progress: `${flow.resolvedCount} of ${flow.totalSteps} steps in`,
          now: flow.now,
        };
      }
      // The waker is AWAKE and has nothing to submit: the Chef, the Empath, the
      // Undertaker, and any learn-in character with nobody to learn about. They are
      // not asleep and the night is not over.
      //
      // This branch used to fall through to "X, close your eyes" and "Everyone is
      // done. Resolve the night." for exactly this state, which told the table to
      // wake somebody and close the same person's eyes in consecutive sentences
      // while telling the Storyteller the night was finished. The server's own
      // `announcement` already says "X, wake up." here, and it is this line the PA
      // reads aloud, so the whole table was told the wrong thing.
      // "Done" is either the server's own readiness flag or the stepper saying
      // every step is in. Both mean the same thing, and honouring only one of them
      // is how this line ends up wrong in one direction or the other.
      const allDone = flow.readyToResolve || (flow.totalSteps > 0 && flow.resolvedCount >= flow.totalSteps);
      if (flow.activePlayerName && !allDone) {
        return {
          say: `${flow.activePlayerName}, wake up.`,
          action: 'They have nothing to choose. Tell them what they learn, then move on to the next waker.',
          canAdvance: true,
          progress: `${flow.resolvedCount} of ${flow.totalSteps} steps in`,
          now: flow.now,
        };
      }
      // Genuinely done: every waker has been dealt with and the night can resolve.
      return {
        say: 'Everyone, close your eyes.',
        action: 'Everyone is done. Resolve the night.',
        canAdvance: true,
        progress: `${flow.resolvedCount} of ${flow.totalSteps} steps in`,
        now: flow.now,
      };
    }
    case 'night-resolving':
      return {
        say: 'Everyone, open your eyes.',
        action: 'The night has been applied. Move to the day when the table is ready.',
        canAdvance: true,
        progress: 'Night resolved',
        now: flow.now,
      };
    case 'day-reveal':
      return {
        say: 'Everyone, open your eyes. It is day. Check the Grimoire for the dead.',
        action: 'Give the table a moment to read who died, then start the day.',
        canAdvance: true,
        progress: `Day ${flow.dayNumber}`,
        now: flow.now,
      };
    case 'day-voting':
      return {
        say: 'Voting is open. Hands up if you are in.',
        action: flow.executionPending
          ? 'The vote passed. Confirm the execution.'
          : 'Close the vote when the table has decided.',
        canAdvance: flow.executionPending,
        progress: 'Voting',
        now: flow.now,
      };
    case 'day-discussion':
      return {
        say: 'Anyone can nominate. Otherwise, discuss.',
        action: 'Run the discussion. Open a nomination when someone wants one.',
        canAdvance: false,
        progress: `Day ${flow.dayNumber}`,
        now: flow.now,
      };
    case 'ended':
      return {
        say: 'The game is over.',
        action: 'Announce the result and talk the game out.',
        canAdvance: false,
        progress: null,
        now: flow.now,
      };
    default:
      // A stage this build does not know about must not silently produce no
      // instruction — that is the "directionless" failure mode all over again.
      throw new Error(`deriveStorytellerLine: unknown stage ${JSON.stringify((flow as FlowState).stage)}`);
  }
}

// ---------------------------------------------------------------------------
// The player's own situation.
//
// The instruction a player is shown lives in `moment.ts`, which also decides what
// belongs on their screen. This file keeps the shared inputs.
// ---------------------------------------------------------------------------

export interface PlayerFlowContext {
  playerId: string;
  alive: boolean;
  /** The player has a night prompt open and owes a choice. */
  hasOpenNightPrompt: boolean;
  /** This player's step cannot be made at all (a Librarian with no Outsider in play). */
  stepIsUnmakeable: boolean;
  /** The player already sent their choice for this night. */
  hasSubmittedNightChoice: boolean;
  /** The player is Evil and the Evil chat is theirs to use. */
  isEvil: boolean;
}

/** How urgent a moment is, which is what its colour and icon follow. */
export type PlayerTone = 'sleep' | 'action' | 'wait' | 'talk' | 'over';

// ---------------------------------------------------------------------------
// The leak guard.
// ---------------------------------------------------------------------------

/** Character names that must never appear in a spoken announcement. */
const CHARACTER_NAMES = [
  'Washerwoman',
  'Librarian',
  'Investigator',
  'Chef',
  'Empath',
  'Fortune Teller',
  'Undertaker',
  'Monk',
  'Ravenkeeper',
  'Virgin',
  'Slayer',
  'Soldier',
  'Mayor',
  'Butler',
  'Drunk',
  'Recluse',
  'Saint',
  'Poisoner',
  'Spy',
  'Scarlet Woman',
  'Baron',
  'Imp',
];

const ALIGNMENT_WORDS = ['evil', 'demon', 'minion', 'townsfolk', 'outsider'];
/** Fragments that only appear in a generated ability RESULT, never in an instruction. */
const RESULT_WORDS = ['you learn', 'neighbours are', 'neighbors are', 'pairs of adjacent', 'was poisoned', 'is poisoned'];

/**
 * Throws if `announcement` contains anything a waker or the table must not hear.
 * Called in the test suite over a whole generated night, and available to any
 * future caller that builds a spoken line from dynamic data.
 *
 * Display names are blanked out first. They are arbitrary player input, so
 * someone named "Poison" or "Chef" must not make every announcement look like a
 * leak — and blanking them also means the character-name check below is testing
 * the part of the string the server actually controls.
 */
export function assertSpeakableAnnouncement(announcement: string, displayNames: string[] = []): void {
  let probe = announcement;
  for (const name of displayNames) {
    if (name.length === 0) continue;
    probe = probe.split(name).join(' ');
  }
  const lower = probe.toLowerCase();

  for (const name of CHARACTER_NAMES) {
    if (lower.includes(name.toLowerCase())) {
      throw new Error(`Announcement leaks a character name: "${announcement}" (${name})`);
    }
  }
  for (const word of ALIGNMENT_WORDS) {
    if (lower.includes(word)) {
      throw new Error(`Announcement leaks an alignment or type: "${announcement}" (${word})`);
    }
  }
  for (const word of RESULT_WORDS) {
    if (lower.includes(word)) {
      throw new Error(`Announcement leaks an ability result: "${announcement}" (${word})`);
    }
  }

  // After display names are removed, a capitalised word that is NOT the first
  // word of a sentence is a noun the server invented, which is exactly the kind
  // of thing that leaks ("Bram, wake up — the Imp needs to know"). Sentence-initial
  // words are ordinary English ("Everyone, close your eyes.") and are allowed.
  const properNouns = probe.match(/\b[A-Z][a-z]+\b/g) ?? [];
  for (const word of properNouns) {
    const atSentenceStart = new RegExp(`(^|[.!?]\\s*)${word}\\b`).test(probe);
    if (atSentenceStart) continue;
    if (word === 'Day' || word === 'Night' || word === 'Grimoire') continue;
    throw new Error(`Announcement contains an unexpected proper noun: "${announcement}" (${word})`);
  }
}
