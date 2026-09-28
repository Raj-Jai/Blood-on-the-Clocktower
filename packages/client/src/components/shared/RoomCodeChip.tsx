import { useState } from 'react';

interface RoomCodeChipProps {
  code: string;
}

/**
 * Persistent, copyable room code chip. Rendered in every in-game header so
 * the code never disappears once the Storyteller starts distribution --
 * previously it only ever appeared on the lobby screen, so nobody (not even
 * the Storyteller) could answer "what's the code?" once the game started.
 */
export function RoomCodeChip({ code }: RoomCodeChipProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied (permissions, non-secure context,
      // older browsers) -- the code is still visible on-screen, so this is
      // a soft failure, not something that needs to interrupt the player.
    }
  }

  return (
    <button
      className="btn btn-inline"
      onClick={copy}
      title="Copy room code"
      aria-label={`Room code ${code}. Tap to copy.`}
      style={{ fontFamily: 'monospace', letterSpacing: '0.08em' }}
    >
      Room {code} {copied ? '✓' : '📋'}
    </button>
  );
}
