import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../firebase'
import type { ProjectPhoto } from '../data/types'

// A project's photos, oldest first. Returns [] on failure so callers that only
// want pictures for a slideshow don't have to handle an error.
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
