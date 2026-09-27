import { describe, expect, it } from 'vitest';
import { derivePlayerMoment } from './moment.js';
import type { FlowState } from './flow.js';
import type { PlayerFlowContext } from './flow.js';

const ADA = 'p-ada';

function flow(over: Partial<FlowState> = {}): FlowState {
  return {
    dayNumber: 0,
    nightNumber: 1,
    now: 0,
    nominationId: null,
    votingOpen: false,
    executionPending: false,
    stage: 'night-step',
    phase: 'night',
    wakeBlockedUntil: null,
    closingPlayerName: null,
    delaySeconds: 5,
    unmakeableSteps: [],
    announcement: '',
    activePlayerId: null,
    activePlayerName: null,
    needsChoiceFromPlayerId: null,
    needsChoiceFromName: null,
    stepNumber: null,
    totalSteps: 4,
    resolvedCount: 0,
    readyToResolve: false,
    executedPlayerName: null,
    ...over,
  } as FlowState;
}

function ctx(over: Partial<PlayerFlowContext> = {}): PlayerFlowContext {
  return {
    playerId: ADA,
    alive: true,
    hasOpenNightPrompt: false,
    hasSubmittedNightChoice: false,
    stepIsUnmakeable: false,
    isEvil: false,
    ...over,
  };
}

