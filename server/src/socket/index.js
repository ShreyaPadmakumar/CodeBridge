import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Room from '../models/Room.js';
import RoomState from '../models/RoomState.js';

// socket handler - realtime sync for code, canvas, chat, voice

const roomUsers = new Map();
const roomHosts = new Map();
const roomSettings = new Map();

const saveTimers = new Map();
const pendingSaves = new Map();

const debouncedSave = (roomId, fileId = null, content = null) => {
    if (saveTimers.has(roomId)) {
        clearTimeout(saveTimers.get(roomId));
    }

    if (fileId && content !== null) {
        if (!pendingSaves.has(roomId)) {
            pendingSaves.set(roomId, new Map());
        }
        pendingSaves.get(roomId).set(fileId, content);
    }

    const timer = setTimeout(async () => {
        try {
            const filesToSave = pendingSaves.get(roomId);
            if (filesToSave && filesToSave.size > 0) {
                for (const [fId, fContent] of filesToSave) {
                    await RoomState.findOneAndUpdate(
                        { roomId, 'codeFiles.id': fId },
                        {
                            $set: {
                                'codeFiles.$.content': fContent,
                                'codeFiles.$.lastModified': new Date()
                            },
                            lastUpdated: new Date()
                        }
                    );
                }
                console.log(`saved ${filesToSave.size} file(s) for room ${roomId}`);
                pendingSaves.delete(roomId);
            }
        } catch (error) {
            console.error(`save error for room ${roomId}:`, error.message);
        }
        saveTimers.delete(roomId);
    }, 2000);

    saveTimers.set(roomId, timer);
};

