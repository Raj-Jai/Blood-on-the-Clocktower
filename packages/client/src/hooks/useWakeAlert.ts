import { useEffect, useRef } from 'react';

/**
 * THE ALARM.
 *
 * The app knows whose turn it is, and then only ever said so to a screen nobody might
 * be looking at. Measured in a real browser: zero uses of `document.title`,
 * `Notification`, `vibrate` or any audio anywhere in the client, even though the
 * browser had all of them. So the complete set of signals a player got when the
 * Storyteller woke them at night was — the card's border turns gold, the emoji changes,
 * two words change. With the phone face-down, in a pocket, on silent, or backgrounded,
 * a player received NOTHING, and the Storyteller had to shout their name across the
 * table, which is precisely the verbal ritual this app exists to replace.
 *
 * These are ordered by how much they are worth per line of code:
 *
 *   1. `document.title` — appears in the iOS app switcher, the Android recents card
 *      and the browser tab bar. No permission prompt, no service worker, works today.
 *   2. `navigator.vibrate` — the phone buzzes on the table. Needs a user gesture on
 *      iOS, so it is armed on the first tap rather than on mount, and it is opt-out.
 *   3. A visible flash on the moment card, for when the player is looking at it.
 *
 * Deliberately NOT a web Notification: browsers refuse `requestPermission` unless it
 * is called from a user gesture, and asking at page load silently fails. That needs a
 * real opt-in switch during onboarding, which is a separate piece of work.
 */

const BASE_TITLE = 'Blood on the Clocktower';

export type WakeUrgency = 'asleep' | 'choose' | 'day' | 'other';

function titleFor(urgency: WakeUrgency): string {
  switch (urgency) {
    case 'choose':
      return '⚡ YOU ARE AWAKE — Clocktower';
    case 'day':
      return '🗳 You are being voted on — Clocktower';
    default:
      return BASE_TITLE;
  }
}

export interface WakeAlertOptions {
  /** 'choose' while the player owes a night choice, 'day' when a vote is open on them. */
  urgency: WakeUrgency;
  /** The player can opt out of the buzz. Vibration cannot be enabled without consent. */
  vibrateEnabled: boolean;
  onFirstGesture?: () => void;
}

const VIBRATE_KEY = 'botc:vibrate';

export function vibrationEnabledByDefault(): boolean {
  try {
    const stored = window.localStorage.getItem(VIBRATE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function setVibrationEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(VIBRATE_KEY, String(enabled));
  } catch {
    /* private mode; the setting just will not persist */
  }
}

export function useWakeAlert({ urgency, vibrateEnabled, onFirstGesture }: WakeAlertOptions): void {
  const previous = useRef<WakeUrgency>(urgency);
  const gestureArmed = useRef(false);

  // iOS will not vibrate without a user gesture having happened first, so arm on the
  // first interaction of the session rather than trying at the moment we need it.
  useEffect(() => {
    if (gestureArmed.current) return undefined;
    const arm = () => {
      gestureArmed.current = true;
      onFirstGesture?.();
    };
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
  }, [onFirstGesture]);

  useEffect(() => {
    document.title = titleFor(urgency);
  }, [urgency]);

  // Buzz only on a TRANSITION into something urgent, never on every re-render, and
  // never when the phone cannot do it.
  useEffect(() => {
    const was = previous.current;
    previous.current = urgency;
    if (urgency === was) return;
    if (urgency !== 'choose' && urgency !== 'day') return;
    if (!vibrateEnabled) return;
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    // Two short pulses. Long enough to feel through a table, short enough not to be
    // embarrassing next to the device.
    navigator.vibrate([120, 80, 120]);
  }, [urgency, vibrateEnabled]);
}
