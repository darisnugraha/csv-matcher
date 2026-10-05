export type MatchStatus = 'certain' | 'review' | 'unmatched'
export type Decision = 'use-json' | 'keep-csv' | 'pending'

export interface Candidate {
  id: string
  name: string
  score: number
  refs: string[]
  reason: string
  specConflict?: boolean
}

export interface MatchRow {
  id: string
  sourceIndex: number
  sourceName: string
  variant: string
  identifier: string
  status: MatchStatus
  reason: string
  candidates: Candidate[]
  decision: Decision
  chosenId?: string
  finalName: string
}

export interface CsvInfo {
  fileName: string
  bytes: number
  rows: number
  columns: number
  headers: string[]
  delimiter: string
  linebreak: string
  bom: boolean
  trailingNewline: boolean
  preview: string[][]
  warnings: string[]
}

export interface JsonInfo {
  fileName: string
  bytes: number
  records: number
  fields: string[]
  invalidNames: number
  preview: Record<string, unknown>[]
}

export type WorkerRequest =
  | { type: 'load-files'; csv: File; json: File }
  | { type: 'match'; targetIndex: number; variantIndex: number | null; jsonNameField: string; identifierIndex: number | null }
  | { type: 'search'; query: string; rowId: string }
  | { type: 'decide'; rowId: string; decision: Decision; candidateId?: string }
  | { type: 'export' }
  | { type: 'cancel' }
  | { type: 'reset' }

let sourceRows: string[][] = []
let masterRecords: Record<string, unknown>[] = []
let csvInfo: CsvInfo | null = null
let jsonInfo: JsonInfo | null = null
let matchRows: MatchRow[] = []
let mappings: { targetIndex: number; variantIndex: number | null; jsonNameField: string; identifierIndex: number | null } | null = null
let canceled = false
let matchComplete = false

const post = (type: string, payload?: unknown) => self.postMessage({ type, payload })

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleUpperCase('id-ID').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/[“”]/g, '"').trim()
}

function tokens(value: string): string[] {
  return normalize(value).replace(/[^A-Z0-9.]+/g, ' ').split(/\s+/).filter(Boolean)
}

function specs(value: string): Set<string> {
  return new Set(normalize(value).match(/\d+(?:\.\d+)?[A-Z]*/g) ?? [])
}

function conflicts(a: string, b: string): boolean {
  const aa = specs(a)
  const bb = specs(b)
  const numericConflict = [...aa].some(token => [...bb].some(other => {
    const leftUnit = token.replace(/[\d.]/g, '')
    const rightUnit = other.replace(/[\d.]/g, '')
    return token !== other && leftUnit === rightUnit && (leftUnit !== '' || [...tokens(a)].some(part => [...tokens(b)].includes(part)))
  }))
  const unitConflict = /\b(?:PCS|PACK|PACKS|BOTTLE|BOTOL)\b/.test(normalize(a)) && /\b(?:PCS|PACK|PACKS|BOTTLE|BOTOL)\b/.test(normalize(b))
    && [...normalize(a).matchAll(/\b(?:PCS|PACK|PACKS|BOTTLE|BOTOL)\b/g)].map(item => item[0]).some(unit => !normalize(b).includes(unit))
  return numericConflict || unitConflict
}

function recordRef(record: Record<string, unknown>, index: number): string {
  const id = record._id
  if (id && typeof id === 'object' && '$oid' in id && typeof id.$oid === 'string') return id.$oid
  if (typeof id === 'string' || typeof id === 'number') return String(id)
  return String(index)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

function similarity(a: string, b: string): number {
  const left = normalize(a)
  const right = normalize(b)
  if (!left && !right) return 100
  return Math.round(100 * (1 - levenshtein(left, right) / Math.max(left.length, right.length)))
}

function detectCsvDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  const options = [',', ';', '\t']
  return options.map((delimiter, order) => {
    let quoted = false
    let count = 0
    for (let i = 0; i < firstLine.length; i += 1) {
      if (firstLine[i] === '"') {
        if (quoted && firstLine[i + 1] === '"') i += 1
        else quoted = !quoted
      } else if (!quoted && firstLine[i] === delimiter) count += 1
    }
    return { delimiter, count, order }
  }).sort((a, b) => b.count - a.count || a.order - b.order)[0].delimiter
}

