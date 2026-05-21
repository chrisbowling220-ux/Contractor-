import { useState, useRef, useEffect } from 'react'
import { httpsCallable } from 'firebase/functions'
import { collection, addDoc, getDocs, query, where } from 'firebase/firestore'
import { useAuth, useUser } from '@clerk/clerk-react'
import { db, functions } from './firebase'
import { regionFromZip, DEFAULT_ZIP } from './data/materials'
import { buildFallbackQuote } from './lib/fallbackQuote'
import { toCustomerView } from './lib/customerView'
import type { AIQuote } from './data/types'

const callable = httpsCallable<
  {
    clerkToken: string
    input: {
      customerName: string
      jobLocationZip: string
      jobLocationRegion: string
      regionMultiplier: number
      transcript: string
      images: string[]
      hourlyRateOverride?: number
      markupPercentOverride?: number
      debugForceFail?: string
    }
  },
  AIQuote
>(functions, 'analyzeScan')

const transcribeCallable = httpsCallable<
  { clerkToken: string; input: { audioBase64: string; mimeType: string } },
  { transcript: string }
>(functions, 'transcribeAudio')

const sendEmailCallable = httpsCallable<
  {
    clerkToken: string
    input: {
      to: string
      fromName?: string
      replyTo?: string
      estimate: {
        customerName: string
        jobTypeName: string
        jobLocationZip: string
        total: number
        aiQuote?: AIQuote
      }
    }
  },
  { ok: boolean; emailId?: string }
>(functions, 'sendEstimateEmail')

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const result = r.result as string
      resolve(result.split(',')[1] || '')
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

// Pick the first MIME type the browser supports. Order matters: prefer formats
// Google Speech-to-Text handles natively, fall back to whatever the browser offers.
function pickRecorderMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
  ]
  if (typeof MediaRecorder === 'undefined') return ''
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

