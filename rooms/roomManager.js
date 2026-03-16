// roomManager.js
// All room logic lives here — server.js stays clean.

const rooms = {};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a random 6-character uppercase room code.
 */
function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Regenerate if code already exists (extremely rare, but safe)
  return rooms[code] ? generateRoomCode() : code;
}

// ─── Room CRUD ───────────────────────────────────────────────────────────────

/**
 * Create a new room and add the host as the first player.
 * @returns {{ success: true, roomCode: string, room: object }
 *          |{ success: false, error: string }}
 */
function createRoom(socketId, playerName, gameType) {
  const roomCode = generateRoomCode();

  rooms[roomCode] = {
    host: socketId,
    players: [{ id: socketId, name: playerName }],
    gameMode: gameType,
    gameState: "LOBBY",
    gameData: {},
  };

  return { success: true, roomCode, room: rooms[roomCode] };
}

/**
 * Add a player to an existing room.
 * @returns {{ success: true, roomCode: string, room: object }
 *          |{ success: false, error: string }}
 */
function joinRoom(socketId, roomCode, playerName, gameType) {
  const room = rooms[roomCode];

  if (!room) {
    return { success: false, error: "Room does not exist." };
  }

  if (room.gameMode !== gameType) {
    return { success: false, error: `This code is for a different game (${room.gameMode}). Please return to game selection.` };
  }

  const alreadyIn = room.players.some((p) => p.id === socketId);
  if (alreadyIn) {
    return { success: false, error: "You are already in this room." };
  }

  // ── Reconnect by name (lobby → game.html page navigation) ────────────────
  // When a player navigates between pages, their socket ID changes. During an
  // in-progress game the old socket may still be alive briefly, making the room
  // appear full. If the game has already started, allow a reconnect by matching
  // the player name and replacing the stale socket ID in-place.
  const inProgress = ['SETUP', 'ACTIVE', 'ROUND_END', 'GAME_END'].includes(room.gameState);
  if (inProgress) {
    const existingSlot = room.players.find((p) => p.name === playerName);
    if (existingSlot) {
      const oldId = existingSlot.id;
      existingSlot.id = socketId; // Swap socket ID in-place
      delete existingSlot.disconnected; // Clear disconnected flag
      if (room.host === oldId) room.host = socketId; // Keep host status
      return { success: true, roomCode, room, reconnected: true, oldId };
    }
  }

  if (room.players.length >= 2) {
    return { success: false, error: "Room is full (max 2 players)." };
  }

  room.players.push({ id: socketId, name: playerName });

  return { success: true, roomCode, room };
}

/**
 * Remove a player from whatever room they're in.
 * Deletes the room entirely if it becomes empty.
 * Transfers host if the host left but another player remains.
 * @returns {{ roomCode: string, room: object|null }|null}
 *   null  → player wasn't in any room
 *   room  → updated room object (null if room was deleted)
 */
function leaveRoom(socketId) {
  const roomCode = findRoomBySocket(socketId);
  if (!roomCode) return null;

  const room = rooms[roomCode];
  const inProgress = ['SETUP', 'ACTIVE', 'ROUND_END', 'GAME_END'].includes(room.gameState);

  if (inProgress) {
    // During an active game, don't remove the player object.
    // They might just be navigating from lobby to game page.
    // Instead, mark them disconnected. (They keep their slot for reconnecting).
    const p = room.players.find(p => p.id === socketId);
    if (p) p.disconnected = true;
    
    // Do NOT reassign host if the game is in progress (prevents stale host IDs)
    return { roomCode, room };
  }

  // If LOBBY phase, it's safe to fully remove the player
  room.players = room.players.filter((p) => p.id !== socketId);

  // Room is now empty — clean it up
  if (room.players.length === 0) {
    delete rooms[roomCode];
    return { roomCode, room: null };
  }

  // Host left — promote the next player
  if (room.host === socketId && room.players.length > 0) {
    room.host = room.players[0].id;
  }

  return { roomCode, room };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/**
 * Find the room code a given socket is currently in, or null.
 */
function findRoomBySocket(socketId) {
  for (const [code, room] of Object.entries(rooms)) {
    if (room.players.some((p) => p.id === socketId)) {
      return code;
    }
  }
  return null;
}

/**
 * Return a room object by code, or null if it doesn't exist.
 */
function getRoom(roomCode) {
  return rooms[roomCode] || null;
}

// ─── Lookups (continued) ──────────────────────────────────────────────────────

/**
 * Return the raw rooms map.
 * Used by gameEngine.js to resolve rooms without a circular import.
 */
function getRooms() {
  return rooms;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  findRoomBySocket,
  getRoom,
  getRooms,
};
