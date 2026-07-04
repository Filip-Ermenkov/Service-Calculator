import { headers as getHeaders } from 'next/headers.js'
import { getPayload } from 'payload'
import React from 'react'

import config from '@/payload.config'
import './styles.css'

export default async function HomePage() {
  const headers = await getHeaders()
  const payloadConfig = await config
  const payload = await getPayload({ config: payloadConfig })
  const { user } = await payload.auth({ headers })

  return (
    <div className="home">
      <div className="content">
        <h1>bulbau.lu</h1>
        <p>Phase 0 scaffold — Next.js + Payload CMS.</p>
        {!user || !('email' in user) ? (
          <p>No admin user yet.</p>
        ) : (
          <p>Signed in as {user.email}</p>
        )}
        <div className="links">
          <a className="admin" href={payloadConfig.routes.admin} rel="noopener noreferrer">
            Go to admin panel
          </a>
        </div>
      </div>
    </div>
  )
}
