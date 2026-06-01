const CLIENT_ID = import.meta.env.VITE_STRAVA_CLIENT_ID || '254453'
const CLIENT_SECRET = import.meta.env.VITE_STRAVA_CLIENT_SECRET
const REDIRECT_URI = window.location.origin + window.location.pathname.replace(/\/$/, '')

export function stravaAuthUrl() {
  return `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=read,activity:read_all&approval_prompt=auto`
}

export async function exchangeCode(code) {
  const resp = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  })
  if (!resp.ok) throw new Error('Strava login mislukt')
  return resp.json()
}

export async function fetchActivityStream(activityId, token) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=latlng&key_by_type=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!resp.ok) throw new Error('Activiteit ophalen mislukt — controleer of de activiteit bestaat en publiek is')
  const data = await resp.json()
  if (!data.latlng?.data) throw new Error('Geen GPS data gevonden in deze activiteit')
  return data.latlng.data.map(([lat, lon]) => ({ lat, lon }))
}

export function getStoredToken() {
  try {
    const t = localStorage.getItem('strava_token')
    if (!t) return null
    const parsed = JSON.parse(t)
    if (parsed.expires_at * 1000 < Date.now()) { localStorage.removeItem('strava_token'); return null }
    return parsed
  } catch { return null }
}

export function storeToken(tokenData) {
  localStorage.setItem('strava_token', JSON.stringify(tokenData))
}

export function clearToken() {
  localStorage.removeItem('strava_token')
}

export function extractActivityId(input) {
  const match = input.match(/activities\/(\d+)/) || input.match(/^(\d+)$/)
  return match ? match[1] : null
}

export async function fetchActivities(token, page = 1) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?per_page=50&page=${page}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!resp.ok) throw new Error('Activiteiten ophalen mislukt')
  return resp.json()
}

export async function fetchAthleteId(token) {
  const resp = await fetch('https://www.strava.com/api/v3/athlete', {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!resp.ok) throw new Error('Atleet ophalen mislukt')
  const data = await resp.json()
  return data.id
}

export async function fetchRoutes(token, athleteId, page = 1) {
  const resp = await fetch(
    `https://www.strava.com/api/v3/athletes/${athleteId}/routes?per_page=50&page=${page}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!resp.ok) throw new Error('Routes ophalen mislukt')
  return resp.json()
}

export async function fetchRouteStream(routeId, token) {
  // Exporteer route als GPX en parseer die
  const resp = await fetch(
    `https://www.strava.com/api/v3/routes/${routeId}/export_gpx`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(`Strava fout (${resp.status}): ${data.message || 'onbekend'}`)
  }
  const gpxText = await resp.text()
  const parser = new DOMParser()
  const doc = parser.parseFromString(gpxText, 'application/xml')
  const points = []
  doc.querySelectorAll('trkpt, rtept').forEach(pt => {
    const lat = parseFloat(pt.getAttribute('lat'))
    const lon = parseFloat(pt.getAttribute('lon'))
    if (!isNaN(lat) && !isNaN(lon)) points.push({ lat, lon })
  })
  if (points.length === 0) throw new Error('Geen GPS data gevonden in deze route')
  return points
}
