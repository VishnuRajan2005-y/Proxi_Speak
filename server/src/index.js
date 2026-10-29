import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import User from './models/User.js';

const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const EARSHOT = 100;
const METRES_PER_DEGREE = 111320;
const MIN_X = 18;
const MAX_X = 982;
const MIN_Y = 18;
const MAX_Y = 582;

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] } });
// This is the authoritative list of currently connected users. MongoDB is an
// optional spatial-query store; it must not decide whether a user is present.
const memoryUsers = new Map();
let mongoReady = false;

const toGeoPoint = (x, y) => ({ type: 'Point', coordinates: [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE] });
const publicUser = ({ socketId, name, x, y }) => ({ id: socketId, name, x, y });
const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);

function clampCoordinate(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

function readPosition(payload, fallback) {
  return {
    x: clampCoordinate(payload?.x, MIN_X, MAX_X, fallback.x),
    y: clampCoordinate(payload?.y, MIN_Y, MAX_Y, fallback.y)
  };
}

async function writeUserToMongo(record) {
  await User.findOneAndUpdate(
    { socketId: record.socketId },
    record,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function upsertUser(socketId, name, x, y) {
  const record = { socketId, name, x, y, location: toGeoPoint(x, y), updatedAt: new Date() };
  memoryUsers.set(socketId, record);

  if (!mongoReady) return;
  try {
    await writeUserToMongo(record);
  } catch (error) {
    // Presence and proximity still work locally if MongoDB becomes unavailable.
    mongoReady = false;
    console.warn('MongoDB write failed; using in-memory presence store:', error.message);
  }
}

async function removeUser(socketId) {
  memoryUsers.delete(socketId);
  if (!mongoReady) return;

  try {
    await User.deleteOne({ socketId });
  } catch (error) {
    mongoReady = false;
    console.warn('MongoDB delete failed; using in-memory presence store:', error.message);
  }
}

function getMemoryNearby(socketId, x, y, radius = EARSHOT) {
  return [...memoryUsers.values()].filter(user => (
    user.socketId !== socketId && Math.hypot(user.x - x, user.y - y) <= radius
  ));
}

async function getNearby(socketId, x, y, radius = EARSHOT) {
  const memoryNearby = getMemoryNearby(socketId, x, y, radius);
  if (!mongoReady || memoryNearby.length === 0) return memoryNearby.map(publicUser);

  try {
    // Limit the spatial query to live socket IDs. This prevents stale records
    // from a previous process from appearing in the virtual office.
    const liveIds = memoryNearby.map(user => user.socketId);
    const docs = await User.find({
      socketId: { $in: liveIds },
      location: { $near: { $geometry: toGeoPoint(x, y), $maxDistance: radius } }
    }).select('socketId').lean();

    // Use the in-memory profile after MongoDB determines distance/order. It is
    // always the freshest source while an update is in flight.
    const byId = new Map(memoryNearby.map(user => [user.socketId, user]));
    const mongoOrdered = docs.map(doc => byId.get(doc.socketId)).filter(Boolean);
    const returnedIds = new Set(mongoOrdered.map(user => user.socketId));
    return [...mongoOrdered, ...memoryNearby.filter(user => !returnedIds.has(user.socketId))].map(publicUser);
  } catch (error) {
    console.warn('MongoDB proximity query failed; using in-memory fallback:', error.message);
    return memoryNearby.map(publicUser);
  }
}

function getAllUsers() {
  return [...memoryUsers.values()].map(publicUser);
}

function affectedSocketIds(socketId, previousPosition, nextPosition) {
  const affected = new Set([socketId]);
  for (const user of memoryUsers.values()) {
    if (user.socketId === socketId) continue;
    if ((previousPosition && distance(user, previousPosition) <= EARSHOT)
      || (nextPosition && distance(user, nextPosition) <= EARSHOT)) {
      affected.add(user.socketId);
    }
  }
  return affected;
}

async function emitProximityUpdate(socket) {
  const profile = socket?.data?.profile;
  if (!socket?.connected || !profile) return;

  const startedAt = performance.now();
  const nearby = await getNearby(socket.id, profile.x, profile.y, EARSHOT);
  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
  socket.emit('proximity:update', { nearby, radius: EARSHOT });
  socket.emit('proximity:debug', { count: nearby.length, ids: nearby.map(user => user.id), elapsedMs });
}

async function refreshProximity(socketIds) {
  await Promise.all([...new Set(socketIds)].map(async socketId => {
    const socket = io.sockets.sockets.get(socketId);
    try {
      await emitProximityUpdate(socket);
    } catch (error) {
      socket?.emit('server:error', { message: `Proximity update failed: ${error.message}` });
    }
  }));
}

async function peerIsNearby(socket, targetId) {
  if (!targetId || !socket.data.profile || !io.sockets.sockets.has(targetId)) return false;
  const nearby = await getNearby(socket.id, socket.data.profile.x, socket.data.profile.y, EARSHOT);
  return nearby.some(user => user.id === targetId);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, database: mongoReady ? 'mongodb' : 'memory-fallback', earshot: EARSHOT });
});

