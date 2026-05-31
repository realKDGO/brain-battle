// games/connectLetters.js  — Connect the Letters
//
// Single Player (1P): Endless mode. System generates start+end letters.
//   Player has 15s to submit a valid word. On success or timeout → new letters, new 15s timer.
//   No Best-Of format. Game continues until player exits.
//
// 1v1 (2P): Setup phase required each round.
//   P1 submits a letter (start), P2 submits a letter (end). Letters hidden until both submit.
//   Countdown begins only after both letters are in.
//   Best-Of format (BO3/BO5/BO7). First to ceil(N/2) round wins.
//
// Royal Rumble (3P+): System generates start+end letters. No setup phase.
//   Best-Of format (BO3/BO5/BO7). First to ceil(N/2) round wins.
//   No 15-second timer. Rounds end by multiplayer round rules only.

'use strict';

const checkWord = require('check-word');
const dict      = checkWord('en');

const ALL_LETTERS = 'ABCDEFGHIJKLMNOPRSTUW';

function randomLetter() {
  return ALL_LETTERS[Math.floor(Math.random() * ALL_LETTERS.length)];
}

function randomLetterPair() {
  const s = randomLetter();
  let e;
  do { e = randomLetter(); } while (e === s);
  return { start: s, end: e };
}

// ─── Dictionary ───────────────────────────────────────────────────────────────
async function isValidWord(word) {
  const apiKey = process.env.MW_API_KEY;
  const w = word.toLowerCase();
  if (!apiKey) return dict.check(w);
  try {
    const res = await fetch(
      `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(w)}?key=${apiKey}`
    );
    if (!res.ok) return dict.check(w);
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object';
  } catch { return dict.check(w); }
}

// ─── init ─────────────────────────────────────────────────────────────────────
function init(players, options = {}) {
  const n         = players.length;
  const playerIds = players.map(p => p.id);

  // Mode detection
  const isSolo      = n === 1;   // Endless, no BO
  const is1v1       = n === 2;   // Player-provided letters, BO
  const isRoyalRumble = n >= 3;  // System letters, BO

  const bo = isSolo ? null : (options.bo || 3);  // Solo has no BO

  const roundWins = {};
  for (const p of players) roundWins[p.id] = 0;

  const gameData = {
    playerIds,
    isSolo,
    is1v1,
    isRoyalRumble,
    bo,
    winsNeeded: bo ? Math.ceil(bo / 2) : null,
    roundWins,
    round: 0,
    roundState: 'IDLE', // IDLE | LETTER_INPUT | ACTIVE | CHALLENGE
    startLetter: null,
    endLetter: null,
    submittedLetters: {},
    roundWinner: null,
    challengeActive: false,
    challengeDeadline: null,
    matchWinner: null,
    simultaneous: true,
    // systemLetters: true for 1P and 3P+, false for 2P
    systemLetters: !is1v1,
    // Track solo successful words
    soloWords: isSolo ? [] : null,
  };

  return gameData;
}

// ─── startRound ───────────────────────────────────────────────────────────────
function startRound(gameData) {
  gameData.round += 1;
  gameData.roundWinner = null;
  gameData.challengeActive = false;
  gameData.challengeDeadline = null;
  gameData.submittedLetters = {};

  if (gameData.systemLetters) {
    // 1P and 3P+: system picks letters
    const pair = randomLetterPair();
    gameData.startLetter = pair.start;
    gameData.endLetter   = pair.end;
    gameData.roundState  = 'ACTIVE';
  } else {
    // 2P: players must submit letters first
    gameData.startLetter = null;
    gameData.endLetter   = null;
    gameData.roundState  = 'LETTER_INPUT';
  }

  return {
    startLetter: gameData.startLetter,
    endLetter:   gameData.endLetter,
    round:       gameData.round,
    roundState:  gameData.roundState,
  };
}

