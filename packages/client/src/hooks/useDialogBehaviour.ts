import { useEffect, useRef } from 'react';

/**
 * The one behaviour every full-screen overlay in this app was missing.
 *
 * There are six of them — the player's More sheet, the Storyteller's More sheet, the
 * onboarding modal, the rules reference, the character reference, and the Spectre
 * reference — and every one declares `role="dialog" aria-modal="true"` while trapping
 * nothing: no Escape, no backdrop tap, no focus move. `aria-modal="true"` is a promise
 * that focus cannot leave the dialog, and the DOM does not keep it. On a phone the
 * only exit is a small Close button in the corner of a scrolling sheet, which is fine
 * for a thumb and unusable for a switch-control or keyboard user.
 *
 * Usage: give the backdrop a ref, call this with the element to focus on open and the
 * function to close.
 */
export function useDialogBehaviour(
  open: boolean,
  onClose: () => void,
  panelRef?: React.RefObject<HTMLElement | null>
): React.RefObject<HTMLDivElement | null> {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest onClose without re-running the effect on every render, which would
  // re-bind the listener for no reason.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // Move focus into the dialog so a keyboard or screen-reader user starts inside it
    // rather than somewhere behind it.
    const target = panelRef?.current;
    if (target) {
      const first = target.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      (first ?? target).focus?.();
    }

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Put focus back where it came from, so dismissing a sheet does not dump the user
      // at the top of the document.
      previouslyFocused?.focus?.();
    };
  }, [open, panelRef]);

  return backdropRef;
}

/**
 * The backdrop's click handler.
 *
 * Plain `onClick={onClose}` on the backdrop would also fire when a click INSIDE the
 * sheet bubbled up to it, closing the sheet the moment you tapped anything in it. So
 * the check is against the element the event actually started on.
 */
export function backdropClick(backdrop: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  return (e: React.MouseEvent) => {
    if (e.target === backdrop.current) onClose();
  };
}
