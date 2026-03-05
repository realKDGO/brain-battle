// server.js
// Only wires Socket.IO events — all room logic lives in roomManager.js.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const {
  createRoom,
  joinRoom,
  leaveRoom,
  findRoomBySocket,
} = require("./rooms/roomManager");

// ─── App Setup ────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // Tighten this in production
});

const PORT = process.env.PORT || 3000;

// ─── Serve Static Files ────────────────────────────────────────────────────────
app.use(express.static("public"));

// Fallback route for root
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Broadcast the full room object to every socket in that room.
 * If room is null (deleted), notify remaining socket if any.
 */
function broadcastRoomUpdate(roomCode, room) {
  if (room) {
    io.to(roomCode).emit("roomUpdate", room);
  }
}

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[+] Connected:  ${socket.id}`);

  // ── createRoom ─────────────────────────────────────────────────────────────
  // Client sends: playerName (string)
  // Server emits back to caller: "createRoomResponse" { success, roomCode?, error? }
  // Server emits to room:        "roomUpdate" (full room object)
  socket.on("createRoom", (playerName) => {
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return socket.emit("createRoomResponse", {
        success: false,
        error: "A valid player name is required.",
      });
    }

    const result = createRoom(socket.id, playerName.trim());

    if (result.success) {
      socket.join(result.roomCode);
      socket.emit("createRoomResponse", {
        success: true,
        roomCode: result.roomCode,
      });
      broadcastRoomUpdate(result.roomCode, result.room);
      console.log(
        `[Room] Created ${result.roomCode} by "${playerName}" (${socket.id})`
      );
    } else {
      socket.emit("createRoomResponse", { success: false, error: result.error });
    }
  });

  // ── joinRoom ───────────────────────────────────────────────────────────────
  // Client sends: { roomCode, playerName }
  // Server emits back to caller: "joinRoomResponse" { success, roomCode?, error? }
  // Server emits to room:        "roomUpdate"
  socket.on("joinRoom", ({ roomCode, playerName } = {}) => {
    if (!roomCode || typeof roomCode !== "string") {
      return socket.emit("joinRoomResponse", {
        success: false,
        error: "A valid room code is required.",
      });
    }
    if (!playerName || typeof playerName !== "string" || !playerName.trim()) {
      return socket.emit("joinRoomResponse", {
        success: false,
        error: "A valid player name is required.",
      });
    }

    const result = joinRoom(socket.id, roomCode.toUpperCase(), playerName.trim());

    if (result.success) {
      socket.join(result.roomCode);
      socket.emit("joinRoomResponse", {
        success: true,
        roomCode: result.roomCode,
      });
      broadcastRoomUpdate(result.roomCode, result.room);
      console.log(
        `[Room] "${playerName}" (${socket.id}) joined ${result.roomCode}`
      );
    } else {
      socket.emit("joinRoomResponse", { success: false, error: result.error });
    }
  });

  // ── leaveRoom ──────────────────────────────────────────────────────────────
  // Client sends: (no payload)
  // Server emits to room: "roomUpdate"  (or nothing if room was deleted)
  socket.on("leaveRoom", () => {
    handleLeave(socket);
  });

  // ── disconnect ─────────────────────────────────────────────────────────────
  // Treat a dropped connection exactly like a voluntary leave.
  socket.on("disconnect", () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    handleLeave(socket);
  });
});

// ─── Shared leave handler ─────────────────────────────────────────────────────

function handleLeave(socket) {
  const result = leaveRoom(socket.id);
  if (!result) return; // Player wasn't in any room

  const { roomCode, room } = result;
  socket.leave(roomCode);

  if (room) {
    // Room still alive — tell remaining players
    broadcastRoomUpdate(roomCode, room);
    console.log(`[Room] ${socket.id} left ${roomCode} (room still active)`);
  } else {
    // Room was deleted — nothing left to broadcast
    console.log(`[Room] ${roomCode} deleted (all players gone)`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});