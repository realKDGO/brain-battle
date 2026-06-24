// games/wordle.js
// Wordle — 1v1 Simultaneous Multiplayer
// Players submit a word for their opponent to guess, then race to guess it.

'use strict';

const checkWord = require('check-word');
const dict = checkWord('en');
const { isValidWordAPI } = require('./wordChain');

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(players, config = {}) {
  const playerIds = players.map(p => p.id);
  const scores = {};
  const chains = {};
  const guessProgress = {};
  
  const wordLength = config.wordLength || 5;

  for (const p of players) {
    scores[p.id] = 0;
    chains[p.id] = { word: null, submitted: false };
    guessProgress[p.id] = {
      guesses: [], // Array of { word, result: ['green', 'yellow', 'gray'] }
      finished: false,
      won: false
    };
  }

  return {
    playerIds,
    scores,
    wordLength,
    maxRounds: 6,
    chains,
    guessProgress,
    timeTaken: {},
    startTime: null // set when ACTIVE begins
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTargetId(gameData, playerId) {
  const n = gameData.playerIds.length;
  if (n === 2) {
    return gameData.playerIds.find(id => id !== playerId) || null;
  }
  return null; // Only 2 player supported in Phase 1
}

function validateWord(word, expectedLength) {
  if (typeof word !== 'string') return { valid: false, error: 'Word must be a string.' };
  const w = word.trim().toLowerCase();
  if (!w) return { valid: false, error: 'Word cannot be empty.' };
  if (!/^[a-z]+$/.test(w)) return { valid: false, error: `"${w}" must contain only letters.` };
  if (w.length !== expectedLength) return { valid: false, error: `Word must be exactly ${expectedLength} letters.` };
  
  return { valid: true, word: w };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

async function handleSetup(gameData, socketId, data) {
  const { targetWord } = data || {};
  
  const res = validateWord(targetWord, gameData.wordLength);
  if (!res.valid) return { success: false, error: res.error };
  const word = res.word;

  // Dictionary Check if enabled (assume enabled by default unless dictEnabled=false is passed via room context)
  // We'll just do basic spell check and API check. The dictionary toggle logic usually controls if skipValidation is passed.
  // Actually, gameEngine submitSetup doesn't pass dictEnabled to module. We'll check it here using wordChain's API check.
  const exists = await isValidWordAPI(word);
  if (!exists) {
    return { success: false, error: `"${word}" is not a recognized word.` };
  }

  if (!gameData.chains[socketId]) {
    gameData.chains[socketId] = { word: null, submitted: false };
  }

  gameData.chains[socketId].word = word;
  gameData.chains[socketId].submitted = true;

  return { success: true };
}

// ─── Action ──────────────────────────────────────────────────────────────────

function handleAction(gameData, currentPlayer, data) {
  const guess = typeof data?.guess === 'string' ? data.guess.trim().toLowerCase() : null;
  if (!guess) return { success: false, error: 'A guess is required.' };

  const targetId = getTargetId(gameData, currentPlayer.id);
  if (!targetId || !gameData.chains[targetId]?.submitted) {
    return { success: false, error: 'Target player has not submitted their word yet.' };
  }

  const targetWord = gameData.chains[targetId].word;
  const progress = gameData.guessProgress[currentPlayer.id];
  
  if (progress.finished) {
    return { success: false, error: 'You have already finished.' };
  }

  const res = validateWord(guess, gameData.wordLength);
  if (!res.valid) return { success: false, error: res.error };

  // Validate english word
  if (!dict.check(res.word)) {
    return { success: false, error: 'Not a valid English word.' };
  }

  // Calculate Green/Yellow/Gray array
  // Colors: 'green', 'yellow', 'gray'
  const resultColors = Array(gameData.wordLength).fill('gray');
  const targetChars = targetWord.split('');
  const guessChars = res.word.split('');
  
  // First pass: find greens
  for (let i = 0; i < gameData.wordLength; i++) {
    if (guessChars[i] === targetChars[i]) {
      resultColors[i] = 'green';
      targetChars[i] = null; // Mark as used
      guessChars[i] = null;
    }
  }

  // Second pass: find yellows
  for (let i = 0; i < gameData.wordLength; i++) {
    if (guessChars[i] !== null) {
      const idx = targetChars.indexOf(guessChars[i]);
      if (idx !== -1) {
        resultColors[i] = 'yellow';
        targetChars[idx] = null; // Mark as used
      }
    }
  }

  progress.guesses.push({ word: res.word, result: resultColors });

  const isWin = resultColors.every(c => c === 'green');
  const isLoss = progress.guesses.length >= gameData.maxRounds && !isWin;

  if (isWin || isLoss) {
    progress.finished = true;
    progress.won = isWin;
    
    // Record time taken
    if (!gameData.timeTaken) gameData.timeTaken = {};
    if (!gameData.timeTaken[currentPlayer.id]) {
      const elapsedMs = Date.now() - (gameData.startTime || Date.now());
      gameData.timeTaken[currentPlayer.id] = parseFloat((elapsedMs / 1000).toFixed(2));
    }
    
    // Simple speed scoring: arbitrary points based on time. 
    // Faster = more points. Max 10000 points.
    // e.g. Score = Max(0, 10000 - (seconds * 50))
    if (isWin) {
      const time = gameData.timeTaken[currentPlayer.id];
      let score = Math.max(0, 10000 - (time * 50));
      gameData.scores[currentPlayer.id] = Math.round(score);
    } else {
      gameData.scores[currentPlayer.id] = 0;
    }
  }

  return {
    success: true,
    correct: isWin,
    result: resultColors,
    guessRowIndex: progress.guesses.length - 1,
    finished: progress.finished,
    won: progress.won,
    guess: res.word
  };
}

// ─── Engine interface stubs ───────────────────────────────────────────────────

function getInitialPayload(gameData) {
  const payload = {};
  (gameData.playerIds || []).forEach(id => {
    payload[id] = {
      wordLength: gameData.wordLength,
      maxRounds:  gameData.maxRounds,
      scores:     gameData.scores,
      playerIds:  gameData.playerIds,
      guessProgress: gameData.guessProgress[id]
    };
  });
  return payload;
}

function checkGameEnd(gameData) {
  const playerIds = gameData.playerIds || Object.keys(gameData.guessProgress || {});
  if (!playerIds || playerIds.length === 0) return false;
  
  for (const id of playerIds) {
    const prog = gameData.guessProgress[id];
    if (!prog) return false;
    if (!prog.finished) return false;
  }
  return true;
}

module.exports = {
  simultaneous: true,
  init,
  handleSetup,
  handleAction,
  validateWord,
  getInitialPayload,
  checkGameEnd,
};
