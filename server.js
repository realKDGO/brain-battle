// server.js
// Thin event router — all room and game logic lives in roomManager.
require('dotenv').config();

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const {
  createRoom,
  joinRoom,
  leaveRoom,
  findRoomBySocket,
  getRoom,
} = require("./rooms/roomManager");

const {
  startSetup,
  startGame,
  endRound,
  endGame,
  resetGame,
  nextTurn,
  getCurrentPlayer,
  submitSetup,
  submitAction,
} = require("./engine/gameEngine");

const { GAME_MODE } = require("./engine/constants");

// ─── App Setup ────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*" }, // Tighten in production
});

const PORT = process.env.PORT || 3000;

// ─── Serve Static Files ───────────────────────────────────────────────────────

app.use(express.static("public"));
app.get("/", (_req, res) => res.sendFile(__dirname + "/public/index.html"));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Broadcast the full room object to every socket in that room.
 */
function broadcastRoomUpdate(roomCode, room) {
  if (room) {
    io.to(roomCode).emit("roomUpdate", room);
  }
}

/**
 * Guard: only the room host may perform certain actions.
 * Returns true and emits an error to socket if the socket is NOT the host.
 */
function rejectIfNotHost(socket, room, eventName) {
  if (room.host !== socket.id) {
    socket.emit(eventName + "Response", {
      success: false,
      error:   "Only the host can perform this action.",
    });
    return true;
  }
  return false;
}

/**
 * Guard: socket must be in a room.
 * Returns the { roomCode, room } pair or emits an error and returns null.
 */
