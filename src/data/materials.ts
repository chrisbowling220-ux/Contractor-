export interface Material {
  id: string
  name: string
  unit: string
  basePrice: number
  category: string
}

export interface MaterialLine {
  materialId: string
  name: string
  quantity: number
  unit: string
  unitPrice: number
}

// Base prices reflect 2026 retail at Home Depot / Lowe's in central North Carolina
// (Roxboro / Durham / Raleigh / Greensboro corridor). These are the canonical
// prices used everywhere in the app — pricing does not vary by state.
export const MATERIALS: Material[] = [
  { id: 'drywall-half', name: '1/2" Drywall Sheet (4x8)', unit: 'sheet', basePrice: 15.98, category: 'Drywall' },
  { id: 'drywall-screw', name: 'Drywall Screws (1lb box)', unit: 'box', basePrice: 9.48, category: 'Drywall' },
  { id: 'joint-compound', name: 'Joint Compound (4.5gal)', unit: 'bucket', basePrice: 17.97, category: 'Drywall' },
  { id: 'mesh-tape', name: 'Drywall Mesh Tape (300ft)', unit: 'roll', basePrice: 5.28, category: 'Drywall' },
  { id: 'stud-2x4-8', name: '2x4x8 SPF Stud', unit: 'each', basePrice: 3.78, category: 'Lumber' },
  { id: 'stud-2x4-10', name: '2x4x10 SPF Stud', unit: 'each', basePrice: 5.48, category: 'Lumber' },
  { id: 'stud-2x6-8', name: '2x6x8 SPF Stud', unit: 'each', basePrice: 6.97, category: 'Lumber' },
  { id: 'plywood-half', name: '1/2" CDX Plywood (4x8)', unit: 'sheet', basePrice: 36.98, category: 'Lumber' },
  { id: 'plywood-osb', name: '7/16" OSB (4x8)', unit: 'sheet', basePrice: 22.98, category: 'Lumber' },
  { id: 'paint-interior-gal', name: 'Interior Paint (Behr/Valspar, 1 gal)', unit: 'gallon', basePrice: 31.98, category: 'Paint' },
  { id: 'paint-exterior-gal', name: 'Exterior Paint (1 gal)', unit: 'gallon', basePrice: 38.98, category: 'Paint' },
  { id: 'primer-gal', name: 'Primer (1 gal)', unit: 'gallon', basePrice: 23.98, category: 'Paint' },
  { id: 'paint-roller', name: 'Paint Roller (3-pack)', unit: 'pack', basePrice: 8.98, category: 'Paint' },
  { id: 'paint-brush', name: 'Paint Brush', unit: 'each', basePrice: 6.48, category: 'Paint' },
  { id: 'tile-ceramic', name: 'Ceramic Tile 12x12 (basic)', unit: 'sqft', basePrice: 1.98, category: 'Tile' },
  { id: 'tile-porcelain', name: 'Porcelain Tile 12x24', unit: 'sqft', basePrice: 3.98, category: 'Tile' },
  { id: 'thinset', name: 'Thinset Mortar (50lb)', unit: 'bag', basePrice: 17.98, category: 'Tile' },
  { id: 'grout', name: 'Grout (10lb)', unit: 'bag', basePrice: 13.98, category: 'Tile' },
  { id: 'hardwood-oak', name: 'Oak Hardwood Flooring', unit: 'sqft', basePrice: 5.48, category: 'Flooring' },
  { id: 'laminate', name: 'Laminate Flooring', unit: 'sqft', basePrice: 1.79, category: 'Flooring' },
  { id: 'vinyl-plank', name: 'Luxury Vinyl Plank', unit: 'sqft', basePrice: 2.69, category: 'Flooring' },
  { id: 'underlayment', name: 'Floor Underlayment', unit: 'sqft', basePrice: 0.45, category: 'Flooring' },
  { id: 'shingle-arch', name: 'Architectural Shingles', unit: 'bundle', basePrice: 36.98, category: 'Roofing' },
  { id: 'felt-paper', name: 'Roofing Felt (#15, 432sqft)', unit: 'roll', basePrice: 23.98, category: 'Roofing' },
  { id: 'roofing-nails', name: 'Roofing Nails (1lb)', unit: 'box', basePrice: 6.48, category: 'Roofing' },
  { id: 'insul-r13', name: 'R-13 Batt Insulation', unit: 'sqft', basePrice: 0.78, category: 'Insulation' },
  { id: 'insul-r19', name: 'R-19 Batt Insulation', unit: 'sqft', basePrice: 1.05, category: 'Insulation' },
  { id: 'insul-r30', name: 'R-30 Batt Insulation', unit: 'sqft', basePrice: 1.38, category: 'Insulation' },
  { id: 'wire-12-2', name: '12/2 Romex w/ Ground (250ft)', unit: 'roll', basePrice: 109.98, category: 'Electrical' },
  { id: 'wire-14-2', name: '14/2 Romex w/ Ground (250ft)', unit: 'roll', basePrice: 82.98, category: 'Electrical' },
  { id: 'outlet', name: 'Standard 15A Outlet', unit: 'each', basePrice: 1.28, category: 'Electrical' },
  { id: 'switch', name: 'Single Pole Light Switch', unit: 'each', basePrice: 1.78, category: 'Electrical' },
  { id: 'outlet-box', name: 'Plastic Outlet Box', unit: 'each', basePrice: 0.89, category: 'Electrical' },
  { id: 'pipe-pvc-half', name: '1/2" PVC Pipe (10ft)', unit: 'each', basePrice: 3.98, category: 'Plumbing' },
  { id: 'pipe-pex-half', name: '1/2" PEX (100ft)', unit: 'roll', basePrice: 36.98, category: 'Plumbing' },
  { id: 'pex-fitting', name: 'PEX Fitting', unit: 'each', basePrice: 1.78, category: 'Plumbing' },
  { id: 'concrete-mix', name: 'Concrete Mix (60lb)', unit: 'bag', basePrice: 5.48, category: 'Concrete' },
  { id: 'rebar', name: '#4 Rebar (20ft)', unit: 'each', basePrice: 8.48, category: 'Concrete' },
  { id: 'caulk-silicone', name: 'Silicone Caulk', unit: 'tube', basePrice: 5.48, category: 'Misc' },
  { id: 'wood-screws', name: 'Wood Screws (1lb)', unit: 'box', basePrice: 7.48, category: 'Fasteners' },
  { id: 'nails-framing', name: 'Framing Nails (5lb)', unit: 'box', basePrice: 21.98, category: 'Fasteners' },
]

// Empty default — user must enter the job ZIP so the AI prices it correctly
// for that region. See functions/src/index.ts for the per-ZIP scaling rules.
export const DEFAULT_ZIP = ''

// regionFromZip is now a thin label helper — the actual price scaling happens
// inside the AI function based on the ZIP we send. We keep the client-side
// multiplier at 1.0 because we no longer hard-code regional math in the UI;
// the AI handles all regional adjustments from the prompt's scaling rules.
export function regionFromZip(zip: string): { multiplier: number; region: string } {
  if (!/^[0-9]{5}$/.test(zip)) return { multiplier: 1.0, region: '' }
  return { multiplier: 1.0, region: `ZIP ${zip}` }
}
