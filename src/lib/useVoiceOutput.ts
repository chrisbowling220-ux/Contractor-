import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'

// Read-aloud for the app. Two engines, always in this order:
//
//   1. ElevenLabs (via the synthesizeSpeech function) — the good voice.
//   2. The phone's own built-in voice (window.speechSynthesis) — free, offline,
//      instant, and always there.
//
// The fallback is the important part. ElevenLabs' free tier is a shared monthly
// budget, so the server WILL start refusing calls partway through a busy month.
// When it does, the contractor still hears their schedule — just in the robot
// voice. Read-aloud never breaks, and it never quietly runs up a bill.

const speakCallable = httpsCallable<
  { clerkToken: string; input: { text: string } },
  {
    audioBase64: string
    mimeType: string
    characters: number
    truncated: boolean
    remainingUserChars: number
    remainingAccountChars: number
  }
>(functions, 'synthesizeSpeech')

// Prefer a natural-sounding en-US voice for the fallback. Browsers hand back
// wildly different lists, so this is best-effort: any English voice beats none.
function pickBrowserVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  const voices = synth.getVoices()
  if (!voices.length) return null
  const english = voices.filter(v => v.lang?.toLowerCase().startsWith('en'))
  const pool = english.length ? english : voices
  // Google/Siri/Microsoft neural voices sound markedly better than the defaults.
  const nice = pool.find(v => /google|siri|natural|neural|enhanced|premium/i.test(v.name))
  return nice || pool.find(v => v.lang?.toLowerCase() === 'en-us') || pool[0]
}

export type VoiceEngine = 'elevenlabs' | 'browser'

export function useVoiceOutput() {
  const { getToken } = useAuth()
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [engine, setEngine] = useState<VoiceEngine | null>(null)
  const [error, setError] = useState('')
  // Chars left in this contractor's monthly read-aloud budget, as of the last
  // successful call. null = unknown (never called, or the server refused).
  const [remainingChars, setRemainingChars] = useState<number | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  // Set to true when the browser blocked playback and the contractor needs to
  // tap once more. The audio is already downloaded, so the retry is instant.
  const [needsTap, setNeedsTap] = useState(false)

  const releaseAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    releaseAudio()
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
    setIsSpeaking(false)
    setIsLoading(false)
    setNeedsTap(false)
  }, [releaseAudio])

  // Never leave a voice talking after the screen is gone.
  useEffect(() => stop, [stop])

  const speakWithBrowser = useCallback((text: string): boolean => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return false
    try {
      const synth = window.speechSynthesis
      synth.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 0.95   // a touch slower than default — it's read over road noise
      const voice = pickBrowserVoice(synth)
      if (voice) utterance.voice = voice
      utterance.onend = () => setIsSpeaking(false)
      utterance.onerror = () => setIsSpeaking(false)
      synth.speak(utterance)
      setEngine('browser')
      setIsSpeaking(true)
      return true
    } catch {
      return false
    }
  }, [])

  // MUST be called from a real user gesture (a tap) — mobile browsers refuse
  // to start audio any other way.
  const speak = useCallback(async (text: string) => {
    const clean = (text || '').trim()
    if (!clean) return

    stop()
    setError('')

    // Create the element inside the gesture, before any await. Safari is much
    // more willing to play an element that was born during the tap.
    const audio = new Audio()
    audio.preload = 'auto'
    audioRef.current = audio
    setIsLoading(true)

    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('not-signed-in')

      const res = await speakCallable({ clerkToken, input: { text: clean } })
      const { audioBase64, mimeType, remainingUserChars, remainingAccountChars } = res.data
      if (!audioBase64) throw new Error('empty-audio')
      // Whichever budget runs out first is the one that will bite.
      setRemainingChars(Math.min(remainingUserChars ?? 0, remainingAccountChars ?? 0))

      // Base64 → Blob, so playback works offline-ish and we can revoke it later.
      const bytes = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'audio/mpeg' }))
      urlRef.current = url

      audio.src = url
      audio.onended = () => { setIsSpeaking(false); releaseAudio() }
      audio.onerror = () => { setIsSpeaking(false); releaseAudio() }

      await audio.play()
      setEngine('elevenlabs')
      setIsSpeaking(true)
    } catch (err) {
      // Everything that isn't a playback block — no key, budget spent, offline,
      // ElevenLabs down — lands here and gets the phone's own voice instead.
      releaseAudio()
      const name = (err as { name?: string })?.name
      if (name === 'NotAllowedError') {
        // Browser wants a fresh tap. The text is still in hand; ask for one.
        setNeedsTap(true)
        setError('Tap again to play.')
      } else if (!speakWithBrowser(clean)) {
        setError('This phone can\'t read text out loud.')
      }
    } finally {
      setIsLoading(false)
    }
  }, [getToken, releaseAudio, speakWithBrowser, stop])

  return { speak, stop, isSpeaking, isLoading, engine, error, needsTap, remainingChars }
}
