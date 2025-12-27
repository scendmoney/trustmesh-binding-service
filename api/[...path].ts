import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createApp } from '../src/app'

const app = createApp()

export default function handler(req: VercelRequest, res: VercelResponse) {
  const parts = (req.query as any).path
  const path = Array.isArray(parts) ? parts.join('/') : (parts ?? '')
  const qs = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  req.url = '/' + path + qs
  return (app as any)(req, res)
}
