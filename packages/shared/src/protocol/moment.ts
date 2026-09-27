import type { FlowState, PlayerFlowContext, PlayerTone } from './flow.js';

/**
 * WHAT THIS PLAYER SHOULD DO RIGHT NOW.
 *
 * The app has to work for somebody who has never read the rulebook and will not
 * read these instructions either. So a player's screen answers exactly one
 * question — "what do I do now?" — and the control for that answer is rendered
 * directly underneath it. There is no hunt, and nothing to navigate to.
 *
 * Three rules shaped this, each of them learned from a bug:
 *
 * 1. **Never name a place.** The previous instructions said "open a nomination
 *    from the Town Square tab" and "use it on the Town Square tab". That coupled
 *    the logic to the navigation, and when the prompt ended up on a tab the
 *    player was not looking at, the app told them to do a thing they could not
 *    see. A moment says WHAT, never WHERE.
 *
 * 2. **Every player is told when they are awake, even with nothing to submit.**
 *    A picker is proven awake by their own private prompt. An auto-resolving
 *    character (the Chef, the Empath) and an unmakeable one (a Librarian with no
 *    Outsiders in play) never get a prompt, so before this they sat on "close
 *    your eyes" while the Storyteller was telling them their information. In the
 *    real game you ARE woken for those; being told to sleep instead is a rules
 *    bug, not a wording one.
 *
 * 3. **One action, in view, no navigation.** `action` names the single control to
 *    surface. Everything else lives behind one "More" affordance.
 */
export type PlayerMomentKind =
  | 'waiting-for-deal'
  | 'asleep'
  | 'awake-choose'
  | 'awake-listen'
  | 'awake-done'
  | 'night-over'
  | 'day-reveal'
  | 'discuss'
  | 'nominate'
  | 'vote'
  | 'voted'
  | 'dead'
  | 'ended';

export type PlayerMomentAction = 'none' | 'submit-night-choice' | 'nominate' | 'vote' | 'discuss';

export interface PlayerMoment {
  kind: PlayerMomentKind;
  /** The one line that matters, in the imperative. */
  title: string;
  /** One supporting sentence. Never instructions about where to click. */
  detail: string;
  tone: PlayerTone;
  /** The single control to put in front of the player, if any. */
  action: PlayerMomentAction;
  /**
   * The private night prompt belongs on screen for exactly one moment. When this is
   * false the prompt is hidden, so a stale prompt from earlier in the night can
   * never sit on a screen telling somebody they are awake when they are not.
   */
  showNightPrompt: boolean;
  /** "Night 2" / "Day 1", for the quiet header line. */
  phaseLabel: string;
  /** True when the player is dead but may still vote. */
  mayStillVote: boolean;
}

function phaseLabelOf(flow: FlowState): string {
  if (flow.stage === 'ended') return 'Game over';
  return flow.phase === 'day' ? `Day ${flow.dayNumber}` : `Night ${flow.nightNumber}`;
}

