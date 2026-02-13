import { useState, useEffect, useRef } from 'react';
import { MessageCircle, X, Send, Users } from 'lucide-react';
import { sendChatMessage, onChatMessage, getSocketId, isConnected } from '../../services/socket';

export default function ChatPanel({ roomId, userName, disabled = false }) {
    const [isOpen, setIsOpen] = useState(false);
    const [message, setMessage] = useState('');
    const [messages, setMessages] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const messagesEndRef = useRef(null);
    const mySocketId = getSocketId();

    // Auto-scroll to bottom when new messages arrive
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    // Listen for incoming chat messages
    useEffect(() => {
        if (!roomId) return;

        const unsubscribe = onChatMessage((data) => {
            console.log('chat msg received:', data);

            setMessages(prev => [...prev, {
                id: data.id || `msg-${Date.now()}`,
                userId: data.userId,
                username: data.username || 'Unknown',
                message: data.message,
                timestamp: data.timestamp || new Date().toISOString(),
                isMe: data.userId === mySocketId || data.userId === `guest-${mySocketId}`
            }]);

            // Increment unread count if chat is closed
            if (!isOpen) {
                setUnreadCount(prev => prev + 1);
            }
        });

        return () => unsubscribe();
    }, [roomId, mySocketId, isOpen]);

    // Clear unread count when opening chat
    useEffect(() => {
        if (isOpen) {
            setUnreadCount(0);
        }
    }, [isOpen]);

    const handleSend = () => {
        if (!message.trim() || !isConnected()) return;

        console.log('sending chat msg:', message);
        sendChatMessage(message.trim());
        setMessage('');
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const formatTime = (timestamp) => {
        try {
            const date = new Date(timestamp);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch {
            return '';
        }
    };

    return (
        <>
            {/* Chat Toggle Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="chat-toggle-btn"
                title="Toggle Chat"
            >
                <MessageCircle size={24} />
                {unreadCount > 0 && (
                    <span className="chat-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
                )}
            </button>

            {/* Chat Panel */}
            {isOpen && (
                <div className="chat-panel">
                    <div className="chat-header">
                        <span>
                            <MessageCircle size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                            Room Chat
                        </span>
                        <button onClick={() => setIsOpen(false)} className="chat-close-btn">
                            <X size={16} />
                        </button>
                    </div>

                    <div className="chat-messages">
                        {messages.length === 0 ? (
                            <div className="chat-empty">
                                <Users size={32} style={{ opacity: 0.5, marginBottom: '8px' }} />
                                <p>No messages yet</p>
                                <p className="chat-empty-sub">Start the conversation!</p>
                            </div>
                        ) : (
                            messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`chat-message ${msg.isMe ? 'chat-message-me' : 'chat-message-other'}`}
                                >
                                    {!msg.isMe && (
                                        <div className="chat-message-username">{msg.username}</div>
                                    )}
                                    <div className="chat-message-content">
                                        <span className="chat-message-text">{msg.message}</span>
                                        <span className="chat-message-time">{formatTime(msg.timestamp)}</span>
                                    </div>
                                </div>
                            ))
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {disabled ? (
                        <div className="chat-disabled-message">
                            💬 Chat has been disabled by the host
                        </div>
                    ) : (
                        <div className="chat-input-container">
                            <input
                                type="text"
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={isConnected() ? "Type a message..." : "Not connected..."}
                                className="chat-input"
                                disabled={!isConnected()}
                            />
                            <button
                                onClick={handleSend}
                                className="chat-send-btn"
                                disabled={!message.trim() || !isConnected()}
                            >
                                <Send size={18} />
                            </button>
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
