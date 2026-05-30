// games/wordChain.js
// Word Chain — 1v1 Simultaneous Multiplayer
// Players build a 7-word compound chain, then race to guess each other's hidden words.
// Points are earned per word guessed — fewer hints used means a higher word score.

'use strict';

const compounds = require('./compounds.json');
const checkWord = require('check-word');
const dict = checkWord('en');

const ALLOWED_S_WORDS = new Set([
  'grass','boss','loss','toss','cross','glass','class','pass','mass','brass',
  'dress','press','stress','bless','chess','guess','mess','miss','kiss','bliss',
  'plus','bus','focus','status','campus','bonus','census','chorus','virus',
  'iris','axis','basis','crisis','thesis','radius','genius','terminus',
  'walrus','cactus','nexus','lexus','exodus','circus','mucus','hiatus',
  'abacus','ruckus','caucus','callus','corpus','rebus','anus','sinus',
  'cosmos','chaos','pathos','ethos','logos','kudos','truss','fuss','puss',
  'moss','toss','loss','boss','cross','across'
]);

/**
 * Check length and characters.
 */
function validateWord(word) {
  if (typeof word !== 'string') return { valid: false, error: 'Word must be a string.' };
  const w = word.trim().toLowerCase();
  if (!w) return { valid: false, error: 'Word cannot be empty.' };
  if (!/^[a-z]+$/.test(w)) return { valid: false, error: `"${w}" must contain only letters.` };
  if (w.length > 9) return { valid: false, error: `"${w}" exceeds 9 letters.` };
  
  // Basic plural validation
  if (w.length > 3 && w.endsWith('s') && !ALLOWED_S_WORDS.has(w) && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && !w.endsWith('as') && !w.endsWith('os')) {
      return { valid: false, error: `"${w}" appears to be plural. Plural words ending in "s" are not allowed.` };
  }
  
  return { valid: true, word: w };
}

/**
 * Generate a valid 7-word chain.
 */
function generateWordChain() {
  const chain = compounds[Math.floor(Math.random() * compounds.length)];
  return [...chain];
}

/**
 * Returns just the revealed prefix for the input fields.
 */
function buildRevealedWord(targetWord, revealedCount) {
  // Pad with spaces up to targetWord.length so the client knows the intended word length for UI features like "Last Letter"
  return targetWord.substring(0, revealedCount).padEnd(targetWord.length, ' ');
}

function buildRevealedWords(words, revealedCounts) {
  return words.map((word, i) => buildRevealedWord(word, revealedCounts[i]));
}

function getTargetId(gameData, playerId) {
  const playerIds = gameData.playerIds || Object.keys(gameData.chains || {}).filter(id => id !== 'system');
  const n = playerIds.length;
  if (n === 1 || n >= 4) {
    return 'system';
  }
  if (n === 2) {
    return playerIds.find(id => id !== playerId) || null;
  }
  if (n === 3) {
    // Circular: P0 guesses P2's words, P1 guesses P0's words, P2 guesses P1's words
    const idx = playerIds.indexOf(playerId);
    if (idx === -1) return null;
    const targetIdx = (idx - 1 + 3) % 3;
    return playerIds[targetIdx];
  }
  if (n === 4) {
    // Pairs: P0↔P2, P1↔P3
    const idx = playerIds.indexOf(playerId);
    if (idx === -1) return null;
    const targetIdx = (idx + 2) % 4;
    return playerIds[targetIdx];
  }
  return null;
}

function initGuessProgress(opponentWords) {
  const LEN = opponentWords.length;
  const revealedCounts = Array(LEN).fill(0);
  const wordScores = Array(LEN).fill(20);

  // First and last words are fully revealed.
  revealedCounts[0] = opponentWords[0].length;
  revealedCounts[LEN - 1] = opponentWords[LEN - 1].length;
  wordScores[0] = 0;
  wordScores[LEN - 1] = 0;

  // Start sequential guess at index 1
  revealedCounts[1] = 1;

  return {
    currentIndex: 1, // Target word to guess (1 to 5)
    mistakes: Array(LEN).fill(0),
    revealedCounts,
    wordScores,
    totalScore: 0,
    guessed: Array(LEN).fill(false),
  };
}

