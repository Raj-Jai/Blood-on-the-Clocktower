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
  /** Every choice is in, so the engine can resolve. */
  readyToResolve: boolean;
  nominationId: string | null;
  /** The nomination is open and votes are being cast. */
  votingOpen: boolean;
  /** A qualifying nomination awaits the Storyteller's execution confirmation. */
  executionPending: boolean;
  executedPlayerName: string | null;
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
  nominationId: null,
  votingOpen: false,
  executionPending: false,
  executedPlayerName: null,
};

// ---------------------------------------------------------------------------
// The Storyteller's spoken line and action.
// ---------------------------------------------------------------------------

export interface StorytellerLine {
  /** What to say out loud. Safe to speak: public information only. */
  say: string;
  /** What to do on the device, in plain language. */
  action: string;
  /** True when a single control moves the flow forward from here. */
  canAdvance: boolean;
  /** How many steps through the night this is, for progress. */
  progress: string | null;
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
      };
    case 'night-briefing':
      return {
        say: 'Everyone, close your eyes.',
        action: 'Nobody speaks, and nobody looks at a screen, until the first wake-up.',
        canAdvance: true,
        progress: 'Night briefing',
      };
    case 'night-step': {
      if (flow.needsChoiceFromName) {
        return {
          say: `${flow.needsChoiceFromName}, wake up.`,
          action: 'Wait for them to submit their choice on their own screen. Nothing else is needed from you.',
          canAdvance: false,
          progress: `${flow.resolvedCount} of ${flow.totalSteps} steps in`,
        };
      }
      return {
        say: flow.activePlayerName ? `${flow.activePlayerName}, close your eyes.` : 'Keep your eyes closed.',
        action: 'Everyone is done. Resolve the night.',
        canAdvance: true,
        progress: `${flow.resolvedCount} of ${flow.totalSteps} steps in`,
      };
    }
    case 'night-resolving':
      return {
        say: 'Everyone, open your eyes.',
        action: 'The night has been applied. Move to the day when the table is ready.',
        canAdvance: true,
        progress: 'Night resolved',
      };
    case 'day-reveal':
      return {
        say: 'Everyone, open your eyes. It is day. Check the Grimoire for the dead.',
        action: 'Give the table a moment to read who died, then start the day.',
        canAdvance: true,
        progress: `Day ${flow.dayNumber}`,
      };
    case 'day-voting':
      return {
        say: 'Voting is open. Hands up if you are in.',
        action: flow.executionPending
          ? 'The vote passed. Confirm the execution.'
          : 'Close the vote when the table has decided.',
        canAdvance: flow.executionPending,
        progress: 'Voting',
      };
    case 'day-discussion':
      return {
        say: 'Anyone can nominate. Otherwise, discuss.',
        action: 'Run the discussion. Open a nomination when someone wants one.',
        canAdvance: false,
        progress: `Day ${flow.dayNumber}`,
      };
    case 'ended':
      return {
        say: 'The game is over.',
        action: 'Announce the result and talk the game out.',
        canAdvance: false,
        progress: null,
      };
    default:
      // A stage this build does not know about must not silently produce no
      // instruction — that is the "directionless" failure mode all over again.
      throw new Error(`deriveStorytellerLine: unknown stage ${JSON.stringify((flow as FlowState).stage)}`);
  }
}

// ---------------------------------------------------------------------------
// The player's own instruction.
// ---------------------------------------------------------------------------

export interface PlayerFlowContext {
  playerId: string;
  alive: boolean;
  /** The player has a night prompt open and owes a choice. */
  hasOpenNightPrompt: boolean;
  /** The player already sent their choice for this night. */
  hasSubmittedNightChoice: boolean;
  /** The player is Evil and the Evil chat is theirs to use. */
  isEvil: boolean;
}

export type PlayerAction = 'submit-night-choice' | 'nominate' | 'vote' | 'wait' | 'discuss' | 'none';
export type PlayerTone = 'sleep' | 'action' | 'wait' | 'talk' | 'over';

export interface PlayerInstruction {
  /** The single most important line, in the imperative. */
  title: string;
  /** Supporting detail. */
  detail: string;
  action: PlayerAction;
  tone: PlayerTone;
}

