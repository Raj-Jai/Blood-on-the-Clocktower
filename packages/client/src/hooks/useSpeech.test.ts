import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeech } from './useSpeech.js';

class FakeUtterance {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** Stands in for window.speechSynthesis so the hook can be observed without audio. */
function installFakeSynthesis() {
  const spoken: string[] = [];
  const cancelled: number[] = [];
  let cancelCount = 0;
  const fake = {
    speak: vi.fn((utterance: FakeUtterance) => {
      spoken.push(utterance.text);
    }),
    cancel: vi.fn(() => {
      cancelCount += 1;
      cancelled.push(cancelCount);
    }),
  };
  Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true, writable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtterance,
    configurable: true,
    writable: true,
  });
  return { spoken, cancelled, fake };
}

function removeFakeSynthesis() {
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

describe('useSpeech', () => {
  it('is OFF by default and does not speak', () => {
    const { fake, spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useSpeech());
    expect(result.current.enabled).toBe(false);
    act(() => result.current.speak('You learn there is 1 pair of adjacent evil players.'));
    expect(fake.speak).not.toHaveBeenCalled();
    expect(spoken).toEqual([]);
  });

  it('persists the choice per device and restores it', () => {
    const first = renderHook(() => useSpeech());
    act(() => first.result.current.setEnabled(true));
    expect(window.localStorage.getItem('botc:speech:enabled')).toBe('true');

    // A new hook instance (a remount, a reload) picks the preference back up.
    const second = renderHook(() => useSpeech());
    expect(second.result.current.enabled).toBe(true);
  });

  it('speaks only when enabled, and clears the preference when turned off', () => {
    const { fake, spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.setEnabled(true));
    act(() => result.current.speak('Neither of them is the Demon.'));
    expect(spoken).toEqual(['Neither of them is the Demon.']);

    act(() => result.current.setEnabled(false));
    expect(window.localStorage.getItem('botc:speech:enabled')).toBeNull();
    act(() => result.current.speak('This must not be spoken.'));
    expect(spoken).toEqual(['Neither of them is the Demon.']);
  });

  it('cancels any in-flight utterance before speaking, so a stale prompt is never read after the result', () => {
    const { fake } = installFakeSynthesis();
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.setEnabled(true));
    act(() => result.current.speak('First'));
    act(() => result.current.speak('Second'));
    expect(fake.cancel).toHaveBeenCalledTimes(2);
  });

  it('ignores empty text', () => {
    const { fake, spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.setEnabled(true));
    act(() => result.current.speak('   '));
    act(() => result.current.speak(''));
    expect(spoken).toEqual([]);
    expect(fake.speak).not.toHaveBeenCalled();
  });

  it('degrades safely when the platform has no speech synthesis at all', () => {
    removeFakeSynthesis();
    const { result } = renderHook(() => useSpeech());
    expect(result.current.supported).toBe(false);
    // Must not throw when window.speechSynthesis is missing.
    expect(() => act(() => result.current.setEnabled(true))).not.toThrow();
    expect(() => act(() => result.current.speak('anything'))).not.toThrow();
    expect(() => act(() => result.current.stop())).not.toThrow();
    const { unmount } = renderHook(() => useSpeech());
    expect(() => unmount()).not.toThrow();
  });

  it('cancels speech on unmount so a closed tab does not keep talking', () => {
    const { fake } = installFakeSynthesis();
    const { result, unmount } = renderHook(() => useSpeech());
    act(() => result.current.setEnabled(true));
    unmount();
    expect(fake.cancel).toHaveBeenCalled();
  });

  it('exposes a stop control and a supported flag for the visible toggle', () => {
    const { result } = renderHook(() => useSpeech());
    expect(result.current.supported).toBe(true);
    act(() => result.current.stop());
  });

  it('NEVER receives another player data: the hook has no access to session state at all', () => {
    // The important architectural property, asserted rather than assumed: this
    // hook takes a bare string and knows nothing about players, roles, the
    // Grimoire or the socket. It is structurally incapable of reading another
    // player's secret, because the only thing it can be handed is text the caller
    // already narrowed to the listening player's own server-projected payload.
    const { fake, spoken } = installFakeSynthesis();
    const { result } = renderHook(() => useSpeech());
    act(() => result.current.setEnabled(true));

    act(() => result.current.speak('Empath'));
    act(() => result.current.speak('You learn that 0 of your neighbours are evil.'));

    // Anything that reaches speak() is the caller's own text, verbatim.
    expect(spoken).toEqual(['Empath', 'You learn that 0 of your neighbours are evil.']);
    // No network call: a cloud TTS provider would be a third-party disclosure of
    // game secrets, so synthesis must be entirely local.
    expect(fake.speak).toHaveBeenCalledTimes(2);
    expect(window.speechSynthesis).toBe(fake);
  });
});
