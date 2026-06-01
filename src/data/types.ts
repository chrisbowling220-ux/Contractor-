export interface MaterialLine {
  materialId: string
  name: string
  quantity: number
  unit: string
  unitPrice: number
}

export interface RentalLine {
  rentalId: string
  name: string
  days: number
  dailyRate: number
  deposit: number
}

export interface AIMaterialLine {
  name: string
  base_quantity: number
  waste_percent: number
  quantity_with_waste: number
  quantity_math: string
  unit: string
  unit_price: number
  line_total: number
}

export interface AIQuote {
  customer_summary: string
  work_scope: string
  material_list: AIMaterialLine[]
  labor: {
    estimated_hours: number
    breakdown: string
    hourly_rate: number
    labor_total: number
  }
  price_breakdown: {
    labor_subtotal: number
    materials_subtotal: number
    rentals_subtotal: number
    raw_cost: number
  }
  profit_markup: {
    markup_percent: number
    markup_dollars: number
    rationale: string
  }
  final_customer_quote: number
  contractor_notes: string
}

export interface Estimate {
  id: string
  customerName: string
  customerId?: string
  jobTypeId: string
  jobTypeName: string
  description: string
  rateType: 'flat' | 'hourly'
  flatAmount?: number
  hourlyRate?: number
  estimatedHours?: number
  laborTotal: number
  materials: MaterialLine[]
  materialsTotal: number
  rentals: RentalLine[]
  rentalsTotal: number
  jobLocationZip: string
  jobLocationRegion: string
  regionMultiplier: number
  total: number
  scopeOfWork: string
  aiQuote?: AIQuote
  status: 'pending' | 'approved' | 'declined'
  // Optional upfront deposit the contractor requests before starting work.
  // Off by default — many jobs/customers pay only at completion. When set, the
  // customer sees the deposit terms on the estimate, and on approval a deposit
  // invoice is auto-generated (deposit due now, balance due at completion).
  depositRequested?: boolean
  depositAmount?: number          // dollar amount of the deposit
  // True once the deposit invoice has been auto-created for this estimate, so
  // we don't create duplicates on repeat dashboard loads.
  depositInvoiceCreated?: boolean
  createdAt: string
  createdBy?: string
  // Set when the customer accepts/declines via the public share link.
  customerResponse?: {
    action: 'approved' | 'declined'
    signedName: string
    reason?: string
    respondedAt: string
  }
  // Set after we auto-create a Project from this approved estimate — prevents
  // creating duplicates on subsequent dashboard loads.
  projectAutoCreated?: boolean
  projectId?: string
}

export interface ChangeOrderLine {
  name: string
  quantity: number    // negative for removals/credits
  unitPrice: number
  lineTotal: number
}

export interface ChangeOrder {
  id: string
  projectId: string
  customerName: string
  description: string
  reason: 'customer_requested' | 'site_condition' | 'code_requirement' | 'other'
  lineItems: ChangeOrderLine[]
  originalTotal: number  // project / estimate total before this change
  delta: number          // positive = increase, negative = credit
  newTotal: number       // originalTotal + delta
  status: 'pending' | 'approved' | 'declined'
  customerResponse?: {
    action: 'approved' | 'declined'
    signedName: string
    reason?: string
    respondedAt: string
  }
  createdAt: string
  createdBy?: string
}

export const CHANGE_ORDER_REASON_LABEL: Record<ChangeOrder['reason'], string> = {
  customer_requested: 'Customer requested',
  site_condition: 'Site condition',
  code_requirement: 'Code requirement',
  other: 'Other',
}

export interface CustomerPhoto {
  id: string
  customerId: string
  customerName: string
  caption: string
  photoUrl: string
  storagePath: string
  createdAt: string
  createdBy?: string
}

