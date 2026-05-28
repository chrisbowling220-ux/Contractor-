import { useState, useRef, useEffect } from 'react'
import { httpsCallable } from 'firebase/functions'
import { collection, addDoc, getDocs, query, where, doc, updateDoc } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { useAuth, useUser } from '@clerk/clerk-react'
import { db, functions, storage } from './firebase'
import { regionFromZip, DEFAULT_ZIP } from './data/materials'
import { buildFallbackQuote } from './lib/fallbackQuote'
import EstimatePreview from './EstimatePreview'
import ManualEstimateBuilder from './ManualEstimateBuilder'
import { openEstimatePrintWindow } from './lib/printEstimate'
import { fetchBusinessProfile } from './Settings'
import type { BusinessProfile } from './Settings'
import type { AIQuote, Estimate } from './data/types'

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

// Best video MIME for MediaRecorder. iOS Safari needs mp4/h264; everything else
// is happiest with webm/vp9 or webm/vp8.
function pickVideoMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ]
  if (typeof MediaRecorder === 'undefined') return ''
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

const VIDEO_MAX_SECONDS = 25
const KEYFRAME_COUNT = 8

// MediaRecorder output (especially WebM on Chrome) often reports
// duration = Infinity until the player seeks past the end. This forces
// the duration to be calculated. Reliable on Chrome + Safari + Firefox.
function forceDuration(video: HTMLVideoElement, knownDurationHint: number): Promise<number> {
  return new Promise(resolve => {
    if (isFinite(video.duration) && video.duration > 0) {
      resolve(video.duration)
      return
    }
    let resolved = false
    const finish = (d: number) => {
      if (resolved) return
      resolved = true
      try { video.currentTime = 0 } catch {}
      resolve(d > 0 && isFinite(d) ? d : knownDurationHint)
    }
    const onDurChange = () => {
      if (isFinite(video.duration) && video.duration > 0 && video.duration < 1e9) {
        video.removeEventListener('durationchange', onDurChange)
        finish(video.duration)
      }
    }
    video.addEventListener('durationchange', onDurChange)
    // Trick: seek to a huge value, which forces the browser to read the
    // end of the file and compute duration.
    try { video.currentTime = 1e9 } catch {}
    // Fallback hard timeout — use the hint we were given by the recorder.
    setTimeout(() => finish(knownDurationHint), 3000)
  })
}

function seekToTime(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    const onSeeked = () => finish()
    video.addEventListener('seeked', onSeeked)
    try { video.currentTime = t } catch { finish() }
    // Safety timeout — some mobile browsers don't fire `seeked` reliably.
    setTimeout(finish, 2500)
  })
}

// Extracts N evenly-spaced keyframes from a recorded video blob.
// `knownDurationMs` is the duration we observed during recording (used as a
// fallback if the browser can't compute duration from the blob).
async function extractKeyframes(videoBlob: Blob, count: number, knownDurationMs: number): Promise<string[]> {
  const url = URL.createObjectURL(videoBlob)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  ;(video as unknown as { autoplay: boolean }).autoplay = false
  video.crossOrigin = 'anonymous'

  try {
    // Wait for metadata.
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onMeta = () => { if (settled) return; settled = true; resolve() }
      const onErr = () => { if (settled) return; settled = true; reject(new Error('Failed to load video')) }
      video.addEventListener('loadedmetadata', onMeta, { once: true })
      video.addEventListener('error', onErr, { once: true })
      // Safety timeout.
      setTimeout(() => { if (!settled) { settled = true; resolve() } }, 4000)
      try { video.load() } catch {}
    })

    const duration = await forceDuration(video, knownDurationMs / 1000)
    if (!isFinite(duration) || duration <= 0) {
      throw new Error('Video duration could not be determined.')
    }

    // Wait a beat after the duration seek-back-to-0.
    await new Promise(r => setTimeout(r, 250))

    const canvas = document.createElement('canvas')
    const maxEdge = 1280
    const vw = video.videoWidth || 640
    const vh = video.videoHeight || 480
    const ratio = Math.min(1, maxEdge / Math.max(vw, vh))
    canvas.width = Math.max(1, Math.round(vw * ratio))
    canvas.height = Math.max(1, Math.round(vh * ratio))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D not available')

    const frames: string[] = []
    for (let i = 0; i < count; i++) {
      const t = (duration * (i + 0.5)) / count
      const target = Math.max(0.05, Math.min(duration - 0.1, t))
      await seekToTime(video, target)
      // Give the renderer a tick to actually paint the frame.
      await new Promise(r => setTimeout(r, 80))
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.78)
        const base64 = dataUrl.split(',')[1] || ''
        if (base64.length > 100) frames.push(base64)
      } catch (err) {
        console.warn(`Frame ${i} draw failed:`, err)
      }
    }

    return frames
  } finally {
    URL.revokeObjectURL(url)
  }
}

