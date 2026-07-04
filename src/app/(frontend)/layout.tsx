import React from 'react'
import './styles.css'

export const metadata = {
  description: 'Multilingual service calculator for a Luxembourg service business.',
  title: 'bulbau.lu',
}

export default async function RootLayout(props: { children: React.ReactNode }) {
  const { children } = props

  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
