import { useState } from 'react';
import { Clock, RotateCcw, Trash2, X, History } from 'lucide-react';
import { getSnapshots, deleteSnapshot, formatSnapshotTime } from '../../services/snapshotService';

export default function SnapshotPanel({ isOpen, onClose, onRestore, isExperimenting }) {
    const [snapshots, setSnapshots] = useState(() => getSnapshots());

    // Refresh snapshots list
    const refreshSnapshots = () => {
        setSnapshots(getSnapshots());
    };

    const handleDelete = (id) => {
        deleteSnapshot(id);
        refreshSnapshots();
    };

    const handleRestore = (snapshot) => {
        if (onRestore) {
            onRestore(snapshot.code, snapshot.filename);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="snapshot-panel">
            <div className="snapshot-header">
                <div className="snapshot-title">
                    <History size={16} />
                    <span>Snapshots</span>
                    {isExperimenting && (
                        <span className="snapshot-active-dot" title="Auto-saving active" />
                    )}
                </div>
                <button className="snapshot-close-btn" onClick={onClose}>
                    <X size={16} />
                </button>
            </div>

            {isExperimenting && (
                <div className="snapshot-auto-banner">
                    <span className="snapshot-auto-icon">🧪</span>
                    Experimenting — auto-saving snapshots
                </div>
            )}

            <div className="snapshot-list">
                {snapshots.length === 0 ? (
                    <div className="snapshot-empty">
                        <Clock size={24} className="snapshot-empty-icon" />
                        <p>No snapshots yet</p>
                        <p className="snapshot-empty-sub">
                            Snapshots are auto-created when you enter Experimenting mode
                        </p>
                    </div>
                ) : (
                    snapshots.map((snap) => (
                        <div key={snap.id} className="snapshot-item">
                            <div className="snapshot-item-info">
                                <div className="snapshot-item-header">
                                    <span className="snapshot-item-file">{snap.filename}</span>
                                    <span className="snapshot-item-time">
                                        {formatSnapshotTime(snap.timestamp)}
                                    </span>
                                </div>
                                <pre className="snapshot-item-preview">{snap.preview}</pre>
                            </div>
                            <div className="snapshot-item-actions">
                                <button
                                    className="snapshot-action-btn restore"
                                    onClick={() => handleRestore(snap)}
                                    title="Restore this snapshot"
                                >
                                    <RotateCcw size={14} />
                                </button>
                                <button
                                    className="snapshot-action-btn delete"
                                    onClick={() => handleDelete(snap.id)}
                                    title="Delete this snapshot"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {snapshots.length > 0 && (
                <button className="snapshot-refresh-btn" onClick={refreshSnapshots}>
                    Refresh List
                </button>
            )}
        </div>
    );
}
