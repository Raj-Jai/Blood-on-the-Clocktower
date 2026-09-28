import { Router, type Request, type Response, type NextFunction } from 'express';
import { nanoid } from 'nanoid';
import { JoinSessionRequestSchema, MAX_PLAYERS } from '@clocktower/shared';
import type { SessionStore } from '../session/store.js';
import { signPlayerToken, signStorytellerToken } from '../session/tokens.js';
import { Errors } from '../errors.js';

/** Grace period after a disconnect before that seat becomes reclaimable by name -- long enough that a brief network blip's own token-based auto-reconnect wins the race, short enough that a genuinely departed player's seat isn't stuck all game. */
const RECLAIM_GRACE_PERIOD_MS = 60_000;

type Handler = (req: Request, res: Response, next: NextFunction) => void;

/** Wraps a synchronous handler so thrown ClocktowerErrors reach the error middleware. */
function safe(handler: Handler): Handler {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

export function createApiRouter(store: SessionStore): Router {
  const router = Router();

  router.post(
    '/sessions',
    safe((_req, res) => {
      const session = store.createSession('placeholder');
      const storytellerToken = signStorytellerToken(session.code);
      session.storytellerToken = storytellerToken;
      res.status(201).json({ code: session.code, storytellerToken });
    })
  );

  router.get(
    '/sessions/:code',
    safe((req, res) => {
      const code = req.params.code;
      const session = code ? store.getSession(code) : undefined;
      if (!session) {
        throw Errors.invalidJoinCode();
      }
      res.json({
        code: session.code,
        phase: session.phase,
        playerCount: session.players.size,
        maxPlayers: MAX_PLAYERS,
      });
    })
  );

  router.post(
    '/sessions/:code/join',
    safe((req, res) => {
      const code = req.params.code;
      const session = code ? store.getSession(code) : undefined;
      if (!session) {
        throw Errors.invalidJoinCode();
      }
      if (session.phase !== 'lobby') {
        throw Errors.lobbyClosed();
      }
      const parseResult = JoinSessionRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw Errors.validationFailed('Please enter a valid display name.');
      }
      const { displayName } = parseResult.data;

      if (session.players.size >= MAX_PLAYERS) {
        throw Errors.sessionFull();
      }
      if (store.isDisplayNameTaken(session, displayName)) {
        throw Errors.nameTaken();
      }

      const playerId = nanoid(12);
      store.addPlayer(session, playerId, displayName);
      store.touch(session);
      const playerToken = signPlayerToken(session.code, playerId);
      res.status(201).json({ playerId, playerToken, code: session.code });
    })
  );

  router.post(
    '/sessions/:code/reclaim',
    safe((req, res) => {
      const code = req.params.code;
      const session = code ? store.getSession(code) : undefined;
      if (!session) {
        throw Errors.invalidJoinCode();
      }
      // A game still in the lobby has no mid-game state worth reclaiming --
      // the normal join endpoint already works there.
      if (session.phase === 'lobby') {
        throw Errors.reclaimNotInProgress();
      }
      const parseResult = JoinSessionRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw Errors.validationFailed('Please enter the display name your seat is under.');
      }
      const { displayName } = parseResult.data;
      const normalized = displayName.trim().toLowerCase();

      const match = [...session.players.values()].find((p) => p.displayName.trim().toLowerCase() === normalized);
      if (!match) {
        throw Errors.reclaimNoMatch();
      }
      if (match.connectionId !== null) {
        throw Errors.reclaimStillConnected();
      }
      const disconnectedAt = match.disconnectedAt;
      if (disconnectedAt !== null && Date.now() - disconnectedAt < RECLAIM_GRACE_PERIOD_MS) {
        throw Errors.reclaimTooSoon();
      }

      // Re-issue a token for the SAME playerId -- this must never create a
      // new PlayerRecord, or the reclaiming player would get a fresh seat,
      // a fresh character, and lose everything (alignment, alive/dead
      // state, dead-vote usage) tied to their original seat.
      store.touch(session);
      const playerToken = signPlayerToken(session.code, match.playerId);
      res.status(200).json({ playerId: match.playerId, playerToken, code: session.code });
    })
  );

  return router;
}
