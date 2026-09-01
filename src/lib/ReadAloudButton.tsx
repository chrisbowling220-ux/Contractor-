import { useVoiceOutput } from './useVoiceOutput'

const ORANGE = '#f97316'
const NAVY = '#1a1f2e'

// The one control for "say this out loud". Sized for a work glove — 44px is the
// floor for a reliable tap, and this sits above it.
//
// `getText` is a function, not a string, so the summary is built at tap time
// against whatever is on the calendar right then.
export default function ReadAloudButton({
  getText,
  label = 'Read aloud',
  compact = false,
}: {
  getText: () => string
  label?: string
  compact?: boolean
}) {
  const { speak, stop, isSpeaking, isLoading, error, needsTap, engine, remainingChars } = useVoiceOutput()

  const busy = isLoading
  // Tell the contractor what's happening to the good voice rather than letting
  // it silently change on them: either it's already gone for the month, or
  // it's about to be (roughly two more readbacks' worth left).
  const budgetNote = engine === 'browser'
    ? 'Read-aloud budget used up — using the phone\'s voice.'
    : remainingChars !== null && remainingChars < 600
      ? 'Read-aloud is nearly out for the month.'
      : ''
  const onTap = () => {
    if (isSpeaking) { stop(); return }
    speak(getText())
  }

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
      <button
        onClick={onTap}
        disabled={busy}
        aria-label={isSpeaking ? 'Stop reading' : label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '7px',
          minHeight: compact ? '40px' : '46px',
          padding: compact ? '0 14px' : '0 18px',
          background: isSpeaking ? '#dc2626' : busy ? '#cbd5e1' : 'white',
          color: isSpeaking ? 'white' : NAVY,
          border: isSpeaking ? 'none' : `2px solid ${ORANGE}`,
          borderRadius: '10px',
          cursor: busy ? 'default' : 'pointer',
          fontSize: compact ? '13px' : '14px',
          fontWeight: 700,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: '17px', lineHeight: 1 }}>
          {isSpeaking ? '⏹' : busy ? '⏳' : needsTap ? '▶' : '🔊'}
        </span>
        {isSpeaking ? 'Stop' : busy ? 'Getting it…' : needsTap ? 'Tap to play' : label}
      </button>

      {error && !needsTap && (
        <span style={{ fontSize: '11px', color: '#94a3b8' }}>{error}</span>
      )}
      {!error && budgetNote && (
        <span style={{ fontSize: '11px', color: '#94a3b8' }}>{budgetNote}</span>
      )}
    </div>
  )
}
