// games/wordChain.js
// Word Chain — 1v1 Simultaneous Multiplayer

'use strict';

const compounds = require('./compounds.json');
const checkWord = require('check-word');
const dict = checkWord('en');

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
  if (w.length > 3 && w.endsWith('s') && !['grass', 'boss', 'loss', 'toss', 'cross', 'glass', 'class', 'pass', 'mass', 'brass'].includes(w)) {
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
  return targetWord.substring(0, revealedCount);
}

function buildRevealedWords(words, revealedCounts) {
  return words.map((word, i) => buildRevealedWord(word, revealedCounts[i]));
}

function getOpponentId(gameData, playerId) {
  return Object.keys(gameData.chains).find(id => id !== playerId) || null;
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
  const opponentId = getOpponentId(gameData, playerId);
  if (!opponentId) return;

  if (gameData.chains[opponentId].submitted && !gameData.guessProgress[playerId]) {
    gameData.guessProgress[playerId] = initGuessProgress(gameData.chains[opponentId].words);
  }
  if (gameData.chains[playerId].submitted && !gameData.guessProgress[opponentId]) {
    gameData.guessProgress[opponentId] = initGuessProgress(gameData.chains[playerId].words);
  }
}

// ─── Module API ───────────────────────────────────────────────────────────────

function init(players) {
  const chains = {};
  const guessProgress = {};
  const scores = {};

  for (const p of players) {
    chains[p.id] = { words: [], submitted: false, generatedWords: null };
    guessProgress[p.id] = null;
    scores[p.id] = 0;
  }
  return { chains, guessProgress, scores };
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
  const { words, autoGenerate } = data || {};

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

  // Validate that the submitted chain forms a true compound chain using the Dictionary API
  for (let i = 0; i < validated.length - 1; i++) {
    const isValid = await isValidCompoundAPI(validated[i], validated[i + 1]);
    if (!isValid) {
      const generated = generateWordChain();
      return { 
        success: false, 
        error: `"${validated[i]}" and "${validated[i + 1]}" do not form a recognized compound phrase. The system has auto-generated a new set for you.`,
        words: generated
      };
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
  const opponentId = Object.keys(gameData.chains).find(id => id !== socketId);
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

  initProgressIfReady(gameData, socketId);
  return { success: true };
}

function handleAction(gameData, currentPlayer, data) {
  const guess = typeof data?.guess === 'string' ? data.guess.trim().toLowerCase() : null;
  if (!guess) return { success: false, error: 'A guess is required.' };

  const opponentId = getOpponentId(gameData, currentPlayer.id);
  if (!opponentId || !gameData.chains[opponentId]?.submitted) {
    return { success: false, error: 'Opponent has not submitted their word chain yet.' };
  }

  if (!gameData.guessProgress) gameData.guessProgress = {};
  if (!gameData.guessProgress[currentPlayer.id]) {
    gameData.guessProgress[currentPlayer.id] = { currentIndex: 1, revealedCounts: [], mistakes: 0 };
    // Start with 1 letter revealed for the first word
    gameData.guessProgress[currentPlayer.id].revealedCounts[1] = 1; 
  }

  const progress = gameData.guessProgress[currentPlayer.id];
  if (!progress) return { success: false, error: 'Game progress not initialised.' };

  const opponentWords = gameData.chains[opponentId].words;

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
  const pIds = Object.keys(gameData.guessProgress);
  if (pIds.length !== 2) return false;
  
  for (const id of pIds) {
    const prog = gameData.guessProgress[id];
    if (!prog) return false;
    let finishedWords = 0;
    for (let i = 1; i <= 5; i++) {
      if (prog.guessed[i] || prog.revealedCounts[i] === gameData.chains[getOpponentId(gameData, id)].words[i].length) {
        finishedWords++;
      }
    }
    if (finishedWords < 5) return false; // This player isn't done
  }
  return true; // Both are done!
}

function getInitialPayload(gameData) {
  const result = {};
  for (const id of Object.keys(gameData.guessProgress)) {
    const prog = gameData.guessProgress[id];
    const opId = getOpponentId(gameData, id);
    if (prog && opId && gameData.chains[opId]) {
      result[id] = {
        revealedWords: buildRevealedWords(gameData.chains[opId].words, prog.revealedCounts),
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
};
