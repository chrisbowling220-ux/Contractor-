import { httpsCallable } from 'firebase/functions'
import { addDoc, collection } from 'firebase/firestore'
import { db, functions } from '../firebase'
import type { ProjectPhoto, Project, ThankYouPackage } from '../data/types'

interface ThankYouLetter {
  greeting: string
  opening: string
  body: string
  closing: string
}

const generateThankYouLetterCallable = httpsCallable<
  {
    clerkToken: string
    input: {
      customerName: string
      jobTypeName: string
      jobLocationZip?: string
      contractorName?: string
      contractorBusiness?: string
      highlights?: string
    }
  },
  ThankYouLetter
>(functions, 'generateThankYouLetter')

// Re-runs the letter generator for an EXISTING package (e.g. the user added
// instructions and hit "Regenerate"). Returns just the new letter; the caller
// persists it to the package doc.
export async function regenerateThankYouLetter(args: {
  clerkToken: string
  customerName: string
  jobTypeName: string
  jobLocationZip?: string
  contractorName?: string
  contractorBusiness?: string
  highlights?: string
}): Promise<ThankYouLetter> {
  const res = await generateThankYouLetterCallable({
    clerkToken: args.clerkToken,
    input: {
      customerName: args.customerName,
      jobTypeName: args.jobTypeName,
      jobLocationZip: args.jobLocationZip,
      contractorName: args.contractorName,
      contractorBusiness: args.contractorBusiness,
      highlights: args.highlights,
    },
  })
  return res.data
}

// Generates the letter via Cloud Function, saves the package to Firestore,
// and returns the saved doc so the caller can show a share modal pointing
// at /thanks/<id>.
export async function createThankYouPackage(args: {
  clerkToken: string
  userId: string
  project: Project
  photos: ProjectPhoto[]
  contractorName?: string
  contractorBusiness?: string
  highlights?: string
}): Promise<ThankYouPackage> {
  const { clerkToken, userId, project, photos } = args
  if (!clerkToken) throw new Error('Not signed in')

  // Get AI-written letter
  const res = await generateThankYouLetterCallable({
    clerkToken,
    input: {
      customerName: project.customerName,
      jobTypeName: project.jobTypeName,
      jobLocationZip: project.jobLocationZip,
      contractorName: args.contractorName,
      contractorBusiness: args.contractorBusiness,
      highlights: args.highlights,
    },
  })
  const letter = res.data

  // Snapshot photos at this moment (URLs only, not re-uploaded).
  const photoSnapshot = photos.map(p => ({
    photoUrl: p.photoUrl,
    caption: p.caption || '',
    createdAt: p.createdAt,
  }))

  const payload: Record<string, unknown> = {
    projectId: project.id,
    customerName: project.customerName,
    jobTypeName: project.jobTypeName,
    letter,
    photos: photoSnapshot,
    createdAt: new Date().toISOString(),
    createdBy: userId,
  }
  if (project.jobLocationZip) payload.jobLocationZip = project.jobLocationZip
  if (args.contractorName) payload.contractorName = args.contractorName
  if (args.contractorBusiness) payload.contractorBusiness = args.contractorBusiness

  const ref = await addDoc(collection(db, 'thankYouPackages'), payload)
  return { id: ref.id, ...payload } as ThankYouPackage
}
