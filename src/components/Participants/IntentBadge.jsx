import { INTENTS } from '../../services/intentDetector';

export default function IntentBadge({ intent, compact = false }) {
    if (!intent) return null;

    // Find the matching INTENTS entry
    const intentData = Object.values(INTENTS).find(i => i.key === intent) || INTENTS.EXPLORING;

    return (
        <span
            className={`intent-badge ${compact ? 'intent-badge-compact' : ''}`}
            style={{
                '--intent-color': intentData.color,
            }}
            title={`Currently ${intentData.label}`}
        >
            <span className="intent-badge-emoji">{intentData.emoji}</span>
            {!compact && <span className="intent-badge-label">{intentData.label}</span>}
        </span>
    );
}
