import { describe, expect, it } from 'vitest';
import { deriveStorytellerLine, type FlowState } from './flow.js';

function flow(over: Partial<FlowState> = {}): FlowState {
  return {
    dayNumber: 0,
    nightNumber: 1,
    now: 1000,
    nominationId: null,
    votingOpen: false,
    executionPending: false,
    stage: 'night-step',
    phase: 'night',
    wakeBlockedUntil: null,
    closingPlayerName: null,
    delaySeconds: 5,
    unmakeableSteps: [],
    announcement: 'Everyone, close your eyes.',
    activePlayerId: null,
    activePlayerName: null,
    needsChoiceFromPlayerId: null,
    needsChoiceFromName: null,
    stepNumber: null,
    totalSteps: 4,
    resolvedCount: 0,
    readyToResolve: false,
    outstanding: [],
    executedPlayerName: null,
    ...over,
  } as FlowState;
}

describe('deriveStorytellerLine', () => {
  it('tells the table to WAKE an auto-resolving waker, not to close their eyes', () => {
    // REGRESSION, and this is the sentence the table actually hears, because
    // StorytellerScript hands `line.say` to the announcer and the host device
    // reads it aloud.
    //
    // The Chef, the Empath, the Undertaker and any learn-in character with nobody
    // to learn about never get a picker, so `needsChoiceFromName` is null while
    // `activePlayerName` is set: somebody IS awake. This used to fall through to
    // "X, close your eyes" and "Everyone is done. Resolve the night.", so a real
    // table was told to wake a player and close the same player's eyes in
    // consecutive sentences — the exact "it said Dev close your eyes then Ada
    // close your eyes" report — and was told the night was finished while a player
    // was still waiting to be dealt with.
    const line = deriveStorytellerLine(
      flow({ activePlayerName: 'Esme', activePlayerId: 'p3', announcement: 'Esme, wake up.', resolvedCount: 1 })
    );
    expect(line.say).toBe('Esme, wake up.');
    // And the Storyteller must be told there is something left to do.
    expect(line.action).not.toMatch(/resolve the night/i);
    expect(line.canAdvance).toBe(true);
  });

  it('agrees with the server: the panel never contradicts flow.announcement', () => {
    // The PA reads the panel, the players read the server. If those two disagree
    // the table is told two different things about who is awake.
    for (const announcement of ['Esme, wake up.', 'Ada, wake up.', 'Everyone, close your eyes.']) {
      const name = announcement.endsWith('wake up.') ? announcement.split(',')[0]! : null;
      const line = deriveStorytellerLine(
        flow({ announcement, activePlayerName: name, closingPlayerName: null, readyToResolve: false })
      );
      expect(line.say).toBe(announcement);
    }
  });

  it('still says "close your eyes" for the person who just acted, while the pause runs', () => {
    const line = deriveStorytellerLine(
      flow({
        closingPlayerName: 'Bram',
        wakeBlockedUntil: 4000,
        now: 1000,
        announcement: 'Bram, close your eyes.',
        activePlayerName: 'Bram',
      })
    );
    expect(line.say).toBe('Bram, close your eyes.');
    expect(line.action).toMatch(/wait 3s/i);
  });

  it('waits for a picker rather than offering to move on', () => {
    const line = deriveStorytellerLine(
      flow({
        needsChoiceFromName: 'Cleo',
        needsChoiceFromPlayerId: 'p2',
        activePlayerName: 'Cleo',
        announcement: 'Cleo, wake up.',
      })
    );
    expect(line.say).toBe('Cleo, wake up.');
    expect(line.canAdvance).toBe(false);
  });

  it('closes the night out only once the night really is ready to resolve', () => {
    const line = deriveStorytellerLine(
      flow({ activePlayerName: 'Ada', announcement: 'Everyone, close your eyes.', readyToResolve: true, resolvedCount: 4 })
    );
    expect(line.say).toBe('Everyone, close your eyes.');
    expect(line.action).toMatch(/resolve the night/i);
  });

  it('closes the night out when the stepper says every step is in, even without the ready flag', () => {
    // The Storyteller's own counter and the server's readiness flag describe the
    // same thing. Trusting only the flag is how the panel tells a table the night
    // is still running when every step is already done.
    const line = deriveStorytellerLine(
      flow({ activePlayerName: 'Bram', resolvedCount: 4, totalSteps: 4, readyToResolve: false })
    );
    expect(line.say).toBe('Everyone, close your eyes.');
    expect(line.action).toMatch(/resolve the night/i);
  });

  it('never names a role in the line the table hears', () => {
    // Naming somebody is public. Naming what they are is a game-ending leak, and
    // this string is read aloud by the host device.
    const line = deriveStorytellerLine(
      flow({ activePlayerName: 'Esme', announcement: 'Esme, wake up.', readyToResolve: false })
    );
    expect(line.say).not.toMatch(/imp|poisoner|empath|chef|washerwoman|librarian|investigator|minion|demon/i);
  });
});
