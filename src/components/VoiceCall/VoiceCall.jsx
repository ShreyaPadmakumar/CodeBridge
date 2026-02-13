import { useState, useEffect, useRef, useCallback } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Volume2, VolumeX, Users, Radio, X } from 'lucide-react';
import Peer from 'peerjs';
import { getSocket, getSocketId, isConnected as socketConnected } from '../../services/socket';

export default function VoiceRoom({ roomId, userName = 'You' }) {
    // State
    const [isInCall, setIsInCall] = useState(false);
    const [isPanelVisible, setIsPanelVisible] = useState(false);
    const [isMuted, setIsMuted] = useState(true); // Start muted by default
    const [isDeafened, setIsDeafened] = useState(false);
    const [participants, setParticipants] = useState([]); // { peerId, socketId, isMuted }
    const [error, setError] = useState('');
    const [isConnecting, setIsConnecting] = useState(false);

    // Refs
    const peerRef = useRef(null);
    const localStreamRef = useRef(null);
    const connectionsRef = useRef(new Map()); // peerId -> { call, audio }
    const myPeerIdRef = useRef(null);
    const audioContainerRef = useRef(null);

    // Generate unique peer ID
    const generatePeerId = useCallback(() => {
        const socketId = getSocketId();
        if (!socketId) return null;
        const suffix = `${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
        return `vr-${socketId.substring(0, 8)}-${suffix}`;
    }, []);

    // Handle main button click
    const handleMainButtonClick = () => {
        if (isInCall) {
            // If in call, toggle panel visibility
            setIsPanelVisible(!isPanelVisible);
        } else {
            // If not in call, join
            joinVoiceRoom();
        }
    };

    // Initialize Peer and join voice room
    const joinVoiceRoom = useCallback(async () => {
        if (isInCall || isConnecting) return;

        setIsConnecting(true);
        setError('');
        setIsPanelVisible(true); // Show panel when joining

        // Get microphone access first
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            localStreamRef.current = stream;

            // Start muted
            stream.getAudioTracks().forEach(track => track.enabled = false);

        } catch (err) {
            console.error('mic access denied:', err);
            setError('Microphone access required. Please allow permissions.');
            setIsConnecting(false);
            return;
        }

        // Initialize PeerJS
        const peerId = generatePeerId();
        if (!peerId) {
            setError('Not connected to server');
            setIsConnecting(false);
            return;
        }

        myPeerIdRef.current = peerId;
        console.log('joining voice room with ID:', peerId);

        const peer = new Peer(peerId, {
            debug: 0,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
        });

        peer.on('open', (id) => {
            console.log('peerjs ready:', id);
            peerRef.current = peer;
            setIsInCall(true);
            setIsConnecting(false);

            // Announce to room that we joined voice
            const socket = getSocket();
            if (socket) {
                socket.emit('voice-join', { peerId: id, roomId });
            }
        });

        peer.on('call', (call) => {
            console.log('incoming voice connection from:', call.peer);
            // Answer with our stream
            call.answer(localStreamRef.current);
            handleIncomingCall(call);
        });

        peer.on('error', (err) => {
            console.error('peerjs error:', err.type);
            if (err.type === 'unavailable-id') {
                // Retry with new ID
                peer.destroy();
                setTimeout(joinVoiceRoom, 500);
            } else {
                setError('Connection error. Please try again.');
                setIsConnecting(false);
            }
        });

        peerRef.current = peer;
    }, [isInCall, isConnecting, generatePeerId, roomId]);

    // Handle incoming call
    const handleIncomingCall = useCallback((call) => {
        call.on('stream', (remoteStream) => {
            console.log('got audio stream from:', call.peer);

            // Create audio element for this peer
            const audio = document.createElement('audio');
            audio.srcObject = remoteStream;
            audio.autoplay = true;
            audio.id = `audio-${call.peer}`;

            if (audioContainerRef.current) {
                audioContainerRef.current.appendChild(audio);
            }

            connectionsRef.current.set(call.peer, { call, audio });

            // Update participants list
            setParticipants(prev => {
                if (!prev.find(p => p.peerId === call.peer)) {
                    return [...prev, { peerId: call.peer, socketId: call.peer.split('-')[1], isMuted: false }];
                }
                return prev;
            });
        });

        call.on('close', () => {
            console.log('peer disconnected:', call.peer);
            const conn = connectionsRef.current.get(call.peer);
            if (conn?.audio) {
                conn.audio.remove();
            }
            connectionsRef.current.delete(call.peer);
            setParticipants(prev => prev.filter(p => p.peerId !== call.peer));
        });
    }, []);

    // Connect to a new peer
    const connectToPeer = useCallback((targetPeerId) => {
        if (!peerRef.current || !localStreamRef.current) return;
        if (connectionsRef.current.has(targetPeerId)) return; // Already connected
        if (targetPeerId === myPeerIdRef.current) return; // Don't connect to self

        console.log('connecting to peer:', targetPeerId);
        const call = peerRef.current.call(targetPeerId, localStreamRef.current);

        if (call) {
            handleIncomingCall(call);
        }
    }, [handleIncomingCall]);

    // Listen for voice room events
    useEffect(() => {
        const socket = getSocket();
        if (!socket) return;

        const handleVoiceJoin = ({ peerId, socketId, username }) => {
            console.log('user joined voice:', peerId, 'username:', username);
            if (peerId === myPeerIdRef.current) return;

            if (isInCall) {
                // Connect to the new peer
                setTimeout(() => connectToPeer(peerId), 500);
            }
            setParticipants(prev => {
                if (!prev.find(p => p.peerId === peerId)) {
                    return [...prev, { peerId, socketId, isMuted: true, username: username || `User-${socketId?.substring(0, 4)}` }];
                }
                return prev;
            });
        };

        const handleVoiceLeave = ({ peerId }) => {
            console.log('user left voice:', peerId);
            const conn = connectionsRef.current.get(peerId);
            if (conn?.audio) {
                conn.audio.remove();
            }
            if (conn?.call) {
                conn.call.close();
            }
            connectionsRef.current.delete(peerId);
            setParticipants(prev => prev.filter(p => p.peerId !== peerId));
        };

        const handleVoiceMute = ({ peerId, isMuted }) => {
            setParticipants(prev => prev.map(p =>
                p.peerId === peerId ? { ...p, isMuted } : p
            ));
        };

        const handleVoiceParticipants = ({ participants: existingPeers }) => {
            console.log('existing voice participants:', existingPeers);
            // Connect to all existing peers and store their usernames
            existingPeers.forEach(({ peerId, socketId, username }) => {
                if (peerId !== myPeerIdRef.current) {
                    setTimeout(() => connectToPeer(peerId), 500);
                    // Add to participants with username
                    setParticipants(prev => {
                        if (!prev.find(p => p.peerId === peerId)) {
                            return [...prev, { peerId, socketId, isMuted: true, username: username || `User-${socketId?.substring(0, 4)}` }];
                        }
                        return prev;
                    });
                }
            });
        };

        socket.on('voice-join', handleVoiceJoin);
        socket.on('voice-leave', handleVoiceLeave);
        socket.on('voice-mute', handleVoiceMute);
        socket.on('voice-participants', handleVoiceParticipants);

        return () => {
            socket.off('voice-join', handleVoiceJoin);
            socket.off('voice-leave', handleVoiceLeave);
            socket.off('voice-mute', handleVoiceMute);
            socket.off('voice-participants', handleVoiceParticipants);
        };
    }, [isInCall, connectToPeer]);

    // Leave voice room
    const leaveVoiceRoom = useCallback(() => {
        console.log('leaving voice room');

        // Notify others
        const socket = getSocket();
        if (socket && myPeerIdRef.current) {
            socket.emit('voice-leave', { peerId: myPeerIdRef.current, roomId });
        }

        // Close all connections
        connectionsRef.current.forEach(({ call, audio }) => {
            if (audio) audio.remove();
            if (call) call.close();
        });
        connectionsRef.current.clear();

        // Stop local stream
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
        }

        // Destroy peer
        if (peerRef.current) {
            peerRef.current.destroy();
            peerRef.current = null;
        }

        setIsInCall(false);
        setIsPanelVisible(false); // Hide panel when leaving
        setParticipants([]);
        setIsMuted(true);
    }, [roomId]);

    // Toggle mute
    const toggleMute = useCallback(() => {
        if (localStreamRef.current) {
            const newMuted = !isMuted;
            localStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = !newMuted;
            });
            setIsMuted(newMuted);

            // Notify others
            const socket = getSocket();
            if (socket && myPeerIdRef.current) {
                socket.emit('voice-mute', { peerId: myPeerIdRef.current, isMuted: newMuted, roomId });
            }
        }
    }, [isMuted, roomId]);

    // Toggle deafen
    const toggleDeafen = useCallback(() => {
        const newDeafened = !isDeafened;
        connectionsRef.current.forEach(({ audio }) => {
            if (audio) audio.muted = newDeafened;
        });
        setIsDeafened(newDeafened);
    }, [isDeafened]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (isInCall) {
                leaveVoiceRoom();
            }
        };
    }, []);

    return (
        <>
            {/* Hidden audio container */}
            <div ref={audioContainerRef} style={{ display: 'none' }} />

            {/* Voice Room Button */}
            <button
                onClick={handleMainButtonClick}
                className={`voice-toggle-btn ${isInCall ? 'voice-active' : ''}`}
                title={isInCall ? (isPanelVisible ? 'Hide Controls' : 'Show Controls') : 'Join Voice'}
                disabled={isConnecting}
            >
                {isConnecting ? (
                    <div className="voice-btn-spinner" />
                ) : isInCall ? (
                    <Phone size={24} />
                ) : (
                    <Phone size={24} />
                )}
            </button>

            {/* Voice Room Panel - Only show when in call AND visible */}
            {isInCall && isPanelVisible && (
                <div className="voice-panel voice-room-panel">
                    <div className="voice-header">
                        <span>
                            <Radio size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                            Voice Room
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div className="voice-header-status">
                                <span className="voice-live-dot"></span>
                                LIVE
                            </div>
                            <button
                                onClick={() => setIsPanelVisible(false)}
                                className="voice-close-btn"
                                title="Hide panel (stay in call)"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    </div>

                    <div className="voice-content">
                        {error && <div className="voice-error">{error}</div>}

                        {/* Self controls */}
                        <div className="voice-self-controls">
                            <button
                                onClick={toggleMute}
                                className={`voice-control-btn ${isMuted ? 'voice-control-muted' : 'voice-control-unmuted'}`}
                                title={isMuted ? 'Unmute' : 'Mute'}
                            >
                                {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                            </button>
                            <span className="voice-self-status">
                                {isMuted ? 'Muted' : 'Speaking'}
                            </span>
                            <button
                                onClick={toggleDeafen}
                                className={`voice-control-btn ${isDeafened ? 'voice-control-active' : ''}`}
                                title={isDeafened ? 'Undeafen' : 'Deafen'}
                            >
                                {isDeafened ? <VolumeX size={20} /> : <Volume2 size={20} />}
                            </button>
                        </div>

                        {/* Participants */}
                        <div className="voice-participants-header">
                            <Users size={14} />
                            <span>In Call ({participants.length + 1})</span>
                        </div>

                        <div className="voice-participants-list">
                            {/* Self - mute/unmute controls above */}

                            {/* Other participants */}
                            {[
                                {
                                    peerId: 'local',
                                    username: userName,
                                    socketId: getSocketId(),
                                    isMuted: isMuted,
                                    isMe: true
                                },
                                ...participants
                            ].map(p => (
                                <div key={p.peerId} className={`voice-participant ${p.isMe ? 'voice-participant-self' : ''}`}>
                                    <span className="voice-participant-name">
                                        {p.username || `User ${p.socketId?.substring(0, 4)}`}
                                    </span>
                                    <div className="voice-participant-status">
                                        {p.isMuted ? <MicOff size={14} /> : <Mic size={14} className="voice-speaking" />}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Leave button */}
                        <button onClick={leaveVoiceRoom} className="voice-leave-btn">
                            <PhoneOff size={16} />
                            Leave Voice
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
