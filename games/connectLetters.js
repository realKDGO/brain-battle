// games/connectLetters.js
// Connect Letters game module.
//
// Rules:
//   • A pool of letters is generated at game start.
//   • Players take turns submitting words that can be formed from the letter pool.
//   • Each letter in the pool may only be used once per word.
//   • Score = word length; longest combined score wins.

/**
 * Generate a random letter pool of the given size.
 * Weighted toward common English letters.
 */
function generateLetterPool(size = 12) {
  const weighted =
    "AAAABBCCDDEEEEEEFFGGHHIIIIJKKLLLLMMNNNNOOOOPPQRRRRSSSSTTTTUUUUVVWWXYYZ";
  const pool = [];
  for (let i = 0; i < size; i++) {
    pool.push(weighted[Math.floor(Math.random() * weighted.length)]);
  }
  return pool; // e.g. ["A","T","E","R","S",...]
}

/**
 * Return a fresh gameData object for a new Connect Letters session.
 * @param {Array<{id:string,name:string}>} players
 */
function init(players) {
  return {
    letterPool: generateLetterPool(12),
    submittedWords: [],     // { playerId, word, score, timestamp }
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    usedWords: new Set(),   // prevent duplicate words
  };
}

/**
 * No mandatory setup step — pool is generated on init.
 * This can optionally let host configure pool size in future.
 * @param {object} gameData
 * @param {string} _socketId
 * @param {{ poolSize?: number }} data
 * @returns {{ success: boolean }}
 */
function handleSetup(gameData, _socketId, data) {
  const poolSize = Number(data?.poolSize);
  if (poolSize && Number.isInteger(poolSize) && poolSize >= 6 && poolSize <= 20) {
    gameData.letterPool = generateLetterPool(poolSize);
  }
  return { success: true };
}

/**
 * Validate and record a word submission.
 * @param {object} gameData
 * @param {{id:string,name:string}} currentPlayer
 * @param {{ word: string }} data
 * @returns {{ success: boolean, score?: number, error?: string }}
 */
function handleAction(gameData, currentPlayer, data) {
  const word = String(data?.word || "").trim().toUpperCase();

  if (!word || word.length < 2) {
    return { success: false, error: "Word must be at least 2 letters." };
  }

  if (!/^[A-Z]+$/.test(word)) {
    return { success: false, error: "Word must contain only letters." };
  }

  if (gameData.usedWords.has(word)) {
    return { success: false, error: `"${word}" has already been submitted.` };
  }

  // Check the word can be formed from the available letter pool
  const poolCopy = [...gameData.letterPool];
  for (const letter of word) {
    const idx = poolCopy.indexOf(letter);
    if (idx === -1) {
      return {
        success: false,
        error: `"${word}" cannot be formed from the available letters.`,
      };
    }
    poolCopy.splice(idx, 1);
  }

  const score = word.length;
  gameData.scores[currentPlayer.id] = (gameData.scores[currentPlayer.id] || 0) + score;
  gameData.usedWords.add(word);
  gameData.submittedWords.push({
    playerId: currentPlayer.id,
    word,
    score,
    timestamp: Date.now(),
  });

  return { success: true, score };
}

module.exports = { init, handleSetup, handleAction };
