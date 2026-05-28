import { useState, useEffect, useRef } from 'react'
import { db, storage } from './firebase'
import { collection, addDoc, getDocs, query, where, doc, deleteDoc, updateDoc } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { useUser } from '@clerk/clerk-react'
import type { ProjectPhoto, Project } from './data/types'

interface Props {
  project: Project
  // Optional callback so the parent can know how many photos exist (e.g. for
  // the "Generate Thank-You Package" button enabled-state).
  onCountChange?: (count: number) => void
}

// Per-project photo album. Photos live in their own Firestore collection
// (projectPhotos) and Storage path (projectPhotos/{userId}/{projectId}/...)
// so they're separate from customer-level photos on the Customers page.
export default function ProjectPhotos({ project, onCountChange }: Props) {
  const { user } = useUser()
  const [photos, setPhotos] = useState<ProjectPhoto[]>([])
  const [uploading, setUploading] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const fetchPhotos = async () => {
    if (!user?.id) return
    try {
      const snap = await getDocs(query(
        collection(db, 'projectPhotos'),
        where('projectId', '==', project.id),
        where('createdBy', '==', user.id),
      ))
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as ProjectPhoto))
      // Oldest first — the slideshow + photo log read chronologically.
      list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      setPhotos(list)
      onCountChange?.(list.length)
    } catch (err) {
      console.error('Project photos fetch failed:', err)
    }
  }
  useEffect(() => { fetchPhotos() }, [project.id, user?.id])

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user?.id) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const ts = Date.now()
        const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_')
        const path = `projectPhotos/${user.id}/${project.id}/${ts}-${safeName}`
        const sRef = storageRef(storage, path)
        await uploadBytes(sRef, file, { contentType: file.type })
        const photoUrl = await getDownloadURL(sRef)
        const docData: Omit<ProjectPhoto, 'id'> = {
          projectId: project.id,
          customerName: project.customerName,
          caption: '',
          photoUrl,
          storagePath: path,
          createdAt: new Date().toISOString(),
          createdBy: user.id,
        }
        await addDoc(collection(db, 'projectPhotos'), docData)
      }
      await fetchPhotos()
    } catch (err) {
      alert('Upload failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setUploading(false)
    }
  }

  const updateCaption = async (id: string, caption: string) => {
    setPhotos(prev => prev.map(p => p.id === id ? { ...p, caption } : p))
    try {
      await updateDoc(doc(db, 'projectPhotos', id), { caption })
    } catch (err) {
      console.error('Caption save failed:', err)
    }
  }

  const deletePhoto = async (p: ProjectPhoto) => {
    if (!confirm('Delete this photo? This cannot be undone.')) return
    try {
      try { await deleteObject(storageRef(storage, p.storagePath)) } catch {}
      await deleteDoc(doc(db, 'projectPhotos', p.id))
      setPhotos(prev => prev.filter(x => x.id !== p.id))
      onCountChange?.(photos.length - 1)
    } catch (err) {
      alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const input: React.CSSProperties = { padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box', width: '100%' }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>📸 Project Photo Album ({photos.length})</h3>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={() => cameraRef.current?.click()} disabled={uploading} style={{ background: '#0ea5e9', color: 'white', border: 'none', padding: '8px 14px', borderRadius: '6px', cursor: uploading ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '13px' }}>
            📷 Capture Photo
          </button>
          <button onClick={() => uploadRef.current?.click()} disabled={uploading} style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', padding: '8px 14px', borderRadius: '6px', cursor: uploading ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '13px' }}>
            Upload from Device
          </button>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={e => { uploadFiles(e.target.files); e.target.value = '' }} />
          <input ref={uploadRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { uploadFiles(e.target.files); e.target.value = '' }} />
        </div>
      </div>
      {uploading && <p style={{ fontSize: '13px', color: '#7c3aed', margin: '0 0 12px' }}>Uploading…</p>}
      <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px' }}>
        Photos build a chronological album of this project — oldest first. Auto-generated into a slideshow + thank-you letter when the project is marked Completed.
      </p>

      {photos.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', padding: '24px 0', fontSize: '14px' }}>No photos yet. Capture or upload your first one above.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
          {photos.map(p => (
            <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', background: '#fafafa' }}>
              <img src={p.photoUrl} alt={p.caption} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', display: 'block' }} />
              <div style={{ padding: '10px' }}>
                <p style={{ margin: '0 0 6px', fontSize: '11px', color: '#94a3b8' }}>{new Date(p.createdAt).toLocaleString()}</p>
                <input
                  placeholder="Add a caption…"
                  value={p.caption}
                  onChange={e => updateCaption(p.id, e.target.value)}
                  style={{ ...input, padding: '6px 8px', fontSize: '13px' }}
                />
                <button onClick={() => deletePhoto(p)} style={{ background: 'transparent', color: '#dc2626', border: 'none', cursor: 'pointer', padding: '6px 0 0', fontSize: '12px' }}>
                  🗑️ Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Exported so the parent can fetch photos when generating the slideshow PDF.
export async function fetchProjectPhotos(projectId: string, userId: string): Promise<ProjectPhoto[]> {
  try {
    const snap = await getDocs(query(
      collection(db, 'projectPhotos'),
      where('projectId', '==', projectId),
      where('createdBy', '==', userId),
    ))
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as ProjectPhoto))
    list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    return list
  } catch {
    return []
  }
}
