import { useCallback, useEffect, useRef, useState } from 'react';

const SPEECH_ENABLED_KEY = 'botc:speech:enabled';

function readStoredPreference(): boolean {
  // Referenced through `window.localStorage` rather than the bare global: in the
  // browser they are the same object, but under Node's newer built-in
  // `localStorage` global (which the client test script would otherwise shadow
  // with --no-webstorage) this avoids reading the wrong store.
  try {
    return window.localStorage.getItem(SPEECH_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredPreference(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(SPEECH_ENABLED_KEY, 'true');
    else window.localStorage.removeItem(SPEECH_ENABLED_KEY);
  } catch {
    // A device with storage disabled still gets a working toggle for this session.
  }
}

export interface SpeechControls {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  /** Speaks `text` locally. A no-op when disabled or when the platform has no speech synthesis. */
  speak: (text: string) => void;
  stop: () => void;
  /** True when the platform actually supports local speech synthesis. */
  supported: boolean;
}

/**
 * LOCAL, OPT-IN text to speech for a player's OWN information.
 *
 * WHY THIS IS OPT-IN AND OFF BY DEFAULT
 * ------------------------------------
 * Text to speech is, by definition, audible. On a phone passed around a table it
 * is an unrecoverable information leak: the whole point of a private Grimoire
 * entry is that only you read it, and a voice removes the private channel. It is
 * also a *screen-reader* feature in the worst case — see below — so it must never
 * be on unless a person asked for it.
 *
 * WHY LOCAL SYNTHESIS ONLY
 * -----------------------
 * This calls `window.speechSynthesis` and never a network TTS API. Sending game
 * secrets to a third-party TTS provider transmits them to another party with
 * provider-dependent retention. For a party game that is low severity; for a
 * graded or recorded game it is a real compliance question, and it is trivially
 * avoidable by not leaving the device.
 *
 * WHY THE CALLER MATTERS MORE THAN THIS HOOK
 * ------------------------------------------
 * The techniques used to hide content from sighted users are frequently the
 * techniques that KEEP content in the accessibility tree: `visibility: hidden`
 * and off-screen positioning are still announced by some screen readers, and
 * WebKit exposes `visibility: hidden` to VoiceOver where Chromium and Gecko
 * remove it from the tree entirely. So a panel that is silent in Chrome can be
 * SPOKEN in Safari. The only reliable fix is on the server: never send another
 * player's data to a player client at all. `speak` therefore takes text the
 * caller has already narrowed to their own payload, and callers must never pass
 * the Grimoire, another player's name-plus-role, or anything from the
 * Storyteller's view. See PlayerGamePage for the only two call sites.
 *
 * NOT announced by the DOM: regions that receive night information deliberately
 * do NOT set `aria-live`. Content that is spoken by design inside a live region
 * gets announced twice, and a per-tick live region is worse still — see the
 * existing defect noted in PhaseTimer, where `role="timer"` + `aria-live="polite"`
 * with a 1-second interval interrupts a screen reader every second for the whole
 * phase.
 */
export function useSpeech(): SpeechControls {
  const [enabled, setEnabledState] = useState<boolean>(() => readStoredPreference());
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // Cancelling on unmount matters: a player closing the tab mid-utterance should
  // not leave the device talking.
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    writeStoredPreference(value);
    if (!value && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    utteranceRef.current = null;
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!enabled) return;
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const synth = window.speechSynthesis;
      // Replace any in-flight utterance rather than queueing: a stale night
      // prompt being read out after the result has arrived is worse than silence.
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(trimmed);
      synth.speak(utterance);
      utteranceRef.current = utterance;
    },
    [enabled]
  );

  return { enabled, setEnabled, speak, stop, supported };
}