function initProgressIfReady(gameData, playerId) {
  const targetId = getTargetId(gameData, playerId);
  if (targetId && gameData.chains[targetId] && gameData.chains[targetId].submitted && !gameData.guessProgress[playerId]) {
    gameData.guessProgress[playerId] = initGuessProgress(gameData.chains[targetId].words);
  }

  // Check if someone else targets this player, and if so, initialize their progress if ready
  const playerIds = gameData.playerIds || Object.keys(gameData.chains || {}).filter(id => id !== 'system');
  for (const otherId of playerIds) {
    if (otherId === playerId) continue;
    const otherTargetId = getTargetId(gameData, otherId);
    if (otherTargetId === playerId && gameData.chains[playerId] && gameData.chains[playerId].submitted && !gameData.guessProgress[otherId]) {
      gameData.guessProgress[otherId] = initGuessProgress(gameData.chains[playerId].words);
    }
  }
}

// ─── Module API ───────────────────────────────────────────────────────────────

function init(players) {
  const chains = {};
  const guessProgress = {};
  const scores = {};
  const playerIds = players.map(p => p.id);
  const n = playerIds.length;

  for (const p of players) {
    chains[p.id] = { words: [], submitted: false, generatedWords: null };
    guessProgress[p.id] = null;
    scores[p.id] = 0;
  }

  if (n === 1 || n >= 4) {
    // System provides words — no setup phase needed
    const systemWords = generateWordChain();
    chains['system'] = { words: systemWords, submitted: true };
    for (const p of players) {
      chains[p.id].submitted = true;
      chains[p.id].words = systemWords;
      guessProgress[p.id] = initGuessProgress(systemWords);
    }
  }

  return { playerIds, chains, guessProgress, scores };
}

/**
 * Check that a single word exists in Merriam-Webster Collegiate.
 */
async function isValidWordAPI(word) {
  const apiKey = process.env.MW_API_KEY;
  if (!apiKey) return true; // No key → skip, keep game playable

  try {
    const res = await fetch(`https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(word)}?key=${apiKey}`);
    if (!res.ok) return true; // Network hiccup → allow
    const data = await res.json();
    // MW returns an array of entry objects when the word is found
    return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object';
  } catch (err) {
    console.error('MW word check error:', err);
    return true;
  }
}

async function isValidCompoundAPI(wordA, wordB) {
  const apiKey = process.env.MW_API_KEY;
  if (!apiKey) {
    console.warn("MW_API_KEY not found. Skipping strict API validation.");
    return true;
  }

  try {
    // Check joined (e.g., "starfish")
    const joined = `${wordA}${wordB}`;
    const joinedRes = await fetch(`https://www.dictionaryapi.com/api/v3/references/collegiate/json/${joined}?key=${apiKey}`);
    if (joinedRes.ok) {
      const data = await joinedRes.json();
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        return true;
      }
    }

    // Check spaced (e.g., "star light")
    const spaced = `${wordA} ${wordB}`;
    // Node.js fetch needs encodeURIComponent for spaces
    const spacedRes = await fetch(`https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(spaced)}?key=${apiKey}`);
    if (spacedRes.ok) {
      const data = await spacedRes.json();
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        return true;
      }
    }
  } catch (err) {
    console.error("Dictionary API error:", err);
    // On network failure, we can default to true so the game isn't unplayable
    return true;
  }

  return false;
}

