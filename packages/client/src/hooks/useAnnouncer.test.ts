import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnouncer } from './useAnnouncer.js';

class FakeUtterance {
  text: string;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function installFakeSynthesis() {
  const spoken: string[] = [];
  let current: FakeUtterance | null = null;
  const fake = {
    speak: vi.fn((u: FakeUtterance) => {
      spoken.push(u.text);
      current = u;
    }),
    cancel: vi.fn(),
    /** Simulates the current utterance finishing. */
    endCurrent: () => {
      const u = current;
      current = null;
      u?.onend?.();
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true, writable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtterance,
    configurable: true,
    writable: true,
  });
  return { spoken, fake };
}

function removeFakeSynthesis(): void {
  Reflect.deleteProperty(window, 'speechSynthesis');
  Reflect.deleteProperty(window, 'SpeechSynthesisUtterance');
}

beforeEach(() => {
  window.localStorage.clear();
  installFakeSynthesis();
});

afterEach(() => {
  removeFakeSynthesis();
  vi.restoreAllMocks();
});

describe('useAnnouncer', () => {
  it('is ON by default, because this channel only ever speaks PUBLIC flow lines', () => {
    // This is the deliberate asymmetry with useSpeech: flow instructions are the
    // sentences a real Storyteller shouts across a table, so saying them aloud
    // discloses nothing. Private information is a different hook and is off.
    const { result } = renderHook(() => useAnnouncer());
    expect(result.current.enabled).toBe(true);
    expect(result.current.supported).toBe(true);
  });

  it('speaks a flow line and remembers what the table heard', () => {
    const { fake, spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Bram, wake up.'));
    expect(spoken).toEqual(['Bram, wake up.']);
    expect(result.current.lastSpoken).toBe('Bram, wake up.');
    expect(fake.speak).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the same line when the state re-renders', () => {
    // A re-render or a reconnect re-delivers the flow state; without this the
    // host would shout "wake up" at the table every second.
    const { spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Everyone, close your eyes.'));
    act(() => result.current.announce('Everyone, close your eyes.'));
    act(() => result.current.announce('Everyone, close your eyes.'));
    expect(spoken).toEqual(['Everyone, close your eyes.']);
  });

  it('repeats a line on demand, which is the "say it again" button', () => {
    const { spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Bram, wake up.'));
    act(() => result.current.repeat('Bram, wake up.'));
    expect(spoken).toEqual(['Bram, wake up.', 'Bram, wake up.']);
  });

  it('finishes one line before starting the next, rather than cutting it off', () => {
    // The previous behaviour here was synth.cancel() before every line, which is
    // what made the table hear "Dev, close your eyes" and then "Ada, close your
    // eyes" with no wake-up between them.
    const { spoken, fake } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Bram, wake up.'));
    act(() => result.current.announce('Everyone, open your eyes.'));
    expect(fake.cancel).not.toHaveBeenCalled();
    act(() => {
      fake.endCurrent?.();
    });
    expect(spoken).toEqual(['Bram, wake up.', 'Everyone, open your eyes.']);
  });

  it('silences itself and cancels anything in flight when turned off', () => {
    const { fake, spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Bram, wake up.'));
    act(() => result.current.setEnabled(false));
    expect(fake.cancel).toHaveBeenCalled();
    act(() => result.current.announce('Everyone, open your eyes.'));
    expect(spoken).toEqual(['Bram, wake up.']);
  });

  it('ignores empty lines', () => {
    const { fake } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('   '));
    act(() => result.current.announce(''));
    expect(fake.speak).not.toHaveBeenCalled();
  });

  it('NEVER truncates a line: a wake-up is finished before the next one starts', () => {
    // REGRESSION, reported from a live table: "it said Dev close your eyes, then
    // Ada close your eyes". The wake-up was never heard. This hook used to call
    // synth.cancel() before every new line, so when the Storyteller clicked
    // through an auto-resolving character, "Ada, wake up" was cut off mid-sentence
    // and replaced by "Ada, close your eyes". A table that hears two people told
    // to sleep and nobody woken has been told the night skipped somebody.
    const { spoken, fake } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());

    act(() => result.current.announce('Ada, wake up.'));
    expect(spoken).toEqual(['Ada, wake up.']);
    expect(fake.cancel).not.toHaveBeenCalled();

    // The next line arrives while the first is still speaking.
    act(() => result.current.announce('Ada, close your eyes.'));
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(spoken).toEqual(['Ada, wake up.']); // queued, not spoken yet

    act(() => {
      fake.endCurrent?.();
    });
    expect(spoken).toEqual(['Ada, wake up.', 'Ada, close your eyes.']);
  });

  it('keeps only the newest pending line, so a burst does not read out a backlog', () => {
    const { spoken, fake } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('One, wake up.'));
    act(() => result.current.announce('Two, wake up.'));
    act(() => result.current.announce('Three, wake up.'));
    act(() => {
      fake.endCurrent?.();
    });
    expect(spoken).toEqual(['One, wake up.', 'Three, wake up.']);
  });

  it('drops the pending line when the table is silenced mid-utterance', () => {
    const { fake, spoken: spokenRef } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Ada, wake up.'));
    act(() => result.current.announce('Ada, close your eyes.'));
    act(() => result.current.setEnabled(false));
    act(() => {
      fake.endCurrent?.();
    });
    // Nothing queued behind the cancelled utterance.
    expect(spokenRef).toEqual(['Ada, wake up.']);
    expect(fake.speak).toHaveBeenCalledTimes(1);
  });

  it('an explicit "say it again" does cut off the current line', () => {
    // This is the one case where truncating is right: the user asked for the line
    // now, and it is the line already in the log.
    const { spoken, fake } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Ada, wake up.'));
    act(() => result.current.repeat('Everyone, close your eyes.'));
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(spoken).toEqual(['Ada, wake up.', 'Everyone, close your eyes.']);
  });

  it('persists the preference per device', () => {
    const first = renderHook(() => useAnnouncer());
    act(() => first.result.current.setEnabled(false));
    expect(window.localStorage.getItem('botc:announce:enabled')).toBe('false');
    const second = renderHook(() => useAnnouncer());
    expect(second.result.current.enabled).toBe(false);
  });

  it('degrades safely with no speech synthesis on the platform', () => {
    removeFakeSynthesis();
    const { result, unmount } = renderHook(() => useAnnouncer());
    expect(result.current.supported).toBe(false);
    expect(() => act(() => result.current.announce('anything'))).not.toThrow();
    expect(() => act(() => result.current.repeat('anything'))).not.toThrow();
    expect(() => act(() => result.current.stop())).not.toThrow();
    expect(() => unmount()).not.toThrow();
  });

  it('cancels on unmount so a closed tab does not keep talking', () => {
    const { fake } = installFakeSynthesis();
    const { result, unmount } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Bram, wake up.'));
    unmount();
    expect(fake.cancel).toHaveBeenCalled();
  });

  it('uses local synthesis only — no network call is possible from this hook', () => {
    const { fake } = installFakeSynthesis();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Everyone, close your eyes.'));
    act(() => result.current.announce('Bram, wake up.'));
    // A cloud TTS provider would be a third party receiving the table's
    // conversation as text. There is no code path here that could call one.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.speechSynthesis).toBe(fake);
    vi.unstubAllGlobals();
  });
});
