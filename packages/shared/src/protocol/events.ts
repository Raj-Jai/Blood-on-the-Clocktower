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
  StorytellerSetDiscretion: 'storyteller:setDiscretion',
  StorytellerAdvanceNight: 'storyteller:advanceNight',
  StorytellerFlowAdvance: 'storyteller:flowAdvance',
  StorytellerEndGame: 'storyteller:endGame',
  PlayerSubmitNightChoice: 'player:submitNightChoice',
  ChatEvilSend: 'chat:evil:send',
  ChatOpenSend: 'chat:open:send',
} as const;

/** Server -> Client event names. */
export const ServerEvents = {
  AuthOk: 'auth:ok',
  LobbyUpdate: 'lobby:update',
  GameDistributed: 'game:distributed',
  GamePhaseChanged: 'game:phaseChanged',
  GrimoireUpdate: 'grimoire:update',
  PlayerSelfUpdate: 'player:selfUpdate',
  NightPrompt: 'night:prompt',
  NightResolved: 'night:resolved',
  NightOrderUpdate: 'night:order',
  NightLog: 'night:log',
  FlowUpdate: 'flow:update',
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
  Error: 'error',
} as const;

export interface ErrorPayload {
  code: string;
  message: string;
}