app.get('/api/users', (_req, res) => {
  res.json({ users: getAllUsers() });
});

io.on('connection', socket => {
  socket.on('user:join', async payload => {
    try {
      const name = String(payload?.name || 'Guest').trim().slice(0, 24) || 'Guest';
      const previousPosition = socket.data.profile;
      const position = readPosition(payload, previousPosition || { x: 120, y: 120 });
      const profile = { name, ...position };

      await upsertUser(socket.id, name, position.x, position.y);
      socket.data.profile = profile;
      socket.emit('world:init', { selfId: socket.id, users: getAllUsers(), earshot: EARSHOT });
      socket.broadcast.emit('user:joined', { id: socket.id, ...profile });
      await refreshProximity(affectedSocketIds(socket.id, previousPosition, position));
      console.log(`${name} joined (${socket.id})`);
    } catch (error) {
      socket.emit('server:error', { message: `Could not join the world: ${error.message}` });
    }
  });

  socket.on('user:move', async payload => {
    if (!socket.data.profile) return;

    try {
      const previousPosition = { ...socket.data.profile };
      const position = readPosition(payload, previousPosition);
      socket.data.profile.x = position.x;
      socket.data.profile.y = position.y;
      await upsertUser(socket.id, socket.data.profile.name, position.x, position.y);
      socket.broadcast.emit('user:moved', { id: socket.id, ...position });
      await refreshProximity(affectedSocketIds(socket.id, previousPosition, position));
    } catch (error) {
      socket.emit('server:error', { message: `Movement/proximity update failed: ${error.message}` });
    }
  });

  // All signalling messages are accepted only for peers currently in earshot.
  socket.on('rtc:offer', async ({ targetId, offer } = {}) => {
    try {
      if (offer && await peerIsNearby(socket, targetId)) {
        io.to(targetId).emit('rtc:offer', { fromId: socket.id, offer });
      }
    } catch (error) {
      socket.emit('server:error', { message: error.message });
    }
  });

  socket.on('rtc:answer', async ({ targetId, answer } = {}) => {
    try {
      if (answer && await peerIsNearby(socket, targetId)) {
        io.to(targetId).emit('rtc:answer', { fromId: socket.id, answer });
      }
    } catch (error) {
      socket.emit('server:error', { message: error.message });
    }
  });

  socket.on('rtc:ice', async ({ targetId, candidate } = {}) => {
    try {
      if (candidate && await peerIsNearby(socket, targetId)) {
        io.to(targetId).emit('rtc:ice', { fromId: socket.id, candidate });
      }
    } catch (error) {
      socket.emit('server:error', { message: error.message });
    }
  });

  socket.on('disconnect', async () => {
    const previousPosition = socket.data.profile;
    await removeUser(socket.id);
    io.emit('user:left', { id: socket.id });
    await refreshProximity(affectedSocketIds(socket.id, previousPosition, null));
  });
});

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
      await User.init();
      mongoReady = true;
      // Persist any users who joined while the connection and index were starting.
      await Promise.all([...memoryUsers.values()].map(writeUserToMongo));
      console.log('MongoDB connected; 2dsphere index ready');
    })
    .catch(error => {
      mongoReady = false;
      console.warn('MongoDB unavailable; using in-memory fallback:', error.message);
    });
} else {
  console.log('MONGODB_URI not set; using in-memory presence store.');
}

server.listen(PORT, () => console.log(`ProxiSpeak server listening on http://localhost:${PORT}`));
