/**
 * API client for nano-agent-team backend
 * Base URL: /api (proxied to http://localhost:3001 in dev)
 */

const BASE = '/api'

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API ${options?.method ?? 'GET'} ${path} → ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}
