import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'

/*
 * Three roles, deliberately. Plex Sans and Plex Mono are one family designed for technical
 * documentation, which is what a transcript index is; Space Grotesk appears only on the
 * wordmark and page titles, where its mechanical letterforms do the work a serif would do
 * on a magazine and would do wrong here.
 */
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-space-grotesk',
})

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
})

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
})

export const metadata: Metadata = {
  title: 'Sightline',
  description: 'Every Claude Code session you have run, in one place.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
