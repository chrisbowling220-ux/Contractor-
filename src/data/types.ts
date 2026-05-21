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
}

export interface ChangeOrder {
  id: string
  projectId: string
  customerName: string
  jobTypeName: string
  description: string
  additionalAmount: number
  newTotal: number
  status: 'pending' | 'approved' | 'declined'
  notes?: string
  createdAt: string
  createdBy?: string
}

export interface Invoice {
  id: string
  projectId: string
  estimateId?: string
  customerName: string
  jobTypeName: string
  invoiceType: 'deposit' | 'milestone' | 'final'
  amount: number
  description: string
  dueDate?: string
  notes?: string
  status: 'draft' | 'sent' | 'paid' | 'overdue'
  createdAt: string
  createdBy?: string
  paidAt?: string
}
