export class ClocktowerError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const Errors = {
  invalidJoinCode: () =>
    new ClocktowerError('INVALID_JOIN_CODE', "That code doesn't match an active game. Double-check with your Storyteller.", 404),
  nameTaken: () =>
    new ClocktowerError('NAME_TAKEN', 'Someone in this game already has that name. Try another.', 409),
  sessionFull: () =>
    new ClocktowerError('SESSION_FULL', 'This game already has the maximum of 15 players.', 403),
  lobbyClosed: () =>
    new ClocktowerError('LOBBY_CLOSED', 'This game has already started and can no longer be joined.', 403),
  belowMinPlayers: (min: number) =>
    new ClocktowerError('BELOW_MIN_PLAYERS', `You need at least ${min} players before starting.`, 422),
  distributionRange: (min: number, max: number) =>
    new ClocktowerError('DISTRIBUTION_RANGE', `Blood on the Clocktower supports ${min}-${max} players.`, 422),
  notStoryteller: () =>
    new ClocktowerError('NOT_STORYTELLER', 'Only the Storyteller can do that.', 403),
  notAuthenticated: () =>
    new ClocktowerError('NOT_AUTHENTICATED', 'You need to rejoin the game.', 401),
  invalidToken: () =>
    new ClocktowerError('INVALID_TOKEN', 'Your session has expired. Please rejoin the game.', 401),
  playerNotFound: () =>
    new ClocktowerError('PLAYER_NOT_FOUND', "That player isn't in this game.", 404),
  alreadyNominatedToday: () =>
    new ClocktowerError('ALREADY_NOMINATED_TODAY', "You've already nominated someone today.", 403),
  nominatorDead: () =>
    new ClocktowerError('NOMINATOR_DEAD', 'Dead players cannot nominate.', 403),
  targetDead: () =>
    new ClocktowerError('TARGET_DEAD', 'You can only nominate a living player.', 403),
  nominationInProgress: () =>
    new ClocktowerError('NOMINATION_IN_PROGRESS', 'Only one nomination can be open at a time. Wait for it to close.', 403),
  noActiveNomination: () =>
    new ClocktowerError('NO_ACTIVE_NOMINATION', 'There is no open nomination to vote on.', 404),
  nominationClosed: () =>
    new ClocktowerError('NOMINATION_CLOSED', 'Voting has already closed on this nomination.', 403),
  noDeadVoteRemaining: () =>
    new ClocktowerError('NO_DEAD_VOTE_REMAINING', "You've already used your one vote as a ghost.", 403),
  notInEvilChat: () =>
    new ClocktowerError('NOT_IN_EVIL_CHAT', "You don't have access to this chat.", 403),
  invalidPhaseTransition: () =>
    new ClocktowerError('INVALID_PHASE_TRANSITION', 'That phase change is not allowed right now.', 400),
  distributionAlreadyDone: () =>
    new ClocktowerError('DISTRIBUTION_ALREADY_DONE', 'Roles have already been assigned for this game.', 403),
  validationFailed: (message: string) => new ClocktowerError('VALIDATION_FAILED', message, 422),
  questionNotFound: () => new ClocktowerError('QUESTION_NOT_FOUND', "That question isn't in the queue.", 404),
  questionAlreadyAnswered: () =>
    new ClocktowerError('QUESTION_ALREADY_ANSWERED', 'That question has already been answered.', 403),
  questionNotActive: () =>
    new ClocktowerError('QUESTION_NOT_ACTIVE', 'Answer questions in order — this one is not next in the queue.', 403),
  notTheDemon: () => new ClocktowerError('NOT_THE_DEMON', 'Only a living Demon can make a night kill.', 403),
  gameAlreadyEnded: () => new ClocktowerError('GAME_ALREADY_ENDED', 'This game has already ended.', 403),
  notNightPhase: () =>
    new ClocktowerError('NOT_NIGHT_PHASE', 'That only happens at night. Switch the game to the night phase first.', 403),
  noOpenNight: () => new ClocktowerError('NO_OPEN_NIGHT', 'There is no night in progress.', 409),
  nightAlreadyResolved: () => new ClocktowerError('NIGHT_ALREADY_RESOLVED', 'Tonight has already been resolved.', 409),
  notYourNightStep: () =>
    new ClocktowerError('NOT_YOUR_NIGHT_STEP', 'You have no night choice to make right now.', 403),
  nightChoiceAlreadySubmitted: () =>
    new ClocktowerError('NIGHT_CHOICE_ALREADY_SUBMITTED', "You've already sent your choice for tonight.", 403),
  nothingToChoose: () => new ClocktowerError('NOTHING_TO_CHOOSE', "Your character doesn't make a choice tonight.", 400),
  wrongTargetCount: (expected: number, got: number) =>
    new ClocktowerError(
      'WRONG_TARGET_COUNT',
      expected === 1 ? 'Choose exactly 1 player.' : `Choose exactly ${expected} players (you chose ${got}).`,
      422
    ),
  duplicateTarget: () => new ClocktowerError('DUPLICATE_TARGET', 'Choose a player only once.', 422),
  illegalTarget: (name: string) =>
    new ClocktowerError('ILLEGAL_TARGET', `${name} is not a legal choice for your character.`, 422),
  playerNotInGame: () => new ClocktowerError('PLAYER_NOT_FOUND', "That player isn't in this game.", 404),
  flowNotAdvanceable: () =>
    new ClocktowerError(
      'FLOW_NOT_ADVANCEABLE',
      "The flow moves on its own right now — switch phases, resolve the night, or close the vote.",
      409
    ),
  butlerMustFollow: () =>
    new ClocktowerError('BUTLER_MUST_FOLLOW', "You're the Butler: you may only vote if the player you chose is voting too.", 403),
};