async function decodeFile(file: File): Promise<{ text: string; bytes: number }> {
  if (file.size > (file.name.toLowerCase().endsWith('.csv') ? 10 : 50) * 1024 * 1024) throw new Error(file.name.toLowerCase().endsWith('.csv') ? 'Ukuran CSV melebihi batas 10 MB.' : 'Ukuran JSON melebihi batas 50 MB.')
  const buffer = await file.arrayBuffer()
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    return { text, bytes: buffer.byteLength }
  } catch {
    throw new Error(`File ${file.name} bukan UTF-8 yang valid. Simpan ulang file sebagai UTF-8, lalu unggah kembali.`)
  }
}

async function loadFiles(csvFile: File, jsonFile: File) {
  canceled = false
  if (!csvFile.name.toLowerCase().endsWith('.csv')) throw new Error('Pilih file sumber dengan ekstensi .csv.')
  if (!jsonFile.name.toLowerCase().endsWith('.json')) throw new Error('Pilih master barang dengan ekstensi .json.')
  post('progress', { stage: 'Membaca CSV dan JSON…', value: 5 })
  const [csvDecoded, jsonDecoded] = await Promise.all([decodeFile(csvFile), decodeFile(jsonFile)])
  if (canceled) return
  const bom = csvDecoded.text.charCodeAt(0) === 0xfeff
  const csvText = bom ? csvDecoded.text.slice(1) : csvDecoded.text
  const delimiter = detectCsvDelimiter(csvText)
  post('progress', { stage: 'Memvalidasi struktur file…', value: 18 })
  const parsedCsv = Papa.parse<string[]>(csvText, { delimiter, header: false, dynamicTyping: false, skipEmptyLines: false, quoteChar: '"', escapeChar: '"' })
  if (parsedCsv.errors.length) {
    const error = parsedCsv.errors[0]
    throw new Error(`CSV tidak dapat dibaca di baris ${typeof error.row === 'number' ? error.row + 1 : '?'}: ${error.message}`)
  }
  const parsedRows = parsedCsv.data
  if (parsedRows.length < 1 || !parsedRows[0]?.some(value => value.trim())) throw new Error('CSV harus berisi header.')
  const width = parsedRows[0].length
  if (parsedRows.some(row => row.length !== width && row.some(value => value !== ''))) {
    const bad = parsedRows.findIndex(row => row.length !== width && row.some(value => value !== ''))
    throw new Error(`Jumlah kolom tidak sesuai di record ${bad + 1}. Periksa pemisah dan kutipan pada baris tersebut.`)
  }
  if (parsedRows.length - 1 > 20_000) throw new Error('CSV melebihi batas 20.000 record. Gunakan file yang lebih kecil.')
  const jsonText = jsonDecoded.text.replace(/^\uFEFF/, '')
  let parsedJson: unknown
  try { parsedJson = JSON.parse(jsonText) } catch (error) {
    const message = error instanceof Error ? error.message : 'JSON tidak valid'
    throw new Error(`JSON rusak: ${message}`)
  }
  if (!Array.isArray(parsedJson)) throw new Error('JSON harus berupa array objek pada root.')
  if (parsedJson.length > 50_000) throw new Error('JSON melebihi batas 50.000 record. Gunakan file yang lebih kecil.')
  if (parsedJson.some(item => item === null || Array.isArray(item) || typeof item !== 'object')) throw new Error('Setiap item JSON harus berupa objek.')
  sourceRows = parsedRows
  masterRecords = parsedJson as Record<string, unknown>[]
  matchRows = []
  matchComplete = false
  const headers = [...parsedRows[0]]
  const fields = [...new Set(masterRecords.flatMap(item => Object.keys(item)))].sort()
  const jsonNameGuess = fields.find(field => field.toLowerCase() === 'nama_barang') ?? fields.find(field => /nama.*barang|product.*name/i.test(field)) ?? ''
  const targetGuess = headers.findIndex(field => /items name|nama barang|nama produk/i.test(field))
  const variantGuess = headers.findIndex(field => /variant name|varian/i.test(field))
  const idGuess = headers.findIndex(field => /sku|internal id|item id/i.test(field))
  csvInfo = {
    fileName: csvFile.name, bytes: csvDecoded.bytes, rows: parsedRows.length - 1, columns: width, headers, delimiter,
    linebreak: parsedCsv.meta.linebreak || (csvText.includes('\r\n') ? '\r\n' : '\n'), bom,
    trailingNewline: /(?:\r\n|\n|\r)$/.test(csvText), preview: parsedRows.slice(0, 5), warnings: [],
  }
  const invalidNames = masterRecords.reduce((count, record) => count + (typeof record[jsonNameGuess] !== 'string' || !(record[jsonNameGuess] as string).trim() ? 1 : 0), 0)
  jsonInfo = { fileName: jsonFile.name, bytes: jsonDecoded.bytes, records: masterRecords.length, fields, invalidNames, preview: masterRecords.slice(0, 3) }
  post('files-loaded', { csv: csvInfo, json: jsonInfo, guesses: { targetIndex: targetGuess, variantIndex: variantGuess >= 0 ? variantGuess : null, identifierIndex: idGuess >= 0 ? idGuess : null, jsonNameField: jsonNameGuess } })
}