async function handleSetup(gameData, socketId, data) {
  const { words, autoGenerate, skipCompoundValidation } = data || {};

  if (autoGenerate) {
    const generated = generateWordChain();
    // Return generated words but DO NOT mark as submitted. The client fills its inputs and then submits them manually.
    return { success: true, words: generated };
  }

  if (!Array.isArray(words) || words.length !== 7) {
    return { success: false, error: 'Provide exactly 7 words for your chain.' };
  }

  const validated = [];
  for (let i = 0; i < words.length; i++) {
    const res = validateWord(words[i]);
    if (!res.valid) return { success: false, error: `Word ${i + 1}: ${res.error}` };
    validated.push(res.word);
  }

  // Validate each individual word exists in Merriam-Webster
  for (let i = 0; i < validated.length; i++) {
    const exists = await isValidWordAPI(validated[i]);
    if (!exists) {
      return { success: false, error: `"${validated[i]}" is not a recognized word.` };
    }
  }

  // Validate that the submitted chain forms a true compound chain using the Dictionary API
  // (Skipped when the host has turned Dictionary Check OFF — spell check still runs above)
  if (!skipCompoundValidation) {
    for (let i = 0; i < validated.length - 1; i++) {
      const isValid = await isValidCompoundAPI(validated[i], validated[i + 1]);
      if (!isValid) {
        return { 
          success: false, 
          invalidCompound: {
            index1: i,
            index2: i + 1,
            word1: validated[i],
            word2: validated[i + 1]
          },
          error: `"${validated[i]}" and "${validated[i + 1]}" do not form a recognized compound phrase.`
        };
      }
    }
  }

  // Defensive initialization in case fast reconnect dropped the specific mapping
  if (!gameData.chains) gameData.chains = {};
  if (!gameData.chains[socketId]) {
    gameData.chains[socketId] = { words: [], submitted: false };
  }

  gameData.chains[socketId].words = validated;
  gameData.chains[socketId].submitted = true;

  // ── Collision detection: did both players pick the exact same chain? ──────
  const playerIds = gameData.playerIds || Object.keys(gameData.chains || {}).filter(id => id !== 'system');
  if (playerIds.length === 2) {
    const opponentId = playerIds.find(id => id !== socketId);
    if (opponentId && gameData.chains[opponentId] && gameData.chains[opponentId].submitted) {
      const opponentWords = gameData.chains[opponentId].words;
      const isSame = opponentWords.length === validated.length &&
        validated.every((w, i) => w === opponentWords[i]);

      if (isSame) {
        // Generate two distinct random chains
        let chain1, chain2;
        do {
          chain1 = generateWordChain();
          chain2 = generateWordChain();
        } while (chain1.join(',') === chain2.join(','));

        gameData.chains[socketId].words = chain1;
        gameData.chains[opponentId].words = chain2;
        // Both remain submitted = true — game can proceed
        initProgressIfReady(gameData, socketId);

        return {
          success: false,
          forceSync: true,
          error: 'Both players submitted the exact same set of words! ' +
                 'The system has automatically randomized both sets of words for you.',
        };
      }
    }
  }

  initProgressIfReady(gameData, socketId);
  return { success: true };
}

