import * as readline from 'readline'
import Database from 'better-sqlite3'
import { s2 } from 's2js'
const LatLng = s2.LatLng
const toToken = s2.cellid.toToken

// Check if database name is provided
if (process.argv.length < 3) {
  console.error('Please provide database name as argument')
  process.exit(1)
}

const dbName = process.argv[2]
const db = new Database(dbName)

// Create table and index
db.exec(`
        CREATE TABLE IF NOT EXISTS positions (
            timestamp INTEGER,
            lat REAL,
            lon REAL,
            s2cell TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_s2cell ON positions(s2cell);
    `)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
})

const insertStmt = db.prepare(`
    INSERT INTO positions (timestamp, lat, lon, s2cell)
    VALUES (?, ?, ?, ?)
`)

rl.on('line', (line) => {
  try {
    const parsed = parseInfluxLine(line)
    if (parsed && parsed.fields.lat && parsed.fields.lon) {
      const lat = parseFloat(parsed.fields.lat)
      const lon = parseFloat(parsed.fields.lon)
      const timestamp = parsed.timestamp ? Math.floor(parsed.timestamp / 1000000) : Date.now()

      const s2token = toToken(s2.Cell.fromLatLng(LatLng.fromDegrees(lat, lon)).id)

      insertStmt.run(timestamp, lat, lon, s2token)
    }
  } catch (error) {
    console.error('Error processing line:', error)
  }
})

rl.on('close', () => {
  db.close()
})

const parseInfluxLine = (line: string) => {
  const parts = line.split(' ')
  const measurementWithTags = parts[0]
  const fields = parts[1].split(',')
  const timestamp = parseInt(parts.pop() || '', 10)

  const parsed: {
    measurement: string
    fields: { [key: string]: string }
    timestamp: number
  } = {
    measurement: measurementWithTags,
    fields: {},
    timestamp,
  }


  fields.forEach((field) => {
    const [key, value] = field.split('=')
    parsed.fields[key] = value
  })

  return parsed
}

parseInfluxLine(
  'navigation.position,context=vessels.urn:mrn:imo:mmsi:230029970,self=true,source=can0.c07891002fb5847c lat=60.1526336,lon=24.8941595 1720510098460000000',
)
