// ── BuildPro+ design tokens ──────────────────────────────────────────────
// Single source of truth for the "clean light" look: calm near-white surfaces,
// soft neutral background, one confident orange accent, generous radius, and
// soft layered shadows. New/refactored screens should pull from here instead of
// hardcoding hex values, so the platform stays visually consistent.
//
// (The global backdrop, focus ring, scrollbars and selection live in
// src/index.css and mirror these same values.)
import type { CSSProperties } from 'react'

export const colors = {
  bg: '#f6f7f9',          // app background wash
  surface: '#ffffff',     // cards, panels
  surfaceAlt: '#f1f5f9',  // subtle insets, secondary buttons
  text: '#0f172a',        // primary text (slate-900)
  muted: '#64748b',       // secondary text
  faint: '#94a3b8',       // tertiary / placeholder
  border: '#e8ecf1',      // hairline borders
  accent: '#f97316',      // brand orange
  accentSoft: '#fff7ed',  // orange tint background
  navy: '#1a1f2e',        // dark anchor (sidebar)
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
} as const

export const radius = {
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  pill: '999px',
} as const

// Soft, layered, low-contrast shadows — the core of the "floating card" feel.
export const shadow = {
  sm: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.05)',
  md: '0 2px 6px rgba(15,23,42,0.05), 0 8px 24px rgba(15,23,42,0.06)',
  lg: '0 12px 36px rgba(15,23,42,0.09)',
  accent: '0 6px 18px rgba(249,115,22,0.22)',
} as const

// 4px spacing scale: space(4) => '16px'
export const space = (n: number): string => `${n * 4}px`

export const font = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
} as const

// Ready-made primitives for inline-style screens.
export const card: CSSProperties = {
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.lg,
  boxShadow: shadow.sm,
}

export const theme = { colors, radius, shadow, space, font, card } as const
export default theme