function splitName(value: string): { base: string; variant: string } {
  const name = normalize(value)
  const splitAt = name.indexOf(' - ')
  return splitAt >= 0 ? { base: name.slice(0, splitAt), variant: name.slice(splitAt + 3) } : { base: name, variant: '' }
}

function masterName(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === 'string' ? record[field] as string : ''
}

function candidatesFor(sourceName: string, variant: string, field: string, tokenIndex: Map<string, Set<number>>): Candidate[] {
  const full = normalize([sourceName, variant].filter(Boolean).join(' - '))
  const queryTokens = [...new Set(tokens(`${sourceName} ${variant}`))].sort((a, b) => (tokenIndex.get(a)?.size ?? 0) - (tokenIndex.get(b)?.size ?? 0))
  const pool = new Set<number>()
  for (const token of queryTokens) {
    for (const id of tokenIndex.get(token) ?? []) {
      pool.add(id)
      if (pool.size >= 500) break
    }
    if (pool.size >= 500) break
  }
  if (!pool.size) {
    const grams = trigrams(full).sort((a, b) => (tokenIndex.get(`~${a}`)?.size ?? 0) - (tokenIndex.get(`~${b}`)?.size ?? 0))
    // The trigrams are indexed under a reserved prefix to retain typo candidates.
    for (const gram of grams) {
      for (const id of tokenIndex.get(`~${gram}`) ?? []) {
        pool.add(id)
        if (pool.size >= 500) break
      }
      if (pool.size >= 500) break
    }
  }
  const scored = [...pool].map(index => {
    const record = masterRecords[index]
    const name = masterName(record, field)
    const parts = splitName(name)
    let score = similarity(full, name)
    if (variant) score = Math.round(similarity(sourceName, parts.base) * 0.6 + similarity(variant, parts.variant || name) * 0.4)
    const context = ['kode_varian', 'jenis_varian'].map(key => typeof record[key] === 'string' ? record[key] as string : '').filter(Boolean).join(' ')
    const conflict = conflicts(`${sourceName} ${variant}`, `${name} ${context}`)
    return { index, name, score, conflict }
  }).filter(item => item.name).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'id') || a.index - b.index)
  const deduped: Candidate[] = []
  const byName = new Map<string, Candidate>()
  for (const item of scored) {
    const key = normalize(item.name)
    const existing = byName.get(key)
    const reason = item.conflict ? 'Periksa perbedaan angka atau spesifikasi.' : item.score >= 90 ? 'Nama sangat mirip; konfirmasi sebelum digunakan.' : 'Kemiripan teks; perlu tinjauan operator.'
    if (existing) {
      existing.refs.push(recordRef(masterRecords[item.index], item.index))
      if (item.conflict) {
        existing.specConflict = true
        existing.reason = reason
      }
      continue
    }
    const record = masterRecords[item.index]
    const context = ['kode_varian', 'jenis_varian'].map(key => typeof record[key] === 'string' ? record[key] as string : '').filter(Boolean).join(' ')
    const specConflict = conflicts(`${sourceName} ${variant}`, `${item.name} ${context}`)
    const candidate = { id: recordRef(record, item.index), name: item.name, score: item.score, refs: [recordRef(record, item.index)], reason, specConflict }
    byName.set(key, candidate)
    deduped.push(candidate)
  }
  return deduped.slice(0, 3)
}

