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
  /** The information this player learned overnight. Shown on its own, briefly. */
  | 'night-result'
  | 'night-over'
  | 'day-reveal'
  | 'discuss'
  | 'nominate'
  | 'vote'
  | 'voted'
  /** This player's nomination passed. They are about to be executed. */
  | 'on-the-block'
  /** Somebody else's nomination passed. */
  | 'vote-passed'
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

    /*
     * WHAT YOU LEARNED, and this is the information the whole game runs on.
     *
     * The server resolves the night and sends every learn-in character their result.
     * Until now the client simply never showed it: the only component that renders a
     * result is gated on `showNightPrompt`, which is true only while a player still owes
     * a CHOICE, and by resolve time nobody owes one. The result arrives into a state
     * that deliberately hides it.
     *
     * Priority matters here, and it is the order of the three beats a real table has:
     *   1. you are awake and owe a choice   -> the choice wins
     *   2. you have been told what you learn -> the information wins
     *   3. you are done, close your eyes    -> the quiet fallback
     * So this sits below `awake-choose` and above `awake-done`, and a dead player is
     * excluded because a ghost is told nothing overnight.
     */
    if (ctx.alive && ctx.hasNightResult) {
      return {
        ...base,
        kind: 'night-result',
        title: 'Here is what you learned.',
        detail: 'Read it, then close your eyes. The table will open them at dawn.',
        tone: 'action',
        action: 'none',
        // The panel below renders the RESULT, with no picker: `NightPromptPanel`
        // already handles a result arriving without a prompt, which is exactly the
        // Chef's and the Empath's case, since they are never given one.
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
    // The table reads the Grimoire together, and a player reading their own overnight
    // information at the same moment is exactly the real game. It stays in the moment
    // card for this beat and then yields: once discussion starts, "what am I doing
    // now" is the more urgent question. It does not go away — it is still readable in
    // the More sheet for the rest of the day.
    if (ctx.alive && ctx.hasNightResult) {
      return {
        ...base,
        kind: 'night-result',
        title: 'Here is what you learned.',
        detail: 'The table is reading the Grimoire now. Keep this somewhere safe.',
        tone: 'action',
        action: 'none',
        showNightPrompt: true,
      };
    }
    return {
      ...base,
      kind: 'day-reveal',
      title: 'Open your eyes. It is day.',
      detail: 'Check the Grimoire and the seating to see who died last night.',
      tone: 'talk',
      action: 'none',
    };
  }

  if (flow.stage === 'day-execution-pending') {
    /*
     * THE MOMENT THE WHOLE DAY IS ABOUT, and it used to say nothing at all.
     *
     * Once a vote passed, the flow left `day-voting` entirely, so every player's moment
     * went back to "Talk it over. Nominate if you have a reason." The nominee — who was
     * just voted for, by name, in front of everyone — was told nothing had happened, and
     * was handed a live Nominate button. The server would have accepted that nomination,
     * which silently destroyed the pending execution.
     *
     * Two moments, because the table needs different things: the person on the block
     * needs to know they are about to die, and everyone else needs to know the vote
     * passed and why nobody may nominate. Neither has a control — there is nothing to do
     * about being executed, and the day's remaining business is the Storyteller's.
     */
    if (flow.executedPlayerName && flow.executedPlayerName === ctx.displayName) {
      return {
        ...base,
        kind: 'on-the-block',
        title: 'You have been nominated, and the vote passed.',
        detail: 'You are about to be executed. Nothing on this screen changes that — remember who voted.',
        tone: 'action',
        action: 'none',
      };
    }
    return {
      ...base,
      kind: 'vote-passed',
      title: `${flow.executedPlayerName ?? 'The nominated player'} is about to be executed.`,
      detail: 'The vote passed. Nobody may nominate until the Storyteller confirms it.',
      tone: 'talk',
      action: 'none',
    };
  }

  if (flow.stage === 'day-voting') {
    // A dead player keeps exactly one vote, for the REST OF THE GAME, and the app must
    // not pretend otherwise: this is the single most surprising rule in the game for a
    // new player, so it is stated rather than left to be discovered.
    //
    // Once it is spent, the moment says so and stops offering an action. It used to say
    // "you have one vote left" forever, and hand over a button that could only ever come
    // back as an error — a player who believed the app about its own most surprising
    // rule would learn to distrust everything else it told them.
    if (!ctx.alive) {
      if (!ctx.hasVoteToken) {
        return {
          ...base,
          kind: 'dead',
          title: 'You are dead, and your vote is spent.',
          detail: 'You get one vote for the whole game, not one a day. Nothing else is required of you.',
          tone: 'wait',
          action: 'none',
          mayStillVote: false,
        };
      }
      return {
        ...base,
        kind: 'dead',
        title: 'You are dead — you have your one vote for the whole game.',
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
      // The rule is "the number of votes EQUALS OR EXCEEDS half the number of alive
      // players". This said "A simple majority of the living players executes", which is
      // a different and stricter rule: it disagrees on every even table, where half or
      // more is N/2 and a majority is N/2+1. A player told they need a majority sits on
      // their hand at 4 of 6 and watches the vote carry anyway. The number itself is
      // public, so it is stated rather than described.
      detail:
        flow.executionThreshold > 0
          ? `${flow.executionThreshold} of the living players is enough to execute. You can change your vote until the Storyteller closes it.`
          : 'Half of the living players, or more, executes. You can change your vote until the Storyteller closes it.',
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
