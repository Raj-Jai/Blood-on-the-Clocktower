import { useState } from 'react';
import { ClientEvents, getCharacterById } from '@clocktower/shared';
import type { Socket } from 'socket.io-client';
import type { GrimoirePlayerEntry } from '@clocktower/shared';

interface NightDiscretionPanelProps {
  socket: Socket | null;
  grimoire: GrimoirePlayerEntry[];
  nightNumber: number;
}

const ALIGNMENTS = ['good', 'evil'] as const;
const TYPES = ['townsfolk', 'outsider', 'minion', 'demon'] as const;

/**
 * The Storyteller's discretion panel — Phase 4 of the issue.
 *
 * Everything the server picks on the Storyteller's behalf is overridable here:
 * the Drunk's cover, the Fortune Teller's red herring, the Imp's self-kill heir,
 * per-player Recluse/Spy registration, and any single generated result.
 *
 * The reason this panel exists is the honest one: the rules make information
 * content discretionary by design. "Treat the Drunk as the character they
 * believe themselves to be, but you may provide false information or ignore
 * their instructions whenever you want"; the Recluse is "the Storyteller chooses
 * whatever is most interesting"; and the guidance is to "help the weaker team as
 * much as possible", which means a worse-than-optimal Storyteller is the correct
 * one. An engine that pretended to make those calls would produce a worse game.
 *
 * Every override here is written to the night log with a timestamp, the same as
 * every generated default. A hidden state that is never audited is
 * indistinguishable from gardening, and the community's argument about gardening
 * is precisely about hidden state being chosen late and opportunistically.
 */