export function derivePlayerMoment(flow: FlowState, ctx: PlayerFlowContext): PlayerMoment {
  const phaseLabel = phaseLabelOf(flow);
  const base = { phaseLabel, showNightPrompt: false, mayStillVote: false };

  if (flow.stage === 'ended') {
    return {
      ...base,
      kind: 'ended',
      title: 'The game is over.',
      detail: 'Talk the game out with the table.',
      tone: 'over',
      action: 'none',
    };
  }

  if (flow.stage === 'setup') {
    return {
      ...base,
      kind: 'waiting-for-deal',
      title: 'Waiting for the game to start.',
      detail: 'Nothing to do until the Storyteller deals the roles.',
      tone: 'wait',
      action: 'none',
    };
  }

  // ---------------------------------------------------------------- night ---

  if (flow.stage === 'night-briefing') {
    return {
      ...base,
      kind: 'asleep',
      title: 'Keep your eyes closed.',
      detail: 'The Storyteller will wake you by name when it is your turn.',
      tone: 'sleep',
      action: 'none',
    };
  }

  if (flow.stage === 'night-step' || flow.stage === 'night-resolving') {
    // Whether it is still this player's turn. The server clears the waker's prompt
    // only at dawn, so after submitting, the prompt is still on screen and still
    // says "Choice sent" with every button disabled. Without this check a player who
    // had already sent their choice was told "You're awake. Do the thing below" —
    // an instruction to use a control that can no longer be used.
    const owesAChoice = flow.needsChoiceFromPlayerId === ctx.playerId;

    // A picker is proven awake by their own private prompt AND by the server still
    // saying the choice is owed. The prompt alone is not enough, and neither is the
    // cursor: `activePlayerId` can point at somebody already done, which is how two
    // players used to be told they were awake at once.
    if (ctx.alive && ctx.hasOpenNightPrompt && owesAChoice) {
      return {
        ...base,
        kind: 'awake-choose',
        title: "You're awake.",
        detail: 'Do the thing below, send it, then close your eyes.',
        tone: 'action',
        action: 'submit-night-choice',
        showNightPrompt: true,
      };
    }

    // The night is over and there is nothing left for this player to do.
    if (flow.stage === 'night-resolving' && !ctx.hasOpenNightPrompt) {
      return {
        ...base,
        kind: 'night-over',
        title: 'The night is over.',
        detail: 'Open your eyes when the Storyteller says so.',
        tone: 'wait',
        action: 'none',
      };
    }

    // Already sent, and the server has moved on. The prompt is still on screen but
    // every control in it is disabled, so the honest thing is to say the turn is
    // over rather than leave a dead picker under an instruction to use it.
    if (ctx.alive && (ctx.hasSubmittedNightChoice || (ctx.hasOpenNightPrompt && !owesAChoice))) {
      return {
        ...base,
        kind: 'awake-done',
        title: 'Done. Close your eyes.',
        detail: 'Your choice is in for tonight.',
        tone: 'wait',
        action: 'none',
      };
    }

    // Awake with nothing to submit. The walk is on this player's step, which the
    // server tracks as the wake cursor — not the stepper, and not a guess.
    if (ctx.alive && flow.activePlayerId === ctx.playerId) {
      return {
        ...base,
        kind: 'awake-listen',
        title: "You're awake.",
        detail: ctx.stepIsUnmakeable
          ? 'You have nobody to choose tonight, so just listen to the Storyteller.'
          : 'You have nothing to choose tonight, so just listen to the Storyteller.',
        tone: 'action',
        action: 'none',
      };
    }

    if (!ctx.alive) {
      return {
        ...base,
        kind: 'asleep',
        title: 'Close your eyes.',
        detail: 'The Storyteller will wake you if something happens to you.',
        tone: 'sleep',
        action: 'none',
      };
    }

    return {
      ...base,
      kind: 'asleep',
      title: 'Close your eyes.',
      detail: 'You will be woken by name when it is your turn.',
      tone: 'sleep',
      action: 'none',
    };
  }

  // ------------------------------------------------------------------ day ---

  if (flow.stage === 'day-reveal') {
    return {
      ...base,
      kind: 'day-reveal',
      title: 'Open your eyes. It is day.',
      detail: 'Check the Grimoire and the seating to see who died last night.',
      tone: 'talk',
      action: 'none',
    };
  }

  if (flow.stage === 'day-voting') {
    // A dead player keeps exactly one vote, and the app must not pretend
    // otherwise: this is the single most surprising rule in the game for a new
    // player, so it is stated rather than left to be discovered.
    if (!ctx.alive) {
      return {
        ...base,
        kind: 'dead',
        title: 'You are dead — but you have one vote left.',
        detail: 'Use it below if you want to. Nothing else is required of you.',
        tone: 'action',
        action: 'vote',
        mayStillVote: true,
      };
    }
    return {
      ...base,
      kind: 'vote',
      title: 'Vote: hands up if you are in.',
      detail: 'A simple majority of the living players executes. You can change your vote until the Storyteller closes it.',
      tone: 'action',
      action: 'vote',
    };
  }

  if (flow.stage === 'day-discussion') {
    if (!ctx.alive) {
      return {
        ...base,
        kind: 'dead',
        title: 'You are dead. Listen.',
        detail: 'You cannot act today, but you can still ask the Storyteller a question.',
        tone: 'talk',
        action: 'none',
      };
    }
    return {
      ...base,
      kind: 'discuss',
      title: 'Talk it over. Nominate if you have a reason.',
      detail: 'Nominating is public and cannot be undone, so only do it when you mean it.',
      tone: 'talk',
      action: 'nominate',
    };
  }

  // Unknown stage. Saying so beats inventing an instruction: a stage this build
  // does not understand must not tell a player to close their eyes.
  return {
    ...base,
    kind: 'asleep',
    title: 'Wait for the Storyteller.',
    detail: 'Nothing is being asked of you right now.',
    tone: 'wait',
    action: 'none',
  };
}
