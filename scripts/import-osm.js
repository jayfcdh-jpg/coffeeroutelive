/**
 * CoffeeRoute — OSM Import Script
 * Haalt cafés en bakkerijen op per provincie en importeert ze in Supabase.
 */

import { createClient } from '@supabase/supabase-js'
import ws from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

// ─── .env laden ───────────────────────────────────────────────────────────────
const envPath = path.join(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    process.env[key] = val
  }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.includes('JOUW')) {
  console.error('❌ Vul eerst je Supabase gegevens in in het .env bestand!')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws },
})

// ─── Nederland opgedeeld in bounding boxes per regio ─────────────────────────
// Klein houden zodat Overpass niet time-out geeft
const REGIONS = [
  { name: 'Noord-Holland',   bbox: [52.20, 4.40, 52.90, 5.30] },
  { name: 'Zuid-Holland',    bbox: [51.70, 4.00, 52.20, 4.90] },
  { name: 'Utrecht',         bbox: [51.90, 4.80, 52.30, 5.50] },
  { name: 'Gelderland',      bbox: [51.70, 5.40, 52.30, 6.90] },
  { name: 'Noord-Brabant',   bbox: [51.35, 4.20, 51.80, 5.90] },
  { name: 'Limburg',         bbox: [50.75, 5.55, 51.55, 6.25] },
  { name: 'Overijssel',      bbox: [52.20, 6.00, 52.80, 7.10] },
  { name: 'Friesland',       bbox: [52.80, 4.80, 53.55, 6.00] },
  { name: 'Groningen',       bbox: [52.90, 6.40, 53.50, 7.20] },
  { name: 'Drenthe',         bbox: [52.40, 6.20, 53.00, 7.00] },
  { name: 'Flevoland',       bbox: [52.20, 5.20, 52.80, 6.00] },
  { name: 'Zeeland',         bbox: [51.15, 3.40, 51.75, 4.30] },
]

// ─── Overpass query voor één regio ───────────────────────────────────────────
function buildQuery(bbox) {
  const [south, west, north, east] = bbox
  return `[out:json][timeout:30];
(
  node["amenity"="cafe"](${south},${west},${north},${east});
  node["shop"="bakery"](${south},${west},${north},${east});
);
out body;`
}

async function fetchRegion(region) {
  const query = buildQuery(region.bbox)
  const tmpFile = `/tmp/overpass_query_${Date.now()}.txt`
  fs.writeFileSync(tmpFile, query)

  const mirrors = [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ]

  for (const url of mirrors) {
    try {
      const result = execSync(
        `curl -s -X POST --data-urlencode "data@${tmpFile}" "${url}"`,
        { maxBuffer: 50 * 1024 * 1024 }
      )
      const json = JSON.parse(result.toString())
      if (json.elements) { fs.unlinkSync(tmpFile); return json.elements }
    } catch (e) {
      console.error(`   mirror ${url} fout: ${e.message.slice(0, 100)}`)
    }
  }
  try { fs.unlinkSync(tmpFile) } catch {}
  throw new Error('Alle Overpass mirrors zijn niet bereikbaar')
}

// ─── Importeer batch naar Supabase ───────────────────────────────────────────
async function importBatch(elements) {
  const rows = elements
    .filter(el => el.lat && el.lon && el.tags && el.tags.name)
    .map(el => {
      const t = el.tags
      return {
        osm_id: el.id,
        name: t.name || t['name:nl'] || t.brand || 'Koffiestop',
        type: t.shop === 'bakery' ? 'bakkerij' : 'koffiebar',
        lat: el.lat,
        lon: el.lon,
        address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ') || null,
        city: t['addr:city'] || t['addr:town'] || t['addr:village'] || null,
        opening_hours: t.opening_hours || null,
        phone: t.phone || t['contact:phone'] || null,
        website: t.website || t['contact:website'] || null,
        outdoor_seating: t.outdoor_seating === 'yes',
      }
    })

  if (rows.length === 0) return 0

  const { error } = await supabase
    .from('cafes')
    .upsert(rows, { onConflict: 'osm_id' })

  if (error) throw new Error('Supabase fout: ' + error.message)
  return rows.length
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('☕ CoffeeRoute — OSM Import\n')
  console.log('Verbinding testen met Supabase...')

  // Test verbinding
  const { error: testErr } = await supabase.from('cafes').select('id').limit(1)
  if (testErr) {
    console.error('❌ Kan geen verbinding maken met Supabase:', testErr.message)
    console.error('   Controleer je .env bestand en of de tabel is aangemaakt (stap 2 in README)')
    process.exit(1)
  }
  console.log('✅ Verbinding OK\n')

  let totalImported = 0

  for (let i = 0; i < REGIONS.length; i++) {
    const region = REGIONS[i]
    const progress = `[${i + 1}/${REGIONS.length}]`
    process.stdout.write(`📡 ${progress} ${region.name}... ophalen`)
    try {
      const elements = await fetchRegion(region)
      process.stdout.write(` → ${elements.length} locaties... importeren`)
      const count = await importBatch(elements)
      console.log(` → ✅ ${count} opgeslagen`)
      totalImported += count
      await new Promise(r => setTimeout(r, 1500))
    } catch (e) {
      console.log(` → ⚠️  overgeslagen (${e.message})`)
    }
  }

  console.log(`\n🎉 Klaar! ${totalImported} koffiestops in je database.`)
}

main()