describe('derivePlayerMoment', () => {
  describe('nothing to do yet', () => {
    it('tells a player to wait while the roles are dealt', () => {
      const m = derivePlayerMoment(flow({ stage: 'setup' }), ctx());
      expect(m.kind).toBe('waiting-for-deal');
      expect(m.action).toBe('none');
      expect(m.showNightPrompt).toBe(false);
    });

    it('tells a player to keep their eyes closed during the briefing', () => {
      const m = derivePlayerMoment(flow({ stage: 'night-briefing' }), ctx({ hasOpenNightPrompt: true }));
      // Even a stale prompt from an earlier night must not present a choice now.
      expect(m.kind).toBe('asleep');
      expect(m.showNightPrompt).toBe(false);
    });

    it('tells a player to sleep at night when it is not their turn', () => {
      const m = derivePlayerMoment(
        flow({ activePlayerId: 'someone-else', needsChoiceFromPlayerId: 'someone-else', needsChoiceFromName: 'Bram' }),
        ctx()
      );
      expect(m.kind).toBe('asleep');
      expect(m.title).toMatch(/close your eyes/i);
    });
  });

  describe('being woken at night', () => {
    it('puts the private prompt on screen and asks for the choice', () => {
      const m = derivePlayerMoment(flow({ activePlayerId: ADA }), ctx({ hasOpenNightPrompt: true }));
      expect(m.kind).toBe('awake-choose');
      expect(m.action).toBe('submit-night-choice');
      expect(m.showNightPrompt).toBe(true);
    });

    it('tells an auto-resolving character they are awake, even with no prompt', () => {
      // The Chef, the Empath, the Undertaker. They never get a picker, so before
      // this they were told to close their eyes while the Storyteller was standing
      // there waiting to tell them something.
      const m = derivePlayerMoment(flow({ activePlayerId: ADA }), ctx());
      expect(m.kind).toBe('awake-listen');
      expect(m.showNightPrompt).toBe(false);
      expect(m.detail).toMatch(/listen to the storyteller/i);
    });

    it('tells an unmakeable character they are awake and have nobody to choose', () => {
      // A Librarian with no Outsiders in play. The real game still wakes them.
      const m = derivePlayerMoment(
        flow({ activePlayerId: ADA }),
        ctx({ stepIsUnmakeable: true })
      );
      expect(m.kind).toBe('awake-listen');
      expect(m.detail).toMatch(/nobody to choose/i);
    });

    it('tells a player who has sent their choice that they are done', () => {
      const m = derivePlayerMoment(flow({ activePlayerId: ADA }), ctx({ hasSubmittedNightChoice: true }));
      expect(m.kind).toBe('awake-done');
      expect(m.action).toBe('none');
      // The prompt must not linger after the choice is in.
      expect(m.showNightPrompt).toBe(false);
    });

    it('never tells two players they are awake off a cursor alone', () => {
      // `activePlayerId` is the wake cursor. A player with no prompt and no
      // submission who is NOT the cursor must be asleep even if the server's
      // needsChoiceFrom* points at somebody else.
      const m = derivePlayerMoment(
        flow({ activePlayerId: 'other', needsChoiceFromPlayerId: 'other', needsChoiceFromName: 'Bram' }),
        ctx({ hasSubmittedNightChoice: true, playerId: ADA })
      );
      expect(['awake-done', 'asleep']).toContain(m.kind);
      expect(m.kind).not.toBe('awake-choose');
    });

    it('tells a dead player they may still be woken', () => {
      const m = derivePlayerMoment(flow({ activePlayerId: 'other' }), ctx({ alive: false }));
      expect(m.kind).toBe('asleep');
      expect(m.detail).toMatch(/wake you if something happens/i);
    });

    it('hides the prompt once the night resolves', () => {
      const m = derivePlayerMoment(
        flow({ stage: 'night-resolving' }),
        ctx({ hasSubmittedNightChoice: true })
      );
      expect(m.kind).toBe('night-over');
      expect(m.showNightPrompt).toBe(false);
    });
  });

  describe('the day', () => {
    it('asks the table to read the dead', () => {
      const m = derivePlayerMoment(flow({ stage: 'day-reveal', phase: 'day', dayNumber: 1 }), ctx());
      expect(m.kind).toBe('day-reveal');
      expect(m.phaseLabel).toBe('Day 1');
    });

    it('offers the nomination in view during discussion', () => {
      const m = derivePlayerMoment(flow({ stage: 'day-discussion', phase: 'day', dayNumber: 1 }), ctx());
      expect(m.kind).toBe('discuss');
      expect(m.action).toBe('nominate');
    });

    it('asks for a vote while the vote is open', () => {
      const m = derivePlayerMoment(flow({ stage: 'day-voting', phase: 'day', dayNumber: 1 }), ctx());
      expect(m.kind).toBe('vote');
      expect(m.action).toBe('vote');
    });

    it('reminds a dead player that they have one vote left', () => {
      // The rule that surprises new players most, so it is said outright.
      const m = derivePlayerMoment(flow({ stage: 'day-voting', phase: 'day' }), ctx({ alive: false }));
      expect(m.kind).toBe('dead');
      expect(m.mayStillVote).toBe(true);
      expect(m.action).toBe('vote');
      expect(m.title).toMatch(/one vote left/i);
    });

    it('does not offer a dead player a nomination during discussion', () => {
      const m = derivePlayerMoment(flow({ stage: 'day-discussion', phase: 'day' }), ctx({ alive: false }));
      expect(m.kind).toBe('dead');
      expect(m.action).toBe('none');
    });
  });

  describe('invariants that must hold for every state', () => {
    const stages: FlowState['stage'][] = [
      'setup',
      'night-briefing',
      'night-step',
      'night-resolving',
      'day-reveal',
      'day-discussion',
      'day-voting',
      'ended',
    ];
    const variations = [ctx(), ctx({ hasOpenNightPrompt: true }), ctx({ hasSubmittedNightChoice: true }),
      ctx({ alive: false }), ctx({ stepIsUnmakeable: true }), ctx({ alive: false, hasOpenNightPrompt: true })];

    it('never tells a player where to click', () => {
      // Naming a tab is what made the prompt-behind-a-tab bug possible: the app
      // said "use the Town Square tab" and the control was somewhere else entirely.
      for (const stage of stages) {
        for (const c of variations) {
          for (const active of [null, ADA, 'other']) {
            const m = derivePlayerMoment(flow({ stage, activePlayerId: active, phase: stage.startsWith('day') ? 'day' : 'night' }), c);
            const text = `${m.title} ${m.detail}`;
            expect(text, `${stage}/${c.alive}/${active}`).not.toMatch(/\btab\b|\btabs\b|panel|button|click on|go to the/i);
          }
        }
      }
    });

    it('never shows the night prompt outside the night', () => {
      for (const stage of stages) {
        for (const c of variations) {
          const m = derivePlayerMoment(flow({ stage, phase: stage.startsWith('day') ? 'day' : 'night' }), c);
          if (m.showNightPrompt) {
            // `night-resolving` is allowed on purpose: a Ravenkeeper woken by the
            // night kill is prompted AFTER the night resolves, and hiding that
            // prompt would strand them with no way to act.
            expect(['night-step', 'night-resolving'], `${stage} must not show a night prompt`).toContain(stage);
            expect(m.action).toBe('submit-night-choice');
          }
        }
      }
    });

    it('always has something to say', () => {
      for (const stage of stages) {
        for (const c of variations) {
          const m = derivePlayerMoment(flow({ stage, phase: stage.startsWith('day') ? 'day' : 'night' }), c);
          expect(m.title.length, `${stage}`).toBeGreaterThan(0);
          expect(m.detail.length, `${stage}`).toBeGreaterThan(0);
        }
      }
    });

    it('never asks a dead player to choose at night', () => {
      for (const stage of stages) {
        const m = derivePlayerMoment(flow({ stage, phase: stage.startsWith('day') ? 'day' : 'night' }), ctx({ alive: false, hasOpenNightPrompt: true }));
        if (m.action === 'submit-night-choice') {
          expect(stage).toBe('night-step');
        }
        // A dead player may still vote, and only vote.
        if (!m.mayStillVote) expect(m.action).not.toBe('nominate');
      }
    });
  });
});
