/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        void: '#05070a',
        panel: '#0b0f14',
        panel2: '#10151c',
        border: '#1c232d',
        borderBright: '#2a3340',
        emerald: '#1fe3a8',
        gold: '#f0b429',
        coral: '#ff5470',
        blue: '#5ea8ff',
        cyan: '#22d3ee',
        violet: '#a78bfa',
      },
      fontFamily: {
        display: ['Orbitron', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
