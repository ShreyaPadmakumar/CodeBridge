import express from 'express';
import Room from '../models/Room.js';
import RoomState from '../models/RoomState.js';
import { auth, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

const inMemoryRooms = new Map();
router.post('/', optionalAuth, async (req, res) => {
    try {
        const { name } = req.body;
        const hostId = req.user ? req.user._id : null;

        // Generate unique room ID
        const roomId = generateRoomId();
        const roomName = name || `Room ${roomId}`;

        // Store in memory
        inMemoryRooms.set(roomId, {
            roomId,
            name: roomName,
            createdAt: new Date().toISOString(),
            participants: [],
            host: hostId
        });

        console.log(`created room ${roomId} (host: ${hostId || 'anonymous'})`);

        // Send response immediately
        res.status(201).json({
            message: 'Room created',
            room: {
                roomId,
                name: roomName,
                createdAt: new Date().toISOString(),
                host: hostId
            }
        });

        // save to mongo in background
        saveRoomToDBAsync(roomId, roomName, hostId);

    } catch (error) {
        console.error('Create room error:', error);
        res.status(500).json({ error: 'Failed to create room' });
    }
});

// 6-char room ID
function generateRoomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function saveRoomToDBAsync(roomId, name, hostId) {
    try {
        const room = new Room({
            roomId,
            name,
            host: hostId
        });
        await room.save();
        console.log(`room ${roomId} saved to db`);
    } catch (error) {
        console.error(`Failed to save room ${roomId} to DB:`, error.message);
    }
}


router.get('/:roomId', async (req, res) => {
    try {
        const { roomId } = req.params;

        const room = await Room.findOne({ roomId })
            .populate('host', 'username email')
            .populate('participants.user', 'username');

        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        res.json({ room });

    } catch (error) {
        console.error('Get room error:', error);
        res.status(500).json({ error: 'Failed to get room' });
    }
});


router.get('/:roomId/state', async (req, res) => {
    try {
        const { roomId } = req.params;

        const state = await RoomState.getOrCreate(roomId);

        res.json({ state });

    } catch (error) {
        console.error('Get room state error:', error);
        res.status(500).json({ error: 'Failed to get room state' });
    }
});


router.post('/:roomId/join', optionalAuth, async (req, res) => {
    try {
        const roomIdParam = req.params.roomId;
        console.log(`join attempt for room: ${roomIdParam}`);

        // try both cases
        const roomIdUpper = roomIdParam.toUpperCase();
        const roomIdLower = roomIdParam.toLowerCase();

        // check memory first
        let memoryRoom = inMemoryRooms.get(roomIdUpper) || inMemoryRooms.get(roomIdLower) || inMemoryRooms.get(roomIdParam);

        if (memoryRoom) {
            console.log(`found room ${memoryRoom.roomId} in memory`);
            // Get or create room state
            const state = await RoomState.getOrCreate(memoryRoom.roomId);

            return res.json({
                message: 'Joined room',
                room: {
                    roomId: memoryRoom.roomId,
                    name: memoryRoom.name
                },
                state
            });
        }

        // fallback to mongo
        console.log(`Searching MongoDB for room: ${roomIdParam}`);
        let room = await Room.findOne({
            roomId: { $regex: new RegExp(`^${roomIdParam}$`, 'i') }
        });

        if (!room) {
            console.log(`room not found: ${roomIdParam}`);
            return res.status(404).json({ error: `Room ${roomIdParam} not found` });
        }

        console.log(`found room ${room.roomId} in mongodb`);


        if (req.user && !req.user.isGuest) {
            const alreadyJoined = room.participants.some(
                p => p.user?.toString() === req.user._id.toString()
            );

            if (!alreadyJoined) {
                room.participants.push({ user: req.user._id });
                await room.save();
            }
        }

        // get room state
        const state = await RoomState.getOrCreate(room.roomId);

        res.json({
            message: 'Joined room',
            room: {
                roomId: room.roomId,
                name: room.name
            },
            state
        });

    } catch (error) {
        console.error('Join room error:', error);
        res.status(500).json({ error: 'Failed to join room' });
    }
});


router.delete('/:roomId', auth, async (req, res) => {
    try {
        const { roomId } = req.params;

        const room = await Room.findOne({ roomId });

        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // only host can delete
        if (room.host?.toString() !== req.user._id.toString()) {
            return res.status(403).json({ error: 'Only the host can delete this room' });
        }


        await Room.deleteOne({ roomId });
        await RoomState.deleteOne({ roomId });

        res.json({ message: 'Room deleted' });

    } catch (error) {
        console.error('Delete room error:', error);
        res.status(500).json({ error: 'Failed to delete room' });
    }
});

export default router;
