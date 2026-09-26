import { useCallback, useEffect, useRef, useState } from 'react';

const ANNOUNCE_ENABLED_KEY = 'botc:announce:enabled';

function readStored(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, 'true');
    else window.localStorage.setItem(key, 'false');
  } catch {
    // Storage disabled: the toggle still works for this session.
  }
}

export interface AnnouncerControls {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  /** Speaks `text` if the announcement channel is on and the text is new. */
  announce: (text: string) => void;
  /** Speaks `text` even if it is the same as the last line (a "say it again" button). */
  repeat: (text: string) => void;
  stop: () => void;
  supported: boolean;
  /** Last line spoken, so the UI can show what the table just heard. */
  lastSpoken: string | null;
}

/**
 * THE TABLE PA. Flow announcements, spoken aloud, on the host device.
 *
 * THIS IS A DIFFERENT CHANNEL FROM `useSpeech`, and the split is the whole point.
 *
 *   useAnnouncer (this) — PUBLIC flow instructions. "Everyone, close your eyes."
 *                         "Bram, wake up." "Voting is open." These are the exact
 *                         sentences a real Storyteller shouts across a table, so
 *                         saying them out loud discloses nothing. Default ON,
 *                         because a room full of people who do not know what to
 *                         do is the problem being solved.
 *
 *   useSpeech         — PRIVATE information. Roles, ability results, the
 *                         Grimoire. Default OFF, and it is not wired to this
 *                         channel at all.
 *
 * The rule for anything routed here: it must come from the server's public
 * `FlowState`, whose leak invariant is enforced by `assertSpeakableAnnouncement`.
 * Do not pass a role, a result, or a Grimoire entry to `announce` — the guard
 * exists to make that a test failure rather than a disclosure.
 *
 * LOCAL SYNTHESIS ONLY. A cloud TTS provider would be a third party receiving
 * the table's conversation in text form; for a party game that is low severity,
 * for a graded one it is a compliance question, and there is no reason to pay
 * it. The trade-off is that every device has its own voice, so this is a
 * convenience rather than a house sound system.
 */
export function useAnnouncer(): AnnouncerControls {
  // Default ON: this channel only ever speaks public instructions.
  const [enabled, setEnabledState] = useState<boolean>(() => readStored(ANNOUNCE_ENABLED_KEY, true));
  const [lastSpoken, setLastSpoken] = useState<string | null>(null);
  const lastRef = useRef<string | null>(null);

  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    writeStored(ANNOUNCE_ENABLED_KEY, value);
    if (!value && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const speakOnce = useCallback((text: string, force: boolean) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (!force && lastRef.current === trimmed) return;
    lastRef.current = trimmed;
    setLastSpoken(trimmed);
    // Replace rather than queue: a stale "wake up" read after "open your eyes" is
    // worse than saying nothing.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(trimmed));
  }, []);

  const announce = useCallback(
    (text: string) => {
      if (!enabled) return;
      speakOnce(text, false);
    },
    [enabled, speakOnce]
  );

  const repeat = useCallback(
    (text: string) => {
      if (!enabled) return;
      speakOnce(text, true);
    },
    [enabled, speakOnce]
  );

  return { enabled, setEnabled, announce, repeat, stop, supported, lastSpoken };
}