export function NightDiscretionPanel({ socket, grimoire, nightNumber }: NightDiscretionPanelProps) {
  const [redHerring, setRedHerring] = useState('');
  const [impHeir, setImpHeir] = useState('');
  const [stepCharacter, setStepCharacter] = useState('');
  const [overrideText, setOverrideText] = useState('');
  const [coverPlayerId, setCoverPlayerId] = useState('');

  const living = grimoire.filter((p) => p.alive);
  const drunk = grimoire.find((p) => p.character === 'drunk');
  const goodPlayers = living.filter((p) => p.alignment === 'good');
  const minionCandidates = living.filter((p) => p.characterType === 'minion');
  const registrable = living.filter((p) => p.character === 'recluse' || p.character === 'spy');

  function setRegistration(playerId: string, field: 'alignment' | 'characterType', value: string) {
    socket?.emit(ClientEvents.StorytellerSetDiscretion, {
      registrations: [{ playerId, [field]: value === 'truth' ? undefined : value }],
    });
  }

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Discretion</h2>
      <p className="faint" style={{ marginTop: -8 }}>
        Everything the server decides for you, and everything it cannot decide for you. The rules leave lie content
        and game feel to you on purpose — use this panel, and every choice lands in the night log with a timestamp.
      </p>

      <fieldset style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 12 }}>
        <legend style={{ padding: '0 6px' }}>Fortune Teller red herring</legend>
        <p className="faint" style={{ marginTop: 0 }}>
          One Good player registers as the Demon to the Fortune Teller. A permanently fixed red herring is learnable
          by a careful table (“always yes for Bram”), so move it when the story calls for it.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="input" value={redHerring} onChange={(e) => setRedHerring(e.target.value)}>
            <option value="">Choose a Good player…</option>
            {goodPlayers.map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.displayName}
              </option>
            ))}
          </select>
          <button
            className="btn btn-inline"
            disabled={!redHerring}
            onClick={() => {
              socket?.emit(ClientEvents.StorytellerSetDiscretion, { redHerringPlayerId: redHerring });
              setRedHerring('');
            }}
          >
            Set for tonight
          </button>
        </div>
      </fieldset>

      <fieldset style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 12 }}>
        <legend style={{ padding: '0 6px' }}>Imp self-kill heir</legend>
        <p className="faint" style={{ marginTop: 0 }}>
          “If you kill yourself this way, a Minion becomes the Imp.” Choose the Minion. If you leave this unset the
          server picks one at random and logs that it did, which is the outcome you least want in an audit.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="input" value={impHeir} onChange={(e) => setImpHeir(e.target.value)}>
            <option value="">Choose a Minion…</option>
            {minionCandidates.map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.displayName}
              </option>
            ))}
          </select>
          <button
            className="btn btn-inline"
            disabled={!impHeir}
            onClick={() => {
              socket?.emit(ClientEvents.StorytellerSetDiscretion, { impHeirPlayerId: impHeir });
              setImpHeir('');
            }}
          >
            Set for Night {nightNumber}
          </button>
        </div>
      </fieldset>

      {drunk && (
        <fieldset style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 12 }}>
          <legend style={{ padding: '0 6px' }}>Drunk cover</legend>
          <p className="faint" style={{ marginTop: 0 }}>
            {drunk.displayName} believes they are a Townsfolk. The server already picked a cover character that is not
            in play and is showing them that; re-pick it here if you want a different one.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select className="input" value={coverPlayerId} onChange={(e) => setCoverPlayerId(e.target.value)}>
              <option value="">Re-pick the Drunk’s cover…</option>
              {living.map((p) => (
                <option key={p.playerId} value={p.playerId}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <button
              className="btn btn-inline"
              disabled={!coverPlayerId}
              onClick={() => {
                socket?.emit(ClientEvents.StorytellerSetDiscretion, { drunkCoverPlayerId: coverPlayerId });
                setCoverPlayerId('');
              }}
            >
              Re-pick cover
            </button>
          </div>
        </fieldset>
      )}

      <fieldset style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, marginBottom: 12 }}>
        <legend style={{ padding: '0 6px' }}>Registration (Recluse &amp; Spy)</legend>
        <p className="faint" style={{ marginTop: 0 }}>
          What a player registers as to <em>detection</em> abilities — the Chef, the Empath, the Fortune Teller, the
          Washerwoman. This is not the same as alignment: a Recluse who registers as evil is still a Good player, and
          the rest of the table can execute them for it.
        </p>
        {registrable.length === 0 ? (
          <p className="faint">No Recluse or Spy is in play.</p>
        ) : (
          registrable.map((p) => (
            <div key={p.playerId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <strong style={{ minWidth: 110 }}>
                {p.displayName} <span className="muted">({p.character === 'recluse' ? 'Recluse' : 'Spy'})</span>
              </strong>
              <select
                className="input"
                value={p.registration.alignment ?? 'truth'}
                onChange={(e) => setRegistration(p.playerId, 'alignment', e.target.value)}
              >
                <option value="truth">registers truthfully</option>
                {ALIGNMENTS.map((a) => (
                  <option key={a} value={a}>
                    registers as {a}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={p.registration.characterType ?? 'truth'}
                onChange={(e) => setRegistration(p.playerId, 'characterType', e.target.value)}
              >
                <option value="truth">their own type</option>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    registers as {t}
                  </option>
                ))}
              </select>
            </div>
          ))
        )}
      </fieldset>

      <fieldset style={{ border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
        <legend style={{ padding: '0 6px' }}>Override one result</legend>
        <p className="faint" style={{ marginTop: 0 }}>
          Replace anything the engine generated for a single waker, in your own words. This is the escape hatch for
          every case the generator cannot know is more interesting.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
          <select className="input" value={stepCharacter} onChange={(e) => setStepCharacter(e.target.value)}>
            <option value="">Choose an ability…</option>
            {[
              'washerwoman',
              'librarian',
              'investigator',
              'chef',
              'empath',
              'fortune-teller',
              'undertaker',
              'ravenkeeper',
            ].map((id) => (
              <option key={id} value={id}>
                {getCharacterById(id)?.name ?? id}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="What they should be told instead"
            value={overrideText}
            onChange={(e) => setOverrideText(e.target.value)}
          />
          <button
            className="btn btn-primary"
            disabled={!stepCharacter || !overrideText.trim()}
            onClick={() => {
              socket?.emit(ClientEvents.StorytellerSetDiscretion, {
                stepOverride: { characterId: stepCharacter, text: overrideText.trim() },
              });
              setOverrideText('');
            }}
          >
            Queue override
          </button>
        </div>
      </fieldset>
    </div>
  );
}