export default function ScanRoom({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const { user } = useUser()
  const { getToken } = useAuth()

  const [customerName, setCustomerName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [zip, setZip] = useState(DEFAULT_ZIP)
  // Estimate that was just auto-saved — opens the editor modal so the user
  // can edit and send to the customer right away.
  const [savedEstimate, setSavedEstimate] = useState<Estimate | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [profile, setProfile] = useState<BusinessProfile>({ businessName: '', businessPhone: '', businessEmail: '', licenseNumber: '', logoUrl: '' })
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
  const [loadingMessage, setLoadingMessage] = useState('')
  const [usedFallback, setUsedFallback] = useState(false)
  const [videoRecording, setVideoRecording] = useState(false)
  const [videoElapsed, setVideoElapsed] = useState(0)
  const [extractingFrames, setExtractingFrames] = useState(false)
  const [lastVideoExtraction, setLastVideoExtraction] = useState<{ count: number; durationSec: number } | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioStreamRef = useRef<MediaStream | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const videoRecorderRef = useRef<MediaRecorder | null>(null)
  const videoChunksRef = useRef<Blob[]>([])
  const videoStreamRef = useRef<MediaStream | null>(null)
  const videoTimerRef = useRef<number | null>(null)
  const videoAutoStopRef = useRef<number | null>(null)
  const livePreviewRef = useRef<HTMLVideoElement | null>(null)

  const { region, multiplier } = regionFromZip(zip)
  const validZip = /^[0-9]{5}$/.test(zip)
  const audioSupported = typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  useEffect(() => () => {
    mediaRecorderRef.current?.stop()
    audioStreamRef.current?.getTracks().forEach(t => t.stop())
    videoRecorderRef.current?.stop()
    videoStreamRef.current?.getTracks().forEach(t => t.stop())
    if (videoTimerRef.current) clearInterval(videoTimerRef.current)
    if (videoAutoStopRef.current) clearTimeout(videoAutoStopRef.current)
  }, [])

  // Fetch the contractor's business profile for printed-estimate letterhead.
  useEffect(() => {
    if (!user?.id) return
    fetchBusinessProfile(user.id).then(setProfile).catch(() => { /* ignore */ })
  }, [user?.id])

  // Pull the user's customer list for the dropdown.
  useEffect(() => {
    if (!user?.id) return
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'customers'),
          where('createdBy', '==', user.id),
        ))
        const list = snap.docs
          .map(d => ({ id: d.id, name: (d.data().name as string) || '', createdAt: (d.data().createdAt as string) || '' }))
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
          .map(({ id, name }) => ({ id, name }))
        setCustomers(list)
      } catch (err) {
        console.error('Customers fetch failed:', err)
      }
    })()
  }, [user?.id])

  const startVideoRecording = async () => {
    setError('')
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Video recording not supported in this browser.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      })
      videoStreamRef.current = stream
      // Show live camera feed so the user can frame the shot.
      if (livePreviewRef.current) {
        livePreviewRef.current.srcObject = stream
        livePreviewRef.current.muted = true
        livePreviewRef.current.playsInline = true
        try { await livePreviewRef.current.play() } catch {}
      }
      const mimeType = pickVideoMimeType()
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      videoChunksRef.current = []
      const recordStartedAt = Date.now()
      rec.ondataavailable = e => {
        if (e.data && e.data.size > 0) videoChunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        const recordDurationMs = Date.now() - recordStartedAt
        stream.getTracks().forEach(t => t.stop())
        videoStreamRef.current = null
        if (livePreviewRef.current) {
          livePreviewRef.current.srcObject = null
        }
        if (videoTimerRef.current) { clearInterval(videoTimerRef.current); videoTimerRef.current = null }
        if (videoAutoStopRef.current) { clearTimeout(videoAutoStopRef.current); videoAutoStopRef.current = null }
        const blob = new Blob(videoChunksRef.current, { type: rec.mimeType || mimeType || 'video/webm' })
        if (blob.size === 0) {
          setError('No video captured — try again.')
          return
        }
        setExtractingFrames(true)
        setLastVideoExtraction(null)
        try {
          const frames = await extractKeyframes(blob, KEYFRAME_COUNT, recordDurationMs)
          if (frames.length === 0) {
            setError('Recorded the video but couldn\'t extract any keyframes from it. Try again, or use the photo buttons.')
            return
          }
          const newImages = frames.map(data => ({
            preview: `data:image/jpeg;base64,${data}`,
            data,
          }))
          // Replace the photo list with the extracted keyframes. The user
          // sees them in the grid below, can remove any they don't want,
          // then taps "Generate Instant Estimate" when ready.
          setImages(newImages)
          setLastVideoExtraction({ count: frames.length, durationSec: Math.round(recordDurationMs / 1000) })
        } catch (err) {
          setError('Could not extract frames from the video: ' + (err instanceof Error ? err.message : String(err)))
        } finally {
          setExtractingFrames(false)
        }
      }
      rec.onerror = () => setError('Video recording error — please try again.')
      videoRecorderRef.current = rec
      setVideoElapsed(0)
      // Request a data chunk every 500ms so even a sub-second tap-stop has
      // some bytes in the blob (without this, MediaRecorder may flush
      // nothing until stop on some browsers).
      rec.start(500)
      setVideoRecording(true)

      // Tick the elapsed counter for the UI.
      videoTimerRef.current = window.setInterval(() => {
        setVideoElapsed(prev => prev + 1)
      }, 1000)
      // Hard-cap at VIDEO_MAX_SECONDS.
      videoAutoStopRef.current = window.setTimeout(() => {
        if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
          videoRecorderRef.current.stop()
          setVideoRecording(false)
        }
      }, VIDEO_MAX_SECONDS * 1000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Camera access denied'
      setError(`Couldn't start video: ${msg}. Make sure camera and microphone permissions are granted.`)
    }
  }

  const stopVideoRecording = () => {
    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.stop()
    }
    setVideoRecording(false)
  }

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

  const runAnalysisWithImages = async (imgs: { preview: string; data: string }[]) => {
    if (!customerName) {
      setError('Customer name required — fill it in and click Generate Instant Estimate.')
      return
    }
    if (imgs.length === 0 && !transcript.trim()) { setError('Add at least one photo or some narration'); return }
    setAnalyzing(true); setError(''); setResult(null); setSavedId(null); setUsedFallback(false)
    setLoadingMessage('Generating your estimate…')
    const timers: number[] = []
    timers.push(window.setTimeout(() => setLoadingMessage('Still working — Claude is analyzing your photos and narration…'), 10000))
    timers.push(window.setTimeout(() => setLoadingMessage('Anthropic seems busy. Retrying behind the scenes…'), 20000))
    timers.push(window.setTimeout(() => setLoadingMessage('One more try — this can take up to 45s for image analysis…'), 30000))

    try {
      const clerkToken = await getToken()
      if (!clerkToken) throw new Error('Not signed in')
      const res = await callable({
        clerkToken,
        input: {
          customerName,
          jobLocationZip: zip,
          jobLocationRegion: region,
          regionMultiplier: multiplier,
          transcript: transcript.trim(),
          images: imgs.map(i => i.data),
          hourlyRateOverride: Number(aiHourlyRate) || undefined,
          markupPercentOverride: aiMarkupPct === '' ? undefined : Number(aiMarkupPct),
          debugForceFail: new URLSearchParams(window.location.search).get('debugForceFail') || undefined,
        },
      })
      setResult(res.data)
      // Auto-save the AI quote to Firestore and open the editor so the user
      // can review/edit and send to the customer right away.
      const saved = await saveAsEstimateAndReturn(res.data)
      if (saved) setSavedEstimate(saved)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // Fallback: build a minimal quote from the transcript + form inputs since
      // ScanRoom has no pre-form materials list. The contractor still gets a
      // structured shell they can edit.
      try {
        const fallback = buildFallbackQuote({
          customerName,
          jobTypeName: 'Quick Quote (offline)',
          description: transcript.trim().slice(0, 1000) || 'No narration captured',
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

  const runAnalysis = () => runAnalysisWithImages(images)

  // Saves an AI quote as an Estimate doc and returns the full Estimate object
  // (with id) so the caller can open the editor immediately.
  const saveAsEstimateAndReturn = async (ai: AIQuote): Promise<Estimate | null> => {
    if (!user?.id) { setError('Not signed in'); return null }
    const payload: Record<string, unknown> = {
      customerName,
      jobTypeId: 'quick-quote',
      jobTypeName: 'Quick Quote',
      description: transcript.slice(0, 500),
      rateType: 'hourly',
      hourlyRate: ai.labor.hourly_rate,
      estimatedHours: ai.labor.estimated_hours,
      laborTotal: ai.labor.labor_total,
      materials: [],
      materialsTotal: ai.price_breakdown.materials_subtotal,
      rentals: [],
      rentalsTotal: ai.price_breakdown.rentals_subtotal,
      jobLocationZip: zip,
      jobLocationRegion: region,
      regionMultiplier: multiplier,
      total: ai.final_customer_quote,
      scopeOfWork: `SCOPE OF WORK\n\nCLIENT: ${customerName}\n\nSUMMARY:\n${ai.customer_summary}\n\n${ai.work_scope}`,
      aiQuote: ai,
      status: 'pending',
      createdAt: new Date().toISOString(),
      createdBy: user.id,
    }
    if (customerId) payload.customerId = customerId
    try {
      const docRef = await addDoc(collection(db, 'estimates'), payload)
      setSavedId(docRef.id)
      // Create the project FIRST (so we have its id), then upload photos
      // directly into that project's album. Chained — not parallel — so the
      // photos always land in the right project (no race condition).
      ;(async () => {
        try {
          const projectId = await autoCreateProjectFromEstimate(docRef.id, payload)
          await uploadScanPhotosToProject(docRef.id, projectId)
        } catch (err) {
          console.warn('Post-save project/photo flow failed:', err)
        }
      })()
      return { id: docRef.id, ...payload } as Estimate
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
      return null
    }
  }

  // Creates a matching Project doc for a freshly-saved Quick Quote estimate.
  // Same logic the dashboard sweep would do — but inline so the project
  // exists the moment Quick Quote saves. Returns the new project's id.
  const autoCreateProjectFromEstimate = async (estimateId: string, est: Record<string, unknown>): Promise<string | null> => {
    if (!user?.id) return null
    const projectPayload: Record<string, unknown> = {
      customerName: est.customerName as string,
      jobTypeName: est.jobTypeName as string,
      jobLocationZip: (est.jobLocationZip as string) || '',
      description: (est.description as string) || '',
      status: 'lead',
      notes: `Auto-created from Quick Quote on ${new Date().toLocaleDateString()}.`,
      createdAt: new Date().toISOString(),
      createdBy: user.id,
      sourceEstimateId: estimateId,
      estimateTotal: (est.total as number) || 0,
    }
    if (est.customerId) projectPayload.customerId = est.customerId
    try {
      const pRef = await addDoc(collection(db, 'projects'), projectPayload)
      await updateDoc(doc(db, 'estimates', estimateId), {
        projectAutoCreated: true,
        projectId: pRef.id,
      })
      return pRef.id
    } catch (err) {
      console.warn('Could not auto-create project for estimate', estimateId, err)
      return null
    }
  }

  // Uploads each Quick Quote photo into the project's album (tagged with
  // both projectId AND estimateId). If projectId is null (project creation
  // failed), still tag with estimateId so the dashboard sweep can migrate later.
  const uploadScanPhotosToProject = async (estimateId: string, projectId: string | null) => {
    if (!user?.id || images.length === 0) return
    for (let i = 0; i < images.length; i++) {
      const img = images[i]
      try {
        const ts = Date.now() + i
        const blob = await (await fetch(`data:image/jpeg;base64,${img.data}`)).blob()
        const folder = projectId || '_pending'
        const path = `projectPhotos/${user.id}/${folder}/${estimateId}/${ts}.jpg`
        const sRef = storageRef(storage, path)
        await uploadBytes(sRef, blob, { contentType: 'image/jpeg' })
        const photoUrl = await getDownloadURL(sRef)
        await addDoc(collection(db, 'projectPhotos'), {
          projectId: projectId || '',
          estimateId,
          customerName,
          caption: '',
          photoUrl,
          storagePath: path,
          createdAt: new Date(ts).toISOString(),
          createdBy: user.id,
        })
      } catch (err) {
        console.warn(`Failed to upload scan photo ${i}:`, err)
      }
    }
  }

  // Manual save button still works — wraps the new helper.
  const saveAsEstimate = async () => {
    if (!result) return
    const saved = await saveAsEstimateAndReturn(result)
    if (saved) setSavedEstimate(saved)
  }

  const input: React.CSSProperties = { padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }
  const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }
  const card: React.CSSProperties = { background: 'white', padding: '24px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '16px' }

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: '1100px', margin: '0 auto' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '26px', fontWeight: 800, margin: 0, color: '#1a1f2e', letterSpacing: '-0.5px' }}>⚡ Quick Quote</h2>
        <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '14px' }}>Walk the job, snap photos or record video, narrate the scope — Claude turns it into a fair-market estimate in seconds.</p>
      </div>

      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
          <div>
            <label style={label}>Customer *</label>
            {customers.length > 0 ? (
              <select
                value={customerId || '__new__'}
                onChange={e => {
                  if (e.target.value === '__new__') { setCustomerId(''); setCustomerName('') }
                  else {
                    const c = customers.find(x => x.id === e.target.value)
                    setCustomerId(e.target.value); setCustomerName(c?.name || '')
                  }
                }}
                style={input}
              >
                <option value="__new__">+ New customer (type below)</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0' }}>No saved customers — type a name below.</p>
            )}
            {!customerId && (
              <input value={customerName} onChange={e => setCustomerName(e.target.value)} style={{ ...input, marginTop: '6px' }} placeholder="e.g. Jane Smith" />
            )}
          </div>
          <div>
            <label style={label}>Job Location ZIP</label>
            <input value={zip} onChange={e => setZip(e.target.value)} maxLength={5} placeholder="e.g. 90210" style={input} />
            {validZip && <p style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px' }}>Pricing set for {region}</p>}
          </div>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ marginBottom: '4px' }}>📸 Photos ({images.length}/8)</h3>
        <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>Snap individual photos, upload existing ones, OR record a 25-second walkthrough video and we'll pick {KEYFRAME_COUNT} keyframes automatically.</p>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <button onClick={() => cameraInputRef.current?.click()} disabled={images.length >= 8 || videoRecording || extractingFrames} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
            📷 Take Photo
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={images.length >= 8 || videoRecording || extractingFrames} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}>
            Upload Photos
          </button>
          {!videoRecording ? (
            <button onClick={startVideoRecording} disabled={extractingFrames} style={{ background: '#dc2626', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: extractingFrames ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              🎥 Record Video (25s)
            </button>
          ) : (
            <button onClick={stopVideoRecording} style={{ background: '#1a1f2e', color: 'white', border: 'none', padding: '10px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              ■ Stop ({VIDEO_MAX_SECONDS - videoElapsed}s left) <span style={{ color: '#ef4444', animation: 'pulse 1s ease-in-out infinite' }}>● REC</span>
            </button>
          )}
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
        </div>
        {extractingFrames && (
          <p style={{ fontSize: '13px', color: '#7c3aed', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid #c4b5fd', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            Pulling {KEYFRAME_COUNT} keyframes from your video…
          </p>
        )}
        <div style={{ position: 'relative', width: '100%', maxWidth: '480px', marginBottom: '12px', display: videoRecording ? 'block' : 'none' }}>
          <video
            ref={livePreviewRef}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', borderRadius: '8px', background: '#000', aspectRatio: '16/9', objectFit: 'cover' }}
          />
          <div style={{ position: 'absolute', top: '8px', left: '8px', background: 'rgba(220,38,38,0.95)', color: 'white', padding: '4px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', width: '8px', height: '8px', background: 'white', borderRadius: '50%', animation: 'pulse 1s ease-in-out infinite' }} />
            REC · {videoElapsed}s / {VIDEO_MAX_SECONDS}s
          </div>
        </div>
        {lastVideoExtraction && !extractingFrames && (
          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a', padding: '10px 12px', borderRadius: '6px', marginBottom: '10px', fontSize: '13px' }}>
            ✓ Pulled <strong>{lastVideoExtraction.count} keyframe{lastVideoExtraction.count === 1 ? '' : 's'}</strong> from your {lastVideoExtraction.durationSec}-second video. Review below, remove any you don't want, then tap <strong>Generate Instant Estimate</strong>.
          </div>
        )}
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
        <h3 style={{ marginBottom: '12px' }}>💵 Smart Pricing Settings</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
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
      </div>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <button onClick={runAnalysis} disabled={analyzing} style={{ background: '#7c3aed', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: analyzing ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
          {analyzing ? '⚡ Building estimate…' : '⚡ Generate Instant Estimate'}
        </button>
        <button onClick={() => setManualOpen(true)} disabled={analyzing} style={{ background: 'white', color: '#1a1f2e', border: '2px solid #cbd5e1', padding: '12px 24px', borderRadius: '8px', cursor: analyzing ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
          ✍️ Build Manually
        </button>
      </div>
      <p style={{ fontSize: '12px', color: '#94a3b8', margin: '-8px 0 16px' }}>
        Out of free instant quotes, or prefer full control? <strong>Build Manually</strong> lets you make unlimited estimates by hand.
      </p>

      {analyzing && loadingMessage && (
        <div style={{ ...card, background: '#faf5ff', color: '#6d28d9', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #c4b5fd', borderTopColor: '#7c3aed', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          {loadingMessage}
        </div>
      )}
      {usedFallback && !analyzing && (
        <div style={{ ...card, background: '#fef3c7', color: '#92400e' }}>
          ⚠ <strong>Pricing service was unavailable — showing a placeholder estimate.</strong> Edit the values below before saving. Click "Generate Instant Estimate" again to retry.
        </div>
      )}
      {error && !usedFallback && <div style={{ ...card, background: '#fef2f2', color: '#dc2626' }}>⚠ {error}</div>}

      {result && (
        <div style={{ ...card, border: '2px dashed #7c3aed' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '16px' }}>
            <div>
              <h3>🎯 Instant Estimate</h3>
              <p style={{ color: '#64748b', fontSize: '13px' }}>Based on {images.length} photo(s) and {transcript.trim().split(/\s+/).filter(Boolean).length} words of narration</p>
            </div>
            {savedId ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
                <span style={{ background: '#f0fdf4', color: '#16a34a', padding: '6px 12px', borderRadius: '6px', fontWeight: 600, fontSize: '13px' }}>✓ Saved as Project</span>
                <p style={{ margin: 0, fontSize: '11px', color: '#64748b', textAlign: 'right' }}>
                  Find it in <strong>🗂️ Projects</strong> — edit, send, add change orders.
                </p>
                <button onClick={saveAsEstimate} style={{ background: '#f97316', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}>
                  ✏️ Reopen Editor
                </button>
              </div>
            ) : (
              <button onClick={saveAsEstimate} style={{ background: '#f97316', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                💾 Save as Estimate
              </button>
            )}
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

      {/* After AI generation, auto-open the editor so the user can edit + send.
          Closing it lands the user in Projects, where the new project is now
          waiting at "lead" for the customer's approve/decline. */}
      {savedEstimate && (
        <EstimatePreview
          estimate={savedEstimate}
          onClose={() => {
            setSavedEstimate(null)
            if (onNavigate) onNavigate('projects')
          }}
          onSaved={updated => setSavedEstimate(updated)}
          onPrint={(est) => openEstimatePrintWindow(est, profile)}
        />
      )}

      {manualOpen && (
        <ManualEstimateBuilder
          defaultCustomerName={customerName}
          defaultCustomerId={customerId || undefined}
          onClose={() => setManualOpen(false)}
          onSaved={(est) => {
            setManualOpen(false)
            setSavedEstimate(est)
          }}
        />
      )}
    </div>
  )
}
