// games/connectLetters.js  — Connect the Letters
'use strict';

const checkWord = require('check-word');
const dict      = checkWord('en');

const ALL_LETTERS = 'ABCDEFGHIJKLMNOPRSTUW';

const VALID_PAIRS = new Set([
  'AT','AN','AL','AR','AS','AK','AD','AY',
  'BA','BE','BT','BN','BO','BL','BY',
  'CA','CE','CH','CK','CL','CT','CN',
  'DA','DE','DK','DN','DO','DR','DS','DY',
  'EA','ED','EL','EN','ER','ES','ET','EW',
  'FA','FE','FL','FN','FT','FY',
  'GA','GE','GL','GN','GO','GS','GT',
  'HA','HE','HN','HO','HS','HT',
  'IA','IC','ID','IN','IO','IS','IT',
  'KA','KE','KN',
  'LA','LE','LK','LL','LO','LS','LT','LY',
  'MA','ME','MN','MO','MS','MT','MY',
  'NA','NE','NK','NO','NS','NT','NY',
  'OA','OB','OD','OF','ON','OR','OT','OW','OY',
  'PA','PE','PH','PK','PL','PN','PT','PY',
  'RA','RE','RK','RN','RO','RS','RT','RY',
  'SA','SE','SH','SK','SL','SM','SN','SO','SP','SS','ST','SW','SY',
  'TA','TE','TH','TK','TN','TO','TS','TT','TY',
  'UA','UE','UN','UP','UR','US','UT',
  'WA','WE','WN','WO','WS','WT',
  'YA','YE',
]);

function isValidPair(start, end) {
  return VALID_PAIRS.has(start + end);
}

function randomValidPair() {
  const candidates = [...VALID_PAIRS]
    .filter(p => p.length === 2 && ALL_LETTERS.includes(p[0]) && ALL_LETTERS.includes(p[1]) && p[0] !== p[1]);
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { start: pick[0], end: pick[1] };
}

function randomLetter() {
  return ALL_LETTERS[Math.floor(Math.random() * ALL_LETTERS.length)];
}

// ─── Dictionary + Definition ──────────────────────────────────────────────────
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

// Returns { valid: bool, definition: string|null }
async function lookupWord(word) {
  const w = word.toLowerCase();
  const apiKey = process.env.MW_API_KEY;
  if (!apiKey) {
    const valid = dict.check(w);
    return { valid, definition: null };
  }
  try {
    const res = await fetch(
      `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(w)}?key=${apiKey}`
    );
    if (!res.ok) { const v = dict.check(w); return { valid: v, definition: null }; }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length || typeof data[0] !== 'object') {
      return { valid: false, definition: null };
    }
    // Extract first short definition
    const entry = data[0];
    let definition = null;
    if (entry.shortdef && entry.shortdef.length) {
      definition = entry.shortdef[0];
    } else if (entry.def && entry.def[0]?.sseq?.[0]?.[0]?.[1]?.dt?.[0]?.[1]) {
      definition = entry.def[0].sseq[0][0][1].dt[0][1].replace(/\{[^}]+\}/g, '').trim();
    }
    return { valid: true, definition };
  } catch {
    return { valid: dict.check(w), definition: null };
  }
}

// ─── init ─────────────────────────────────────────────────────────────────────
function init(players, options = {}) {
  const n         = players.length;
  const playerIds = players.map(p => p.id);

  const isSolo        = n === 1;
  const is1v1         = n === 2;
  const isRoyalRumble = n >= 3;
  const bo = isSolo ? null : (options.bo || 3);

  const roundWins = {};
  for (const p of players) roundWins[p.id] = 0;

  return {
    playerIds,
    isSolo,
    is1v1,
    isRoyalRumble,
    bo,
    winsNeeded:        bo ? Math.ceil(bo / 2) : null,
    roundWins,
    round:             0,
    roundState:        'IDLE',
    startLetter:       null,
    endLetter:         null,
    submittedLetters:  {},
    roundWinner:       null,
    challengeActive:   false,
    challengeDeadline: null,
    matchWinner:       null,
    simultaneous:      true,
    systemLetters:     !is1v1,
    // Word history: every submission across all rounds, keyed by playerId
    wordHistory:       Object.fromEntries(playerIds.map(id => [id, []])),
  };
}

