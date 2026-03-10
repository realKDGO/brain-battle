// engine/constants.js
// Shared enumerations — import these instead of using raw strings.

const GAME_STATE = Object.freeze({
  WAITING:   "WAITING",
  SETUP:     "SETUP",
  ACTIVE:    "ACTIVE",
  ROUND_END: "ROUND_END",
  GAME_END:  "GAME_END",
});

const GAME_MODE = Object.freeze({
  WORD_CHAIN:      "WORD_CHAIN",
  GUESS_NUMBER:    "GUESS_NUMBER",
  CONNECT_LETTERS: "CONNECT_LETTERS",
});

module.exports = { GAME_STATE, GAME_MODE };
