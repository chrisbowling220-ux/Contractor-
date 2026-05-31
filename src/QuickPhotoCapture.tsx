import { useEffect, useRef, useState } from 'react'
import { useUser } from '@clerk/clerk-react'
import { collection, addDoc, getDocs, query, where } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase'
import type { Project, ProjectPhoto } from './data/types'
import { PROJECT_STATUS_LABEL } from './data/types'

const ORANGE = '#f97316'

// Quick job-photo capture from the dashboard. Flow: snap/upload photos first,
// then pick which active project they belong to, then they save into that
// project's photo log (projectPhotos) — the SAME photos that flow through the
// job and into the thank-you letter picker. Nothing is a separate bucket.
export default function QuickPhotoCapture({ onClose }: { onClose: () => void }) {
  const { user } = useUser()
  const [pics, setPics] = useState<{ preview: string; file: File }[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedCount, setSavedCount] = useState(0)
  const [error, setError] = useState('')
  const cameraRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  // Load active (non-archived, non-declined) projects to assign photos to.
  useEffect(() => {
    if (!user?.id) return
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'projects'), where('createdBy', '==', user.id)))
        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() } as Project))
          .filter(p => !p.archived && !p.declined)
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        setProjects(list)
        if (list.length === 1) setSelectedProjectId(list[0].id)
      } catch (err) {
        console.error('Load projects for photo capture failed:', err)
      }
    })()
  }, [user?.id])

  const addFiles = (files: FileList | null) => {
    if (!files) return
    const next = Array.from(files).map(f => ({ preview: URL.createObjectURL(f), file: f }))
    setPics(prev => [...prev, ...next])
  }
  const removePic = (i: number) => setPics(prev => {
    const target = prev[i]
    if (target) URL.revokeObjectURL(target.preview)  // free the blob URL
    return prev.filter((_, idx) => idx !== i)
  })
  // Revoke all preview URLs when the modal unmounts to avoid leaking blobs.
  useEffect(() => () => { pics.forEach(p => URL.revokeObjectURL(p.preview)) }, [pics])

  const save = async () => {
    if (!user?.id) { setError('Not signed in.'); return }
    if (pics.length === 0) { setError('Take or upload at least one photo first.'); return }
    if (!selectedProjectId) { setError('Pick which job these photos belong to.'); return }
    const project = projects.find(p => p.id === selectedProjectId)
    if (!project) { setError('That project could not be found.'); return }
    setSaving(true)
    setError('')
    try {
      let n = 0
      for (const pic of pics) {
        const ts = Date.now() + n
        const safeName = pic.file.name.replace(/[^A-Za-z0-9._-]/g, '_') || `photo-${ts}.jpg`
        const path = `projectPhotos/${user.id}/${project.id}/${ts}-${safeName}`
        const sRef = storageRef(storage, path)
        await uploadBytes(sRef, pic.file, { contentType: pic.file.type || 'image/jpeg' })
        const photoUrl = await getDownloadURL(sRef)
        const docData: Omit<ProjectPhoto, 'id'> = {
          projectId: project.id,
          customerName: project.customerName,
          caption: '',
          photoUrl,
          storagePath: path,
          createdAt: new Date(ts).toISOString(),
          createdBy: user.id,
        }
        await addDoc(collection(db, 'projectPhotos'), docData)
        n++
        setSavedCount(n)
      }
      // Done — show a brief success then close.
      setTimeout(onClose, 900)
    } catch (err) {
      setError('Upload failed: ' + (err instanceof Error ? err.message : String(err)))
      setSaving(false)
    }
  }

  const btn: React.CSSProperties = { padding: '12px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 700, fontSize: '14px', border: 'none' }
  const input: React.CSSProperties = { width: '100%', padding: '12px', border: '1px solid #cbd5e1', borderRadius: '8px', fontSize: '15px', boxSizing: 'border-box' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 300, padding: '16px', overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ maxWidth: '560px', margin: '24px auto', background: '#f8fafc', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ background: '#1a1f2e', color: 'white', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
          <button onClick={onClose} style={{ ...btn, background: ORANGE, color: 'white', padding: '10px 16px', marginBottom: '10px', fontSize: '13px' }}>← Back</button>
          <h2 style={{ margin: 0, color: ORANGE, fontSize: '18px' }}>📸 Job Photos</h2>
          <p style={{ margin: '2px 0 0', color: '#94a3b8', fontSize: '12px' }}>Snap or upload, then pick the job. Photos save to that project and flow to the thank-you letter.</p>
        </div>

        <div style={{ padding: '16px' }}>
          {/* Capture buttons */}
          <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
            <button onClick={() => cameraRef.current?.click()} style={{ ...btn, background: '#0ea5e9', color: 'white', flex: '1 1 auto' }}>📷 Take Photo</button>
            <button onClick={() => uploadRef.current?.click()} style={{ ...btn, background: 'white', color: '#1a1f2e', border: '1px solid #cbd5e1', flex: '1 1 auto' }}>⬆️ Upload</button>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
            <input ref={uploadRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
          </div>

          {/* Thumbnails */}
          {pics.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: '8px', marginBottom: '16px' }}>
              {pics.map((p, i) => (
                <div key={i} style={{ position: 'relative', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
                  <img src={p.preview} alt="" style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' }} />
                  <button onClick={() => removePic(i)} style={{ position: 'absolute', top: '2px', right: '2px', background: 'rgba(220,38,38,0.9)', color: 'white', border: 'none', borderRadius: '50%', width: '22px', height: '22px', cursor: 'pointer', fontWeight: 700, fontSize: '12px', lineHeight: 1 }}>×</button>
                </div>
              ))}
            </div>
          )}

          {/* Project picker */}
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>Which job?</label>
          {projects.length === 0 ? (
            <p style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 16px' }}>No active jobs yet. Start one in Quick Quote first, then photos can attach to it.</p>
          ) : (
            <select value={selectedProjectId} onChange={e => setSelectedProjectId(e.target.value)} style={{ ...input, marginBottom: '16px' }}>
              <option value="">— Select a job —</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.customerName} · {p.jobTypeName} ({PROJECT_STATUS_LABEL[p.status]})</option>
              ))}
            </select>
          )}

          {error && <p style={{ color: '#dc2626', fontSize: '14px', margin: '0 0 12px' }}>⚠ {error}</p>}

          <button onClick={save} disabled={saving || projects.length === 0} style={{ ...btn, width: '100%', background: saving || projects.length === 0 ? '#cbd5e1' : '#16a34a', color: 'white', padding: '14px', fontSize: '15px' }}>
            {saving ? `Saving ${savedCount}/${pics.length}…` : `Save ${pics.length || ''} Photo${pics.length === 1 ? '' : 's'} to Job`}
          </button>
        </div>
      </div>
    </div>
  )
}