// ─── startRound ───────────────────────────────────────────────────────────────
function startRound(gameData) {
  gameData.round            += 1;
  gameData.roundWinner       = null;
  gameData.challengeActive   = false;
  gameData.challengeDeadline = null;
  gameData.submittedLetters  = {};

  if (gameData.systemLetters) {
    const pair = randomValidPair();
    gameData.startLetter = pair.start;
    gameData.endLetter   = pair.end;
    gameData.roundState  = 'ACTIVE';
  } else {
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
// Returns rich result including definition and rejection reason for history.
async function handleAction(gameData, currentPlayer, data) {
  if (gameData.roundState !== 'ACTIVE' && gameData.roundState !== 'CHALLENGE') {
    return { success: false, error: 'Round is not active.' };
  }

  const word  = (data?.word || '').trim().toUpperCase();
  const pid   = currentPlayer.id;
  const start = gameData.startLetter;
  const end   = gameData.endLetter;

  if (!word || word.length < 2) return { success: false, error: 'Word too short.' };
  if (!/^[A-Z]+$/.test(word))   return { success: false, error: 'Letters only.' };

  const wrongStart = word[0] !== start;
  const wrongEnd   = word[word.length - 1] !== end;

  // Always look up the word so we can show a definition even for rejected valid words
  const { valid: isEnglishWord, definition } = await lookupWord(word);

  // Ensure history array exists for this player
  if (!gameData.wordHistory) gameData.wordHistory = {};
  if (!gameData.wordHistory[pid]) gameData.wordHistory[pid] = [];

  if (!isEnglishWord) {
    // Not a real word
    gameData.wordHistory[pid].push({
      word,
      status: 'invalid_dict',
      round:  gameData.round,
      definition: null,
      rejectionReason: null,
      startLetter: start,
      endLetter: end,
    });
    return {
      success:     false,
      error:       `"${word}" is not a valid English word.`,
      invalidWord: true,
      challengerId: pid,
      historyEntry: gameData.wordHistory[pid].at(-1),
    };
  }

  if (wrongStart || wrongEnd) {
    // Valid English word but wrong letters
    const reasons = [];
    if (wrongStart) reasons.push(`must start with "${start}"`);
    if (wrongEnd)   reasons.push(`must end with "${end}"`);
    const rejectionReason = reasons.join(' and ');

    gameData.wordHistory[pid].push({
      word,
      status: 'wrong_letters',
      round:  gameData.round,
      definition,
      rejectionReason,
      startLetter: start,
      endLetter: end,
    });
    return {
      success:         false,
      error:           `"${word}" ${rejectionReason}.`,
      wrongLetters:    true,
      definition,
      rejectionReason,
      historyEntry:    gameData.wordHistory[pid].at(-1),
    };
  }

  // Accepted
  gameData.wordHistory[pid].push({
    word,
    status: 'accepted',
    round:  gameData.round,
    definition,
    rejectionReason: null,
    startLetter: start,
    endLetter: end,
  });

  gameData.roundWinner     = pid;
  gameData.roundState      = 'IDLE';
  gameData.challengeActive = false;

  if (gameData.isSolo) {
    return {
      success:      true,
      word,
      definition,
      roundWinner:  pid,
      isSolo:       true,
      soloWordCount: gameData.wordHistory[pid].filter(e => e.status === 'accepted').length,
      wordHistory:  gameData.wordHistory[pid],
    };
  }

  gameData.roundWins[pid] = (gameData.roundWins[pid] || 0) + 1;
  const wins     = gameData.roundWins[pid];
  const matchWon = wins >= gameData.winsNeeded;
  if (matchWon) gameData.matchWinner = pid;

  return {
    success:     true,
    word,
    definition,
    roundWinner: pid,
    roundWins:   gameData.roundWins,
    matchWon,
    matchWinner: gameData.matchWinner,
    wordHistory: gameData.wordHistory,
  };
}

// ─── checkGameEnd ─────────────────────────────────────────────────────────────
function checkGameEnd(gameData) {
  if (gameData.isSolo) return false;
  return !!gameData.matchWinner;
}

// ─── getInitialPayload ────────────────────────────────────────────────────────
function getInitialPayload(gameData) {
  const result = {};
  for (const id of (gameData.playerIds || [])) {
    result[id] = {
      isSolo:       gameData.isSolo,
      systemLetters: gameData.systemLetters,
      bo:           gameData.bo,
      winsNeeded:   gameData.winsNeeded,
      roundWins:    gameData.roundWins,
      round:        gameData.round,
      roundState:   gameData.roundState,
      startLetter:  gameData.startLetter,
      endLetter:    gameData.endLetter,
      wordHistory:  gameData.wordHistory || {},
    };
  }
  return result;
}

module.exports = {
  simultaneous: true,
  isValidPair,
  init,
  startRound,
  handleSetup,
  handleAction,
  checkGameEnd,
  getInitialPayload,
  isValidWord,
  lookupWord,
};
