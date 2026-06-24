// games/index.js
// Game module registry.
// Maps each GAME_MODE constant to its handler module.

const { GAME_MODE } = require("../engine/constants");
const wordChain      = require("./wordChain");
const guessNumber    = require("./guessNumber");
const connectLetters = require("./connectLetters");
const wordle         = require("./wordle");

const gameRegistry = {
  [GAME_MODE.WORD_CHAIN]:      wordChain,
  [GAME_MODE.GUESS_NUMBER]:    guessNumber,
  [GAME_MODE.CONNECT_LETTERS]: connectLetters,
  [GAME_MODE.WORDLE]:          wordle,
};

/**
 * Return the game module for a given mode, or null if not found.
 * @param {string} mode  One of GAME_MODE.*
 */
function getGameModule(mode) {
  return gameRegistry[mode] || null;
}

module.exports = { getGameModule };
