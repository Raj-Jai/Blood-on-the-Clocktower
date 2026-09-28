/** Client -> Server event names. */
export const ClientEvents = {
  Auth: 'auth',
  StorytellerStartDistribution: 'storyteller:startDistribution',
  StorytellerRedistribute: 'storyteller:redistribute',
  StorytellerSetPhase: 'storyteller:setPhase',
  StorytellerSetPlayerStatus: 'storyteller:setPlayerStatus',
  StorytellerMarkDead: 'storyteller:markDead',
  StorytellerShareAbilityResult: 'storyteller:shareAbilityResult',
  StorytellerSetPlayerAlignment: 'storyteller:setPlayerAlignment',
  StorytellerReorderSeats: 'storyteller:reorderSeats',
  StorytellerSetTimer: 'storyteller:setTimer',
  PlayerAskQuestion: 'player:askQuestion',
  StorytellerAnswerQuestion: 'storyteller:answerQuestion',
  PlayerNominate: 'player:nominate',
  PlayerVote: 'player:vote',
  StorytellerCloseVote: 'storyteller:closeVote',
  StorytellerConfirmExecution: 'storyteller:confirmExecution',
  StorytellerDemonKill: 'storyteller:demonKill',
  StorytellerEndGame: 'storyteller:endGame',
  ChatEvilSend: 'chat:evil:send',
  ChatOpenSend: 'chat:open:send',
  PlayerSubmitNightAction: 'player:submitNightAction',
  StorytellerAdvanceNightStep: 'storyteller:advanceNightStep',
  StorytellerSetDiscretionOverride: 'storyteller:setDiscretionOverride',
} as const;

/** Server -> Client event names. */
export const ServerEvents = {
  AuthOk: 'auth:ok',
  LobbyUpdate: 'lobby:update',
  GameDistributed: 'game:distributed',
  GamePhaseChanged: 'game:phaseChanged',
  GrimoireUpdate: 'grimoire:update',
  PlayerSelfUpdate: 'player:selfUpdate',
  NominationOpened: 'nomination:opened',
  NominationVoteUpdate: 'nomination:voteUpdate',
  NominationClosed: 'nomination:closed',
  ExecutionConfirmed: 'execution:confirmed',
  ChatEvilMessage: 'chat:evil:message',
  ChatEvilHistory: 'chat:evil:history',
  ChatOpenMessage: 'chat:open:message',
  ChatOpenHistory: 'chat:open:history',
  QuestionQueueUpdate: 'question:queueUpdate',
  StorytellerConnectionStatus: 'storyteller:connectionStatus',
  GameEnded: 'game:ended',
  DemonInherited: 'demon:inherited',
  NightRosterUpdate: 'night:rosterUpdate',
  NightPrompt: 'night:prompt',
  NightInfoResult: 'night:infoResult',
  DiscretionLogUpdate: 'discretion:logUpdate',
  Error: 'error',
} as const;

export interface ErrorPayload {
  code: string;
  message: string;
}
