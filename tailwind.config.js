/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // Both values resolve to CSS variables so the user can pick a
        // different accent at runtime (Settings → Appearance) without
        // a rebuild. The DEFAULT MUST be in `rgb(<vars> / <alpha-value>)`
        // form — otherwise Tailwind's opacity modifier (`bg-accent/85`,
        // `border-accent/40`, etc.) silently breaks because Tailwind
        // can't inject an alpha into a plain CSS-variable color. See
        // globals.css for the defaults and App.tsx for the accentColor
        // effect that swaps the vars.
        accent: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          glow: 'var(--accent-glow)',
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        // Multi-layer "premium tile" shadow: a tight inner top rim
        // highlight (catches light like glass), a thin inner ring,
        // a near drop-shadow for crispness, plus a mid + wide
        // ambient shadow for the floating macOS HUD feel. Reads
        // as a 3D pill, not a flat colored rectangle — the visual
        // half of the user's "look more premium / macOS-like" ask
        // that CSS can deliver without OS vibrancy.
        glass: [
          'inset 0 1px 0 rgba(255, 255, 255, 0.10)',
          'inset 0 0 0 1px rgba(255, 255, 255, 0.06)',
          '0 1px 1px rgba(0, 0, 0, 0.18)',
          '0 10px 28px rgba(0, 0, 0, 0.36)',
          '0 28px 64px rgba(0, 0, 0, 0.22)',
        ].join(', '),
        halo: '0 0 24px 6px rgb(var(--accent-rgb) / 0.5), 0 0 64px 16px rgb(var(--accent-rgb) / 0.25)',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Inter', 'sans-serif'],
      },
    },
  },
  plugins: [
    function ({ addUtilities }) {
      addUtilities({});
    },
  ],
};
