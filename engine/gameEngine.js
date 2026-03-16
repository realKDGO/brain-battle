// engine/gameEngine.js
// Server-authoritative game state machine.
//
// Owns all state transitions and turn management.
// Never mutates rooms directly from server.js — call these functions instead.

const { GAME_STATE, GAME_MODE } = require("./constants");
const { getRoom, getRooms }     = require("../rooms/roomManager");
const { getGameModule }         = require("../games/index");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve and validate a room, returning an error payload if invalid.
 * @returns {{ room: object }|{ error: string }}
 */
function resolveRoom(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return { error: `Room "${roomCode}" does not exist.` };
  return { room };
}

/**
 * Resolve the game module for a room's current gameMode.
 * @returns {{ mod: object }|{ error: string }}
 */
function resolveModule(room) {
  const mod = getGameModule(room.gameMode);
  if (!mod) return { error: `Unknown or unset game mode: "${room.gameMode}".` };
  return { mod };
}

/**
 * Determine the winner from scores stored in gameData.
 * Falls back to "No winner" if scores aren't present.
 */
function computeWinner(room) {
  const { gameData, players } = room;
  if (!gameData.scores) return null;

  let best = -Infinity;
  let tied = false;
  let winnerId = null;

  for (const [id, score] of Object.entries(gameData.scores)) {
    if (score > best) {
      best = score;
      winnerId = id;
      tied = false;
    } else if (score === best) {
      tied = true;
    }
  }

  if (tied) return null; // It's a draw!
  return players.find((p) => p.id === winnerId) || null;
}

// ─── State Transitions ───────────────────────────────────────────────────────

/**
 * WAITING → SETUP
 * Initialises gameData via the game module.
 * @param {string} roomCode
 * @returns {{ success: boolean, room?: object, error?: string }}
 */
function startSetup(roomCode) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.LOBBY) {
    return { success: false, error: `Cannot start setup from state "${room.gameState}".` };
  }
  if (!room.gameMode) {
    return { success: false, error: "Set a game mode before starting setup." };
  }

  const { mod, error: modErr } = resolveModule(room);
  if (modErr) return { success: false, error: modErr };

  room.gameData  = mod.init(room.players);
  room.gameState = GAME_STATE.SETUP;

  console.log(`[Engine] ${roomCode} → SETUP (mode: ${room.gameMode})`);
  return { success: true, room };
}

/**
 * SETUP → ACTIVE
 * Picks the first player's turn (random).
 * @param {string} roomCode
 * @returns {{ success: boolean, room?: object, error?: string }}
 */
function startGame(roomCode) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.SETUP) {
    return { success: false, error: `Cannot start game from state "${room.gameState}".` };
  }

  // Pick a random starting player
  room.gameData.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
  room.gameData.round = (room.gameData.round || 0) + 1;
  room.gameState = GAME_STATE.ACTIVE;

  console.log(
    `[Engine] ${roomCode} → ACTIVE | turn: ${room.players[room.gameData.currentPlayerIndex].name}`
  );
  
  // Expose initial payload to clients if the module supports it (e.g., Word Chain revealed words)
  const { mod } = resolveModule(room);
  let payload = {};
  if (mod && mod.getInitialPayload) {
      payload = mod.getInitialPayload(room.gameData);
  }

  return { success: true, room, payload };
}

/**
 * ACTIVE → ROUND_END
 * Locks in round results.
 * @param {string} roomCode
 * @returns {{ success: boolean, room?: object, error?: string }}
 */
function endRound(roomCode) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.ACTIVE) {
    return { success: false, error: `Cannot end round from state "${room.gameState}".` };
  }

  room.gameState = GAME_STATE.ROUND_END;
  room.gameData.roundResults = {
    round: room.gameData.round,
    scores: { ...(room.gameData.scores || {}) },
    timestamp: Date.now(),
  };

  console.log(`[Engine] ${roomCode} → ROUND_END`);
  return { success: true, room };
}

/**
 * ROUND_END → GAME_END
 * Determines the overall winner.
 * @param {string} roomCode
 * @returns {{ success: boolean, room?: object, winner?: object, error?: string }}
 */
function endGame(roomCode) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.ROUND_END) {
    return { success: false, error: `Cannot end game from state "${room.gameState}".` };
  }

  const winner = computeWinner(room);
  room.gameData.winner = winner;
  room.gameState = GAME_STATE.GAME_END;

  console.log(`[Engine] ${roomCode} → GAME_END | winner: ${winner?.name ?? "none"}`);
  return { success: true, room, winner };
}

