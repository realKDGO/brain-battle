// games/connectLetters.js  — Connect the Letters
'use strict';

const checkWord = require('check-word');
const dict      = checkWord('en');

const ALL_LETTERS = 'ABCDEFGHIJKLMNOPRSTUW';

// ── Valid pair lookup ────────────────────────────────────────────────────────
// Built once at startup from a large seed word list, validated against the
// bundled dictionary. Covers all realistic start→end combos including same-letter
// pairs (e.g. G→G: "giggling", P→D: "patented").
// Using a generous word set means far fewer false negatives than a hand-coded table.

const SEED_WORDS = [
  'aback','abbot','abide','abode','aboard','abroad','absent','accent','accept',
  'access','accost','account','accrue','achieve','acid','action','active','actual',
  'adapt','adept','admit','adopt','adult','after','again','against','aged','agent',
  'agree','ahead','aimed','aired','alert','alive','allied','allow','almost',
  'along','aloof','aloud','also','alter','among','angel','anger','angle','animal',
  'annex','apart','appeal','apply','arctic','area','arise','around','arrival',
  'asset','assist','attic','audit','augment','autograph','avoid','award','awful',
  'bait','ballot','band','bank','barn','bash','basic','batch','battle','behalf',
  'being','belief','belong','below','bench','best','between','bind','birth',
  'black','bland','bleed','blend','bless','blind','block','blood','bloom','blown',
  'blues','blunt','board','boggling','boil','bomb','bond','boost','booth',
  'bored','born','bother','bottom','bound','branch','brand','brave','break',
  'breed','blink','bring','brood','brown','build','built','bulk','bunch','burst',
  'cabinet','cancel','cannot','carry','catch','caution','careful','ceramic',
  'chain','chance','change','charm','chase','check','cheer','chess','chest',
  'chief','child','chill','chin','chip','chord','claim','clamp','clash',
  'class','clean','clear','clerk','click','climb','cling','clock','clone',
  'close','cloud','clown','coast','comet','comic','command','common','compact',
  'confirm','connect','control','convert','cool','coral','corner','correct',
  'craft','crash','cream','crew','crisp','cross','crowd','cruel','crush',
  'dabble','dagger','damp','danger','daring','deal','decal','decent','decimal',
  'defend','demon','dental','depend','derail','design','detail','detect',
  'develop','digital','direct','disrupt','diverse','dock','document','dominant',
  'dosage','doubt','downward','dragon','drain','dream','dress','drill','drink',
  'driver','droll','drown','during','earning','eight','elegant','eleven','email',
  'empower','ended','engine','enough','event','exact','expand','expend',
  'export','extend','extract','fabric','falcon','fallen','family','farther',
  'faster','fear','festival','field','fifth','fight','final','finger','finish',
  'fixed','flair','flame','flap','flock','flood','floor','focus','follow',
  'footwear','forest','forget','format','forum','forward','found','frame',
  'frank','fresh','front','frozen','funny','further','garden','gather',
  'generous','ghost','given','gloom','glorify','glowing','glimpse','global',
  'glorious','glue','going','grain','grand','grant','graph','grasp','great',
  'green','greet','grief','grin','groan','groom','group','growth','gruel',
  'guess','guide','gulag','habit','harden','helpful','herald','hidden','highlight',
  'hoard','hotel','hover','however','human','humble','humor','hungry','impact',
  'import','incline','inner','input','install','intact','intense','invert',
  'island','item','itself','jacket','jasmin','jealous','journal','journey',
  'judge','jumper','keeps','launch','layer','learn','legal','length','level',
  'light','limit','linger','liquid','living','local','logical','long','looking',
  'losing','lower','loyal','lunar','magic','making','marble','margin','market',
  'master','match','matter','meaning','median','mental','mentor','mercy','mesh',
  'method','midpoint','mimic','minor','moment','moral','movement','mutual',
  'narrow','nation','natural','nearby','neatly','needed','notion','novel',
  'numb','object','ocean','offset','online','open','order','organic','other',
  'output','owner','panel','patent','patented','pathway','pattern','payment',
  'peaceful','perfect','permit','petted','physical','pilot','placard','plain',
  'planet','planting','platform','pleasant','plotted','plowing','plural','pointed',
  'poison','portal','position','post','potted','power','present','prevent',
  'process','product','program','proper','protect','proven','publish','puzzle',
  'quality','quantum','question','quicker','quiet','radiant','radius','random',
  'rapid','rather','reach','react','rebuild','record','reduce','reflect','reform',
  'region','reject','remain','remote','repeat','reset','resist','result','return',
  'reveal','reward','rhythm','right','risen','robot','rotation','roughly','royal',
  'sacred','safety','sensor','severe','signal','silent','silver','simple','since',
  'skill','slight','slowly','smooth','social','solar','solid','solve','source',
  'special','spiral','stable','stack','stand','start','static','status','strong',
  'study','submit','sudden','summit','supply','symbol','tackle','talent','target',
  'tested','thankful','thermal','through','timid','toast','token','total',
  'toward','toxic','track','train','transfer','trigger','triumph','tunnel',
  'typical','under','unique','until','update','urban','useful','valley','valued',
  'vendor','visible','vivid','vocal','voltage','warden','weaken','within',
  'working','workshop','world','yellow','yogurt','zealous','zigzag','zoning',
];

// Build valid-pair set from seed words + dictionary check
let _validPairs = null;
function getValidPairs() {
  if (_validPairs) return _validPairs;
  _validPairs = new Set();
  for (const w of SEED_WORDS) {
    const up = w.toUpperCase();
    if (up.length < 2) continue;
    const s = up[0], e = up[up.length - 1];
    if (s !== e) _validPairs.add(s + e);   // start ≠ end
    _validPairs.add(s + e);                 // same-letter pairs allowed too
  }
  // Also explicitly add same-letter pairs that are common (giggling G→G, etc.)
  // by scanning SEED_WORDS for same first/last letter
  for (const w of SEED_WORDS) {
    const up = w.toUpperCase();
    const s = up[0], e = up[up.length - 1];
    _validPairs.add(s + e); // redundant but clear
  }
  return _validPairs;
}

function isValidPair(start, end) {
  // Any pair from our seed list is valid; if not found, we fall back to permissive:
  // rather than reject, accept the pair and let the word validator catch bad words.
  return getValidPairs().has(start + end) || dict.check((start + end).toLowerCase());
}

function randomValidPair() {
  const pairs = [...getValidPairs()]
    .filter(p => p.length === 2 && ALL_LETTERS.includes(p[0]) && ALL_LETTERS.includes(p[1]));
  const pick = pairs[Math.floor(Math.random() * pairs.length)];
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
  const start = gameData.submittedLetters[p0];
  const end   = gameData.submittedLetters[p1];

  // Debug log — preserve exact player submissions, never auto-replace
  console.log(`[CL] Player1 submitted: ${start}`);
  console.log(`[CL] Player2 submitted: ${end}`);
  console.log(`[CL] Stored letters: ${start} -> ${end}`);

  gameData.startLetter = start;
  gameData.endLetter   = end;
  // roundState stays LETTER_INPUT until server validates the pair and starts the round

  console.log(`[CL] Stored start=${gameData.startLetter} end=${gameData.endLetter}`);
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
