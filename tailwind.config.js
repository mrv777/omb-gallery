/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'omb-red': '#FF0000',
        'omb-blue': '#0000FF',
        'omb-green': '#00FF00',
        'omb-orange': '#FFA500',
        'omb-black': '#000000',
      },
    },
  },
  plugins: [],
} 