/**
 * GAME_END → WAITING
 * Resets the room so a new game can be started.
 * @param {string} roomCode
 * @returns {{ success: boolean, room?: object, error?: string }}
 */
function resetGame(roomCode) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.GAME_END) {
    return { success: false, error: `Cannot reset from state "${room.gameState}".` };
  }

  // Initialize game-specific data for a fresh round
  const { getGameModule } = require("../games/index");
  const mod = getGameModule(room.gameMode);
  if (mod && mod.init) {
    room.gameData = mod.init(room.players);
  } else {
    room.gameData = {};
  }

  room.gameState = GAME_STATE.SETUP;

  console.log(`[Engine] ${roomCode} → SETUP (reset)`);
  return { success: true, room };
}

// ─── Turn Management ─────────────────────────────────────────────────────────

/**
 * Return the player whose turn it currently is, or null.
 * @param {string} roomCode
 * @returns {{ success: boolean, player?: object, error?: string }}
 */
function getCurrentPlayer(roomCode) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.ACTIVE) {
    return { success: false, error: "Not in an active game." };
  }

  const idx    = room.gameData.currentPlayerIndex ?? 0;
  const player = room.players[idx] || null;
  return { success: true, player };
}

/**
 * Advance to the next player's turn (round-robin).
 * Only valid during ACTIVE state.
 * @param {string} roomCode
 * @returns {{ success: boolean, player?: object, error?: string }}
 */
function nextTurn(roomCode) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.ACTIVE) {
    return { success: false, error: "Can only advance turns during an ACTIVE game." };
  }

  const count = room.players.length;
  room.gameData.currentPlayerIndex =
    ((room.gameData.currentPlayerIndex ?? 0) + 1) % count;

  const player = room.players[room.gameData.currentPlayerIndex];
  console.log(`[Engine] ${roomCode} → nextTurn: ${player.name}`);
  return { success: true, player, room };
}

// ─── Validated Action Handlers ────────────────────────────────────────────────

/**
 * A player submits data during the SETUP phase.
 * @param {string} roomCode
 * @param {string} socketId
 * @param {object} data       Game-specific setup payload
 * @returns {{ success: boolean, room?: object, error?: string }}
 */
async function submitSetup(roomCode, socketId, data) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.SETUP) {
    return { success: false, error: "Setup submissions are only allowed during SETUP." };
  }

  const { mod, error: modErr } = resolveModule(room);
  if (modErr) return { success: false, error: modErr };

  if (typeof mod.handleSetup !== "function") {
    return { success: false, error: "Game module does not support setup." };
  }

  const result = await mod.handleSetup(room.gameData, socketId, data);
  if (!result.success) return result;

  return { success: true, room, ...result };
}

/**
 * The current player submits a game action during ACTIVE.
 * Guards that only the current player can act.
 * @param {string} roomCode
 * @param {string} socketId
 * @param {object} data       Game-specific action payload
 * @returns {{ success: boolean, room?: object, error?: string }}
 */
function submitAction(roomCode, socketId, data) {
  const { room, error } = resolveRoom(roomCode);
  if (error) return { success: false, error };

  if (room.gameState !== GAME_STATE.ACTIVE) {
    return { success: false, error: "Actions are only allowed during an ACTIVE game." };
  }

  const { mod, error: modErr } = resolveModule(room);
  if (modErr) return { success: false, error: modErr };

  let actionPlayer;
  if (mod.simultaneous) {
    actionPlayer = room.players.find(p => p.id === socketId);
    if (!actionPlayer) return { success: false, error: "You are not in this game." };
  } else {
    const { player: currentPlayer, error: turnErr } = getCurrentPlayer(roomCode);
    if (turnErr) return { success: false, error: turnErr };

    if (currentPlayer.id !== socketId) {
      return { success: false, error: "It is not your turn." };
    }
    actionPlayer = currentPlayer;
  }

  const result = mod.handleAction(room.gameData, actionPlayer, data);
  if (!result.success) return result;

  return { success: true, ...result, room };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // State transitions
  startSetup,
  startGame,
  endRound,
  endGame,
  resetGame,
  // Turn management
  nextTurn,
  getCurrentPlayer,
  // Player actions
  submitSetup,
  submitAction,
};