// ─── handleSetup: 2P letter submission ───────────────────────────────────────
function handleSetup(gameData, socketId, data) {
  if (gameData.roundState !== 'LETTER_INPUT') {
    return { success: false, error: 'Not in letter input phase.' };
  }

  const letter = (data?.letter || '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(letter)) {
    return { success: false, error: 'Please submit exactly one letter (A–Z).' };
  }

  gameData.submittedLetters[socketId] = letter;

  const allIn = gameData.playerIds.every(id => gameData.submittedLetters[id]);
  if (!allIn) return { success: true, waiting: true };

  // Both submitted — assign letters
  const [p0, p1] = gameData.playerIds;
  let start = gameData.submittedLetters[p0];
  let end   = gameData.submittedLetters[p1];
  if (start === end) {
    do { end = randomLetter(); } while (end === start);
  }
  gameData.startLetter = start;
  gameData.endLetter   = end;
  gameData.roundState  = 'ACTIVE';

  return { success: true, ready: true, startLetter: start, endLetter: end };
}

// ─── handleAction ─────────────────────────────────────────────────────────────
async function handleAction(gameData, currentPlayer, data) {
  if (gameData.roundState !== 'ACTIVE' && gameData.roundState !== 'CHALLENGE') {
    return { success: false, error: 'Round is not active.' };
  }

  const word = (data?.word || '').trim().toUpperCase();
  if (!word || word.length < 2) return { success: false, error: 'Word too short.' };
  if (!/^[A-Z]+$/.test(word))   return { success: false, error: 'Letters only.' };

  if (word[0] !== gameData.startLetter) {
    return { success: false, error: `Word must start with "${gameData.startLetter}".` };
  }
  if (word[word.length - 1] !== gameData.endLetter) {
    return { success: false, error: `Word must end with "${gameData.endLetter}".` };
  }

  const valid = await isValidWord(word);

  if (!valid) {
    return {
      success: false,
      error: `"${word}" is not a valid word.`,
      invalidWord: true,
      challengerId: currentPlayer.id,
    };
  }

  // Valid word
  gameData.roundWinner    = currentPlayer.id;
  gameData.roundState     = 'IDLE';
  gameData.challengeActive = false;

  // Solo: record word, no round-win tracking
  if (gameData.isSolo) {
    gameData.soloWords = gameData.soloWords || [];
    gameData.soloWords.push(word);
    return {
      success: true,
      word,
      roundWinner: currentPlayer.id,
      isSolo: true,
      soloWordCount: gameData.soloWords.length,
    };
  }

  // 2P / 3P+: track round wins and check BO match end
  gameData.roundWins[currentPlayer.id] = (gameData.roundWins[currentPlayer.id] || 0) + 1;
  const wins = gameData.roundWins[currentPlayer.id];
  const matchWon = wins >= gameData.winsNeeded;
  if (matchWon) gameData.matchWinner = currentPlayer.id;

  return {
    success: true,
    word,
    roundWinner:  currentPlayer.id,
    roundWins:    gameData.roundWins,
    matchWon,
    matchWinner:  gameData.matchWinner,
  };
}

// ─── checkGameEnd ─────────────────────────────────────────────────────────────
function checkGameEnd(gameData) {
  if (gameData.isSolo) return false; // Endless — never auto-ends
  return !!gameData.matchWinner;
}

// ─── getInitialPayload ────────────────────────────────────────────────────────
function getInitialPayload(gameData) {
  const result = {};
  for (const id of (gameData.playerIds || [])) {
    result[id] = {
      isSolo:      gameData.isSolo,
      bo:          gameData.bo,
      winsNeeded:  gameData.winsNeeded,
      roundWins:   gameData.roundWins,
      round:       gameData.round,
      roundState:  gameData.roundState,
      startLetter: gameData.startLetter,
      endLetter:   gameData.endLetter,
    };
  }
  return result;
}

module.exports = {
  simultaneous: true,
  init,
  startRound,
  handleSetup,
  handleAction,
  checkGameEnd,
  getInitialPayload,
  isValidWord,
};
