import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/lib/ThemeContext';
import { FavoritesProvider } from '@/lib/FavoritesContext';
import ThemeToggle from '@/components/ThemeToggle';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'OMB Gallery',
  description: 'A zoomable gallery of OMB images',
  icons: {
    icon: [
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline script to apply theme before page renders */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  // Check localStorage for theme
                  const storedTheme = localStorage.getItem('theme');
                  
                  // Check system preference
                  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                  
                  // Apply theme based on stored preference or system preference
                  if (storedTheme === 'dark' || (!storedTheme && prefersDark)) {
                    document.documentElement.classList.add('dark');
                  } else {
                    document.documentElement.classList.remove('dark');
                  }
                } catch (e) {
                  // Fail silently if localStorage is not available
                  console.error('Error applying theme:', e);
                }
              })();
            `,
          }}
        />
      </head>
      <body className={`${inter.className} transition-colors duration-300`}>
        <ThemeProvider>
          <FavoritesProvider>
            <ThemeToggle />
            {children}
          </FavoritesProvider>
        </ThemeProvider>
      </body>
    </html>
  );
} 