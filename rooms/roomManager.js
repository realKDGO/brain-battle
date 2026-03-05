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
function createRoom(socketId, playerName) {
  const roomCode = generateRoomCode();

  rooms[roomCode] = {
    host: socketId,
    players: [{ id: socketId, name: playerName }],
    gameMode: null,
    gameState: "WAITING",
    gameData: {},
  };

  return { success: true, roomCode, room: rooms[roomCode] };
}

/**
 * Add a player to an existing room.
 * @returns {{ success: true, roomCode: string, room: object }
 *          |{ success: false, error: string }}
 */
function joinRoom(socketId, roomCode, playerName) {
  const room = rooms[roomCode];

  if (!room) {
    return { success: false, error: "Room does not exist." };
  }

  const alreadyIn = room.players.some((p) => p.id === socketId);
  if (alreadyIn) {
    return { success: false, error: "You are already in this room." };
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

  // Remove the player
  room.players = room.players.filter((p) => p.id !== socketId);

  // Room is now empty — clean it up
  if (room.players.length === 0) {
    delete rooms[roomCode];
    return { roomCode, room: null };
  }

  // Host left — promote the next player
  if (room.host === socketId) {
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

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  findRoomBySocket,
  getRoom,
};