/**
 * What THIS player should be doing right now.
 *
 * Derived on the client from the public `FlowState` plus the player's own id, so
 * there is no second channel to get out of sync and nothing private is needed to
 * compute it. The one place it reads the player themselves is the night prompt,
 * which is already theirs alone.
 */
export function derivePlayerInstruction(flow: FlowState, ctx: PlayerFlowContext): PlayerInstruction {
  if (flow.stage === 'ended') {
    return { title: 'The game is over.', detail: 'Talk the game out with the table.', action: 'none', tone: 'over' };
  }

  if (flow.stage === 'setup') {
    return {
      title: 'Wait for the Storyteller to deal the roles.',
      detail: 'Nothing to do until the game starts.',
      action: 'wait',
      tone: 'wait',
    };
  }

  // The briefing is before anyone wakes. Nobody may be told they are awake here,
  // even if a prompt is somehow still on their screen from an earlier night.
  if (flow.stage === 'night-briefing') {
    return {
      title: 'Close your eyes.',
      detail: 'The Storyteller will wake you by name when it is your turn.',
      action: 'wait',
      tone: 'sleep',
    };
  }

  if (flow.stage === 'night-step' || flow.stage === 'night-resolving') {
    // "You are awake" keys off TWO signals, and deliberately not off
    // `activePlayerId`. That field is the Storyteller's cursor — a presentation
    // detail for their stepper — and it can point at somebody who has already
    // acted while somebody else still owes a choice. Trusting it tells two
    // players they are awake at once, which is worse than telling nobody.
    //
    // The two signals that are actually true:
    //   - the server sent THEM a private night prompt, and
    //   - the server says they are the one who owes a choice.
    const owesAChoice = flow.needsChoiceFromPlayerId === ctx.playerId;
    const hasBeenPrompted = ctx.hasOpenNightPrompt || ctx.hasSubmittedNightChoice;
    const isTheWaker = (owesAChoice || hasBeenPrompted) && ctx.alive;

    if (isTheWaker && ctx.hasOpenNightPrompt) {
      return {
        title: "You're awake. Do your thing.",
        detail: 'Your prompt is below. Then close your eyes and wait.',
        action: 'submit-night-choice',
        tone: 'action',
      };
    }
    if (isTheWaker && ctx.hasSubmittedNightChoice) {
      return {
        title: 'Done. Close your eyes and wait.',
        detail: 'Your choice is in for tonight.',
        action: 'wait',
        tone: 'wait',
      };
    }
    if (owesAChoice && !ctx.alive) {
      return {
        title: 'Close your eyes and wait.',
        detail: 'The Storyteller will wake you if something happens to you.',
        action: 'wait',
        tone: 'wait',
      };
    }
    if (flow.stage === 'night-resolving') {
      return { title: 'Open your eyes.', detail: 'The night is over.', action: 'wait', tone: 'wait' };
    }
    const waitingOn = flow.needsChoiceFromName ?? flow.activePlayerName;
    return {
      title: 'Close your eyes.',
      detail: waitingOn ? `Waiting for ${waitingOn}.` : 'Nothing to do right now.',
      action: 'wait',
      tone: 'sleep',
    };
  }

  if (flow.stage === 'day-reveal') {
    return {
      title: 'Open your eyes. It is day.',
      detail: 'Check the Grimoire and the seating circle to see who died last night.',
      action: 'none',
      tone: 'talk',
    };
  }

  if (flow.stage === 'day-voting') {
    if (!ctx.alive) {
      return {
        title: 'You are dead, but you have one vote left.',
        detail: 'Use it on the Town Square tab if you want to.',
        action: 'vote',
        tone: 'action',
      };
    }
    return {
      title: 'Vote: hands up if you are in.',
      detail: 'A simple majority of the living players executes.',
      action: 'vote',
      tone: 'action',
    };
  }

  if (flow.stage === 'day-discussion') {
    return {
      title: ctx.alive ? 'Discuss. Nominate if you have a reason.' : 'Listen. You are dead.',
      detail: ctx.isEvil
        ? 'Your private chat is on the Evil Chat tab — nobody else can see it.'
        : 'Open a nomination from the Town Square tab.',
      action: ctx.alive ? 'discuss' : 'none',
      tone: 'talk',
    };
  }

  return { title: 'Wait for the Storyteller.', detail: '', action: 'wait', tone: 'wait' };
}

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