export interface ProjectPhoto {
  id: string
  projectId: string   // Empty string while the photo is still tagged only by estimate
  estimateId?: string // Set if photo came from Scan Room before a project existed
  customerName: string
  caption: string
  photoUrl: string
  storagePath: string
  createdAt: string
  createdBy?: string
  // For slideshow ordering. Falls back to createdAt when missing.
  sortOrder?: number
  // Set by the contractor if they want this photo specifically NOT included
  // in the thank-you letter slideshow.
  hiddenFromThankYou?: boolean
}

export interface InvoiceLine {
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

export interface Invoice {
  id: string
  projectId: string
  customerName: string
  customerEmail?: string
  customerPhone?: string
  customerAddress?: string
  jobTypeName: string
  jobLocationZip?: string
  invoiceNumber: string         // e.g. "INV-2026-0001"
  // AI-written content
  introNote: string             // "Thanks for trusting us with your project. Here's the final invoice…"
  paymentTerms: string          // "Payment due within 30 days. We accept check, Venmo, Zelle, or cash."
  // Line items rolled up from estimate + approved change orders
  lineItems: InvoiceLine[]
  subtotal: number
  amountPaid: number            // for deposits already received
  amountDue: number             // subtotal - amountPaid
  // Snapshot of contractor profile at time of generation
  businessName?: string
  businessPhone?: string
  businessEmail?: string
  licenseNumber?: string
  logoUrl?: string
  contractorName?: string
  // Status
  status: 'draft' | 'sent' | 'paid' | 'overdue'
  dueDate: string               // ISO date
  paidAt?: string
  // Set when the customer chooses "Pay Cash / In Person" on the public invoice
  // page (they'll settle up directly with the contractor). Status stays "sent"
  // until the contractor manually confirms cash received.
  customerCashChoice?: boolean
  customerCashAt?: string
  // True for the upfront-deposit invoice auto-created when a customer approves
  // an estimate that requested a deposit. The final invoice nets this out.
  isDeposit?: boolean
  createdAt: string
  createdBy?: string
}

export interface ThankYouPackage {
  id: string
  projectId: string
  customerName: string
  jobTypeName: string
  jobLocationZip?: string
  contractorName?: string
  contractorBusiness?: string
  letter: {
    greeting: string
    opening: string
    body: string
    closing: string
  }
  // Snapshot of photos at the time the package was generated. We store URLs
  // (not re-uploaded) so deleting a project photo later doesn't break the
  // package; the customer still sees what they saw.
  photos: { photoUrl: string; caption: string; createdAt: string }[]
  createdAt: string
  createdBy?: string
}

export type ProjectStatus = 'lead' | 'estimated' | 'contracted' | 'in_progress' | 'completed' | 'closed'

export const PROJECT_STATUS_ORDER: ProjectStatus[] = ['lead', 'estimated', 'contracted', 'in_progress', 'completed', 'closed']

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  lead: 'Lead',
  estimated: 'Estimated',
  contracted: 'Contracted',
  in_progress: 'In Progress',
  completed: 'Completed',
  closed: 'Closed',
}

export interface Project {
  id: string
  customerName: string
  customerId?: string
  jobTypeName: string
  jobLocationZip: string
  description: string
  status: ProjectStatus
  startDate?: string
  completionDate?: string
  notes: string
  createdAt: string
  createdBy?: string
  // Set if this project was auto-created from an approved estimate.
  sourceEstimateId?: string
  estimateTotal?: number
  // Set when contractor archives a finished project into the Completed Jobs
  // folder. Filtered out of the main Projects list.
  archived?: boolean
  archivedAt?: string
  // Set when the source estimate was DECLINED by the customer. Lands in the
  // "Declined" view instead of active Projects. Can be deleted.
  declined?: boolean
  declinedAt?: string
  declineReason?: string
  // Set when the project auto-closes after the invoice is paid in full.
  closedAt?: string
  // Set when the contractor taps "Mark Job Complete" (In Progress → Completed).
  completedAt?: string
}
