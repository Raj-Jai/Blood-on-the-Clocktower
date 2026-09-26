import { charactersByType, getCharacterById, type CharacterDefinition } from '@clocktower/shared';
import type { GameSession, PlayerRecord } from '../session/store.js';
import { logNightEvent } from '../session/store.js';
import { Errors } from '../errors.js';

export interface DemonKillResult {
  targetPlayerId: string;
  /** False when protection stopped the kill. The rest of the call chain must respect this. */
  killed: boolean;
  /** Set only when the Demon killed itself and a Minion inherited the role. */
  inheritance: { previousDemonPlayerId: string; newDemonPlayerId: string; newDemonCharacterId: string } | null;
}

function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
  return arr;
}

function livingMinions(session: GameSession, excludingPlayerId: string): PlayerRecord[] {
  return [...session.players.values()].filter(
    (p) => p.alive && p.characterType === 'minion' && p.playerId !== excludingPlayerId
  );
}

/**
 * Re-assigns a single Evil player's bluff after a promotion, WITHOUT touching
 * anyone else's.
 *
 * The full `assignBluffs` pass in distribution.ts re-shuffles the whole pool, so
 * re-running it on a Demon hand-off would silently change every other Evil
 * player's fixed bluff mid-game. A bluff is a promise to the table ("I am the
 * Washerwoman"), so it must be stable for the player who already made it. Only
 * the promoted player needs a new one, and only because their old bluff is now a
 * character they demonstrably are not: they were claiming it while actually
 * holding a Minion role that no longer exists.
 */
export function reassignBluffFor(session: GameSession, player: PlayerRecord): void {
  const inPlayIds = new Set(
    [...session.players.values()].map((p) => p.character).filter((c): c is string => c !== null)
  );
  const takenByOthers = new Set(
    [...session.players.values()]
      .filter((p) => p.playerId !== player.playerId && p.bluffCharacterId)
      .map((p) => p.bluffCharacterId as string)
  );
  const candidates = shuffle(
    charactersByType('townsfolk').filter((c) => !inPlayIds.has(c.id) && !takenByOthers.has(c.id))
  );
  const chosen = candidates[0];
  player.bluffCharacterId = chosen?.id ?? null;
  logNightEvent(
    session,
    'bluff-reassigned',
    `${player.displayName} inherited the Demon role; their bluff is now ${
      chosen ? chosen.name : 'none available'
    }. No other player's bluff changed.`
  );
}

/**
 * Resolves the Storyteller choosing a Demon-kill target at night.
 *
 * PROTECTION IS NOW ENFORCED. This used to be `target.alive = false`
 * unconditionally, which made the Monk and the Soldier do nothing at all: their
 * status effect was stored, displayed in the Grimoire, and read by no game logic
 * whatsoever. A protected target now survives, and the caller is told via
 * `killed: false` so it can report the save instead of assuming a death.
 *
 * SELF-KILL. If the killer targets themself ("If you kill yourself this way, a
 * Minion becomes the Imp") and a living Minion exists, that Minion inherits the
 * role. `heirPlayerId` lets the Storyteller choose the heir through the
 * discretion panel. When it is omitted the heir is picked at random AND THAT IS
 * WRITTEN TO THE NIGHT LOG — a server that silently chooses a hidden successor
 * is exactly the "gardening" the audit trail exists to rule out.
 *
 * The new Demon's PUBLIC identity does not change: they keep playing as whatever
 * they were already claiming, and only their own client and the Storyteller ever
 * learn about the switch.
 */
export function resolveDemonKill(
  session: GameSession,
  killerId: string,
  targetPlayerId: string,
  heirPlayerId?: string
): DemonKillResult {
  const killer = session.players.get(killerId);
  const target = session.players.get(targetPlayerId);
  if (!killer || !target) throw Errors.playerNotFound();
  if (!killer.alive || killer.characterType !== 'demon') throw Errors.notTheDemon();
  if (!target.alive) throw Errors.targetDead();

  if (target.statusEffects.protected) {
    logNightEvent(
      session,
      'kill-blocked',
      `${target.displayName} is protected (Monk or Soldier) and cannot be killed by the Demon.`
    );
    return { targetPlayerId, killed: false, inheritance: null };
  }

  target.alive = false;

  if (targetPlayerId !== killerId) {
    return { targetPlayerId, killed: true, inheritance: null };
  }

  // Self-kill: hand the Demon role to a chosen or random living Minion.
  const candidates = livingMinions(session, killerId);
  if (candidates.length === 0) {
    return { targetPlayerId, killed: true, inheritance: null };
  }

  let heir = heirPlayerId ? candidates.find((p) => p.playerId === heirPlayerId) : undefined;
  if (heirPlayerId && !heir) {
    logNightEvent(
      session,
      'heir-fallback',
      `Chosen Imp heir ${heirPlayerId} was not an eligible living Minion, so one was chosen at random instead.`
    );
  }
  if (!heir) {
    [heir] = shuffle(candidates);
    logNightEvent(
      session,
      'heir-random',
      `The Imp self-killed with NO heir chosen by the Storyteller, so the server picked ${
        heir?.displayName ?? 'nobody'
      } at random. Choose the heir in the discretion panel to avoid this.`
    );
  }
  if (!heir) return { targetPlayerId, killed: true, inheritance: null };

  const previousDemonCharacterId = killer.character;
  heir.character = previousDemonCharacterId;
  heir.characterType = 'demon';
  // Alignment is already 'evil' for any Minion, so it does not need to change.
  // The heir's registration must be cleared: it described how they registered as
  // a Minion, which is no longer what they are.
  heir.registration = { alignment: null, characterType: null };
  reassignBluffFor(session, heir);

  return {
    targetPlayerId,
    killed: true,
    inheritance: {
      previousDemonPlayerId: killerId,
      newDemonPlayerId: heir.playerId,
      newDemonCharacterId: previousDemonCharacterId ?? '',
    },
  };
}

export function characterName(id: string | null): string {
  if (!id) return 'Unknown';
  return getCharacterById(id)?.name ?? id;
}