function handleAction(gameData, currentPlayer, data) {
  const guess = typeof data?.guess === 'string' ? data.guess.trim().toLowerCase() : null;
  if (!guess) return { success: false, error: 'A guess is required.' };

  // Guard against rapid duplicate submissions (e.g. double Enter key fire)
  if (!gameData._lastGuess) gameData._lastGuess = {};
  const lastGuess = gameData._lastGuess[currentPlayer.id];
  const now = Date.now();
  if (lastGuess && lastGuess.guess === guess && (now - lastGuess.time) < 800) {
    return { success: false, error: 'duplicate' };
  }
  gameData._lastGuess[currentPlayer.id] = { guess, time: now };

  const targetId = getTargetId(gameData, currentPlayer.id);
  if (!targetId || !gameData.chains[targetId]?.submitted) {
    return { success: false, error: 'Target player has not submitted their word chain yet.' };
  }

  if (!gameData.guessProgress) gameData.guessProgress = {};
  if (!gameData.guessProgress[currentPlayer.id]) {
    // Use the proper initialiser so first/last words are fully revealed
    // and all arrays (mistakes, wordScores, guessed) are correctly set up.
    const fallbackTargetId = getTargetId(gameData, currentPlayer.id);
    if (fallbackTargetId && gameData.chains[fallbackTargetId]) {
      gameData.guessProgress[currentPlayer.id] = initGuessProgress(gameData.chains[fallbackTargetId].words);
    } else {
      return { success: false, error: 'Game progress could not be initialised.' };
    }
  }

  const progress = gameData.guessProgress[currentPlayer.id];
  if (!progress) return { success: false, error: 'Game progress not initialised.' };

  const opponentWords = gameData.chains[targetId].words;

  // Evaluate only the current sequential target word
  if (progress.currentIndex > 5) {
      return { success: false, error: "You have already completed the word chain!" };
  }

  const targetIdx = progress.currentIndex;
  const targetWord = opponentWords[targetIdx];

  if (targetWord === guess) {
    // ── Correct guess ─────────────────────────────────────────────────────────
    const earned = progress.wordScores[targetIdx];
    progress.totalScore += earned;
    progress.guessed[targetIdx] = true;
    progress.revealedCounts[targetIdx] = targetWord.length; // fully revealed
    
    // Advance index and unlock next word's first letter
    progress.currentIndex += 1;
    if (progress.currentIndex <= 5) {
        progress.revealedCounts[progress.currentIndex] = 1;
    }

    if (!gameData.scores) gameData.scores = {};
    gameData.scores[currentPlayer.id] = progress.totalScore;

    // Record time taken if they just finished the last word
    if (progress.currentIndex > 5) {
      if (!gameData.timeTaken) gameData.timeTaken = {};
      if (!gameData.timeTaken[currentPlayer.id]) {
        const elapsedMs = Date.now() - (gameData.startTime || Date.now());
        gameData.timeTaken[currentPlayer.id] = parseFloat((elapsedMs / 1000).toFixed(2));
      }
    }

    return {
      success: true,
      correct: true,
      wordEarned: earned,
      totalScore: progress.totalScore,
      revealedWords: buildRevealedWords(opponentWords, progress.revealedCounts),
      currentIndex: progress.currentIndex
    };
  } else {
    // ── Incorrect guess ───────────────────────────────────────────────────────
    if (!dict.check(guess)) {
      return { success: false, error: 'Not a valid English word.' };
    }

    if (progress.revealedCounts[targetIdx] >= targetWord.length - 1) {
      return { success: false, error: 'Last Letter' };
    }

    progress.mistakes[targetIdx] += 1;
    progress.wordScores[targetIdx] = Math.max(0, 20 - (progress.mistakes[targetIdx] * 5));

    // Reveal next letter
    if (progress.revealedCounts[targetIdx] < targetWord.length) {
        progress.revealedCounts[targetIdx] += 1;
    }

    return {
        success: true,
        correct: false,
        mistakes: progress.mistakes[targetIdx],
        currentWordScore: progress.wordScores[targetIdx],
        revealedWords: buildRevealedWords(opponentWords, progress.revealedCounts),
        currentIndex: progress.currentIndex
    };
  }
}

function checkGameEnd(gameData) {
  const playerIds = gameData.playerIds || Object.keys(gameData.guessProgress || {});
  if (!playerIds || playerIds.length === 0) return false;
  
  for (const id of playerIds) {
    const prog = gameData.guessProgress[id];
    if (!prog) return false;
    if (prog.currentIndex <= 5) return false;
  }
  return true;
}

function getInitialPayload(gameData) {
  const result = {};
  const playerIds = gameData.playerIds || Object.keys(gameData.chains || {}).filter(id => id !== 'system');
  for (const id of playerIds) {
    const prog = gameData.guessProgress[id];
    const targetId = getTargetId(gameData, id);
    if (prog && targetId && gameData.chains[targetId]) {
      result[id] = {
        revealedWords: buildRevealedWords(gameData.chains[targetId].words, prog.revealedCounts),
        currentIndex: prog.currentIndex
      };
    }
  }
  return result;
}

module.exports = {
  simultaneous: true, // Tell gameEngine.js to bypass turn enforce
  init,
  handleSetup,
  handleAction,
  validateWord,
  buildRevealedWord,
  checkGameEnd,
  getInitialPayload,
  isValidWordAPI,
};
