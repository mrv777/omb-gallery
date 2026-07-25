/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      screens: {
        // Width at which the *full* nav — both tiers, marketplace included —
        // fits alongside the search field and colour swatches. Measured, not
        // guessed: all seven items clear the subpage header with zero overflow
        // down to 1080px, where the search input hits its 9rem floor exactly.
        // 1120 keeps ~24px of slack for font-rendering differences.
        //
        // Below this the secondary tier moves into the menu sheet, so this one
        // value drives four things that must agree: the secondary tier, the
        // menu trigger, the menu sheet, and the inline help button.
        'nav-full': '1120px',
      },
      colors: {
        // Punk-zine palette. Single mode (dark).
        'ink-0': '#000000', // page background
        'ink-1': '#0a0a0a', // header / scrim
        'ink-2': '#151515', // hairline separators
        bone: '#ededea',
        'bone-dim': '#7a7a75',
        'accent-red': '#ff2a2a',
        'accent-blue': '#2f4cff',
        'accent-green': '#2bd46c',
        'accent-orange': '#ff8a2a',
        'accent-black': '#bfbfbf',
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
