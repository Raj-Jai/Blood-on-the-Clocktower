import { z } from 'zod';

export const AuthPayloadSchema = z.object({
  token: z.string().min(1),
});

export const SetPhaseSchema = z.object({
  phase: z.enum(['day', 'night']),
  /** Optional countdown duration in seconds for the new phase. Omit for no timer. */
  timerSeconds: z.number().int().positive().max(3600).optional(),
});

export const SetTimerSchema = z.object({
  /** Seconds remaining from now, or null to clear the timer. */
  timerSeconds: z.number().int().positive().max(3600).nullable(),
});

export const SetPlayerStatusSchema = z.object({
  playerId: z.string().min(1),
  statusEffects: z.object({
    poisoned: z.boolean().optional(),
    drunk: z.boolean().optional(),
    protected: z.boolean().optional(),
  }),
});

export const MarkDeadSchema = z.object({
  playerId: z.string().min(1),
});

export const ShareAbilityResultSchema = z.object({
  playerId: z.string().min(1),
  text: z.string().min(1).max(500),
});

export const NominateSchema = z.object({
  targetPlayerId: z.string().min(1),
});

export const VoteSchema = z.object({
  nominationId: z.string().min(1),
  voting: z.boolean(),
});

export const CloseVoteSchema = z.object({
  nominationId: z.string().min(1),
});

export const ConfirmExecutionSchema = z.object({
  nominationId: z.string().min(1),
});

export const ChatSendSchema = z.object({
  text: z.string().min(1).max(1000),
});

export const SetPlayerAlignmentSchema = z.object({
  playerId: z.string().min(1),
  alignment: z.enum(['good', 'evil']),
});

export const ReorderSeatsSchema = z.object({
  orderedPlayerIds: z.array(z.string().min(1)).min(1),
});

export const AskQuestionSchema = z.object({
  text: z.string().min(1).max(500),
});

export const AnswerQuestionSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1).max(1000),
});
export const DemonKillSchema = z.object({
  targetPlayerId: z.string().min(1),
});

/** A waker's own night choice. Max 2 because no Trouble Brewing ability picks more. */
export const SubmitNightChoiceSchema = z.object({
  targetIds: z.array(z.string().min(1)).max(2),
});

/** Storyteller overrides for every value the server generates on the Storyteller's behalf. */
export const SetDiscretionSchema = z.object({
  /** Re-picks which Townsfolk a Drunk believes themself to be. */
  drunkCoverPlayerId: z.string().min(1).optional(),
  /** Re-picks which Good player registers as the Demon to the Fortune Teller. */
  redHerringPlayerId: z.string().min(1).optional(),
  /** Which living Minion inherits the Demon if the Imp self-kills, for the current night. */
  impHeirPlayerId: z.string().min(1).optional(),
  /** Per-player registration overrides (Recluse / Spy), applied for the current night. */
  registrations: z
    .array(
      z.object({
        playerId: z.string().min(1),
        alignment: z.enum(['good', 'evil']).optional(),
        characterType: z.enum(['townsfolk', 'outsider', 'minion', 'demon']).optional(),
      })
    )
    .max(15)
    .optional(),
  /** Free-text replacement for one resolved night step, sent verbatim to that waker. */
  stepOverride: z
    .object({
      characterId: z.string().min(1),
      text: z.string().min(1).max(500),
    })
    .optional(),
});

export const AdvanceNightSchema = z.object({
  action: z.enum(['next', 'previous', 'goto', 'resolve', 'skipDelay']),
  /** Only used with action 'goto'. */
  stepIndex: z.number().int().min(0).optional(),
});

/** The Storyteller's pause between consecutive wakers. 0 disables it. */
export const SetNightDelaySchema = z.object({
  seconds: z.number().int().min(0).max(60),
});

export const EndGameSchema = z.object({
  winner: z.enum(['good', 'evil']),
});

export const CreateSessionRequestSchema = z.object({});

export const JoinSessionRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(30),
});
