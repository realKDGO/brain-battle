// games/guessNumber.js
// Guess Number game module.
//
// Rules:
//   • During SETUP, the non-active player secretly picks a number (1–100).
//   • During ACTIVE, the current player submits guesses; server responds
//     with "higher", "lower", or "correct".
//   • Track number of guesses and who picked/who guessed each round.

/**
 * Return a fresh gameData object for a new Guess Number session.
 * @param {Array<{id:string,name:string}>} players
 */
function init(players) {
  return {
    // Maps socketId → the number they chose for this round (set during SETUP)
    chosenNumbers: {},
    // All guesses made this round: { playerId, guess, result, timestamp }
    guesses: [],
    // Cumulative scores: { socketId → points }
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
  };
}

/**
 * A player secretly submits their chosen number during SETUP.
 * @param {object} gameData
 * @param {string} socketId
 * @param {{ number: number }} data
 * @returns {{ success: boolean, error?: string }}
 */
function handleSetup(gameData, socketId, data) {
  const num = Number(data?.number);

  if (!Number.isInteger(num) || num < 1 || num > 100) {
    return { success: false, error: "Choose a whole number between 1 and 100." };
  }

  gameData.chosenNumbers[socketId] = num;
  return { success: true };
}

/**
 * The current player submits a guess during ACTIVE.
 * They are guessing the number chosen by their opponent.
 * @param {object} gameData
 * @param {{id:string,name:string}} currentPlayer
 * @param {{ guess: number, opponentId: string }} data
 * @returns {{ success: boolean, result?: "higher"|"lower"|"correct", error?: string }}
 */
function handleAction(gameData, currentPlayer, data) {
  const guess = Number(data?.guess);
  const { opponentId } = data || {};

  if (!Number.isInteger(guess) || guess < 1 || guess > 100) {
    return { success: false, error: "Guess must be a whole number between 1 and 100." };
  }

  if (!opponentId || gameData.chosenNumbers[opponentId] === undefined) {
    return { success: false, error: "Opponent has not submitted their number yet." };
  }

  const target = gameData.chosenNumbers[opponentId];
  let result;

  if (guess === target) {
    result = "correct";
    gameData.scores[currentPlayer.id] = (gameData.scores[currentPlayer.id] || 0) + 1;
  } else if (guess < target) {
    result = "higher"; // hint: go higher
  } else {
    result = "lower";  // hint: go lower
  }

  gameData.guesses.push({
    playerId: currentPlayer.id,
    guess,
    result,
    timestamp: Date.now(),
  });

  return { success: true, result };
}

module.exports = { init, handleSetup, handleAction };