export default function initializeSocket(io) {
    // auth middleware
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token;

            if (token) {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const user = await User.findById(decoded.userId);
                if (user) {
                    socket.user = user;
                }
            }

            if (!socket.user) {
                socket.user = {
                    _id: `guest-${socket.id}`,
                    username: `Guest-${socket.id.substring(0, 6)}`,
                    isGuest: true
                };
            }

            next();
        } catch (error) {
            // invalid token - connect as guest anyway
            socket.user = {
                _id: `guest-${socket.id}`,
                username: `Guest-${socket.id.substring(0, 6)}`,
                isGuest: true
            };
            next();
        }
    });

    io.on('connection', (socket) => {
        console.log(`connected: ${socket.user.username} (${socket.id})`);

        // --- room management ---
        socket.on('join-room', async ({ roomId, displayName }) => {
            try {
                socket.join(roomId);
                socket.roomId = roomId;


                if (displayName && displayName.trim()) {
                    socket.user.username = displayName.trim();
                    socket.displayName = displayName.trim();
                }


                if (!roomUsers.has(roomId)) {
                    roomUsers.set(roomId, new Map());
                }
                roomUsers.get(roomId).set(socket.id, {
                    id: socket.user._id,
                    username: socket.user.username,
                    isGuest: socket.user.isGuest || false,
                    socketId: socket.id
                });

                if (!roomHosts.has(roomId)) {
                    roomHosts.set(roomId, socket.id);
                    console.log(`${socket.user.username} is now host of room ${roomId}`);
                }


                if (!roomSettings.has(roomId)) {
                    roomSettings.set(roomId, { chatDisabled: false });
                }

                // get state from db for late joiners
                const roomState = await RoomState.getOrCreate(roomId);
                const roomDoc = await Room.findOne({ roomId });

                if (roomDoc) {
                    const isPersistentHost = roomDoc.host && roomDoc.host.toString() === socket.user._id.toString();

                    if (isPersistentHost) {
                        roomHosts.set(roomId, socket.id);
                        console.log(`host reclaimed by ${socket.user.username}`);
                    } else if (!roomHosts.has(roomId)) {
                        if (!roomDoc.host) {
                            roomHosts.set(roomId, socket.id);
                            console.log(`${socket.user.username} became host (first joiner)`);
                        } else {
                            console.log(`room ${roomId} has a db host who isn't connected, ${socket.user.username} is a participant`);
                        }
                    }
                } else {
                    if (!roomHosts.has(roomId)) {
                        roomHosts.set(roomId, socket.id);
                    }
                }

                const hostSocketId = roomHosts.get(roomId);
                const settings = roomSettings.get(roomId);

                socket.emit('room-state', {
                    roomId,
                    state: {
                        codeFiles: roomState.codeFiles || [],
                        canvasFiles: roomState.canvasFiles || [],
                        chatMessages: roomState.chatMessages || [],
                        terminalHistory: roomState.terminalHistory || [],
                        activeCodeFileId: roomState.activeCodeFileId,
                        activeCanvasFileId: roomState.activeCanvasFileId
                    },
                    users: Array.from(roomUsers.get(roomId).values()),
                    hostSocketId,
                    chatDisabled: settings.chatDisabled
                });


                socket.to(roomId).emit('user-joined', {
                    user: {
                        id: socket.user._id,
                        username: socket.user.username,
                        socketId: socket.id
                    },
                    users: Array.from(roomUsers.get(roomId).values()),
                    hostSocketId
                });

                console.log(`${socket.user.username} joined room ${roomId}`);

            } catch (error) {
                console.error('Join room error:', error);
                socket.emit('error', { message: 'Failed to join room' });
            }
        });

        socket.on('leave-room', () => handleLeaveRoom(socket, io));

        // --- code sync ---
        socket.on('code-change', async ({ fileId, content, cursorPosition }) => {
            const roomId = socket.roomId;
            if (!roomId) {
                return;
            }


            socket.to(roomId).emit('code-change', {
                fileId,
                content,
                cursorPosition,
                userId: socket.user._id,
                username: socket.user.username
            });

            debouncedSave(roomId, fileId, content);
        });

        // file ops
        socket.on('file-create', async ({ file }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('file-create', { file, userId: socket.user._id });

            try {
                await RoomState.findOneAndUpdate(
                    { roomId },
                    { $push: { codeFiles: file } }
                );
            } catch (error) {
                console.error('File create save error:', error);
            }
        });

        socket.on('file-delete', async ({ fileId }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('file-delete', { fileId, userId: socket.user._id });

            try {
                await RoomState.findOneAndUpdate(
                    { roomId },
                    { $pull: { codeFiles: { id: fileId } } }
                );
            } catch (error) {
                console.error('File delete save error:', error);
            }
        });

        socket.on('file-rename', async ({ fileId, newName }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('file-rename', { fileId, newName, userId: socket.user._id });


            try {
                await RoomState.findOneAndUpdate(
                    { roomId, 'codeFiles.id': fileId },
                    {
                        $set: {
                            'codeFiles.$.filename': newName,
                            'codeFiles.$.lastModified': new Date()
                        },
                        lastUpdated: new Date()
                    }
                );
            } catch (error) {
                console.error('File rename save error:', error);
            }
        });

        socket.on('active-file-change', async ({ fileId }) => {
            const roomId = socket.roomId;
            if (!roomId) return;


            socket.to(roomId).emit('active-file-change', {
                fileId,
                userId: socket.user._id,
                username: socket.user.username
            });
        });

        // cursor sync
        socket.on('cursor-position', ({ fileId, position, selection }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('cursor-position', {
                fileId,
                position,
                selection,
                userId: socket.user._id,
                username: socket.user.username
            });
        });

        // intent collab
        socket.on('intent-update', ({ intent }) => {
            const roomId = socket.roomId;
            if (!roomId) return;


            const users = roomUsers.get(roomId);
            if (users && users.has(socket.id)) {
                const userInfo = users.get(socket.id);
                userInfo.intent = intent;
                users.set(socket.id, userInfo);
            }


            socket.to(roomId).emit('intent-update', {
                socketId: socket.id,
                username: socket.user.username,
                intent
            });
        });

        // tab groups

        socket.on('tab-group-create', async ({ group }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('tab-group-create', { group });

            try {
                await RoomState.findOneAndUpdate(
                    { roomId },
                    { $push: { tabGroups: group } }
                );
            } catch (error) {
                console.error('Tab group create error:', error);
            }
        });

        socket.on('tab-group-update', async ({ groupId, updates }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('tab-group-update', { groupId, updates });
        });

        socket.on('tab-group-delete', async ({ groupId }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('tab-group-delete', { groupId });

            try {
                await RoomState.findOneAndUpdate(
                    { roomId },
                    { $pull: { tabGroups: { id: groupId } } }
                );
            } catch (error) {
                console.error('Tab group delete error:', error);
            }
        });

        // --- canvas sync ---
        socket.on('canvas-object-add', ({ canvasId, object, objectId }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('canvas-object-add', {
                canvasId,
                object,
                objectId,
                userId: socket.user._id
            });
        });

        socket.on('canvas-object-modify', ({ canvasId, objectId, changes }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('canvas-object-modify', {
                canvasId,
                objectId,
                changes,
                userId: socket.user._id
            });
        });

        socket.on('canvas-object-delete', ({ canvasId, objectId }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('canvas-object-delete', {
                canvasId,
                objectId,
                userId: socket.user._id
            });
        });


        socket.on('canvas-path-create', ({ canvasId, pathData }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('canvas-path-create', {
                canvasId,
                pathData,
                userId: socket.user._id
            });
        });


        socket.on('canvas-full-sync', async (payload) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            console.log(`canvas sync from ${socket.user.username} in room ${roomId}`);

            socket.to(roomId).emit('canvas-full-sync', {
                ...payload,
                userId: socket.user._id
            });

            if (payload.fabricJSON && payload.canvasId) {
                try {
                    await RoomState.findOneAndUpdate(
                        { roomId, 'canvasFiles.id': payload.canvasId },
                        {
                            $set: {
                                'canvasFiles.$.fabricJSON': payload.fabricJSON
                            },
                            lastUpdated: new Date()
                        }
                    );
                    console.log(`canvas saved for room ${roomId}`);
                } catch (error) {
                    console.error('Canvas save error:', error);
                }
            }
        });


        socket.on('canvas-file-create', async ({ file }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('canvas-file-create', { file });

            try {
                await RoomState.findOneAndUpdate(
                    { roomId },
                    { $push: { canvasFiles: file } }
                );
            } catch (error) {
                console.error('Canvas file create error:', error);
            }
        });

        socket.on('canvas-file-switch', ({ canvasId }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('canvas-file-switch', {
                canvasId,
                userId: socket.user._id,
                username: socket.user.username
            });
        });

        // --- chat ---

        socket.on('chat-message', async ({ message }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            const chatMessage = {
                id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                userId: socket.user._id,
                username: socket.user.username,
                message,
                timestamp: new Date()
            };


            io.to(roomId).emit('chat-message', chatMessage);

            try {
                await RoomState.findOneAndUpdate(
                    { roomId },
                    {
                        $push: {
                            chatMessages: {
                                $each: [chatMessage],
                                $slice: -100
                            }
                        }
                    }
                );
            } catch (error) {
                console.error('Chat save error:', error);
            }
        });

        // --- voice ---
        if (!global.voiceRooms) {
            global.voiceRooms = new Map();
        }


        socket.on('voice-join', ({ peerId, roomId: voiceRoomId }) => {
            const roomId = socket.roomId || voiceRoomId;
            if (!roomId) return;

            console.log(`voice join: ${peerId} in room ${roomId}`);


            if (!global.voiceRooms.has(roomId)) {
                global.voiceRooms.set(roomId, []);
            }

            const voiceRoom = global.voiceRooms.get(roomId);


            socket.emit('voice-participants', {
                participants: voiceRoom.filter(p => p.peerId !== peerId).map(p => ({
                    peerId: p.peerId,
                    socketId: p.socketId,
                    isMuted: p.isMuted,
                    username: p.username
                }))
            });


            if (!voiceRoom.find(p => p.peerId === peerId)) {
                voiceRoom.push({ peerId, socketId: socket.id, isMuted: true, username: socket.user.username });
            }

            socket.voicePeerId = peerId;

            io.to(roomId).emit('voice-join', { peerId, socketId: socket.id, username: socket.user.username });
        });


        socket.on('voice-leave', ({ peerId }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            console.log(`voice leave: ${peerId} from room ${roomId}`);

            const voiceRoom = global.voiceRooms.get(roomId);
            if (voiceRoom) {
                const idx = voiceRoom.findIndex(p => p.peerId === peerId);
                if (idx !== -1) voiceRoom.splice(idx, 1);
            }

            socket.voicePeerId = null;
            io.to(roomId).emit('voice-leave', { peerId });
        });


        socket.on('voice-mute', ({ peerId, isMuted }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            const voiceRoom = global.voiceRooms.get(roomId);
            if (voiceRoom) {
                const participant = voiceRoom.find(p => p.peerId === peerId);
                if (participant) participant.isMuted = isMuted;
            }

            io.to(roomId).emit('voice-mute', { peerId, isMuted });
        });

        // terminal output

        socket.on('terminal-output', async ({ entry }) => {
            const roomId = socket.roomId;
            if (!roomId) return;


            socket.to(roomId).emit('terminal-output', { entry });


            try {
                await RoomState.findOneAndUpdate(
                    { roomId },
                    {
                        $push: {
                            terminalHistory: {
                                $each: [entry],
                                $slice: -50
                            }
                        }
                    }
                );
            } catch (error) {
                console.error('Terminal save error:', error);
            }
        });

        // --- canvas / cursor / voice II ---

        socket.on('canvas-full-sync', async (data) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            console.log(`canvas sync from ${socket.username} in room ${roomId}`);

            socket.to(roomId).emit('canvas-full-sync', data);

            if (data.type === 'full-canvas' && data.data) {
                try {
                    await RoomState.findOneAndUpdate(
                        { roomId },
                        {
                            $set: {
                                'canvasFiles.0.fabricJSON': data.data,
                                lastUpdated: new Date()
                            }
                        }
                    );
                } catch (error) {
                    console.error('Canvas save error:', error.message);
                }
            }
        });

        // cursor positions

        const cursorColors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#A78BFA', '#F472B6', '#34D399', '#60A5FA', '#FBBF24'];

        if (!global.roomCursorPositions) {
            global.roomCursorPositions = new Map();
        }

        socket.on('cursor-position', ({ position }) => {
            const roomId = socket.roomId;
            if (!roomId) return;

            const username = socket.user?.username || `Guest-${socket.id.substring(0, 6)}`;

            const colorIndex = Math.abs(username.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % cursorColors.length;

            if (!global.roomCursorPositions.has(roomId)) {
                global.roomCursorPositions.set(roomId, new Map());
            }
            global.roomCursorPositions.get(roomId).set(socket.id, {
                username,
                color: cursorColors[colorIndex],
                position
            });

            socket.to(roomId).emit('cursor-position', {
                socketId: socket.id,
                username,
                color: cursorColors[colorIndex],
                position
            });
        });


        socket.on('request-cursors', () => {
            const roomId = socket.roomId;
            if (!roomId) return;

            const cursors = global.roomCursorPositions.get(roomId);
            if (cursors && cursors.size > 0) {
                cursors.forEach((cursorData, cursorSocketId) => {
                    if (cursorSocketId !== socket.id) {
                        socket.emit('cursor-position', {
                            socketId: cursorSocketId,
                            ...cursorData
                        });
                    }
                });
            }
        });

        // voice (alt handler)
        const voiceParticipants = new Map();

        socket.on('voice-join', ({ peerId, roomId: voiceRoomId }) => {
            const roomId = voiceRoomId || socket.roomId;
            if (!roomId) return;

            console.log(`${socket.username} joined voice room ${roomId}`);

            if (!voiceParticipants.has(roomId)) {
                voiceParticipants.set(roomId, new Set());
            }
            voiceParticipants.get(roomId).add(peerId);

            // Notify others in the room
            socket.to(roomId).emit('voice-join', {
                peerId,
                socketId: socket.id,
                username: socket.username
            });

            const existing = Array.from(voiceParticipants.get(roomId)).filter(p => p !== peerId);
            if (existing.length > 0) {
                socket.emit('voice-participants', { participants: existing });
            }
        });

        socket.on('voice-leave', ({ peerId, roomId: voiceRoomId }) => {
            const roomId = voiceRoomId || socket.roomId;
            if (!roomId) return;

            console.log(`${socket.username} left voice room ${roomId}`);

            if (voiceParticipants.has(roomId)) {
                voiceParticipants.get(roomId).delete(peerId);
            }

            socket.to(roomId).emit('voice-leave', { peerId });
        });

        socket.on('voice-mute', ({ peerId, isMuted, roomId: voiceRoomId }) => {
            const roomId = voiceRoomId || socket.roomId;
            if (!roomId) return;

            socket.to(roomId).emit('voice-mute', { peerId, isMuted });
        });

        // host controls

        const isHost = (socket) => {
            const roomId = socket.roomId;
            return roomId && roomHosts.get(roomId) === socket.id;
        };


        socket.on('host-kick-user', ({ targetSocketId }) => {
            if (!isHost(socket)) {
                socket.emit('host-error', { message: 'Only the host can kick users' });
                return;
            }

            const roomId = socket.roomId;
            const targetSocket = io.sockets.sockets.get(targetSocketId);

            if (targetSocket && targetSocket.roomId === roomId) {
                targetSocket.emit('you-were-kicked', { by: socket.user.username });

                handleLeaveRoom(targetSocket, io);
                console.log(`${socket.user.username} kicked ${targetSocket.user.username} from room ${roomId}`);
            }
        });


        socket.on('host-mute-user', ({ targetSocketId }) => {
            if (!isHost(socket)) {
                socket.emit('host-error', { message: 'Only the host can mute users' });
                return;
            }

            io.to(targetSocketId).emit('you-were-muted', { by: socket.user.username });

            io.to(socket.roomId).emit('voice-mute', {
                peerId: null, // Will need peerId lookup
                socketId: targetSocketId,
                isMuted: true,
                forcedByHost: true
            });

            console.log(`host muted user ${targetSocketId} in room ${socket.roomId}`);
        });


        socket.on('host-transfer', ({ targetSocketId }) => {
            if (!isHost(socket)) {
                socket.emit('host-error', { message: 'Only the host can transfer host role' });
                return;
            }

            const roomId = socket.roomId;


            if (roomUsers.has(roomId) && roomUsers.get(roomId).has(targetSocketId)) {
                roomHosts.set(roomId, targetSocketId);

                io.to(roomId).emit('host-changed', { hostSocketId: targetSocketId });

                console.log(`host transferred from ${socket.id} to ${targetSocketId} in room ${roomId}`);
            }
        });


        socket.on('host-toggle-chat', ({ disabled }) => {
            if (!isHost(socket)) {
                socket.emit('host-error', { message: 'Only the host can toggle chat' });
                return;
            }

            const roomId = socket.roomId;

            if (roomSettings.has(roomId)) {
                roomSettings.get(roomId).chatDisabled = disabled;
            }

            io.to(roomId).emit('chat-toggled', { disabled, by: socket.user.username });

            console.log(`chat ${disabled ? 'disabled' : 'enabled'} by host in room ${roomId}`);
        });


        socket.on('host-end-session', () => {
            if (!isHost(socket)) {
                socket.emit('host-error', { message: 'Only the host can end the session' });
                return;
            }

            const roomId = socket.roomId;

            io.to(roomId).emit('session-ended', { by: socket.user.username });

            console.log(`session ended by host in room ${roomId}`);

            const roomSocketIds = roomUsers.has(roomId) ? Array.from(roomUsers.get(roomId).keys()) : [];

            roomSocketIds.forEach(socketId => {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) {
                    handleLeaveRoom(targetSocket, io);
                }
            });

            roomUsers.delete(roomId);
            roomHosts.delete(roomId);
            roomSettings.delete(roomId);
        });

        // disconnect

        socket.on('disconnect', () => {
            handleLeaveRoom(socket, io);
            console.log(`disconnected: ${socket.user.username}`);
        });
    });
}

function handleLeaveRoom(socket, io) {
    const roomId = socket.roomId;
    if (!roomId) return;


    if (roomUsers.has(roomId)) {
        roomUsers.get(roomId).delete(socket.id);

        if (roomHosts.get(roomId) === socket.id) {
            const remainingUsers = Array.from(roomUsers.get(roomId).keys());
            if (remainingUsers.length > 0) {
                const newHostId = remainingUsers[0];
                roomHosts.set(roomId, newHostId);
                console.log(`host transferred to ${newHostId} in room ${roomId}`);

                io.to(roomId).emit('host-changed', { hostSocketId: newHostId });
            }
        }

        socket.to(roomId).emit('user-left', {
            user: {
                id: socket.user._id,
                username: socket.user.username,
                socketId: socket.id
            },
            users: Array.from(roomUsers.get(roomId).values()),
            hostSocketId: roomHosts.get(roomId)
        });

        if (roomUsers.get(roomId).size === 0) {
            roomUsers.delete(roomId);
            roomHosts.delete(roomId);
            roomSettings.delete(roomId);
        }
    }

    socket.leave(roomId);
    socket.roomId = null;
}
