// "Tip of the Day" — a rotating piece of real, practical contractor wisdom.
// Curated (not AI-generated) so it's free, never fails, and every tip is solid.
// The visible tip changes once per day, renewing at 2:00 AM Eastern.

export const CONTRACTOR_TIPS: { tip: string; tag: string }[] = [
  { tag: 'Money', tip: 'Always get a deposit before you buy materials. Your money should never be tied up in someone else’s job before they’ve put skin in the game.' },
  { tag: 'Quoting', tip: 'Price the job, not the hour. Customers remember the final number, not your hourly rate — quote what the work is worth, not just your time.' },
  { tag: 'Money', tip: 'Charge for the change. The moment scope grows, write a change order and get it signed before you lift a finger. “I thought that was included” is where profit goes to die.' },
  { tag: 'Reputation', tip: 'Show up when you say you will — or call ahead if you can’t. Reliability beats being the cheapest. The contractor who answers the phone wins the job.' },
  { tag: 'Cash flow', tip: 'Bill the day the job is done, not “when you get to it.” Every day an invoice sits unsent is a day you’re lending the customer money for free.' },
  { tag: 'Pricing', tip: 'Never be the lowest bid. The cheapest contractor attracts the worst customers and the thinnest margins. Be the best value, not the cheapest price.' },
  { tag: 'Materials', tip: 'Add 10–15% waste to your material count — but don’t pad it to 50%. Customers can smell a padded quote, and it costs you the bid.' },
  { tag: 'Protect yourself', tip: 'Put everything in writing. A signed estimate and clear scope protects you more than any handshake. Memories get fuzzy when money’s involved.' },
  { tag: 'Reputation', tip: 'Photograph everything — before, during, and after. Photos win disputes, sell the next job, and prove your work better than any words.' },
  { tag: 'Growth', tip: 'Ask every happy customer for a review and a referral the day you finish. That’s when they’re most thrilled — and it costs you nothing.' },
  { tag: 'Money', tip: 'Know your true cost per hour — truck, fuel, insurance, tools, taxes — before you ever quote. Most contractors charge too little because they only count their wage.' },
  { tag: 'Jobsite', tip: 'Leave the site cleaner than you found it. A swept floor and hauled-away trash is free marketing — it’s the last thing the customer sees.' },
  { tag: 'Customers', tip: 'Under-promise and over-deliver on timelines. Say it’ll take a week when you know it’s five days — finishing early makes you a hero.' },
  { tag: 'Cash flow', tip: 'Keep business and personal money in separate accounts. You can’t tell if you’re actually making money when it’s all mixed together.' },
  { tag: 'Protect yourself', tip: 'For big jobs, bill in stages — deposit, midpoint, completion. Never let the amount owed to you get bigger than the work left to do.' },
  { tag: 'Hiring', tip: 'A good helper who shows up beats a great one who doesn’t. Reliability is the most underrated skill on any crew.' },
  { tag: 'Pricing', tip: 'When a customer says “that’s too expensive,” don’t drop your price — reduce the scope. Lowering the number teaches them you were overcharging.' },
  { tag: 'Growth', tip: 'Repeat customers are pure gold. It’s ten times easier to get more work from someone who already trusts you than to chase a stranger.' },
  { tag: 'Mindset', tip: 'Saying “no” to a bad-fit job is a business skill. The wrong customer will cost you more in headaches than the job is worth.' },
  { tag: 'Money', tip: 'Track every dollar in and out. The contractor who knows his numbers sleeps fine; the one who guesses lies awake wondering where it went.' },
  { tag: 'Jobsite', tip: 'Measure twice, cut once — and confirm the scope twice before you start. Most callbacks come from a misunderstanding, not bad workmanship.' },
  { tag: 'Reputation', tip: 'Answer your phone or text back fast. Half of winning the job is just being the one who responded while the customer was still thinking about it.' },
  { tag: 'Protect yourself', tip: 'Carry liability insurance and say so. “Licensed and insured” closes nervous customers — and one accident without it can end your business.' },
  { tag: 'Pricing', tip: 'Build your profit margin into every line — don’t tack it on at the end where it’s easy to negotiate away. Profit isn’t a tip; it’s the point.' },
  { tag: 'Customers', tip: 'Set expectations on day one: hours, dust, noise, payment terms. The clearer you are up front, the fewer problems you’ll have at the end.' },
  { tag: 'Growth', tip: 'Specialize in what pays best and you’re great at. “Jack of all trades” earns less than the guy known as THE deck guy or THE bathroom guy.' },
  { tag: 'Cash flow', tip: 'Make it easy to pay you — card, cash, whatever’s simple. The harder it is to pay, the longer your money sits in someone else’s pocket.' },
  { tag: 'Mindset', tip: 'Your reputation is your business. One angry customer with a phone can undo ten happy ones — so handle complaints fast and fair, every time.' },
  { tag: 'Jobsite', tip: 'Keep a small “extras” buffer in your schedule. Jobs always find a surprise — the contractor with no slack is the one who runs late and looks bad.' },
  { tag: 'Money', tip: 'Raise your prices once a year. Materials and gas go up; if your rates don’t, you’re quietly giving yourself a pay cut every single year.' },
  { tag: 'Customers', tip: 'A quick thank-you after the job turns a one-time customer into a repeat one. People remember the contractor who treated them like a person, not a paycheck.' },
  { tag: 'Protect yourself', tip: 'Never start work on a “we’ll figure out the price later.” That sentence has cost more contractors more money than any other.' },
  { tag: 'Growth', tip: 'Your truck is a billboard. A clean, lettered truck with your name and number parked at a job wins you the neighbor’s job too.' },
  { tag: 'Hiring', tip: 'Train your crew to do it your way once, well — then trust them. You can’t grow if you’re the only one who can do the work.' },
  { tag: 'Mindset', tip: 'Slow is smooth, smooth is fast. Rushing causes the mistakes and callbacks that eat your profit. Steady and right beats fast and wrong.' },
  { tag: 'Cash flow', tip: 'Follow up on unpaid invoices without guilt. You did the work — a polite “just checking in on that invoice” is professional, not pushy.' },
  { tag: 'Pricing', tip: 'Give customers options — good, better, best. People love to choose, and a surprising number pick “best” when you let them.' },
  { tag: 'Reputation', tip: 'Fix your mistakes fast and without arguing. How you handle a problem is remembered far longer than the problem itself.' },
  { tag: 'Money', tip: 'Set aside money for taxes every time you get paid — don’t wait. A 25–30% set-aside means tax season is boring instead of terrifying.' },
  { tag: 'Customers', tip: 'Walk the finished job with the customer and point out what you did. Value they can see is value they’ll happily pay — and brag about — for.' },
]

// Pick today's tip. The "day" rolls over at 2:00 AM Eastern: we subtract 2 hours
// from the Eastern wall-clock time, then index by the day-of-epoch so it's stable
// for the whole day and advances by one each morning.
export function tipOfTheDay(now: Date = new Date()): { tip: string; tag: string } {
  // Eastern time, shifted back 2 hours so the "new day" begins at 2 AM ET.
  const etString = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now)
  const get = (t: string) => Number(etString.find(p => p.type === t)?.value || 0)
  const y = get('year'), mo = get('month'), d = get('day')
  let hour = get('hour'); if (hour === 24) hour = 0
  // Days since epoch for this Eastern date, minus a day if it's before 2 AM.
  const dayNumber = Math.floor(Date.UTC(y, mo - 1, d) / 86400000) - (hour < 2 ? 1 : 0)
  const idx = ((dayNumber % CONTRACTOR_TIPS.length) + CONTRACTOR_TIPS.length) % CONTRACTOR_TIPS.length
  return CONTRACTOR_TIPS[idx]
}