export default function ScanRoom() {
  const { user } = useUser()
  const { getToken } = useAuth()

  const [customers, setCustomers] = useState<{ id: string; name: string; email?: string }[]>([])
  const [customerId, setCustomerId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [zip, setZip] = useState(DEFAULT_ZIP)
  const [transcript, setTranscript] = useState('')
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [images, setImages] = useState<{ preview: string; data: string }[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [result, setResult] = useState<AIQuote | null>(null)
  const [error, setError] = useState('')
  const [savedId, setSavedId] = useState<string | null>(null)
  const [aiHourlyRate, setAiHourlyRate] = useState('65')
  const [aiMarkupPct, setAiMarkupPct] = useState('20')
  const [markupBasis, setMarkupBasis] = useState<'entire_job' | 'materials_only'>('entire_job')
  const [loadingMessage, setLoadingMessage] = useState('')
  const [usedFallback, setUsedFallback] = useState(false)
  const [refinement, setRefinement] = useState('')
  const [showRefine, setShowRefine] = useState(false)

  const [customerEmail, setCustomerEmail] = useState('')
  const [emailSending, setEmailSending] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [emailError, setEmailError] = useState('')

  const [videoRecording, setVideoRecording] = useState(false)
  const [videoProcessing, setVideoProcessing] = useState(false)
  const [videoElapsed, setVideoElapsed] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioStreamRef = useRef<MediaStream | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const videoRecRef = useRef<MediaRecorder | null>(null)
  const videoAudioRecRef = useRef<MediaRecorder | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  const videoChunksRef = useRef<Blob[]>([])
  const videoAudioChunksRef = useRef<Blob[]>([])
  const videoTimerRef = useRef<number | null>(null)
  const videoElapsedRef = useRef(0)
  const videoPreviewRef = useRef<HTMLVideoElement>(null)
  const frameCaptureIntervalRef = useRef<number | null>(null)

  const { region, multiplier } = regionFromZip(zip)
  const validZip = /^[0-9]{5}$/.test(zip)
  const audioSupported = typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(() => () => {
    mediaRecorderRef.current?.stop()
    audioStreamRef.current?.getTracks().forEach(t => t.stop())
    if (videoTimerRef.current) window.clearInterval(videoTimerRef.current)
    if (frameCaptureIntervalRef.current) window.clearInterval(frameCaptureIntervalRef.current)
    videoRecRef.current?.stop()
    videoAudioRecRef.current?.stop()
    videoStreamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  useEffect(() => {
    if (!user?.id) return
    ;(async () => {
      try {
        const snap = await getDocs(query(collection(db, 'customers'), where('createdBy', '==', user.id)))
        setCustomers(snap.docs.map(d => ({
          id: d.id,
          name: (d.data().name as string) || '',
          email: (d.data().email as string) || '',
        })))
      } catch {}
    })()
  }, [user?.id])

  const startRecording = async () => {
    setError('')
    if (!audioSupported) {
      setError('Audio recording not supported in this browser. Type the scope below instead.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream
      const mimeType = pickRecorderMimeType()
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      audioChunksRef.current = []
      rec.ondataavailable = e => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        audioStreamRef.current = null
        const blob = new Blob(audioChunksRef.current, { type: rec.mimeType || mimeType || 'audio/webm' })
        if (blob.size === 0) {
          setError('No audio captured — try again.')
          return
        }
        await sendAudioForTranscription(blob, rec.mimeType || mimeType)
      }
      rec.onerror = () => setError('Recording error — please try again.')
      mediaRecorderRef.current = rec
      rec.start()
      setRecording(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied'
      setError(`Couldn't start recording: ${msg}. Check that you've granted microphone permission.`)
    }
  }

  const stopRecording = () => {
    mediaRecorderRef.current?.stop()
    setRecording(false)
  }

  const sendAudioForTranscription = async (blob: Blob, mimeType: string) => {
    setTranscribing(true)
    setError('')
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const audioBase64 = await fileToBase64(blob)
      const res = await transcribeCallable({ clerkToken, input: { audioBase64, mimeType } })
      const newText = res.data.transcript.trim()
      if (!newText) {
        setError('Couldn\'t hear anything in that recording. Try again or type the scope below.')
      } else {
        // Append, so multiple recordings accumulate cleanly.
        setTranscript(prev => (prev ? prev.trim() + ' ' + newText : newText).replace(/\s+/g, ' ').trim())
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed. You can type the scope below instead.')
    } finally {
      setTranscribing(false)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    const remaining = 8 - images.length
    const picked = Array.from(files).slice(0, remaining)
    const next = await Promise.all(picked.map(async f => ({
      preview: URL.createObjectURL(f),
      data: await fileToBase64(f),
    })))
    setImages([...images, ...next])
  }

  const removeImage = (i: number) => setImages(images.filter((_, idx) => idx !== i))

  const stopVideoRecordingInternal = () => {
    if (videoTimerRef.current) { window.clearInterval(videoTimerRef.current); videoTimerRef.current = null }
    if (frameCaptureIntervalRef.current) { window.clearInterval(frameCaptureIntervalRef.current); frameCaptureIntervalRef.current = null }
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null
    videoAudioRecRef.current?.stop()
    videoRecRef.current?.stop()
    setVideoRecording(false)
  }

  const stopVideoRecording = () => stopVideoRecordingInternal()

  // Only transcribes audio — frames are already captured in real-time via the interval
  const processVideoAudio = async (audioMime: string) => {
    setVideoProcessing(true)
    try {
      if (videoAudioChunksRef.current.length > 0) {
        const audioBlob = new Blob(videoAudioChunksRef.current, { type: audioMime })
        if (audioBlob.size > 100) {
          await sendAudioForTranscription(audioBlob, audioMime)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audio transcription failed — frames were captured successfully.')
    } finally {
      videoStreamRef.current?.getTracks().forEach(t => t.stop())
      videoStreamRef.current = null
      setVideoProcessing(false)
    }
  }

  const startVideoRecording = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      })
      videoStreamRef.current = stream

      // Show live preview
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream
        videoPreviewRef.current.play().catch(() => {})
      }

      // Audio-only recorder → transcription
      const audioMime = pickRecorderMimeType()
      const audioOnlyStream = new MediaStream(stream.getAudioTracks())
      const audioRec = audioMime
        ? new MediaRecorder(audioOnlyStream, { mimeType: audioMime })
        : new MediaRecorder(audioOnlyStream)
      videoAudioChunksRef.current = []
      audioRec.ondataavailable = e => { if (e.data?.size > 0) videoAudioChunksRef.current.push(e.data) }
      videoAudioRecRef.current = audioRec

      // Video recorder (used only to get an onstop hook; frames come from the live canvas interval)
      const videoMime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
        .find(m => MediaRecorder.isTypeSupported(m)) || ''
      const videoRec = videoMime ? new MediaRecorder(stream, { mimeType: videoMime }) : new MediaRecorder(stream)
      videoChunksRef.current = []
      videoRec.onstop = async () => {
        await processVideoAudio(videoAudioRecRef.current?.mimeType || audioMime)
      }
      videoRecRef.current = videoRec

      // Capture a frame from the live preview every 3 seconds (capped at 8)
      frameCaptureIntervalRef.current = window.setInterval(() => {
        const vid = videoPreviewRef.current
        if (!vid || vid.readyState < 2) return
        setImages(prev => {
          if (prev.length >= 8) return prev
          const c = document.createElement('canvas')
          const cx = c.getContext('2d')
          if (!cx) return prev
          c.width = vid.videoWidth || 1280
          c.height = vid.videoHeight || 720
          cx.drawImage(vid, 0, 0, c.width, c.height)
          const preview = c.toDataURL('image/jpeg', 0.82)
          return [...prev, { preview, data: preview.split(',')[1] || '' }]
        })
      }, 3000)

      audioRec.start()
      videoRec.start()
      setVideoRecording(true)
      videoElapsedRef.current = 0
      setVideoElapsed(0)

      videoTimerRef.current = window.setInterval(() => {
        videoElapsedRef.current += 1
        setVideoElapsed(videoElapsedRef.current)
        if (videoElapsedRef.current >= 25) {
          stopVideoRecordingInternal()
        }
      }, 1000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Camera access denied'
      setError(`Couldn't start video: ${msg}. Make sure you've granted camera and microphone permission.`)
    }
  }

  const runAnalysis = async (transcriptOverride?: string) => {
    if (!customerName) { setError('Customer name required'); return }
    const activeTranscript = transcriptOverride ?? transcript
    if (images.length === 0 && !activeTranscript.trim()) { setError('Add at least one photo or some narration'); return }
    setAnalyzing(true); setError(''); setResult(null); setSavedId(null); setUsedFallback(false)
    setShowRefine(false)
    setLoadingMessage('Generating your estimate…')
    const timers: number[] = []
    timers.push(window.setTimeout(() => setLoadingMessage('Still working — Claude is analyzing your photos and narration…'), 10000))
    timers.push(window.setTimeout(() => setLoadingMessage('Anthropic seems busy. Retrying behind the scenes…'), 20000))
    timers.push(window.setTimeout(() => setLoadingMessage('One more try — this can take up to 45s for image analysis…'), 30000))

    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const markupInstruction = markupBasis === 'materials_only'
        ? `CONTRACTOR OVERRIDE — Apply the markup percentage to MATERIALS ONLY (not labor). Labor is billed at cost with no markup. In price_breakdown.raw_cost include labor at cost, then markup applies only to the materials_subtotal.`
        : ''
      const fullTranscript = [activeTranscript.trim(), markupInstruction].filter(Boolean).join('\n\n')

      const res = await callable({
        clerkToken,
        input: {
          customerName,
          jobLocationZip: zip,
          jobLocationRegion: region,
          regionMultiplier: multiplier,
          transcript: fullTranscript,
          images: images.map(i => i.data),
          hourlyRateOverride: Number(aiHourlyRate) || undefined,
          markupPercentOverride: aiMarkupPct === '' ? undefined : Number(aiMarkupPct),
          debugForceFail: new URLSearchParams(window.location.search).get('debugForceFail') || undefined,
        },
      })
      setResult(res.data)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // Fallback: build a minimal quote from the transcript + form inputs since
      // ScanRoom has no pre-form materials list. The contractor still gets a
      // structured shell they can edit.
      try {
        const fallback = buildFallbackQuote({
          customerName,
          jobTypeName: 'Scan Room (offline)',
          description: activeTranscript.trim().slice(0, 1000) || 'No narration captured',
          jobLocationZip: zip,
          materials: [],
          rentals: [],
          hourlyRate: Number(aiHourlyRate) || 65,
          estimatedHours: 0,
          markupPercent: Number(aiMarkupPct) || 20,
          rateType: 'hourly',
        })
        setResult(fallback)
        setUsedFallback(true)
        setError(`${errMsg} — showing a placeholder so you can edit and save.`)
      } catch {
        setError(errMsg)
      }
    } finally {
      timers.forEach(t => window.clearTimeout(t))
      setAnalyzing(false)
      setLoadingMessage('')
    }
  }

  const refineAndRegenerate = () => {
    if (!refinement.trim()) {
      runAnalysis()
      return
    }
    const combined = [transcript.trim(), `ADDITIONAL DETAILS:\n${refinement.trim()}`].filter(Boolean).join('\n\n')
    setTranscript(combined)
    setRefinement('')
    runAnalysis(combined)
  }

  const sendEmail = async () => {
    if (!result || !customerEmail) return
    setEmailSending(true)
    setEmailError('')
    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      // Strip markup from the customer-facing view — markup is baked into prices,
      // no separate "markup" line is shown to the customer.
      const customerQuote = toCustomerView(result)
      await sendEmailCallable({
        clerkToken,
        input: {
          to: customerEmail,
          estimate: {
            customerName,
            jobTypeName: 'Scan Room (AI)',
            jobLocationZip: zip,
            total: customerQuote.final_customer_quote,
            aiQuote: customerQuote,
          },
        },
      })
      setEmailSent(true)
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Email failed — please try again.')
    } finally {
      setEmailSending(false)
    }
  }

  const saveAsEstimate = async () => {
    if (!result) return
    try {
      const docRef = await addDoc(collection(db, 'estimates'), {
        customerName,
        jobTypeId: 'scan-room',
        jobTypeName: 'Scan Room (AI)',
        description: transcript.slice(0, 500),
        rateType: 'hourly',
        hourlyRate: result.labor.hourly_rate,
        estimatedHours: result.labor.estimated_hours,
        laborTotal: result.labor.labor_total,
        materials: [],
        materialsTotal: result.price_breakdown.materials_subtotal,
        rentals: [],
        rentalsTotal: result.price_breakdown.rentals_subtotal,
        jobLocationZip: zip,
        jobLocationRegion: region,
        regionMultiplier: multiplier,
        total: result.final_customer_quote,
        scopeOfWork: `SCOPE OF WORK\n\nCLIENT: ${customerName}\n\nSUMMARY:\n${result.customer_summary}\n\n${result.work_scope}`,
        aiQuote: result,
        status: 'pending',
        createdAt: new Date().toISOString(),
        createdBy: user?.id,
      })
      setSavedId(docRef.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '24px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '16px' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)' }}>
      <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>Scan the Room</h2>
      <p style={{ color: '#64748b', marginBottom: '24px' }}>Snap photos, narrate the scope out loud, and let Claude generate a full estimate.</p>

      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
          <div>
            <label style={label}>Customer *</label>
            {customers.length > 0 ? (
              <select
                value={customerId || '__new__'}
                onChange={e => {
                  if (e.target.value === '__new__') {
                    setCustomerId('')
                    setCustomerName('')
                    setCustomerEmail('')
                  } else {
                    const c = customers.find(x => x.id === e.target.value)
                    setCustomerId(e.target.value)
                    setCustomerName(c?.name || '')
                    setCustomerEmail(c?.email || '')
                  }
                }}
                style={input}
              >
                <option value="__new__">+ New customer (type below)</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : null}
            {!customerId && (
              <input
                value={customerName}
                onChange={e => setCustomerName(e.target.value)}
                style={{ ...input, marginTop: customers.length > 0 ? '6px' : '0' }}
                placeholder="e.g. Jane Smith"
              />
            )}
          </div>
          <div>
            <label style={label}>Job Location ZIP</label>
            <input value={zip} onChange={e => setZip(e.target.value)} maxLength={5} placeholder="e.g. 90210" style={input} />
            {validZip && <p style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px' }}>AI will price for {region}</p>}
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
          <h3 style={{ margin: 0 }}>📸 Photos &amp; Video ({images.length}/8)</h3>
          {images.length > 0 && !videoRecording && !videoProcessing && (
            <button onClick={() => setImages([])} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}>Clear all</button>
          )}
        </div>

        {/* Capture buttons — hidden while video is recording */}
        {!videoRecording && !videoProcessing && (
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <button onClick={() => cameraInputRef.current?.click()} disabled={images.length >= 8} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: images.length >= 8 ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: images.length >= 8 ? 0.5 : 1 }}>
              📷 Take Photo
            </button>
            <button onClick={() => fileInputRef.current?.click()} disabled={images.length >= 8} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 16px', borderRadius: '6px', cursor: images.length >= 8 ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: images.length >= 8 ? 0.5 : 1 }}>
              Upload Photos
            </button>
            <button
              onClick={startVideoRecording}
              disabled={images.length >= 8}
              title={images.length >= 8 ? 'Remove some photos first (max 8 total)' : 'Record a 25-second video walkthrough — a photo is captured every 3 seconds automatically'}
              style={{ background: '#dc2626', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: images.length >= 8 ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: images.length >= 8 ? 0.5 : 1 }}
            >
              🎬 Record Video Walkthrough
            </button>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
          </div>
        )}

        {/* Live video preview while recording */}
        {videoRecording && (
          <div style={{ marginBottom: '12px' }}>
            <video
              ref={videoPreviewRef}
              muted
              playsInline
              style={{ width: '100%', maxHeight: '240px', objectFit: 'cover', borderRadius: '8px', background: '#000', display: 'block' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px', flexWrap: 'wrap', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: '#fef2f2', color: '#dc2626', padding: '8px 12px', borderRadius: '6px', fontWeight: 700, fontSize: '14px' }}>
                  <span style={{ display: 'inline-block', width: '10px', height: '10px', background: '#dc2626', borderRadius: '50%', animation: 'pulse 1s ease-in-out infinite' }} />
                  REC 0:{String(videoElapsed).padStart(2, '0')} / 0:25
                </span>
                <span style={{ fontSize: '12px', color: '#64748b' }}>📸 {images.length} frame{images.length !== 1 ? 's' : ''} captured (every 3s, max 8)</span>
              </div>
              <button onClick={stopVideoRecording} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
                ■ Stop Recording
              </button>
            </div>
          </div>
        )}

        {/* Transcribing audio from video */}
        {videoProcessing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#7c3aed', fontSize: '14px', fontWeight: 600, marginBottom: '12px', padding: '12px', background: '#faf5ff', borderRadius: '8px' }}>
            <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #c4b5fd', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
            Transcribing your narration from the video…
          </div>
        )}

        {/* Captured frames grid */}
        {images.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '8px' }}>
            {images.map((img, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={img.preview} alt={`scan ${i}`} style={{ width: '100%', height: '100px', objectFit: 'cover', borderRadius: '6px' }} />
                <button onClick={() => removeImage(i)} style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(220,38,38,0.9)', color: 'white', border: 'none', borderRadius: '50%', width: '24px', height: '24px', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        )}
        {!videoRecording && images.length === 0 && (
          <p style={{ fontSize: '13px', color: '#94a3b8', textAlign: 'center', padding: '16px 0' }}>No images yet — take a photo or record a video walkthrough above.</p>
        )}
      </div>

      <div style={card}>
        <h3 style={{ marginBottom: '4px' }}>🎤 Voice Narration</h3>
        <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>Press record, talk through the job, then press stop. Audio is transcribed by Google Speech-to-Text after you stop — no echoes, no duplicates.</p>
        {!audioSupported && <p style={{ fontSize: '13px', color: '#dc2626', marginBottom: '8px' }}>⚠ Audio recording not supported in this browser. Type narration in the box below.</p>}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
          {!recording ? (
            <button onClick={startRecording} disabled={!audioSupported || transcribing} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: (!audioSupported || transcribing) ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: transcribing ? 0.6 : 1 }}>
              ● {transcript ? 'Record more' : 'Start Recording'}
            </button>
          ) : (
            <button onClick={stopRecording} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              ■ Stop <span style={{ color: '#ef4444', animation: 'pulse 1s ease-in-out infinite' }}>● REC</span>
            </button>
          )}
          {transcript && !recording && !transcribing && (
            <button onClick={() => setTranscript('')} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer' }}>Clear</button>
          )}
        </div>
        {transcribing && (
          <p style={{ fontSize: '13px', color: '#7c3aed', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid #c4b5fd', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            Transcribing…
          </p>
        )}
        <textarea
          value={transcript}
          onChange={e => setTranscript(e.target.value)}
          rows={5}
          placeholder="Press record above to speak, or type what work needs to be done. E.g. 'The bathroom needs a full gut — remove the old tile, replace the vanity, install new toilet, tile the floor and walls in subway tile...'"
          style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }}
        />
      </div>

      <div style={card}>
        <h3 style={{ marginBottom: '12px' }}>💵 AI Pricing Settings</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div>
            <label style={label}>Hourly Rate ($/hr)</label>
            <input type="number" value={aiHourlyRate} onChange={e => setAiHourlyRate(e.target.value)} style={input} placeholder="65" />
            <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>NC fair-market: $55–$75 solo, $85+ skilled w/ helper</p>
          </div>
          <div>
            <label style={label}>Markup %</label>
            <input type="number" value={aiMarkupPct} onChange={e => setAiMarkupPct(e.target.value)} style={input} placeholder="20" />
            <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>Small: 15–20% · Medium: 20–25% · Specialty: 25–35%</p>
          </div>
        </div>
        <div>
          <label style={label}>Apply Markup To</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setMarkupBasis('entire_job')}
              style={{
                flex: 1, padding: '10px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px',
                border: markupBasis === 'entire_job' ? '2px solid #f97316' : '1px solid #e2e8f0',
                background: markupBasis === 'entire_job' ? '#fff7ed' : 'white',
                color: markupBasis === 'entire_job' ? '#ea580c' : '#475569',
              }}
            >
              Entire Job
              <div style={{ fontSize: '11px', fontWeight: 400, color: '#94a3b8', marginTop: '2px' }}>markup on labor + materials</div>
            </button>
            <button
              onClick={() => setMarkupBasis('materials_only')}
              style={{
                flex: 1, padding: '10px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px',
                border: markupBasis === 'materials_only' ? '2px solid #f97316' : '1px solid #e2e8f0',
                background: markupBasis === 'materials_only' ? '#fff7ed' : 'white',
                color: markupBasis === 'materials_only' ? '#ea580c' : '#475569',
              }}
            >
              Materials Only
              <div style={{ fontSize: '11px', fontWeight: 400, color: '#94a3b8', marginTop: '2px' }}>labor billed at cost</div>
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => runAnalysis()} disabled={analyzing} style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: analyzing ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
          {analyzing ? '🤖 Analyzing scan…' : '🤖 Generate AI Estimate'}
        </button>
      </div>

      {analyzing && loadingMessage && (
        <div style={{ ...card, background: '#faf5ff', color: '#6d28d9', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #c4b5fd', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          {loadingMessage}
        </div>
      )}
      {usedFallback && !analyzing && (
        <div style={{ ...card, background: '#fef3c7', color: '#92400e' }}>
          ⚠ <strong>AI was unavailable — showing a placeholder estimate.</strong> Edit the values below before saving. Click "Generate AI Estimate" again to retry the AI.
        </div>
      )}
      {error && !usedFallback && <div style={{ ...card, background: '#fef2f2', color: '#dc2626' }}>⚠ {error}</div>}

      {result && !analyzing && (
        <div style={{ ...card, background: showRefine ? '#faf5ff' : '#f8fafc', border: showRefine ? '2px solid #7c3aed' : '1px solid #e2e8f0' }}>
          {!showRefine ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <p style={{ fontWeight: 600, margin: 0, fontSize: '14px' }}>Need a more accurate quote?</p>
                <p style={{ color: '#64748b', fontSize: '13px', margin: '2px 0 0' }}>Add more detail about the job — room size, specific materials, access constraints, anything the AI might have guessed.</p>
              </div>
              <button
                onClick={() => setShowRefine(true)}
                style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap' }}
              >
                ✏ Refine / Add Details
              </button>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#6d28d9' }}>✏ Refine This Estimate</h3>
                <button onClick={() => setShowRefine(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: '#94a3b8', lineHeight: 1 }}>×</button>
              </div>
              <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '10px' }}>
                Tell the AI what it missed or got wrong. Be specific — the more detail you add, the more accurate the re-generated quote will be.
              </p>
              <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '8px' }}>
                Examples: "bathroom is 8×10 ft with a 5 ft tub alcove" · "use 12×24 porcelain, not ceramic" · "second floor, no elevator, tight hallway" · "existing shutoffs are corroded and need replacing" · "customer wants to keep the vanity, only replace the top"
              </p>
              <textarea
                value={refinement}
                onChange={e => setRefinement(e.target.value)}
                rows={5}
                placeholder="Add missing details, correct anything the AI guessed wrong, or specify materials and constraints you didn't mention in the original narration…"
                style={{ ...input, fontFamily: 'inherit', resize: 'vertical', marginBottom: '12px' }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  onClick={refineAndRegenerate}
                  style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px' }}
                >
                  🤖 Re-generate with These Details
                </button>
                <button
                  onClick={() => { setShowRefine(false); setRefinement('') }}
                  style={{ background: 'white', border: '1px solid #e2e8f0', padding: '10px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', color: '#64748b' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <div style={{ ...card, border: '2px dashed #7c3aed' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '16px' }}>
            <div>
              <h3>🎯 AI Estimate</h3>
              <p style={{ color: '#64748b', fontSize: '13px' }}>Based on {images.length} photo(s) and {transcript.trim().split(/\s+/).filter(Boolean).length} words of narration</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
              {savedId ? (
                <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '8px 16px', borderRadius: '6px', fontWeight: 600 }}>✓ Saved as Estimate</span>
              ) : (
                <button onClick={saveAsEstimate} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                  💾 Save as Estimate
                </button>
              )}
              {savedId && (
                emailSent ? (
                  <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '6px 12px', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>✓ Email sent</span>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
                    <input
                      type="email"
                      value={customerEmail}
                      onChange={e => setCustomerEmail(e.target.value)}
                      placeholder="customer@email.com"
                      style={{ padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '13px', width: '200px', boxSizing: 'border-box' }}
                    />
                    <button
                      onClick={sendEmail}
                      disabled={emailSending || !customerEmail}
                      style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: (emailSending || !customerEmail) ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '13px', opacity: !customerEmail ? 0.6 : 1 }}
                    >
                      {emailSending ? 'Sending…' : '✉ Email to Customer'}
                    </button>
                    {emailError && <p style={{ color: '#dc2626', fontSize: '12px', margin: 0 }}>{emailError}</p>}
                  </div>
                )
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gap: '14px' }}>
            <div>
              <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Customer Summary</h4>
              <p style={{ fontSize: '14px', lineHeight: 1.5 }}>{result.customer_summary}</p>
            </div>
            <div>
              <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Work Scope</h4>
              <pre style={{ fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#f8fafc', padding: '12px', borderRadius: '6px', margin: 0 }}>{result.work_scope}</pre>
            </div>
            {result.material_list.length > 0 && (
              <div>
                <h4 style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Materials</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginTop: '6px' }}>
                  <thead><tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left' }}>
                    <th style={{ padding: '6px' }}>Item</th>
                    <th style={{ padding: '6px', textAlign: 'right' }}>Qty (+ waste)</th>
                    <th style={{ padding: '6px', textAlign: 'right' }}>Unit $</th>
                    <th style={{ padding: '6px', textAlign: 'right' }}>Total</th>
                  </tr></thead>
                  <tbody>
                    {result.material_list.map((m, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px', fontWeight: 600 }}>{m.name}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>{m.quantity_with_waste} {m.unit}</td>
                        <td style={{ padding: '6px', textAlign: 'right' }}>${m.unit_price.toFixed(2)}</td>
                        <td style={{ padding: '6px', textAlign: 'right', fontWeight: 600 }}>${m.line_total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ background: '#1a1f2e', color: 'white', padding: '20px', borderRadius: '8px' }}>
              <h4 style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '12px' }}>Quote Breakdown</h4>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: '15px' }}>
                <span style={{ color: '#cbd5e1' }}>Materials</span>
                <span style={{ fontWeight: 600 }}>${result.price_breakdown.materials_subtotal.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: '15px' }}>
                <span style={{ color: '#cbd5e1' }}>Labor ({result.labor.estimated_hours}h × ${result.labor.hourly_rate}/hr)</span>
                <span style={{ fontWeight: 600 }}>${result.price_breakdown.labor_subtotal.toFixed(2)}</span>
              </div>
              {result.price_breakdown.rentals_subtotal > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: '15px' }}>
                  <span style={{ color: '#cbd5e1' }}>Rentals</span>
                  <span style={{ fontWeight: 600 }}>${result.price_breakdown.rentals_subtotal.toFixed(2)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: '14px', color: '#94a3b8', borderTop: '1px solid #334155', marginTop: '4px' }}>
                <span>Subtotal (raw cost)</span>
                <span>${result.price_breakdown.raw_cost.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: '15px' }}>
                <span style={{ color: '#cbd5e1' }}>Markup ({result.profit_markup.markup_percent}%)</span>
                <span style={{ fontWeight: 600 }}>+ ${result.profit_markup.markup_dollars.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', marginTop: '8px', borderTop: '2px solid #f97316' }}>
                <span style={{ color: '#fb923c', fontSize: '15px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Grand Total</span>
                <span style={{ color: '#f97316', fontSize: '32px', fontWeight: 700 }}>${result.final_customer_quote.toFixed(2)}</span>
              </div>
            </div>
            <details>
              <summary style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#64748b' }}>🔒 Contractor Notes (internal)</summary>
              <pre style={{ fontSize: '13px', whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: '#fef3c7', padding: '12px', borderRadius: '6px', marginTop: '8px' }}>{result.contractor_notes}</pre>
            </details>
          </div>
        </div>
      )}
    </div>
  )
}
