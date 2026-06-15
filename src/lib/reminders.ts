// Lightweight in-app / browser reminders. When the app is OPEN, we pop a
// native browser notification for anything due (calendar reminders, jobs
// starting, overdue invoices, etc.). We de-dupe per day so the same reminder
// doesn't nag on every dashboard load — each (reminderId + today) only fires
// once, tracked in localStorage.
//
// NOTE: True push notifications when the app is CLOSED require Firebase Cloud
// Messaging + a service worker + a verified domain. That's a separate, larger
// piece (deferred until the domain is live). This covers "app open" which is
// where contractors will see their day's to-dos.

const FIRED_KEY = 'bp_fired_reminders'
const ALERTS_PREF_KEY = 'bp_alerts_enabled'   // the user's ON/OFF switch (separate from browser permission)

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

// Has the browser granted notification permission?
export function notificationsEnabled(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

export function notificationsBlocked(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied'
}

// ── User's ON/OFF preference for alerts (sound + vibration + pop-ups). Fully
//    independent of browser permission — the sound/vibration don't need it.
//    Unset = OFF by default (the user explicitly turns alerts on), so we never
//    surprise anyone with noise.
export function alertsEnabled(): boolean {
  try {
    return localStorage.getItem(ALERTS_PREF_KEY) === 'true'
  } catch {
    return false
  }
}
export function setAlertsEnabled(on: boolean): void {
  try { localStorage.setItem(ALERTS_PREF_KEY, on ? 'true' : 'false') } catch { /* ignore */ }
}

// Play a short ping + vibrate the phone (where supported) to announce a new
// alert. No-op when alerts are turned off. Sound uses the Web Audio API so we
// don't need an audio file; vibration uses the Vibration API (Android browsers;
// iOS Safari generally ignores it, which is why we also play a sound).
let _audioCtx: AudioContext | null = null
export function playAlertCue(): void {
  if (!alertsEnabled()) return
  // Vibrate (Android/Chrome). Harmless no-op where unsupported.
  try { navigator.vibrate?.([120, 60, 120]) } catch { /* ignore */ }
  // Short two-tone beep.
  try {
    type WinAudio = Window & { webkitAudioContext?: typeof AudioContext }
    const Ctor = window.AudioContext || (window as WinAudio).webkitAudioContext
    if (!Ctor) return
    _audioCtx = _audioCtx || new Ctor()
    const ctx = _audioCtx
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const now = ctx.currentTime
    const beep = (start: number, freq: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(start); osc.stop(start + 0.2)
    }
    beep(now, 880)
    beep(now + 0.2, 1175)
  } catch {
    /* audio not available — vibration / popup still cover it */
  }
}

// Ask the user for permission (call from a user gesture — a button click).
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  try {
    const res = await Notification.requestPermission()
    return res === 'granted'
  } catch {
    return false
  }
}

// Read the set of "<reminderId>|<date>" keys already fired (cleaned to today).
function loadFired(): Set<string> {
  try {
    const raw = localStorage.getItem(FIRED_KEY)
    const arr: string[] = raw ? JSON.parse(raw) : []
    const today = todayStamp()
    // Drop anything not from today (keeps the store from growing forever).
    const kept = arr.filter(k => k.endsWith(`|${today}`))
    return new Set(kept)
  } catch {
    return new Set()
  }
}

function saveFired(set: Set<string>) {
  try { localStorage.setItem(FIRED_KEY, JSON.stringify([...set])) } catch { /* ignore quota */ }
}

export interface DueReminder {
  id: string
  label: string
}

// Alert for any reminders not already shown today. Respects the user's ON/OFF
// preference (alertsEnabled). The SOUND + VIBRATION work WITHOUT any browser
// permission; the OS pop-up only fires IF permission happens to be granted (it's
// a bonus, never required). Returns how many were newly alerted.
export function fireDueReminders(items: DueReminder[]): number {
  if (!alertsEnabled() || items.length === 0) return 0
  const fired = loadFired()
  const today = todayStamp()
  const canPopup = notificationsEnabled()
  let count = 0
  for (const it of items) {
    const key = `${it.id}|${today}`
    if (fired.has(key)) continue
    // Pop-up only if the browser granted permission — otherwise we still count
    // it so the sound/vibration fires and we don't re-alert it today.
    if (canPopup) {
      try { new Notification('BuildPro+ reminder', { body: it.label, tag: it.id, icon: '/favicon.ico' }) } catch { /* ignore */ }
    }
    fired.add(key)
    count++
  }
  if (count > 0) { saveFired(fired); playAlertCue() }   // ping + vibrate on new alerts
  return count
}

// The in-app half of the "6am morning-of" alert. Pops ONE consolidated
// "today's schedule" notification, once per day, the first time the app is open
// at or after 6am on a day that has anything scheduled. (The Cloud Function
// emails the same agenda at 6am for when the app is closed — together they make
// sure the contractor can't say they weren't warned.) `labels` is the day's
// items (jobs + events). Returns true if it fired.
export function fireMorningAgenda(labels: string[]): boolean {
  if (!alertsEnabled() || labels.length === 0) return false
  // Only fire from 6am onward — no point waking someone at 2am.
  if (new Date().getHours() < 6) return false
  const today = todayStamp()
  const key = `morning-agenda|${today}`
  const fired = loadFired()
  if (fired.has(key)) return false
  try {
    if (notificationsEnabled()) {
      const body = labels.length <= 4
        ? labels.join('\n')
        : labels.slice(0, 3).join('\n') + `\n…and ${labels.length - 3} more`
      new Notification('☀️ Today\'s schedule', { body, tag: 'morning-agenda', icon: '/favicon.ico' })
    }
    fired.add(key)
    saveFired(fired)
    playAlertCue()   // ping + vibrate
    return true
  } catch {
    return false
  }
}
