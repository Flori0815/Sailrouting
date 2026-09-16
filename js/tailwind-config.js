// Loaded as a classic (non-module) script right after the Tailwind CDN
// script tag, so `tailwind` is already defined on `window` when this runs.
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        marine: {
          950: '#030712',
          900: '#0b1329',
          850: '#111c38',
          800: '#1e293b',
          700: '#334155',
          600: '#475569'
        },
        ocean: {
          500: '#0284c7',
          400: '#38bdf8',
          300: '#7dd3fc'
        }
      }
    }
  }
};
