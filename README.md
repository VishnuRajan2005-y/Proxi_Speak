<<<<<<< HEAD
# ProxiSpeak — Week 2 Review Prototype

A runnable prototype of a proximity-based virtual office. Includes the React Canvas world, Socket.IO movement/signaling, MongoDB GeoJSON schema + `2dsphere` index + `$near` query, and browser WebRTC audio negotiation restricted to peers within 100 pixels.

## What is implemented for the mid-project review

- **World rendering:** 2D office canvas with rooms, avatars, names, and a 100 px earshot circle.
- **Movement:** WASD or arrow keys; positions are sent over Socket.IO and broadcast to other connected clients.
- **Geospatial schema:** MongoDB `User` model stores GeoJSON Point locations and creates a `2dsphere` index.
- **Proximity filtering:** backend runs `$near` with `$maxDistance: 100` (pixel distances are treated as metres for the demo). If MongoDB is not configured, a Euclidean-distance in-memory fallback keeps local demos easy to run.
- **WebRTC audio:** microphone permission, peer connection offers/answers/ICE via Socket.IO, connection initiation only when peers are in range, volume attenuation and stereo panning in Web Audio API.
- **Health/debug:** `/api/health`, `/api/users`, in-earshot count in the UI.

> Honest review note: this is a Week 2 prototype, not a production-scaled 50+ user system. The current mesh and in-memory fallback are for demonstrating the flow. Redis adapter, server-side distance benchmarks, obstacle-based sound blocking, authentication and production TURN configuration are future work. The UI reports measured proximity-query duration, but the <20 ms target must still be tested under realistic load before claiming it is met.

## Requirements

- Node.js 20+ recommended
- npm
- Optional: MongoDB running locally or a MongoDB Atlas connection string
- A modern browser with microphone permission; use `localhost` or HTTPS for `getUserMedia`

## Run locally

1. Open a terminal in the `proxispeak` folder.
2. Install dependencies:

   ```bash
   npm install
   npm install --workspaces
   ```

3. Optional MongoDB setup: copy `.env.example` to `server/.env` and set `MONGODB_URI`. If no URI is set, the app uses the in-memory store.
4. Start both services:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:5173` in two browser tabs/windows. Enter different display names in each and join the office.
6. Allow microphone access in both windows, click **Enable microphone**, then move avatars close together using WASD/arrow keys. Keep the tabs unmuted and use headphones to prevent feedback.

Backend API: `http://localhost:3001/api/health`

## MongoDB notes

The GeoJSON point is `[x / 111320, y / 111320]`; this keeps coordinates within valid longitude/latitude bounds for the canvas-sized demo. `2dsphere` `$near` returns documents ordered by distance and `$maxDistance` is in metres for GeoJSON points. The application treats one canvas pixel as one metre for this demo. In-memory fallback uses exact Euclidean pixel distance.

## Mid-review demo checklist

1. Show the office canvas and avatar movement in browser A.
2. Join from browser B and show real-time position updates in both tabs.
3. Move avatars farther than 100 px apart: the earshot list should be empty.
4. Move them within 100 px: the earshot list should update and the backend permits WebRTC offers to that peer.
5. Enable microphone in both browsers and test audio at close range; move apart to hear volume attenuate.
6. Show `/api/health`; it reports `mongodb` or `memory-fallback`.
7. If MongoDB is enabled, explain the `location` GeoJSON field, `2dsphere` index, and `$near` query.

## Limitations to mention

- Browsers/network configurations may require a TURN server for WebRTC connectivity outside simple local tests.
- Current audio connection cleanup is proximity-driven; large meshes need stricter connection budgeting and robust re-negotiation.
- MongoDB query latency is not yet benchmarked. Measure server query duration before claiming the <20 ms target.
- Redis Pub/Sub and horizontal Socket.IO scaling are Week 3, not implemented here.
=======
# Proxi_Speak
>>>>>>> 93c227613b8cf4a24b07f745437c059b43cb37b7