function requireRoom(socket, eventName) {
  const roomCode = findRoomBySocket(socket.id);
  if (!roomCode) {
    socket.emit(eventName + "Response", {
      success: false,
      error:   "You are not in a room.",
    });
    return null;
  }
  return { roomCode, room: getRoom(roomCode) };
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[+] Connected:  ${socket.id}`);

  // ── createRoom ─────────────────────────────────────────────────────────────
  socket.on("createRoom", ({ playerName, gameType } = {}) => {
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return socket.emit("createRoomResponse", {
        success: false,
        error:   "A valid player name is required.",
      });
    }
    if (!gameType || typeof gameType !== "string") {
      return socket.emit("createRoomResponse", {
        success: false,
        error:   "A valid game type is required.",
      });
    }

    const result = createRoom(socket.id, playerName.trim(), gameType);
    if (result.success) {
      socket.join(result.roomCode);

      socket.emit("createRoomResponse", { success: true, roomCode: result.roomCode });
      broadcastRoomUpdate(result.roomCode, result.room);
      console.log(`[Room] Created ${result.roomCode} by "${playerName}" (${socket.id})`);
    } else {
      socket.emit("createRoomResponse", { success: false, error: result.error });
    }
  });

  // ── joinRoom ───────────────────────────────────────────────────────────────
  socket.on("joinRoom", ({ roomCode, playerName, gameType } = {}) => {
    if (!roomCode || typeof roomCode !== "string") {
      return socket.emit("joinRoomResponse", {
        success: false,
        error:   "A valid room code is required.",
      });
    }
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return socket.emit("joinRoomResponse", {
        success: false,
        error:   "A valid player name is required.",
      });
    }
    if (!gameType || typeof gameType !== "string") {
      return socket.emit("joinRoomResponse", {
        success: false,
        error:   "A valid game type is required.",
      });
    }

    const rCode = roomCode.toUpperCase();
    const existingRoom = getRoom(rCode);
    if (existingRoom) {
        // Pre-emptively remove dead sockets to prevent 'Room is full' race conditions when refreshing.
        // BUT if the game has started (in-progress), KEEP them so the player can reclaim the slot!
        const inProgress = ['SETUP', 'ACTIVE', 'ROUND_END', 'GAME_END'].includes(existingRoom.gameState);
        if (!inProgress) {
            existingRoom.players = existingRoom.players.filter(p => io.sockets.sockets.has(p.id) || p.id === socket.id);
        }
    }

    const result = joinRoom(socket.id, rCode, playerName.trim(), gameType);
    if (result.success) {
      socket.join(result.roomCode);

      // ── Remap gameData from the old socket ID to the new one ──────────────
      // `result.oldId` is set by roomManager when a player reconnects by name.
      const room = result.room;
      const oldId = result.oldId;
      if (oldId && room.gameData) {
        if (room.gameData.chains && oldId in room.gameData.chains) {
          room.gameData.chains[socket.id] = room.gameData.chains[oldId];
          delete room.gameData.chains[oldId];
        }
        if (room.gameData.guessProgress && oldId in room.gameData.guessProgress) {
          room.gameData.guessProgress[socket.id] = room.gameData.guessProgress[oldId];
          delete room.gameData.guessProgress[oldId];
        }
        if (room.gameData.scores && oldId in room.gameData.scores) {
          room.gameData.scores[socket.id] = room.gameData.scores[oldId];
          delete room.gameData.scores[oldId];
        }
        console.log(`[Room] Remapped gameData for "${playerName}" from ${oldId} → ${socket.id}`);
      }

      socket.emit("joinRoomResponse", { success: true, roomCode: result.roomCode, hostId: result.room.host });
      broadcastRoomUpdate(result.roomCode, result.room);
      console.log(`[Room] "${playerName}" (${socket.id}) joined ${result.roomCode}`);
    } else {
      socket.emit("joinRoomResponse", { success: false, error: result.error });
    }
  });

  // ── leaveRoom ──────────────────────────────────────────────────────────────
  socket.on("leaveRoom", () => handleLeave(socket));

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    handleLeave(socket);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GAME ENGINE EVENTS
  // ══════════════════════════════════════════════════════════════════════════

  // ── startSetup ─────────────────────────────────────────────────────────────
  // Host triggers LOBBY → SETUP.
  socket.on("startSetup", () => {
    const ctx = requireRoom(socket, "startSetup");
    if (!ctx) return;
    const { roomCode, room } = ctx;

    if (rejectIfNotHost(socket, room, "startSetup")) return;

    const result = startSetup(roomCode);
    socket.emit("startSetupResponse", { success: result.success, error: result.error });
    if (result.success) broadcastRoomUpdate(roomCode, result.room);
  });

  // ── submitSetup ────────────────────────────────────────────────────────────
  // Any player submits game-specific setup data (e.g., word list, chosen number).
  // Client sends: { data: object }
  socket.on("submitSetup", async ({ data } = {}) => {
    const ctx = requireRoom(socket, "submitSetup");
    if (!ctx) return;
    const { roomCode } = ctx;

    const result = await submitSetup(roomCode, socket.id, data);
    
    if (result.forceSync) {
      // Collision: both players had the same chain — both sets were randomized.
      // Notify ALL players with the error (everyone needs to see the snackbar)
      io.to(roomCode).emit("submitSetupResponse", {
        success: false,
        error: result.error,
        forceSync: true,
      });
      // Still broadcast room state so the game can proceed
      broadcastRoomUpdate(roomCode, result.room);
    } else {
      socket.emit("submitSetupResponse", { success: result.success, error: result.error, words: result.words });
      if (result.success) broadcastRoomUpdate(roomCode, result.room);
    }
  });

  // ── startGame ──────────────────────────────────────────────────────────────
  // Host triggers SETUP → ACTIVE.
  socket.on("startGame", () => {
    const ctx = requireRoom(socket, "startGame");
    if (!ctx) return;
    const { roomCode, room } = ctx;

    if (rejectIfNotHost(socket, room, "startGame")) return;

    const result = startGame(roomCode);
    // Send both success and payload
    socket.emit("startGameResponse", { success: result.success, error: result.error, payload: result.payload });
    
    // Broadcast the full start payload to all players so they can catch their specific initial states
    if (result.success) {
       io.to(roomCode).emit("gameStarted", { payload: result.payload });
       broadcastRoomUpdate(roomCode, result.room);
    }
  });

  // ── submitAction ───────────────────────────────────────────────────────────
  // Current player submits a game action (e.g., a guess).
  // Client sends: { data: object }
  socket.on("submitAction", (payload) => {
    // Determine if new format or old format
    const data = payload && payload.data ? payload.data : payload;
    // Map explicit guessedWord back to guess if not already in data
    if (payload && payload.guessedWord && !data.guess) {
        data.guess = payload.guessedWord;
    }
    const ctx = requireRoom(socket, "submitAction");
    if (!ctx) return;
    const { roomCode } = ctx;

    const result = submitAction(roomCode, socket.id, data);
    socket.emit("submitActionResponse", {
      success: result.success,
      error:   result.error,
      // Pass through any game-specific result fields (e.g., correct, result, score)
      ...(result.success ? { gameResult: result } : {}),
    });
    
    if (result.success) {
      broadcastRoomUpdate(roomCode, result.room);
      
      // Auto-check for end-of-game conditions specifically for WORD_CHAIN
      const { getGameModule } = require("./games/index");
      const mod = getGameModule(result.room.gameMode);
      if (mod && mod.checkGameEnd && mod.checkGameEnd(result.room.gameData)) {
          console.log(`[Engine] ${roomCode}: Game Auto-Ending`);
          // Force round end so the server can compute the winner
          endRound(roomCode);
          const endResult = endGame(roomCode);
          io.to(roomCode).emit("endGameResponse", {
            success: endResult.success,
            winner: endResult.winner,
            scores: result.room.gameData.scores
          });
          broadcastRoomUpdate(roomCode, result.room);
      }
    }
  });

  // ── nextTurn ───────────────────────────────────────────────────────────────
  // Host (or server logic) advances to the next player's turn.
  socket.on("nextTurn", () => {
    const ctx = requireRoom(socket, "nextTurn");
    if (!ctx) return;
    const { roomCode, room } = ctx;

    if (rejectIfNotHost(socket, room, "nextTurn")) return;

    const result = nextTurn(roomCode);
    socket.emit("nextTurnResponse", {
      success: result.success,
      error:   result.error,
      player:  result.player,
    });
    if (result.success) broadcastRoomUpdate(roomCode, result.room);
  });

  // ── getCurrentPlayer ───────────────────────────────────────────────────────
  // Any player can ask whose turn it is.
  socket.on("getCurrentPlayer", () => {
    const ctx = requireRoom(socket, "getCurrentPlayer");
    if (!ctx) return;
    const { roomCode } = ctx;

    const result = getCurrentPlayer(roomCode);
    socket.emit("getCurrentPlayerResponse", {
      success: result.success,
      error:   result.error,
      player:  result.player,
    });
  });

  // ── endRound ───────────────────────────────────────────────────────────────
  // Host triggers ACTIVE → ROUND_END.
  socket.on("endRound", () => {
    const ctx = requireRoom(socket, "endRound");
    if (!ctx) return;
    const { roomCode, room } = ctx;

    if (rejectIfNotHost(socket, room, "endRound")) return;

    const result = endRound(roomCode);
    socket.emit("endRoundResponse", { success: result.success, error: result.error });
    if (result.success) broadcastRoomUpdate(roomCode, result.room);
  });

  // ── endGame ────────────────────────────────────────────────────────────────
  // Host triggers ROUND_END → GAME_END.
  socket.on("endGame", () => {
    const ctx = requireRoom(socket, "endGame");
    if (!ctx) return;
    const { roomCode, room } = ctx;

    if (rejectIfNotHost(socket, room, "endGame")) return;

    const result = endGame(roomCode);
    socket.emit("endGameResponse", {
      success: result.success,
      error:   result.error,
      winner:  result.winner,
    });
    if (result.success) broadcastRoomUpdate(roomCode, result.room);
  });

  // ── resetGame ──────────────────────────────────────────────────────────────
  // Host triggers GAME_END → WAITING (play again).
  socket.on("resetGame", () => {
    const ctx = requireRoom(socket, "resetGame");
    if (!ctx) return;
    const { roomCode, room } = ctx;

    if (rejectIfNotHost(socket, room, "resetGame")) return;

    const result = resetGame(roomCode);
    socket.emit("resetGameResponse", { success: result.success, error: result.error });
    if (result.success) broadcastRoomUpdate(roomCode, result.room);
  });
});

// ─── Shared leave handler ─────────────────────────────────────────────────────

function handleLeave(socket) {
  const result = leaveRoom(socket.id);
  if (!result) return;

  const { roomCode, room } = result;
  socket.leave(roomCode);

  if (room) {
    if (room.gameData) {
      if (room.gameData.chains) delete room.gameData.chains[socket.id];
      if (room.gameData.guessProgress) delete room.gameData.guessProgress[socket.id];
      if (room.gameData.scores) delete room.gameData.scores[socket.id];
    }
    broadcastRoomUpdate(roomCode, room);
    console.log(`[Room] ${socket.id} left ${roomCode} (room still active)`);
  } else {
    console.log(`[Room] ${roomCode} deleted (all players gone)`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '::', () => {
  console.log(`Server running. Access locally at http://localhost:${PORT}`);
  console.log(`Also bound to IPv6 (::) for network access.`);
});