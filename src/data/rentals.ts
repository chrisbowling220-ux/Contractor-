export interface RentalEquipment {
  id: string
  name: string
  category: string
  dailyRate: number
  weeklyRate: number
  deposit: number
}

export const RENTAL_EQUIPMENT: RentalEquipment[] = [
  { id: 'excavator-mini', name: 'Mini Excavator (3,000 lb)', category: 'Excavation', dailyRate: 285, weeklyRate: 950, deposit: 500 },
  { id: 'excavator-mid', name: 'Mid-Size Excavator (8,000 lb)', category: 'Excavation', dailyRate: 425, weeklyRate: 1500, deposit: 750 },
  { id: 'skid-steer', name: 'Skid Steer Loader', category: 'Excavation', dailyRate: 325, weeklyRate: 1100, deposit: 600 },
  { id: 'backhoe', name: 'Backhoe Loader', category: 'Excavation', dailyRate: 450, weeklyRate: 1650, deposit: 800 },
  { id: 'trencher', name: 'Walk-Behind Trencher', category: 'Excavation', dailyRate: 165, weeklyRate: 595, deposit: 250 },
  { id: 'compactor-plate', name: 'Plate Compactor', category: 'Compaction', dailyRate: 85, weeklyRate: 295, deposit: 150 },
  { id: 'compactor-jumping-jack', name: 'Jumping Jack Compactor', category: 'Compaction', dailyRate: 95, weeklyRate: 325, deposit: 175 },
  { id: 'roller', name: 'Walk-Behind Roller', category: 'Compaction', dailyRate: 145, weeklyRate: 525, deposit: 250 },
  { id: 'concrete-mixer', name: 'Concrete Mixer', category: 'Concrete', dailyRate: 65, weeklyRate: 220, deposit: 100 },
  { id: 'concrete-saw', name: 'Walk-Behind Concrete Saw', category: 'Concrete', dailyRate: 125, weeklyRate: 445, deposit: 200 },
  { id: 'power-trowel', name: 'Power Trowel', category: 'Concrete', dailyRate: 95, weeklyRate: 335, deposit: 150 },
  { id: 'jackhammer', name: 'Electric Jackhammer', category: 'Demolition', dailyRate: 75, weeklyRate: 265, deposit: 150 },
  { id: 'demo-saw', name: 'Demolition Saw', category: 'Demolition', dailyRate: 95, weeklyRate: 325, deposit: 175 },
  { id: 'breaker-hammer', name: 'Pneumatic Breaker', category: 'Demolition', dailyRate: 85, weeklyRate: 295, deposit: 150 },
  { id: 'scissor-lift-19', name: '19ft Scissor Lift', category: 'Lifts', dailyRate: 195, weeklyRate: 695, deposit: 400 },
  { id: 'scissor-lift-26', name: '26ft Scissor Lift', category: 'Lifts', dailyRate: 245, weeklyRate: 875, deposit: 500 },
  { id: 'boom-lift-30', name: '30ft Boom Lift', category: 'Lifts', dailyRate: 385, weeklyRate: 1375, deposit: 700 },
  { id: 'boom-lift-45', name: '45ft Boom Lift', category: 'Lifts', dailyRate: 525, weeklyRate: 1875, deposit: 900 },
  { id: 'forklift-rough', name: 'Rough Terrain Forklift', category: 'Lifts', dailyRate: 365, weeklyRate: 1295, deposit: 700 },
  { id: 'scaffold-set', name: 'Scaffold Set (6ft x 4 sections)', category: 'Scaffold', dailyRate: 35, weeklyRate: 95, deposit: 50 },
  { id: 'pump-trash', name: 'Trash Pump 2"', category: 'Pumps', dailyRate: 65, weeklyRate: 225, deposit: 100 },
  { id: 'pump-submersible', name: 'Submersible Pump', category: 'Pumps', dailyRate: 55, weeklyRate: 195, deposit: 100 },
  { id: 'generator-3500w', name: 'Generator 3500W', category: 'Power', dailyRate: 65, weeklyRate: 225, deposit: 150 },
  { id: 'generator-7500w', name: 'Generator 7500W', category: 'Power', dailyRate: 125, weeklyRate: 445, deposit: 250 },
  { id: 'air-compressor', name: 'Tow-Behind Air Compressor', category: 'Power', dailyRate: 145, weeklyRate: 525, deposit: 250 },
  { id: 'tile-saw', name: 'Wet Tile Saw', category: 'Tools', dailyRate: 55, weeklyRate: 195, deposit: 100 },
  { id: 'floor-sander', name: 'Drum Floor Sander', category: 'Tools', dailyRate: 75, weeklyRate: 245, deposit: 150 },
  { id: 'edge-sander', name: 'Edge Sander', category: 'Tools', dailyRate: 55, weeklyRate: 185, deposit: 100 },
  { id: 'carpet-stretcher', name: 'Carpet Power Stretcher', category: 'Tools', dailyRate: 35, weeklyRate: 95, deposit: 50 },
  { id: 'pressure-washer', name: 'Pressure Washer 3500psi', category: 'Tools', dailyRate: 85, weeklyRate: 295, deposit: 150 },
  { id: 'paint-sprayer', name: 'Airless Paint Sprayer', category: 'Tools', dailyRate: 75, weeklyRate: 265, deposit: 150 },
  { id: 'drywall-lift', name: 'Drywall Panel Lift', category: 'Tools', dailyRate: 35, weeklyRate: 95, deposit: 50 },
  { id: 'tile-stripper', name: 'Floor Tile Stripper', category: 'Tools', dailyRate: 95, weeklyRate: 335, deposit: 175 },
  { id: 'auger-1man', name: '1-Man Power Auger', category: 'Outdoor', dailyRate: 65, weeklyRate: 225, deposit: 100 },
  { id: 'auger-2man', name: '2-Man Power Auger', category: 'Outdoor', dailyRate: 85, weeklyRate: 295, deposit: 150 },
  { id: 'chainsaw', name: 'Gas Chainsaw 20"', category: 'Outdoor', dailyRate: 55, weeklyRate: 195, deposit: 100 },
  { id: 'stump-grinder', name: 'Stump Grinder', category: 'Outdoor', dailyRate: 285, weeklyRate: 995, deposit: 500 },
  { id: 'log-splitter', name: 'Log Splitter', category: 'Outdoor', dailyRate: 95, weeklyRate: 335, deposit: 175 },
  { id: 'dumpster-10', name: '10 yd Dumpster', category: 'Disposal', dailyRate: 25, weeklyRate: 395, deposit: 0 },
  { id: 'dumpster-20', name: '20 yd Dumpster', category: 'Disposal', dailyRate: 35, weeklyRate: 525, deposit: 0 },
  { id: 'dumpster-30', name: '30 yd Dumpster', category: 'Disposal', dailyRate: 45, weeklyRate: 695, deposit: 0 },
]

export const RENTAL_CATEGORIES = Array.from(new Set(RENTAL_EQUIPMENT.map(r => r.category))).sort()
