import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnouncer } from './useAnnouncer.js';

class FakeUtterance {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function installFakeSynthesis() {
  const spoken: string[] = [];
  const fake = {
    speak: vi.fn((u: FakeUtterance) => spoken.push(u.text)),
    cancel: vi.fn(),
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

  it('cancels before speaking, so a stale wake-up is never read after open-eyes', () => {
    const { fake } = installFakeSynthesis();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Bram, wake up.'));
    act(() => result.current.announce('Everyone, open your eyes.'));
    expect(fake.cancel).toHaveBeenCalledTimes(2);
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