function trigrams(value: string): string[] {
  const text = `  ${value}  `
  const grams = new Set<string>()
  for (let i = 0; i < text.length - 2; i += 1) grams.add(text.slice(i, i + 3))
  return [...grams]
}

async function runMatch(config: NonNullable<typeof mappings>) {
  if (!csvInfo || !jsonInfo) throw new Error('Unggah kedua file terlebih dahulu.')
  if (config.targetIndex < 0 || config.targetIndex >= csvInfo.columns) throw new Error('Mapping kolom nama CSV wajib dipilih.')
  if (config.variantIndex === config.targetIndex) throw new Error('Kolom varian harus berbeda dari kolom nama barang.')
  if (!config.jsonNameField) throw new Error('Field nama JSON wajib dipilih.')
  mappings = config
  canceled = false
  matchRows = []
  matchComplete = false
  post('progress', { stage: 'Membangun indeks master…', value: 10 })
  const tokenIndex = new Map<string, Set<number>>()
  masterRecords.forEach((record, index) => {
    if (index % 1000 === 0 && canceled) return
    const name = masterName(record, config.jsonNameField)
    for (const token of new Set(tokens(name))) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, new Set())
      tokenIndex.get(token)!.add(index)
    }
    for (const gram of trigrams(normalize(name).slice(0, 160))) {
      if (!tokenIndex.has(`~${gram}`)) tokenIndex.set(`~${gram}`, new Set())
      const postings = tokenIndex.get(`~${gram}`)!
      if (postings.size < 500) postings.add(index)
    }
  })
  const rows = sourceRows.slice(1)
  for (let index = 0; index < rows.length; index += 1) {
    if (canceled) { post('canceled'); return }
    const cells = rows[index]
    const sourceName = cells[config.targetIndex] ?? ''
    const variant = config.variantIndex == null ? '' : cells[config.variantIndex] ?? ''
    const id = `${csvInfo.fileName}:${index + 2}`
    const identifier = config.identifierIndex == null ? '' : cells[config.identifierIndex] ?? ''
    if (!sourceName.trim()) {
      matchRows.push({ id, sourceIndex: index, sourceName, variant, identifier, status: 'unmatched', reason: 'Nama CSV kosong; baris dipertahankan.', candidates: [], decision: 'pending', finalName: sourceName })
    } else {
      const found = candidatesFor(sourceName, variant, config.jsonNameField, tokenIndex).filter(candidate => candidate.score >= 80)
      const expected = normalize([sourceName, variant].filter(Boolean).join(' - '))
      const exact = found.filter(item => normalize(item.name) === expected)
      const approvedPrefixes = ['OXVA'] // Explicit, versioned brand-prefix allowlist (normalization v1).
      const prefixMatches = found.filter(item => {
        const candidateName = normalize(item.name)
        return approvedPrefixes.some(prefix => candidateName.startsWith(`${prefix} `) && candidateName.slice(prefix.length + 1) === expected)
      })
      const safeExact = exact.filter(item => !item.specConflict)
      const automaticCandidates = safeExact.length ? safeExact : prefixMatches.filter(item => !item.specConflict)
      const automatic = automaticCandidates.length === 1
      const selectedCandidate = automaticCandidates[0]
      const reason = automatic ? (safeExact.length ? 'Nama dan varian cocok setelah normalisasi.' : 'Awalan merek OXVA terdaftar; nama produk dan spesifikasi cocok.') : found.length ? found[0].reason : 'Kandidat tidak ditemukan. Cari nama di seluruh master.'
      matchRows.push({ id, sourceIndex: index, sourceName, variant, identifier, status: automatic ? 'certain' : found.length ? 'review' : 'unmatched', reason, candidates: found, decision: automatic ? 'use-json' : 'pending', chosenId: selectedCandidate?.id, finalName: selectedCandidate?.name ?? sourceName })
    }
    if (index % 250 === 0 || index === rows.length - 1) {
      post('progress', { stage: `Mencocokkan record ${index + 1} dari ${rows.length}…`, value: 20 + Math.round((index + 1) / rows.length * 75) })
      if (index % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  if (canceled) { post('canceled'); return }
  matchComplete = true
  post('matched', { rows: matchRows, summary: summarize() })
}

function summarize() {
  return {
    certain: matchRows.filter(row => row.status === 'certain').length,
    review: matchRows.filter(row => row.status === 'review').length,
    unmatched: matchRows.filter(row => row.status === 'unmatched').length,
    decided: matchRows.filter(row => row.decision !== 'pending').length,
    changed: matchRows.filter(row => row.decision === 'use-json' && row.finalName !== row.sourceName).length,
    same: matchRows.filter(row => row.decision === 'use-json' && row.finalName === row.sourceName).length,
    kept: matchRows.filter(row => row.decision !== 'use-json').length,
  }
}

function searchMaster(query: string, rowId: string) {
  if (!mappings || !query.trim()) { post('search-results', { rowId, results: [] }); return }
  const normalizedQuery = normalize(query)
  const found = masterRecords.map((record, index) => ({ record, index, name: masterName(record, mappings!.jsonNameField) }))
    .filter(item => item.name && normalize(item.name).includes(normalizedQuery))
    .map(item => ({ ...item, score: similarity(query, item.name) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'id'))
    .slice(0, 30)
    .map(item => ({ id: recordRef(item.record, item.index), name: item.name, refs: [recordRef(item.record, item.index)], score: item.score, reason: 'Dipilih dari pencarian seluruh master.' }))
  const row = matchRows.find(item => item.id === rowId)
  if (row) {
    for (const candidate of found) if (!row.candidates.some(existing => existing.id === candidate.id)) row.candidates.push(candidate)
  }
  post('search-results', { rowId, results: found })
}

function decide(rowId: string, decision: Decision, candidateId?: string) {
  const row = matchRows.find(item => item.id === rowId)
  if (!row) return
  if (decision === 'use-json') {
    const candidate = row.candidates.find(item => item.id === candidateId)
    if (!candidate) return
    row.decision = decision
    row.chosenId = candidate.id
    row.finalName = candidate.name
  } else if (decision === 'keep-csv') {
    row.decision = decision
    row.chosenId = undefined
    row.finalName = row.sourceName
  } else {
    row.decision = 'pending'
    row.chosenId = undefined
    row.finalName = row.sourceName
  }
  post('decision-updated', { row, summary: summarize() })
}

function csvEscape(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || /[\r\n]/.test(value) || /^\s|\s$/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function serialize(rows: string[][], delimiter: string, newline: string, trailing: boolean): string {
  const output = rows.map(row => row.length === 1 && row[0] === '' ? '' : row.map(value => csvEscape(value, delimiter)).join(delimiter)).join(newline)
  return output + (trailing ? newline : '')
}

function exportFiles() {
  if (!csvInfo || !mappings || !matchComplete) throw new Error('Hasil pencocokan belum selesai. Proses yang dibatalkan atau gagal tidak dapat diekspor.')
  const outputRows = sourceRows.map(row => [...row])
  for (const result of matchRows) if (result.decision === 'use-json') outputRows[result.sourceIndex + 1][mappings.targetIndex] = result.finalName
  const outputTextNoBom = serialize(outputRows, csvInfo.delimiter, csvInfo.linebreak, csvInfo.trailingNewline)
  const reparsed = Papa.parse<string[]>(outputTextNoBom, { delimiter: csvInfo.delimiter, header: false, dynamicTyping: false, skipEmptyLines: false })
  if (reparsed.errors.length || reparsed.data.length !== sourceRows.length) throw new Error('Validasi ekspor gagal: jumlah record berubah. Tidak ada file yang diunduh.')
  for (let r = 0; r < sourceRows.length; r += 1) {
    if (reparsed.data[r].length !== sourceRows[r].length) throw new Error(`Validasi ekspor gagal pada record ${r + 1}: jumlah kolom berubah.`)
    for (let c = 0; c < sourceRows[r].length; c += 1) {
      const expected = c === mappings.targetIndex && r > 0 ? (matchRows[r - 1].decision === 'use-json' ? matchRows[r - 1].finalName : sourceRows[r][c]) : sourceRows[r][c]
      if (reparsed.data[r][c] !== expected) throw new Error(`Validasi ekspor gagal pada record ${r + 1}, kolom ${c + 1}. Tidak ada file yang diunduh.`)
    }
  }
  const csvText = (csvInfo.bom ? '\uFEFF' : '') + outputTextNoBom
  const reportHeaders = ['Nomor record sumber', 'ID atau SKU', 'Nama CSV', 'Varian CSV', 'Referensi JSON', 'Kandidat', 'Skor', 'Metode', 'Alasan', 'Keputusan', 'Nama akhir']
  const report = [reportHeaders, ...matchRows.map(row => {
    const reportCandidate = row.candidates.find(c => c.id === row.chosenId) ?? row.candidates[0]
    return [String(row.sourceIndex + 2), row.identifier, row.sourceName, row.variant, reportCandidate?.refs.join('; ') ?? '', reportCandidate?.name ?? '', String(reportCandidate?.score ?? ''), row.status === 'certain' ? 'Nama tepat' : row.status === 'review' ? 'Fuzzy / tinjauan' : 'Tidak cocok', row.reason, row.decision === 'use-json' ? 'Gunakan JSON' : row.decision === 'keep-csv' ? 'Pertahankan CSV' : 'Belum dipilih', row.finalName]
  })]
  const reportText = serialize(report, ',', '\r\n', false)
  post('export-ready', { csv: csvText, report: reportText, fileName: `${csvInfo.fileName.replace(/\.csv$/i, '')}_nama_disamakan.csv`, reportName: `${csvInfo.fileName.replace(/\.csv$/i, '')}_laporan_pencocokan.csv`, summary: summarize() })
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  try {
    if (message.type === 'load-files') await loadFiles(message.csv, message.json)
    if (message.type === 'match') await runMatch({ targetIndex: message.targetIndex, variantIndex: message.variantIndex, jsonNameField: message.jsonNameField, identifierIndex: message.identifierIndex })
    if (message.type === 'search') searchMaster(message.query, message.rowId)
    if (message.type === 'decide') decide(message.rowId, message.decision, message.candidateId)
    if (message.type === 'export') exportFiles()
    if (message.type === 'cancel') { canceled = true; matchComplete = false; post('canceled') }
    if (message.type === 'reset') { sourceRows = []; masterRecords = []; csvInfo = null; jsonInfo = null; matchRows = []; mappings = null; matchComplete = false; canceled = true; post('reset') }
  } catch (error) {
    post('error', { message: error instanceof Error ? error.message : 'Terjadi kesalahan saat memproses file.' })
  }
}

import Papa from 'papaparse'
