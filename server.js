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
  updateMaxPlayers,
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
  // ── checkRoomGameMode: peek at a room's game type before joining ──────────
  // Returns { exists, gameMode } so the client can warn before cross-game joins.
  socket.on('checkRoomGameMode', ({ roomCode } = {}) => {
    if (!roomCode) return socket.emit('checkRoomGameModeResponse', { exists: false });
    const { getRoom } = require('./rooms/roomManager');
    const room = getRoom(roomCode.trim().toUpperCase());
    if (!room) return socket.emit('checkRoomGameModeResponse', { exists: false });
    socket.emit('checkRoomGameModeResponse', { exists: true, gameMode: room.gameMode });
  });

  // ── rejoinRoom: host returning to their own room after Play Again ──────────
  socket.on("rejoinRoom", ({ roomCode, playerName, gameType } = {}) => {
    console.log(`[DEBUG] Join-room event emitted (rejoin): roomCode=${roomCode} playerName=${playerName} gameType=${gameType} socket=${socket.id}`);
    if (!roomCode || !playerName || !gameType) {
      console.warn(`[DEBUG] Join-room failed: missing parameters`);
      return socket.emit("rejoinRoomResponse", { success: false, error: "Missing parameters." });
    }
    const room = getRoom(roomCode.toUpperCase());
    console.log(`[DEBUG] Room lookup for ${roomCode.toUpperCase()}: ${room ? 'FOUND (state: '+room.gameState+')' : 'NOT FOUND'}`);
    if (!room) {
      console.log('[DEBUG] Join-room failed: room not found');
      return socket.emit("rejoinRoomResponse", { success: false, error: "Room not found." });
    }
    // Add socket to IO room and register as host
    socket.join(roomCode);
    room.host = socket.id;
    // Replace or add player slot
    const existing = room.players.find(p => p.name === playerName);
    if (existing) {
      existing.id = socket.id;
      delete existing.disconnected;
    } else {
      room.players = room.players.filter(p => p.name !== playerName);
      room.players.unshift({ id: socket.id, name: playerName });
    }
    // Reset to LOBBY now that the host's new socket has arrived
    room.gameState = 'LOBBY';
    console.log(`[DEBUG] Join-room success. Lobby initialized.`);
    socket.emit("rejoinRoomResponse", { success: true, roomCode, gameType, hostId: socket.id });
    broadcastRoomUpdate(roomCode, room);
  });

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
        // ── CRITICAL: also update playerIds so getTargetId / getInitialPayload
        //    work correctly after the socket-ID change ─────────────────────────
        if (room.gameData.playerIds) {
          const idx = room.gameData.playerIds.indexOf(oldId);
          if (idx !== -1) room.gameData.playerIds[idx] = socket.id;
        }
        // Remap CL-specific keyed objects
        if (room.gameData.wordHistory && oldId in room.gameData.wordHistory) {
          room.gameData.wordHistory[socket.id] = room.gameData.wordHistory[oldId];
          delete room.gameData.wordHistory[oldId];
        }
        if (room.gameData.roundWins && oldId in room.gameData.roundWins) {
          room.gameData.roundWins[socket.id] = room.gameData.roundWins[oldId];
          delete room.gameData.roundWins[oldId];
        }
        if (room.gameData.submittedLetters && oldId in room.gameData.submittedLetters) {
          room.gameData.submittedLetters[socket.id] = room.gameData.submittedLetters[oldId];
          delete room.gameData.submittedLetters[oldId];
        }
        console.log(`[Room] Remapped gameData for "${playerName}" from ${oldId} → ${socket.id}`);
      }

      socket.emit("joinRoomResponse", { success: true, roomCode: result.roomCode, hostId: result.room.host });
      broadcastRoomUpdate(result.roomCode, result.room);
      console.log(`[Room] "${playerName}" (${socket.id}) joined ${result.roomCode}`);

      // ── Re-send gameStarted when reconnecting to an already-active game ────
      // This covers the case where the game auto-started from the lobby (e.g.
      // single-player / 5+ players) before the player's game.html socket loaded,
      // so the original gameStarted event was never received by the client.
      if (result.reconnected && room.gameState === 'ACTIVE') {
        const { getGameModule } = require('./games/index');
        const mod = getGameModule(room.gameMode);
        if (mod && mod.getInitialPayload) {
          const payload = mod.getInitialPayload(room.gameData);
          if (payload[socket.id]) {
            socket.emit('gameStarted', { payload });
            console.log(`[Room] Re-sent gameStarted to "${playerName}" (${socket.id}) on reconnect`);
          }
        }
      }
    } else if (result.status === 'waiting_for_host') {
      // Room is full — notify the host that someone wants in
      io.to(result.hostId).emit('joinRequest', {
        joiningPlayerId: socket.id,
        playerName: playerName.trim(),
        roomCode: rCode,
        gameType,
      });
      socket.emit("joinRoomResponse", {
        success: false,
        status: 'waiting_for_host',
        error: result.error,
      });
    } else {
      socket.emit("joinRoomResponse", { success: false, error: result.error });
    }
  });

  // ── respondJoinRequest ─────────────────────────────────────────────────────
  // Host accepts or ignores a pending join request from a player trying
  // to enter a full lobby.
  socket.on("respondJoinRequest", ({ joiningPlayerId, playerName, roomCode, gameType, action } = {}) => {
    const ctx = requireRoom(socket, "respondJoinRequest");
    if (!ctx) return;
    const { room } = ctx;
    if (rejectIfNotHost(socket, room, "respondJoinRequest")) return;

    if (action === 'accept') {
      if ((room.maxPlayers || 2) >= 8) {
        io.to(joiningPlayerId).emit("joinRequestResponse", {
          accepted: false,
          error: "The lobby is already at the maximum capacity (8 players).",
        });
        return;
      }
      // Bump maxPlayers so there's a slot
      room.maxPlayers = (room.maxPlayers || 2) + 1;
      const result = joinRoom(joiningPlayerId, roomCode, playerName, gameType);
      if (result.success) {
        const joiningSocket = io.sockets.sockets.get(joiningPlayerId);
        if (joiningSocket) joiningSocket.join(result.roomCode);
        io.to(joiningPlayerId).emit("joinRequestResponse", { accepted: true, roomCode: result.roomCode, hostId: room.host });
        // Tell the host's lobby to remove this player from pendingRequests
        socket.emit('clearJoinRequest', { joiningPlayerId });
        broadcastRoomUpdate(result.roomCode, result.room);
        console.log(`[Room] "${playerName}" (${joiningPlayerId}) joined ${result.roomCode} via host accept`);
      } else {
        io.to(joiningPlayerId).emit("joinRequestResponse", { accepted: false, error: result.error });
      }
    } else {
      // Host ignored
      io.to(joiningPlayerId).emit("joinRequestResponse", {
        accepted: false,
        error: "The host did not add a player slot for you.",
      });
    }
  });

  // ── updateRoomSettings ─────────────────────────────────────────────────────
  // Host changes maxPlayers from the lobby dropdown.
  socket.on("updateRoomSettings", ({ maxPlayers } = {}) => {
    const ctx = requireRoom(socket, "updateRoomSettings");
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (rejectIfNotHost(socket, room, "updateRoomSettings")) return;

    if (typeof maxPlayers === 'number') {
      updateMaxPlayers(roomCode, maxPlayers);
      broadcastRoomUpdate(roomCode, room);
    }
  });

  // ── leaveRoom ──────────────────────────────────────────────────────────────
  socket.on("leaveRoom", () => handleLeave(socket));

  // ── disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    // Note: disconnects after lobby→game navigation are expected (page unload).
    // The player reconnects with a new socket ID on the new page.
    const roomCode = findRoomBySocket(socket.id) || '(not in room)';
    console.log(`[-] Disconnected: ${socket.id} | reason: ${reason} | room: ${roomCode}`);
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
    if (result.success) {
      if (typeof room.dictEnabled === 'undefined') room.dictEnabled = true;
      room.dictRequestCounts = {};

      if (room.gameMode === 'CONNECT_LETTERS') {
        // CL skips the cube setup phase. Move straight to ACTIVE.
        // startGame() increments round by 1, and startRound() also increments by 1.
        // Set round = -1 so startGame makes it 0, and startRound makes it 1.
        room.gameData.round = -1;
        const startResult = startGame(roomCode);
        if (startResult.success) {
          io.to(roomCode).emit('gameStarted', { payload: startResult.payload });
          broadcastRoomUpdate(roomCode, room);
        }
        return;
      }

      const allSubmitted = room.players.every(p => room.gameData.chains && room.gameData.chains[p.id] && room.gameData.chains[p.id].submitted);
      if (allSubmitted) {
        const startResult = startGame(roomCode);
        if (startResult.success) {
          io.to(roomCode).emit("gameStarted", { payload: startResult.payload });
        }
      }
      broadcastRoomUpdate(roomCode, result.room);
    }
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
      socket.emit("submitSetupResponse", { success: result.success, error: result.error, words: result.words, invalidCompound: result.invalidCompound });
      if (result.success) broadcastRoomUpdate(roomCode, result.room);
    }
  });

  // ── validateSetupWord ──────────────────────────────────────────────────────
  // Client instantly asks to check a single word's spelling and validity
  socket.on("validateSetupWord", async ({ word, index }) => {
    const roomCode = findRoomBySocket(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

    const { getGameModule } = require("./games/index");
    const mod = getGameModule(room.gameMode);
    if (!mod || !mod.validateWord) return;

    // 1. Basic format and plural check
    const res = mod.validateWord(word);
    if (!res.valid) {
      return socket.emit("validateSetupWordResponse", { index, valid: false, error: res.error });
    }

    // 2. Dictionary check
    if (mod.isValidWordAPI) {
      const exists = await mod.isValidWordAPI(res.word);
      if (!exists) {
        return socket.emit("validateSetupWordResponse", { index, valid: false, error: `"${res.word}" is not a recognized word.` });
      }
    }

    socket.emit("validateSetupWordResponse", { index, valid: true, word: res.word });
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

      // Notify all players when someone finishes in multiplayer
      const gd = result.room.gameData;
      if (result.correct && result.currentIndex > 5 && gd.playerIds && gd.playerIds.length > 1) {
        const playerIds = gd.playerIds;
        const finishedCount = playerIds.filter(id => {
          const p = gd.guessProgress[id];
          return p && p.currentIndex > 5;
        }).length;
        const stillGuessing = playerIds.length - finishedCount;
        if (stillGuessing > 0) {
          io.to(roomCode).emit('guessingStatus', { finishedCount, stillGuessing });
        }
      }
      
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
            scores: result.room.gameData.scores,
            timeTaken: result.room.gameData.timeTaken,
            players: result.room.players
          });
          broadcastRoomUpdate(roomCode, result.room);
      }
    }
  });

  // ── setupProgressUpdate ───────────────────────────────────────────────────
  // Player reports how many rows they have typed so far (for status bar).
  // Stored as chains[id].filledRows and broadcast via roomUpdate.
  socket.on('setupProgressUpdate', ({ filledRows } = {}) => {
    const roomCode = findRoomBySocket(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || room.gameState !== 'SETUP') return;
    if (!room.gameData.chains) return;
    if (!room.gameData.chains[socket.id]) room.gameData.chains[socket.id] = { words: [], submitted: false };
    room.gameData.chains[socket.id].filledRows = filledRows || 0;
    broadcastRoomUpdate(roomCode, room);
  });

  // ── requestInitialPayload ─────────────────────────────────────────────────
  // Client asks for the initial game state (used when game.html loads into an
  // already-active game, e.g. single-player auto-start or reconnect).
  socket.on('requestInitialPayload', () => {
    const roomCode = findRoomBySocket(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || room.gameState !== 'ACTIVE') return;

    const { getGameModule } = require('./games/index');
    const mod = getGameModule(room.gameMode);
    if (!mod || !mod.getInitialPayload) return;

    const payload = mod.getInitialPayload(room.gameData);
    if (payload[socket.id]) {
      socket.emit('gameStarted', { payload });
      console.log(`[Room] Sent requestInitialPayload to ${socket.id} in ${roomCode}`);
    }
  });


  // ── dictToggle ─────────────────────────────────────────────────────────────
  // Host toggles dictionary validation ON/OFF during setup phase.
  socket.on('dictToggle', ({ enabled } = {}) => {
    const ctx = requireRoom(socket, 'dictToggle');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (rejectIfNotHost(socket, room, 'dictToggle')) return;
    room.dictEnabled = (enabled !== false); // default true
    // Notify all players (excluding host) of the change
    socket.to(roomCode).emit('dictToggleUpdate', { enabled: room.dictEnabled });
    socket.emit('dictToggleUpdate', { enabled: room.dictEnabled }); // confirm to host too
  });

  // ── requestDictOn ──────────────────────────────────────────────────────────
  // Non-host player requests host to turn dictionary validation back on.
  // Server tracks per-player request counts and enforces the 2-request cap.
  socket.on('requestDictOn', ({ requestedState } = {}) => {
    const ctx = requireRoom(socket, 'requestDictOn');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (!room.dictRequestCounts) room.dictRequestCounts = {};
    const count = room.dictRequestCounts[socket.id] || 0;
    if (count >= 2) {
      return socket.emit('requestDictOnResponse', { success: false, limitReached: true });
    }
    room.dictRequestCounts[socket.id] = count + 1;
    // Store requested state so host dialog knows what the player wants
    if (!room._pendingDictRequests) room._pendingDictRequests = {};
    room._pendingDictRequests[socket.id] = (requestedState !== false);
    io.to(room.host).emit('dictOnRequest', { requesterId: socket.id, requestedState: requestedState !== false });
    socket.emit('requestDictOnResponse', { success: true });
  });

  // ── respondDictOnRequest ───────────────────────────────────────────────────
  // Host accepts or ignores a dict-on request.
  socket.on('respondDictOnRequest', ({ requesterId, action } = {}) => {
    const ctx = requireRoom(socket, 'respondDictOnRequest');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (rejectIfNotHost(socket, room, 'respondDictOnRequest')) return;
    if (action === 'accept') {
      // Apply the state the player requested (stored when they sent requestDictOn)
      const targetState = room._pendingDictRequests && typeof room._pendingDictRequests[requesterId] !== 'undefined'
        ? room._pendingDictRequests[requesterId] : true;
      room.dictEnabled = targetState;
      io.to(roomCode).emit('dictToggleUpdate', { enabled: targetState });
    } else {
      io.to(requesterId).emit('dictOnRequestIgnored');
    }
    // Clean up pending entry
    if (room._pendingDictRequests) delete room._pendingDictRequests[requesterId];
  });


  // ══════════════════════════════════════════════════════════════════════════
  // CONNECT LETTERS — socket handlers
  // ══════════════════════════════════════════════════════════════════════════

  // Helper: emit current CL state to whole room
  function clBroadcast(roomCode, room, event, extra = {}) {
    const gd = room.gameData;
    io.to(roomCode).emit(event, {
      round:       gd.round,
      roundState:  gd.roundState,
      startLetter: gd.startLetter,
      endLetter:   gd.endLetter,
      roundWins:   gd.roundWins,
      bo:          gd.bo,
      winsNeeded:  gd.winsNeeded,
      ...extra,
    });
  }

  // ── scheduleSoloExpiry ──────────────────────────────────────────────────────
  // Recursive: each expiry schedules the next. Stops if a word was submitted
  // (round advanced) or the room is gone.
  function scheduleSoloExpiry(roomCode, room, forRound, delayMs) {
    setTimeout(() => {
      if (!room || !room.gameData) return;
      if (room.gameData.roundState !== 'ACTIVE') return;
      if (room.gameData.round !== forRound) return; // player submitted, new round already started
      const mod = require('./games/index').getGameModule('CONNECT_LETTERS');
      mod.startRound(room.gameData);
      room.gameState = 'ACTIVE';
      clBroadcast(roomCode, room, 'clRoundStart', {
        countdown:    0,
        soloTimer:    15,
        autoStart:    true,
        timerExpired: true,
        startLetter:  room.gameData.startLetter,
        endLetter:    room.gameData.endLetter,
        round:        room.gameData.round,
      });
      broadcastRoomUpdate(roomCode, room);
      // Schedule next expiry (15s flat, no countdown delay)
      scheduleSoloExpiry(roomCode, room, room.gameData.round, 15000);
    }, delayMs);
  }

  // ── clStartIntermission ────────────────────────────────────────────────────
  // Called after a round ends (non-solo, non-match-over).
  // Broadcasts a 15s intermission countdown then auto-starts next round.
  function clStartIntermission(roomCode, room, ioRef) {
    let cancelled = false;
    const cancel  = () => { cancelled = true; startNext(); };
    room._clIntermissionCancel = cancel;

    ioRef.to(roomCode).emit('clIntermission', { seconds: 15 });

    const t = setTimeout(() => {
      if (!cancelled) startNext();
    }, 15000);

    function startNext() {
      clearTimeout(t);
      room._clIntermissionCancel = null;
      if (!room.gameData) return;

      // Tell ALL clients to immediately close the intermission overlay and clear
      // timer state — this is the single source of truth for exiting the break phase
      console.log(`[CL] Break ended for room ${roomCode} — broadcasting clBreakEnded`);
      ioRef.to(roomCode).emit('clBreakEnded');

      // Reset per-round pass tracking
      if (room.gameData.roundPassedPlayers) room.gameData.roundPassedPlayers = new Set();

      const mod = require('./games/index').getGameModule('CONNECT_LETTERS');
      const info = mod.startRound(room.gameData);
      room.gameState = 'ACTIVE';
      if (info.roundState === 'ACTIVE') {
        console.log(`[CL] Next round (${info.round}) starting — broadcasting clRoundStart`);
        clBroadcast(roomCode, room, 'clRoundStart', { countdown: 3, soloTimer: null });
      } else {
        console.log(`[CL] Next round (${info.round}) — letter input phase`);
        clBroadcast(roomCode, room, 'clLetterInputPhase', {});
      }
      broadcastRoomUpdate(roomCode, room);
    }
  }

  // ── clStartRound (host triggers FIRST round only) ───────────────────────────

  socket.on('clStartRound', () => {
    const ctx = requireRoom(socket, 'clStartRound');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (rejectIfNotHost(socket, room, 'clStartRound')) return;
    if (room.gameMode !== 'CONNECT_LETTERS') return;

    const mod = require('./games/index').getGameModule('CONNECT_LETTERS');
    const info = mod.startRound(room.gameData);
    room.gameState = 'ACTIVE';

    if (info.roundState === 'ACTIVE') {
      // System letters (1P solo or 3P+ Royal Rumble)
      const isSolo = room.players.length === 1;
      clBroadcast(roomCode, room, 'clRoundStart', {
        countdown:   3,
        soloTimer:   isSolo ? 15 : null,
        startLetter: room.gameData.startLetter,
        endLetter:   room.gameData.endLetter,
        round:       room.gameData.round,
      });
      if (isSolo) {
        // Recursive 15s timer: fires on expiry and re-schedules itself for the next round.
        // First fire: 15s + 3s countdown + 1.7s reveal = 19.7s from clStartRound emit.
        // Subsequent fires: 15s flat (autoStart has no countdown or reveal).
        scheduleSoloExpiry(roomCode, room, room.gameData.round, 15000 + 3000 + 1700);
      }
    } else {
      // 2P — letter input phase; countdown starts only after both letters submitted
      clBroadcast(roomCode, room, 'clLetterInputPhase', {});
    }
    broadcastRoomUpdate(roomCode, room);
  });

  // ── clLetterSubmit (2p setup: each player submits one letter) ─────────────
  socket.on('clLetterSubmit', async ({ letter } = {}) => {
    const ctx = requireRoom(socket, 'clLetterSubmit');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (room.gameMode !== 'CONNECT_LETTERS') return;

    const mod = require('./games/index').getGameModule('CONNECT_LETTERS');
    const result = mod.handleSetup(room.gameData, socket.id, { letter });

    socket.emit('clLetterSubmitResponse', { success: result.success, error: result.error, waiting: result.waiting });

    if (result.success && result.ready) {
      const mod2 = require('./games/index').getGameModule('CONNECT_LETTERS');
      const sl = result.startLetter;
      const el = result.endLetter;
      console.log(`[CL] Validation: ${sl} -> ${el} (from handleSetup: start=${room.gameData.startLetter} end=${room.gameData.endLetter})`);
      // Skip pair-validity check when host has disabled dictionary in lobby
      const pairOk = (room.dictEnabled === false) ? true : mod2.isValidPair(sl, el);
      console.log(`[CL] Validation result: ${pairOk ? 'VALID' : 'INVALID'} (dictEnabled=${room.dictEnabled !== false})`);
      console.log(`[CL] Final letters for round: ${sl} -> ${el}`);
      if (!pairOk) {
        // No valid English word possible — reset round to letter input
        room.gameData.roundState       = 'LETTER_INPUT';
        room.gameData.startLetter      = null;
        room.gameData.endLetter        = null;
        room.gameData.submittedLetters = {};
        io.to(roomCode).emit('clInvalidPair', {
          message: 'No valid English word can be formed from these letters. Round restarting.',
        });
        clBroadcast(roomCode, room, 'clLetterInputPhase', {});
      } else {
        // Valid pair — use EXACT player submissions, then start countdown
        room.gameData.startLetter = sl;
        room.gameData.endLetter   = el;
        room.gameData.roundState  = 'ACTIVE';
        clBroadcast(roomCode, room, 'clRoundStart', {
          countdown: 3, soloTimer: null,
          startLetter: sl, endLetter: el,
          round: room.gameData.round,
        });
      }
      broadcastRoomUpdate(roomCode, room);
    }
  });

  // ── clWordSubmit (active play: player submits a word) ─────────────────────
  socket.on('clWordSubmit', async ({ word } = {}) => {
    const ctx = requireRoom(socket, 'clWordSubmit');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (room.gameMode !== 'CONNECT_LETTERS') return;

    const gd2 = room.gameData;

    // Reject submission from a player who already passed this round
    if (!gd2.isSolo && gd2.roundPassedPlayers && gd2.roundPassedPlayers.has(socket.id)) {
      return socket.emit('clWordRejected', { error: 'You have passed this round.', status: 'other' });
    }

    // Validation Lock: reject if another validation is already in progress
    if (!gd2.isSolo && gd2.validationLock) {
      return socket.emit('clPassResponse', { success: false, error: 'Validation in progress. Please wait.' });
    }

    // Acquire lock for multiplayer
    if (!gd2.isSolo) {
      gd2.validationLock = true;
      const submitterName = (room.players.find(p => p.id === socket.id) || {}).name || 'A player';
      const lockMsg = gd2.is1v1
        ? submitterName + ' submitted a word. Please wait while it is being checked.'
        : 'A word was submitted. Please wait while it is being checked.';
      room.players.filter(p => p.id !== socket.id).forEach(p => {
        io.to(p.id).emit('clValidationLock', { message: lockMsg });
      });
    }

    socket.emit('clValidating', { word });

    const mod    = require('./games/index').getGameModule('CONNECT_LETTERS');
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const result = await mod.handleAction(room.gameData, player, { word });

    // Release validation lock
    if (!room.gameData.isSolo) {
      room.gameData.validationLock = false;
      room.players.forEach(p => io.to(p.id).emit('clValidationUnlock', {}));
    }

    if (result.success) {
      // Round won
      const matchOver = result.matchWon;
      io.to(roomCode).emit('clRoundEnd', {
        roundWinner:    result.roundWinner,
        word:           result.word,
        definition:     result.definition || null,
        roundWins:      result.roundWins,
        matchWon:       matchOver,
        matchWinner:    result.matchWinner,
        isSolo:         result.isSolo,
        soloWordCount:  result.soloWordCount,
        wordHistory:    result.wordHistory || null,
      });

      if (result.isSolo) {
        // Endless solo: immediately start a new round with fresh letters + 15s timer
        const mod2 = require('./games/index').getGameModule('CONNECT_LETTERS');
        mod2.startRound(room.gameData);
        room.gameState = 'ACTIVE';
        clBroadcast(roomCode, room, 'clRoundStart', {
          countdown:   0,
          soloTimer:   15,
          autoStart:   true,
          startLetter: room.gameData.startLetter,
          endLetter:   room.gameData.endLetter,
          round:       room.gameData.round,
        });
        broadcastRoomUpdate(roomCode, room);
        // Schedule expiry for the new round (15s flat, no countdown)
        scheduleSoloExpiry(roomCode, room, room.gameData.round, 15000);
      } else if (matchOver) {
        const { endRound, endGame } = require('./engine/gameEngine');
        endRound(roomCode);
        const eg = endGame(roomCode);
        const winner = room.players.find(p => p.id === result.matchWinner) || null;
        io.to(roomCode).emit('endGameResponse', {
          winner,
          scores:        room.gameData.roundWins,
          players:       room.players,
          roundWins:     room.gameData.roundWins,
          bo:            room.gameData.bo,
          wordHistory:   room.gameData.wordHistory || {},
          passedRounds:  room.gameData.passedRounds || {},
        });
        broadcastRoomUpdate(roomCode, room);
      } else {
        // Auto-intermission: 15s break then next round starts automatically
        clStartIntermission(roomCode, room, io);
        broadcastRoomUpdate(roomCode, room);
      }

    } else if (result.invalidWord) {
      // Not a real English word — challenge opponents
      socket.emit('clWordRejected', {
        word,
        error:           result.error,
        status:          'invalid_dict',
        definition:      null,
        rejectionReason: null,
        historyEntry:    result.historyEntry || null,
      });
      const others = room.players.filter(p => p.id !== socket.id);
      if (others.length) {
        room.gameData.roundState        = 'CHALLENGE';
        room.gameData.challengeActive   = true;
        room.gameData.challengeDeadline = Date.now() + 8000;
        io.to(roomCode).emit('clChallenge', {
          challengerSocket: socket.id,
          timerMs: 8000,
          startLetter: room.gameData.startLetter,
          endLetter:   room.gameData.endLetter,
        });
        setTimeout(() => {
          if (room.gameData.challengeActive) {
            room.gameData.challengeActive = false;
            room.gameData.roundState = 'ACTIVE';
            io.to(roomCode).emit('clChallengeExpired', {});
          }
        }, 8100);
      }
    } else if (result.wrongLetters) {
      // Valid English word but wrong first/last letter — notify all, 3-second resume countdown
      // Only submitter gets the rejection entry (word hidden from others)
      socket.emit('clWordRejected', {
        word,
        error:           result.error,
        status:          'wrong_letters',
        definition:      result.definition || null,
        rejectionReason: result.rejectionReason || null,
        historyEntry:    result.historyEntry || null,
      });
      // Broadcast wrong-letters notice to everyone (no word revealed)
      io.to(roomCode).emit('clWrongLettersNotice', {
        countdownMs: 3000,
        startLetter: room.gameData.startLetter,
        endLetter:   room.gameData.endLetter,
      });
    } else {
      socket.emit('clWordRejected', { word, error: result.error, status: 'other' });
    }
  });

  // ── clPass (player forfeits/skips the current round) ─────────────────────
  socket.on('clPass', async () => {
    const ctx = requireRoom(socket, 'clPass');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (room.gameMode !== 'CONNECT_LETTERS') return;

    const gd = room.gameData;
    if (gd.roundState !== 'ACTIVE' && gd.roundState !== 'CHALLENGE') {
      return socket.emit('clPassResponse', { success: false, error: 'Round is not active.' });
    }

    const pid = socket.id;

    // Prevent double-pass from same player
    if (!gd.roundPassedPlayers) gd.roundPassedPlayers = new Set();
    if (gd.roundPassedPlayers.has(pid)) return;
    gd.roundPassedPlayers.add(pid);

    // Track cumulative passed rounds per player
    if (!gd.passedRounds) gd.passedRounds = {};
    gd.passedRounds[pid] = (gd.passedRounds[pid] || 0) + 1;

    // Release validation lock if held by this player
    if (!gd.isSolo && gd.validationLock) {
      gd.validationLock = false;
      room.players.forEach(p => io.to(p.id).emit('clValidationUnlock', {}));
    }

    socket.emit('clPassResponse', { success: true });

    if (gd.isSolo) {
      // Solo: immediately start a new round with fresh letters + reset timer
      gd.roundPassedPlayers = new Set();
      const mod = require('./games/index').getGameModule('CONNECT_LETTERS');
      mod.startRound(gd);
      room.gameState = 'ACTIVE';
      clBroadcast(roomCode, room, 'clRoundStart', {
        countdown: 0, soloTimer: 15, autoStart: true,
        startLetter: gd.startLetter, endLetter: gd.endLetter, round: gd.round,
      });
      broadcastRoomUpdate(roomCode, room);
      scheduleSoloExpiry(roomCode, room, gd.round, 15000);
      return;
    }

    // ── Multiplayer per-player forfeit ───────────────────────────────────────
    const activePlayers = room.players; // all players stay on screen
    const passedCount   = gd.roundPassedPlayers.size;
    const totalPlayers  = activePlayers.length;
    const allPassed     = passedCount >= totalPlayers;

    if (allPassed) {
      // All players passed — skipped round, no winner, no loss
      gd.roundState        = 'IDLE';
      gd.roundWinner       = null;
      gd.roundPassedPlayers = new Set();

      if (gd.is1v1) {
        // Return both players to letter-input setup for a fresh round
        const mod = require('./games/index').getGameModule('CONNECT_LETTERS');
        const info = mod.startRound(gd); // will enter LETTER_INPUT state for 2P
        room.gameState = 'ACTIVE';
        io.to(roomCode).emit('clAllPassed', { skippedRound: true });
        // Brief delay then show letter input phase
        setTimeout(() => {
          clBroadcast(roomCode, room, 'clLetterInputPhase', {});
          broadcastRoomUpdate(roomCode, room);
        }, 2000);
      } else {
        // Royal Rumble: auto-generate new letters and start fresh round immediately
        const mod = require('./games/index').getGameModule('CONNECT_LETTERS');
        mod.startRound(gd); // generates new system letters
        room.gameState = 'ACTIVE';
        io.to(roomCode).emit('clAllPassed', { skippedRound: true });
        setTimeout(() => {
          clBroadcast(roomCode, room, 'clRoundStart', {
            countdown: 3, soloTimer: null,
            startLetter: gd.startLetter, endLetter: gd.endLetter, round: gd.round,
          });
          broadcastRoomUpdate(roomCode, room);
        }, 2000);
      }
      return;
    }

    // Some players still active — show blur+waiting to the passer; others continue
    const passerName = (activePlayers.find(p => p.id === pid) || {}).name || 'A player';

    // Notify the passer: blur overlay + waiting message
    if (gd.is1v1) {
      const remainingPlayer = activePlayers.find(p => p.id !== pid);
      const remainingName   = remainingPlayer ? remainingPlayer.name : 'the other player';
      socket.emit('clPlayerPassed', {
        isSelf:        true,
        waitingFor:    remainingName,
        is1v1:         true,
      });
    } else {
      socket.emit('clPlayerPassed', {
        isSelf:     true,
        waitingFor: null,
        is1v1:      false,
      });
    }

    // Notify remaining players that someone passed (no name reveal in Royal Rumble)
    activePlayers.filter(p => p.id !== pid).forEach(p => {
      io.to(p.id).emit('clOpponentPassed', {
        passerName: gd.is1v1 ? passerName : null,
        is1v1:      gd.is1v1,
      });
    });
  });

  // ── clRequestSkip (non-host asks host to skip the break) ───────────────────
  socket.on('clRequestSkip', () => {
    const ctx = requireRoom(socket, 'clRequestSkip');
    if (!ctx) return;
    const { roomCode, room } = ctx;

    // Accept if intermission is active OR game is in ACTIVE state (lenient guard —
    // avoids silently dropping the request in race conditions near the end of intermission)
    const gameIsActive = room.gameState === 'ACTIVE';
    if (!gameIsActive) return;

    const requester = room.players.find(p => p.id === socket.id);
    if (!requester || socket.id === room.host) return; // host can't request to themselves

    // Broadcast to the whole room; client-side handler filters by isHost so only
    // the host renders the notification — avoids stale socket-ID targeting issues
    console.log(`[CL] Skip request from "${requester.name}" — broadcasting clSkipRequested to room ${roomCode}`);
    io.to(roomCode).emit('clSkipRequested', { name: requester.name });
  });

  // ── clSkipIntermission (host skips the 15s break) ──────────────────────────
  socket.on('clSkipIntermission', () => {
    const ctx = requireRoom(socket, 'clSkipIntermission');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (rejectIfNotHost(socket, room, 'clSkipIntermission')) return;
    console.log(`[CL] Host (${socket.id}) skipping break in room ${roomCode}`);
    if (room._clIntermissionCancel) {
      room._clIntermissionCancel(); // triggers startNext() → clBreakEnded + clRoundStart
    }
  });

  // ── clSoloQuit (solo player ends the endless session) ────────────────────────
  socket.on('clSoloQuit', () => {
    const ctx = requireRoom(socket, 'clSoloQuit');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (room.gameMode !== 'CONNECT_LETTERS') return;
    if (!room.gameData?.isSolo) return;

    room.gameData.roundState = 'IDLE';
    // Transition to GAME_END so Play Again works cleanly
    const { endRound, endGame } = require('./engine/gameEngine');
    try { endRound(roomCode); } catch(_) {}
    try { endGame(roomCode); } catch(_) {}
    const player = room.players.find(p => p.id === socket.id);
    const history = room.gameData.wordHistory?.[socket.id] || [];
    const accepted = history.filter(e => e.status === 'accepted').length;

    socket.emit('endGameResponse', {
      winner:        player || null,
      isSolo:        true,
      soloQuit:      true,
      players:       room.players,
      wordHistory:   room.gameData.wordHistory || {},
      soloWordCount: accepted,
      passedRounds:  room.gameData.passedRounds || {},
    });
  });

  // ── clBOSelect (host picks match format in lobby) ─────────────────────────

  socket.on('clBOSelect', ({ bo } = {}) => {
    const ctx = requireRoom(socket, 'clBOSelect');
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (rejectIfNotHost(socket, room, 'clBOSelect')) return;
    if (![3, 5, 7].includes(bo)) return;
    if (room.players.length < 2) return; // BO format not used in solo mode
    room.clBO = bo;
    broadcastRoomUpdate(roomCode, room);
  });

  // ── clDictToggle (host toggles pair-validity check in CTL lobby) ────────────
  // (Dictionary toggle for CL is now handled by the unified dictToggle event)

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

  // ── resetGame (legacy — kept for solo Word Chain play-again) ──────────────
  socket.on("resetGame", () => {
    const ctx = requireRoom(socket, "resetGame");
    if (!ctx) return;
    const { roomCode, room } = ctx;
    if (rejectIfNotHost(socket, room, "resetGame")) return;
    const result = resetGame(roomCode);
    socket.emit("resetGameResponse", { success: result.success, error: result.error });
    if (result.success) broadcastRoomUpdate(roomCode, result.room);
  });

  // ── playAgainNew ────────────────────────────────────────────────────────────
  // Host creates a BRAND-NEW room, then invites all previous players.
  // Both Word Chain and Connect the Letters use this path.
  socket.on("playAgainNew", ({ playerName: clientName, gameType: clientGameType, guests: clientGuests } = {}) => {
    console.log('[DEBUG] Play Again clicked by socket', socket.id);

    // Try to find the old room — but do NOT fail if it's gone.
    const oldCode = findRoomBySocket(socket.id);
    const oldRoom = oldCode ? getRoom(oldCode) : null;

    // Resolve identity: prefer room data, fall back to client-supplied values
    const playerName = oldRoom?.players.find(p => p.id === socket.id)?.name || clientName;
    const gameType   = oldRoom?.gameMode || clientGameType;

    if (!playerName || !gameType) {
      console.warn(`[PlayAgain] Missing playerName or gameType for ${socket.id}`);
      return socket.emit("playAgainNewResponse", { success: false, error: "Could not determine player name or game type." });
    }

    // If host is in old room, verify they are the host (soft check — warn but don't block)
    if (oldRoom && oldRoom.host !== socket.id) {
      console.warn(`[PlayAgain] Non-host ${socket.id} tried playAgainNew in ${oldCode}`);
      return socket.emit("playAgainNewResponse", { success: false, error: "Only the host can start a new game." });
    }

    // Collect guests from old room OR from client-supplied list
    const guests = oldRoom
      ? oldRoom.players.filter(p => p.id !== socket.id).map(p => ({ id: p.id, name: p.name }))
      : (clientGuests || []);

    // Cancel any active intermission in old room
    if (oldRoom?._clIntermissionCancel) {
      oldRoom._clIntermissionCancel();
    }

    // Forcefully remove host from old room so `findRoomBySocket` doesn't get confused
    // when the host's socket disconnects during page navigation.
    if (oldRoom) {
      oldRoom.players = oldRoom.players.filter(p => p.id !== socket.id);
    }

    // Create the new room
    const newResult = createRoom(socket.id, playerName, gameType);
    if (!newResult.success) {
      return socket.emit("playAgainNewResponse", { success: false, error: newResult.error });
    }
    const newCode = newResult.roomCode;
    console.log('[DEBUG] New room created:', newCode);
    console.log('[DEBUG] Room saved successfully');

    // Set gameState to SETUP temporarily so leaveRoom won't delete the room
    // when S_old (this socket) disconnects during page navigation.
    // rejoinRoom will reset it back to LOBBY once the host's new socket arrives.
    newResult.room.gameState = 'SETUP';

    // Move host socket to new IO room; leave old one
    socket.join(newCode);
    if (oldCode) socket.leave(oldCode);
    console.log('[DEBUG] Host joined new room IO channel');

    // Copy relevant settings
    if (oldRoom?.maxPlayers) newResult.room.maxPlayers = oldRoom.maxPlayers;
    if (oldRoom?.clBO) newResult.room.clBO = oldRoom.clBO;
    if (typeof oldRoom?.dictEnabled !== 'undefined') newResult.room.dictEnabled = oldRoom.dictEnabled;

    // Tell host to navigate to new lobby
    socket.emit("playAgainNewResponse", { success: true, newCode, gameType });

    // Invite all previous guests
    for (const guest of guests) {
      console.log(`[DEBUG] Invitation sent to ${guest.name} (${guest.id})`);
      console.log(`[DEBUG] Invitation payload:`, { newCode, gameType });
      io.to(guest.id).emit("reInviteDialog", {
        newCode,
        gameType,
        message: "The host has created a new room and is waiting for players.",
      });
    }

    broadcastRoomUpdate(newCode, newResult.room);
  });

  // ── reInviteResponse ────────────────────────────────────────────────────────
  // Non-host player accepts or declines the Play Again invitation.
  socket.on("reInviteResponse", ({ newCode, action, playerName } = {}) => {
    if (!newCode) return;
    const newRoom = getRoom(newCode);
    if (!newRoom) {
      return socket.emit("reInviteResponseResult", { success: false, error: "Room no longer exists." });
    }

    if (action === "accept") {
      console.log(`[DEBUG] Invitation accepted by ${playerName}`);
      // The old flow called joinRoom here, which added the guest's OLD socket to the new room.
      // This caused state mismatches when they navigated to the lobby.
      // We now just send them to the lobby immediately to execute a normal manual join.
      socket.emit("reInviteResponseResult", { success: true, newCode, gameType: newRoom.gameMode });
    } else {
      // Decline — notify host
      console.log(`[PlayAgain] ${playerName} declined invite for ${newCode}`);
      io.to(newRoom.host).emit("reInviteDeclined", { name: playerName });
    }
  });
});

// ─── Shared leave handler ─────────────────────────────────────────────────────

function handleLeave(socket) {
  const result = leaveRoom(socket.id);
  if (!result) return;

  const { roomCode, room } = result;
  socket.leave(roomCode);

  if (room) {
    // Only wipe game data in LOBBY state. During SETUP/ACTIVE/GAME_END the player
    // is navigating lobby.html → game.html; their socket ID changes but their data
    // must survive so the reconnect remap in joinRoom can work correctly.
    const inProgress = ['SETUP', 'ACTIVE', 'ROUND_END', 'GAME_END'].includes(room.gameState);
    if (!inProgress && room.gameData) {
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