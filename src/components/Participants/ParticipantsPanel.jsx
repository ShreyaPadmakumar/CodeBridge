import { useState } from 'react';
import { Users, ChevronDown, ChevronUp, Crown, UserX, ArrowRightLeft } from 'lucide-react';
import { kickUser, transferHost, getSocketId } from '../../services/socket';
import IntentBadge from './IntentBadge';

export default function ParticipantsPanel({
    roomUsers = [],
    hostSocketId = null,
    isHost = false,
    userIntents = {}
}) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [activeMenu, setActiveMenu] = useState(null);
    const mySocketId = getSocketId();

    const getInitials = (user) => {
        if (user.username) return user.username.substring(0, 2).toUpperCase();
        if (user.socketId) return user.socketId.substring(0, 2).toUpperCase();
        return '??';
    };

    const getDisplayName = (user, index) => {
        if (user.username && user.username !== 'Guest') return user.username;
        return `User ${index + 1}`;
    };

    const handleKick = (socketId) => {
        if (confirm('Are you sure you want to kick this user?')) {
            kickUser(socketId);
        }
        setActiveMenu(null);
    };

    const handleTransfer = (socketId) => {
        if (confirm('Are you sure you want to transfer host role to this user?')) {
            transferHost(socketId);
        }
        setActiveMenu(null);
    };

    return (
        <div className="participants-panel">
            <button
                className="participants-header"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="participants-title">
                    <Users size={16} />
                    <span>Participants ({roomUsers.length})</span>
                </div>
                {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {isExpanded && (
                <div className="participants-list">
                    {roomUsers.length === 0 ? (
                        <div className="participants-empty">
                            No participants yet
                        </div>
                    ) : (
                        roomUsers.map((user, index) => {
                            const isThisUserHost = user.socketId === hostSocketId;
                            const isMe = user.socketId === mySocketId;
                            const showMenu = activeMenu === user.socketId;
                            const userIntent = userIntents[user.socketId];

                            return (
                                <div
                                    key={user.socketId || index}
                                    className={`participant-item ${isThisUserHost ? 'is-host' : ''}`}
                                    onClick={() => isHost && !isMe && setActiveMenu(showMenu ? null : user.socketId)}
                                >
                                    <div className="participant-avatar">
                                        {getInitials(user)}
                                        <span className="participant-online-dot"></span>
                                    </div>

                                    <div className="participant-info">
                                        <span className="participant-name">
                                            {getDisplayName(user, index)}
                                            {isMe && <span className="participant-you"> (You)</span>}
                                        </span>
                                        {userIntent && (
                                            <IntentBadge intent={userIntent} compact={true} />
                                        )}
                                    </div>

                                    {isThisUserHost && (
                                        <Crown size={16} className="host-crown" />
                                    )}

                                    {isHost && !isMe && showMenu && (
                                        <div className="participant-actions">
                                            <button
                                                className="action-btn kick"
                                                onClick={(e) => { e.stopPropagation(); handleKick(user.socketId); }}
                                                title="Kick User"
                                            >
                                                <UserX size={14} />
                                            </button>
                                            <button
                                                className="action-btn transfer"
                                                onClick={(e) => { e.stopPropagation(); handleTransfer(user.socketId); }}
                                                title="Make Host"
                                            >
                                                <ArrowRightLeft size={14} />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            )}
        </div>
    );
}
