import { useState } from 'react';
import { Users, Plus, LogIn, Loader2, Copy, Check } from 'lucide-react';

export default function RoomManager({ onJoinRoom, isConnecting }) {
    const [mode, setMode] = useState('choice'); // 'choice', 'create', 'join'
    const [roomName, setRoomName] = useState('');
    const [roomId, setRoomId] = useState('');
    const [error, setError] = useState('');
    const [createdRoom, setCreatedRoom] = useState(null);
    const [copied, setCopied] = useState(false);

    const API_URL = import.meta.env.VITE_API_URL ||
        (window.location.hostname === 'localhost' ? 'http://localhost:5000/api' : `http://${window.location.hostname}:5000/api`);

    const createRoom = async () => {
        setError('');
        try {
            const response = await fetch(`${API_URL}/rooms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: roomName || 'Untitled Room' })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to create room');
            }

            setCreatedRoom(data.room);
        } catch (err) {
            setError(err.message);
        }
    };

    const joinRoom = async (id = roomId) => {
        setError('');
        const targetRoomId = id.trim().toUpperCase();

        if (!targetRoomId) {
            setError('Please enter a room ID');
            return;
        }

        onJoinRoom(targetRoomId);
    };

    const copyRoomId = () => {
        navigator.clipboard.writeText(createdRoom.roomId);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Choice screen
    if (mode === 'choice') {
        return (
            <div className="room-manager">
                <div className="room-manager-header">
                    <h1>Welcome to CodeBuddy</h1>
                    <p>Real-time collaborative coding platform</p>
                </div>

                <div className="room-options">
                    <button
                        className="room-option-btn create"
                        onClick={() => setMode('create')}
                    >
                        <Plus size={24} />
                        <span>Create Room</span>
                        <small>Start a new collaboration session</small>
                    </button>

                    <button
                        className="room-option-btn join"
                        onClick={() => setMode('join')}
                    >
                        <LogIn size={24} />
                        <span>Join Room</span>
                        <small>Join an existing session</small>
                    </button>
                </div>
            </div>
        );
    }

    // Create room screen
    if (mode === 'create') {
        if (createdRoom) {
            return (
                <div className="room-manager">
                    <div className="room-manager-header">
                        <h1>Room Created! 🎉</h1>
                        <p>Share this code with your collaborators</p>
                    </div>

                    <div className="room-created">
                        <div className="room-id-display">
                            <span className="room-id">{createdRoom.roomId}</span>
                            <button onClick={copyRoomId} className="copy-btn">
                                {copied ? <Check size={18} /> : <Copy size={18} />}
                            </button>
                        </div>
                        <p className="room-name">{createdRoom.name}</p>
                    </div>

                    <button
                        className="room-action-btn primary"
                        onClick={() => joinRoom(createdRoom.roomId)}
                        disabled={isConnecting}
                    >
                        {isConnecting ? (
                            <>
                                <Loader2 size={18} className="spin" />
                                Connecting...
                            </>
                        ) : (
                            <>
                                <Users size={18} />
                                Enter Room
                            </>
                        )}
                    </button>
                </div>
            );
        }

        return (
            <div className="room-manager">
                <div className="room-manager-header">
                    <h1>Create New Room</h1>
                    <p>Set up your collaboration space</p>
                </div>

                <div className="room-form">
                    <input
                        type="text"
                        placeholder="Room name (optional)"
                        value={roomName}
                        onChange={(e) => setRoomName(e.target.value)}
                        className="room-input"
                    />

                    {error && <p className="room-error">{error}</p>}

                    <div className="room-actions">
                        <button
                            className="room-action-btn secondary"
                            onClick={() => setMode('choice')}
                        >
                            Back
                        </button>
                        <button
                            className="room-action-btn primary"
                            onClick={createRoom}
                        >
                            <Plus size={18} />
                            Create Room
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Join room screen
    if (mode === 'join') {
        return (
            <div className="room-manager">
                <div className="room-manager-header">
                    <h1>Join Room</h1>
                    <p>Enter the room code to join</p>
                </div>

                <div className="room-form">
                    <input
                        type="text"
                        placeholder="Enter room code (e.g., ABC123)"
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                        className="room-input room-code-input"
                        maxLength={6}
                    />

                    {error && <p className="room-error">{error}</p>}

                    <div className="room-actions">
                        <button
                            className="room-action-btn secondary"
                            onClick={() => setMode('choice')}
                        >
                            Back
                        </button>
                        <button
                            className="room-action-btn primary"
                            onClick={() => joinRoom()}
                            disabled={isConnecting || !roomId.trim()}
                        >
                            {isConnecting ? (
                                <>
                                    <Loader2 size={18} className="spin" />
                                    Joining...
                                </>
                            ) : (
                                <>
                                    <LogIn size={18} />
                                    Join Room
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}
