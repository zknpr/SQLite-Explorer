/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: 'var(--ui-bg)',
        foreground: 'var(--ui-fg)',
        subtle: 'var(--ui-subtle)',
        'subtle-foreground': 'var(--ui-subtle-fg)',
        edge: 'var(--ui-edge)',
        accent: 'var(--ui-accent)',
        'accent-foreground': 'var(--ui-accent-fg)',
        'accent-soft': 'var(--ui-accent-soft)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.6s ease-out both',
        'slide-up': 'slideUp 0.7s ease-out both',
        'slide-up-delay-1': 'slideUp 0.7s ease-out 0.1s both',
        'slide-up-delay-2': 'slideUp 0.7s ease-out 0.2s both',
        'slide-up-delay-3': 'slideUp 0.7s ease-out 0.3s both',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
