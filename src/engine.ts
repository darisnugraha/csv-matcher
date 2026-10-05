import * as XLSX from '@e965/xlsx'
import { normalizeMatchName as normalize } from './normalize'

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
  brand: string
  sourceName: string
  variant: string
  identifier: string
  status: MatchStatus
  reason: string
  candidates: Candidate[]
  decision: Decision
  chosenId?: string
  finalName: string
  manualConfirmation?: {
    status: MatchStatus
    reason: string
  }
  unmatchedOverride?: {
    status: MatchStatus
    reason: string
    decision: Decision
    chosenId?: string
    finalName: string
  }
}

export interface CsvInfo {
  format: 'csv' | 'xlsx'
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
  sheetNames: string[]
  selectedSheet: string
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
  | { type: 'load-files'; source: File; json: File }
  | { type: 'select-sheet'; sheetName: string }
  | { type: 'match'; targetIndex: number; brandIndex: number | null; variantIndex: number | null; jsonNameField: string; identifierIndex: number | null }
  | { type: 'search'; query: string; rowId: string }
  | { type: 'recommendations'; rowId: string }
  | { type: 'decide'; rowId: string; decision: Decision; candidateId?: string }
  | { type: 'mark-unmatched'; rowId: string }
  | { type: 'restore-match'; rowId: string }
  | { type: 'export' }
  | { type: 'cancel' }
  | { type: 'reset' }

let sourceRows: string[][] = []
let sourceFormat: 'csv' | 'xlsx' = 'csv'
let sourceSheetNames: string[] = []
let selectedSheet = ''
let sourceWorkbook: XLSX.WorkBook | null = null
let masterRecords: Record<string, unknown>[] = []
let csvInfo: CsvInfo | null = null
let jsonInfo: JsonInfo | null = null
let matchRows: MatchRow[] = []
let mappings: { targetIndex: number; brandIndex: number | null; variantIndex: number | null; jsonNameField: string; identifierIndex: number | null } | null = null
let masterTokenIndex = new Map<string, Set<number>>()
let masterExactNameIndex = new Map<string, Set<number>>()
let canceled = false
let matchComplete = false

const post = (type: string, payload?: unknown) => self.postMessage({ type, payload })

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

function oneCharacterTypo(left: string, right: string): boolean {
  if (levenshtein(left, right) === 1) return true
  if (left.length !== right.length) return false
  const mismatches = left.split('').flatMap((character, index) => character === right[index] ? [] : [index])
  return mismatches.length === 2
    && mismatches[1] === mismatches[0] + 1
    && left[mismatches[0]] === right[mismatches[1]]
    && left[mismatches[1]] === right[mismatches[0]]
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
  if (file.size > (file.name.toLowerCase().endsWith('.json') ? 50 : 10) * 1024 * 1024) throw new Error(file.name.toLowerCase().endsWith('.json') ? 'Ukuran JSON melebihi batas 50 MB.' : 'Ukuran file sumber melebihi batas 10 MB.')
  const buffer = await file.arrayBuffer()
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
    return { text, bytes: buffer.byteLength }
  } catch {
    throw new Error(`File ${file.name} bukan UTF-8 yang valid. Simpan ulang file sebagai UTF-8, lalu unggah kembali.`)
  }
}

function parseXlsxSheet(sheetName: string): string[][] {
  if (!sourceWorkbook || !sourceWorkbook.Sheets[sheetName]) throw new Error('Sheet XLSX yang dipilih tidak ditemukan. Pilih sheet lain atau unggah ulang workbook.')
  const worksheet = sourceWorkbook.Sheets[sheetName]
  const values = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false, defval: '', blankrows: true })
  const range = worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref'] as string) : null
  const width = Math.max(range ? range.e.c + 1 : 0, ...values.map(row => row.length))
  if (values.length - 1 > 20_000) throw new Error('Sheet XLSX melebihi batas 20.000 record. Pilih sheet yang lebih kecil atau kurangi jumlah baris.')
  if (!values.length || !values[0]?.some(value => String(value ?? '').trim())) throw new Error('Sheet XLSX harus memiliki header pada baris pertama.')
  if (width === 0) throw new Error('Sheet XLSX yang dipilih tidak memiliki kolom data.')
  return values.map(row => Array.from({ length: width }, (_, index) => {
    const value = row[index]
    return value == null ? '' : String(value)
  }))
}

async function loadFiles(sourceFile: File, jsonFile: File) {
  canceled = false
  const lowerName = sourceFile.name.toLowerCase()
  if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.xlsx')) throw new Error('Pilih file sumber dengan ekstensi .csv atau .xlsx.')
  if (!jsonFile.name.toLowerCase().endsWith('.json')) throw new Error('Pilih master barang dengan ekstensi .json.')
  if (sourceFile.size > 10 * 1024 * 1024) throw new Error('Ukuran file sumber melebihi batas 10 MB.')
  post('progress', { stage: `Membaca ${lowerName.endsWith('.xlsx') ? 'XLSX' : 'CSV'} dan JSON…`, value: 5 })
  const [sourceDecoded, jsonDecoded] = await Promise.all([sourceFile.arrayBuffer().then(buffer => ({ buffer, bytes: buffer.byteLength })), decodeFile(jsonFile)])
  if (canceled) return
  sourceFormat = lowerName.endsWith('.xlsx') ? 'xlsx' : 'csv'
  sourceWorkbook = null
  sourceSheetNames = []
  selectedSheet = ''
  post('progress', { stage: 'Memvalidasi struktur file…', value: 18 })
  let parsedRows: string[][]
  let bom = false
  let delimiter = ''
  let linebreak = ''
  let trailingNewline = false
  if (sourceFormat === 'xlsx') {
    try {
      sourceWorkbook = XLSX.read(sourceDecoded.buffer, { type: 'array', cellDates: false, cellFormula: true })
    } catch {
      throw new Error('XLSX tidak dapat dibaca. Pastikan workbook tidak rusak atau dienkripsi, lalu unggah kembali.')
    }
    sourceSheetNames = sourceWorkbook.SheetNames
    if (!sourceSheetNames.length) throw new Error('Workbook XLSX tidak memiliki sheet. Tambahkan sheet dengan header, lalu unggah kembali.')
    selectedSheet = sourceSheetNames[0]
    parsedRows = parseXlsxSheet(selectedSheet)
  } else {
    let sourceText: string
    try { sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceDecoded.buffer) } catch {
      throw new Error(`File ${sourceFile.name} bukan UTF-8 yang valid. Simpan ulang file sebagai UTF-8, lalu unggah kembali.`)
    }
    bom = sourceText.charCodeAt(0) === 0xfeff
    const csvText = bom ? sourceText.slice(1) : sourceText
    delimiter = detectCsvDelimiter(csvText)
    const parsedCsv = Papa.parse<string[]>(csvText, { delimiter, header: false, dynamicTyping: false, skipEmptyLines: false, quoteChar: '"', escapeChar: '"' })
    if (parsedCsv.errors.length) {
      const error = parsedCsv.errors[0]
      throw new Error(`CSV tidak dapat dibaca di baris ${typeof error.row === 'number' ? error.row + 1 : '?'}: ${error.message}`)
    }
    parsedRows = parsedCsv.data
    if (parsedRows.length < 1 || !parsedRows[0]?.some(value => value.trim())) throw new Error('CSV harus berisi header.')
    const width = parsedRows[0].length
    if (parsedRows.some(row => row.length !== width && row.some(value => value !== ''))) {
      const bad = parsedRows.findIndex(row => row.length !== width && row.some(value => value !== ''))
      throw new Error(`Jumlah kolom tidak sesuai di record ${bad + 1}. Periksa pemisah dan kutipan pada baris tersebut.`)
    }
    if (parsedRows.length - 1 > 20_000) throw new Error('CSV melebihi batas 20.000 record. Gunakan file yang lebih kecil.')
    linebreak = parsedCsv.meta.linebreak || (csvText.includes('\r\n') ? '\r\n' : '\n')
    trailingNewline = /(?:\r\n|\n|\r)$/.test(csvText)
  }
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
  if (parsedRows.length - 1 > 20_000) throw new Error(`${sourceFormat.toUpperCase()} melebihi batas 20.000 record. Pilih sheet yang lebih kecil atau gunakan file yang lebih kecil.`)
  const fields = [...new Set(masterRecords.flatMap(item => Object.keys(item)))].sort()
  const jsonNameGuess = fields.find(field => field.toLowerCase() === 'nama_barang') ?? fields.find(field => /nama.*barang|product.*name/i.test(field)) ?? ''
  csvInfo = {
    format: sourceFormat, fileName: sourceFile.name, bytes: sourceDecoded.bytes, rows: parsedRows.length - 1, columns: parsedRows[0].length, headers: [...parsedRows[0]], delimiter,
    linebreak, bom, trailingNewline, preview: parsedRows.slice(0, 5), warnings: [], sheetNames: sourceSheetNames, selectedSheet,
  }
  const invalidNames = masterRecords.reduce((count, record) => count + (typeof record[jsonNameGuess] !== 'string' || !(record[jsonNameGuess] as string).trim() ? 1 : 0), 0)
  jsonInfo = { fileName: jsonFile.name, bytes: jsonDecoded.bytes, records: masterRecords.length, fields, invalidNames, preview: masterRecords.slice(0, 3) }
  sourceRows = parsedRows
  matchRows = []
  matchComplete = false
  const headers = [...parsedRows[0]]
  const targetGuess = headers.findIndex(field => /items name|nama barang|nama produk/i.test(field))
  const brandGuess = headers.findIndex(field => field.trim().toLowerCase() === 'category')
  const variantGuess = headers.findIndex(field => /variant name|varian/i.test(field))
  const idGuess = headers.findIndex(field => /sku|internal id|item id/i.test(field))
  post('files-loaded', { csv: csvInfo, json: jsonInfo, guesses: { targetIndex: targetGuess, brandIndex: brandGuess >= 0 ? brandGuess : null, variantIndex: variantGuess >= 0 ? variantGuess : null, identifierIndex: idGuess >= 0 ? idGuess : null, jsonNameField: jsonNameGuess } })
}

function selectSourceSheet(sheetName: string) {
  if (sourceFormat !== 'xlsx' || !sourceWorkbook || !sourceSheetNames.includes(sheetName)) return
  selectedSheet = sheetName
  sourceRows = parseXlsxSheet(sheetName)
  if (!csvInfo || !jsonInfo) return
  matchRows = []
  matchComplete = false
  mappings = null
  csvInfo = { ...csvInfo, selectedSheet, rows: sourceRows.length - 1, columns: sourceRows[0].length, headers: [...sourceRows[0]], preview: sourceRows.slice(0, 5) }
  const targetGuess = sourceRows[0].findIndex(field => /items name|nama barang|nama produk/i.test(field))
  const brandGuess = sourceRows[0].findIndex(field => field.trim().toLowerCase() === 'category')
  const variantGuess = sourceRows[0].findIndex(field => /variant name|varian/i.test(field))
  const idGuess = sourceRows[0].findIndex(field => /sku|internal id|item id/i.test(field))
  const jsonNameGuess = jsonInfo.fields.find(field => field.toLowerCase() === 'nama_barang') ?? jsonInfo.fields.find(field => /nama.*barang|product.*name/i.test(field)) ?? ''
  post('files-loaded', { csv: csvInfo, json: jsonInfo, guesses: { targetIndex: targetGuess, brandIndex: brandGuess >= 0 ? brandGuess : null, variantIndex: variantGuess >= 0 ? variantGuess : null, identifierIndex: idGuess >= 0 ? idGuess : null, jsonNameField: jsonNameGuess } })
}

function splitName(value: string): { base: string; variant: string } {
  const name = normalize(value)
  const splitAt = name.indexOf(' - ')
  return splitAt >= 0 ? { base: name.slice(0, splitAt), variant: name.slice(splitAt + 3) } : { base: name, variant: '' }
}

function hasOneWordDifference(leftValue: string, rightValue: string): boolean {
  const left = tokens(leftValue)
  const right = tokens(rightValue)
  if (left.length === right.length) {
    const differences = left.map((token, index) => token === right[index] ? -1 : index).filter(index => index >= 0)
    if (differences.length === 0) return true
    if (differences.length === 1) {
      const index = differences[0]
      return left[index].length >= 4 && right[index].length >= 4 && oneCharacterTypo(left[index], right[index])
    }
    return false
  }
  if (Math.abs(left.length - right.length) !== 1) return false
  const longer = left.length > right.length ? left : right
  const shorter = left.length > right.length ? right : left
  for (let skipped = 0; skipped < longer.length; skipped += 1) {
    if (!/^[A-Z]+$/.test(longer[skipped])) continue
    if (longer.filter((_, index) => index !== skipped).every((token, index) => token === shorter[index])) return true
  }
  return false
}

function sameSpecifications(left: string, right: string): boolean {
  const leftSpecs = [...specs(left)].sort()
  const rightSpecs = [...specs(right)].sort()
  return leftSpecs.length === rightSpecs.length && leftSpecs.every((spec, index) => spec === rightSpecs[index])
}

function isCertainCandidate(brand: string, sourceName: string, variant: string, candidate: Candidate): boolean {
  const sourceBase = [brand, sourceName].filter(Boolean).join(' ')
  const target = splitName(candidate.name)
  const sourceFull = [sourceBase, variant].filter(Boolean).join(' - ')
  return !candidate.specConflict
    && normalize(variant) === normalize(target.variant)
    && sameSpecifications(sourceFull, candidate.name)
    && hasOneWordDifference(sourceBase, target.base)
}

function masterName(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === 'string' ? record[field] as string : ''
}

function candidatesFor(sourceName: string, variant: string, field: string, tokenIndex: Map<string, Set<number>>, brand = ''): Candidate[] {
  const baseName = [brand, sourceName].filter(Boolean).join(' ')
  const full = normalize([baseName, variant].filter(Boolean).join(' - '))
  const exactComposite = variant.trim() ? normalize(`${sourceName} - ${variant}`) : ''
  const queryTokens = [...new Set(tokens(`${baseName} ${variant}`))].sort((a, b) => (tokenIndex.get(a)?.size ?? 0) - (tokenIndex.get(b)?.size ?? 0))
  const pool = new Set<number>()
  // Keep exact full-name + variant matches discoverable even when common-token
  // postings hit the candidate cap or the master name has several separators.
  for (const index of masterExactNameIndex.get(exactComposite) ?? []) pool.add(index)
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
    const exactCompositeMatch = Boolean(exactComposite) && normalize(name) === exactComposite
    let score = exactCompositeMatch ? 100 : similarity(full, name)
    if (variant && !exactCompositeMatch) score = Math.round(similarity(baseName, parts.base) * 0.6 + similarity(variant, parts.variant || name) * 0.4)
    const context = ['kode_varian', 'jenis_varian'].map(key => typeof record[key] === 'string' ? record[key] as string : '').filter(Boolean).join(' ')
    const conflict = !exactCompositeMatch && conflicts(`${baseName} ${variant}`, `${name} ${context}`)
    return { index, name, score, conflict, exactCompositeMatch }
  }).filter(item => item.name).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'id') || a.index - b.index)
  const deduped: Candidate[] = []
  const byName = new Map<string, Candidate>()
  for (const item of scored) {
    const key = normalize(item.name)
    const existing = byName.get(key)
    const reason = item.exactCompositeMatch ? 'Nama barang dan varian CSV cocok persis dengan nama master.' : item.conflict ? 'Periksa perbedaan angka atau spesifikasi.' : item.score >= 90 ? 'Nama sangat mirip; konfirmasi sebelum digunakan.' : 'Kemiripan teks; perlu tinjauan operator.'
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
    const specConflict = !item.exactCompositeMatch && conflicts(`${baseName} ${variant}`, `${item.name} ${context}`)
    const candidate = { id: recordRef(record, item.index), name: item.name, score: item.score, refs: [recordRef(record, item.index)], reason, specConflict }
    byName.set(key, candidate)
    deduped.push(candidate)
  }
  return deduped
}

function mergeCandidates(...candidateLists: Candidate[][]): Candidate[] {
  const merged = new Map<string, Candidate>()
  for (const candidate of candidateLists.flat()) {
    const key = normalize(candidate.name)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...candidate, refs: [...candidate.refs] })
      continue
    }
    existing.refs = [...new Set([...existing.refs, ...candidate.refs])]
    existing.specConflict = Boolean(existing.specConflict || candidate.specConflict)
    if (candidate.score > existing.score) {
      existing.score = candidate.score
      existing.id = candidate.id
      existing.reason = candidate.reason
    }
    if (existing.specConflict) existing.reason = 'Periksa perbedaan angka atau spesifikasi.'
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'id'))
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
  if (config.brandIndex != null && (config.brandIndex < 0 || config.brandIndex >= csvInfo.columns)) throw new Error('Mapping kolom merek tidak valid. Pilih kolom merek yang tersedia.')
  if (config.variantIndex === config.targetIndex) throw new Error('Kolom varian harus berbeda dari kolom nama barang.')
  if (config.brandIndex != null && (config.brandIndex === config.targetIndex || config.brandIndex === config.variantIndex)) throw new Error('Kolom merek harus berbeda dari kolom nama barang dan varian.')
  if (!config.jsonNameField) throw new Error('Field nama JSON wajib dipilih.')
  mappings = config
  canceled = false
  matchRows = []
  matchComplete = false
  post('progress', { stage: 'Membangun indeks master…', value: 10 })
  const tokenIndex = new Map<string, Set<number>>()
  const exactNameIndex = new Map<string, Set<number>>()
  masterTokenIndex = tokenIndex
  masterExactNameIndex = exactNameIndex
  masterRecords.forEach((record, index) => {
    if (index % 1000 === 0 && canceled) return
    const name = masterName(record, config.jsonNameField)
    const exactKey = normalize(name)
    if (exactKey) {
      if (!exactNameIndex.has(exactKey)) exactNameIndex.set(exactKey, new Set())
      exactNameIndex.get(exactKey)!.add(index)
    }
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
    const brand = config.brandIndex == null ? '' : cells[config.brandIndex] ?? ''
    const sourceName = cells[config.targetIndex] ?? ''
    const variant = config.variantIndex == null ? '' : cells[config.variantIndex] ?? ''
    const id = `${csvInfo.fileName}:${index + 2}`
    const identifier = config.identifierIndex == null ? '' : cells[config.identifierIndex] ?? ''
    if (!sourceName.trim()) {
      matchRows.push({ id, sourceIndex: index, brand, sourceName, variant, identifier, status: 'unmatched', reason: 'Nama CSV kosong; baris dipertahankan.', candidates: [], decision: 'pending', finalName: sourceName })
    } else {
      const primary = candidatesFor(sourceName, variant, config.jsonNameField, tokenIndex)
      const brandAware = brand.trim() ? candidatesFor(sourceName, variant, config.jsonNameField, tokenIndex, brand.trim()) : []
      const merged = mergeCandidates(primary, brandAware)
      const exactComposite = variant.trim() ? normalize(`${sourceName} - ${variant}`) : ''
      const exactCandidate = merged.find(candidate => exactComposite && normalize(candidate.name) === exactComposite)
      if (exactCandidate) {
        exactCandidate.score = 100
        exactCandidate.specConflict = false
        exactCandidate.reason = 'Nama barang dan varian CSV cocok persis dengan nama master.'
      }
      const certainCandidates = merged.filter(candidate => isCertainCandidate(brand.trim(), sourceName, variant, candidate))
      // A unique perfect displayed score is decisive, even if metadata flags a
      // specification conflict. Distinct names tied at 100% remain ambiguous.
      const perfectCandidates = merged.filter(candidate => candidate.score === 100)
      const selectedCandidate = perfectCandidates.length === 1
        ? perfectCandidates[0]
        : perfectCandidates.length > 1
          ? undefined
          : certainCandidates.length === 1 ? certainCandidates[0] : undefined
      const automatic = Boolean(selectedCandidate)
      const recommended = merged.filter(candidate => candidate.score >= 80 || certainCandidates.includes(candidate))
      const found = selectedCandidate
        ? [selectedCandidate, ...recommended.filter(candidate => normalize(candidate.name) !== normalize(selectedCandidate.name))].slice(0, 3)
        : recommended.slice(0, 3)
      const reason = automatic
        ? exactComposite && normalize(selectedCandidate!.name) === exactComposite
          ? 'Nama barang dan varian CSV cocok persis dengan nama master; dipilih otomatis.'
          : perfectCandidates.length === 1
          ? 'Satu nama master unik mendapat skor 100% dan dipilih otomatis.'
          : 'Varian dan spesifikasi cocok; satu nama master dengan perbedaan maksimal satu kata dipilih otomatis.'
        : found.length ? perfectCandidates.length > 1
          ? 'Beberapa nama master berbeda mendapat skor 100%. Pilih kandidat secara manual.'
          : certainCandidates.length > 1 ? 'Beberapa nama master memiliki varian dan spesifikasi yang cocok. Pilih kandidat secara manual.' : found[0].reason
          : 'Kandidat tidak ditemukan. Cari nama di seluruh master.'
      matchRows.push({ id, sourceIndex: index, brand, sourceName, variant, identifier, status: automatic ? 'certain' : found.length ? 'review' : 'unmatched', reason, candidates: found, decision: automatic ? 'use-json' : 'pending', chosenId: selectedCandidate?.id, finalName: selectedCandidate?.name ?? sourceName })
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
    decided: matchRows.filter(row => row.decision !== 'pending' || Boolean(row.unmatchedOverride)).length,
    changed: matchRows.filter(row => row.decision === 'use-json' && row.finalName !== row.sourceName).length,
    same: matchRows.filter(row => row.decision === 'use-json' && row.finalName === row.sourceName).length,
    kept: matchRows.filter(row => row.decision !== 'use-json').length,
  }
}

function searchMaster(query: string, rowId: string) {
  if (!mappings || !query.trim()) { post('search-results', { rowId, results: [] }); return }
  const row = matchRows.find(item => item.id === rowId)
  if (row?.unmatchedOverride) { post('search-results', { rowId, results: [] }); return }
  const normalizedQuery = normalize(query)
  const usedNames = new Set(matchRows
    .filter(row => row.id !== rowId && row.decision === 'use-json')
    .map(row => normalize(row.finalName)))
  const grouped = new Map<string, Candidate>()
  masterRecords.map((record, index) => ({ record, index, name: masterName(record, mappings!.jsonNameField) }))
    .filter(item => item.name && normalize(item.name).includes(normalizedQuery) && !usedNames.has(normalize(item.name)))
    .map(item => ({ ...item, score: similarity(query, item.name) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'id'))
    .forEach(item => {
      const nameKey = normalize(item.name)
      const reference = recordRef(item.record, item.index)
      const existing = grouped.get(nameKey)
      if (existing) {
        if (!existing.refs.includes(reference)) existing.refs.push(reference)
      } else {
        grouped.set(nameKey, { id: reference, name: item.name, refs: [reference], score: item.score, reason: 'Dipilih dari pencarian seluruh master.' })
      }
    })
  const found = [...grouped.values()].slice(0, 30).map(candidate => {
    const existing = row?.candidates.find(item => normalize(item.name) === normalize(candidate.name))
    return existing
      ? { ...candidate, id: existing.id, refs: [...new Set([...existing.refs, ...candidate.refs])] }
      : candidate
  })
  if (row) {
    for (const candidate of found) {
      const existing = row.candidates.find(item => item.id === candidate.id)
      if (existing) existing.refs = [...new Set([...existing.refs, ...candidate.refs])]
      else row.candidates.push(candidate)
    }
  }
  post('search-results', { rowId, results: found })
}

function updateRecommendations(rowId: string) {
  if (!mappings) return
  const row = matchRows.find(item => item.id === rowId)
  if (!row) return
  if (row.unmatchedOverride) return
  const merged = mergeCandidates(
    candidatesFor(row.sourceName, row.variant, mappings.jsonNameField, masterTokenIndex),
    row.brand.trim() ? candidatesFor(row.sourceName, row.variant, mappings.jsonNameField, masterTokenIndex, row.brand.trim()) : [],
  )
  const exactComposite = row.variant.trim() ? normalize(`${row.sourceName} - ${row.variant}`) : ''
  const exactCandidate = merged.find(candidate => exactComposite && normalize(candidate.name) === exactComposite)
  if (exactCandidate) {
    exactCandidate.score = 100
    exactCandidate.specConflict = false
    exactCandidate.reason = 'Nama barang dan varian CSV cocok persis dengan nama master.'
  }
  const certainCandidates = merged.filter(candidate => isCertainCandidate(row.brand.trim(), row.sourceName, row.variant, candidate))
  const eligible = merged.filter(candidate => candidate.score >= 80 || certainCandidates.includes(candidate))
  const usedNames = new Set(matchRows
    .filter(other => other.id !== row.id && other.decision === 'use-json')
    .map(other => normalize(other.finalName)))
  const available = eligible.filter(candidate => !usedNames.has(normalize(candidate.name)))
  const hiddenCount = eligible.filter(candidate => usedNames.has(normalize(candidate.name))
    && !(row.decision === 'use-json' && normalize(candidate.name) === normalize(row.finalName))).length
  const selectedCandidate = row.decision === 'use-json'
    ? row.candidates.find(candidate => candidate.id === row.chosenId)
      ?? merged.find(candidate => normalize(candidate.name) === normalize(row.finalName))
    : undefined
  const suggestions = selectedCandidate
    ? [selectedCandidate, ...available.filter(candidate => normalize(candidate.name) !== normalize(selectedCandidate.name))].slice(0, 3)
    : available.slice(0, 3)
  row.candidates = suggestions
  post('recommendations-updated', { rowId, candidates: suggestions, hiddenCount })
}

function decide(rowId: string, decision: Decision, candidateId?: string) {
  const row = matchRows.find(item => item.id === rowId)
  if (!row || row.unmatchedOverride) return
  if (decision === 'use-json') {
    const candidate = row.candidates.find(item => item.id === candidateId)
    if (!candidate) return
    if (!row.manualConfirmation) {
      row.manualConfirmation = { status: row.status, reason: row.reason }
    }
    row.status = 'certain'
    row.reason = 'Kandidat master dipilih dan dikonfirmasi oleh operator.'
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
    if (row.manualConfirmation) {
      row.status = row.manualConfirmation.status
      row.reason = row.manualConfirmation.reason
      row.manualConfirmation = undefined
    }
  }
  post('decision-updated', { row, summary: summarize() })
}

function markUnmatched(rowId: string) {
  const row = matchRows.find(item => item.id === rowId)
  if (!row || row.status !== 'certain' || row.unmatchedOverride) return
  row.unmatchedOverride = {
    status: row.status,
    reason: row.reason,
    decision: row.decision,
    chosenId: row.chosenId,
    finalName: row.finalName,
  }
  row.status = 'unmatched'
  row.reason = 'Ditandai belum cocok oleh operator; baris dikecualikan dari ekspor utama.'
  row.decision = 'pending'
  row.chosenId = undefined
  row.finalName = row.sourceName
  post('decision-updated', { row, summary: summarize() })
}

function restoreMatch(rowId: string) {
  const row = matchRows.find(item => item.id === rowId)
  const previous = row?.unmatchedOverride
  if (!row || !previous) return
  const masterAlreadyUsed = previous.decision === 'use-json' && matchRows.some(other =>
    other.id !== row.id && other.decision === 'use-json' && normalize(other.finalName) === normalize(previous.finalName),
  )
  if (masterAlreadyUsed) return
  row.status = previous.status
  row.reason = previous.reason
  row.decision = previous.decision
  row.chosenId = previous.chosenId
  row.finalName = previous.finalName
  row.unmatchedOverride = undefined
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
  const includedRows = matchRows.filter(row => row.status === 'certain').sort((a, b) => a.sourceIndex - b.sourceIndex)
  const outputRows = [
    [...sourceRows[0]],
    ...includedRows.map(result => {
      const row = [...sourceRows[result.sourceIndex + 1]]
      if (result.decision === 'use-json') row[mappings!.targetIndex] = result.finalName
      return row
    }),
  ]
  let mainContent: string | Blob
  let fileName: string
  if (csvInfo.format === 'xlsx') {
    if (!csvInfo.selectedSheet) throw new Error('Sheet XLSX yang dipilih tidak tersedia. Pilih kembali sheet sumber sebelum ekspor.')
    const reparsed = outputRows.map(row => [...row])
    if (reparsed.length !== includedRows.length + 1 || reparsed.some(row => row.length !== sourceRows[0].length)) throw new Error('Validasi ekspor gagal: struktur XLSX berubah. Tidak ada file yang diunduh.')
    reparsed.forEach((row, rowIndex) => {
      const sourceRow = rowIndex === 0 ? sourceRows[0] : sourceRows[includedRows[rowIndex - 1].sourceIndex + 1]
      for (let column = 0; column < row.length; column += 1) {
        const expected = column === mappings!.targetIndex && rowIndex > 0 && includedRows[rowIndex - 1].decision === 'use-json' ? includedRows[rowIndex - 1].finalName : sourceRow[column]
        if (row[column] !== expected) throw new Error(`Validasi ekspor gagal pada record terpilih ${rowIndex + 1}, kolom ${column + 1}. Tidak ada file yang diunduh.`)
      }
    })
    const workbook = XLSX.utils.book_new()
    const worksheet = XLSX.utils.aoa_to_sheet(outputRows)
    XLSX.utils.book_append_sheet(workbook, worksheet, csvInfo.selectedSheet)
    const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
    const verifiedWorkbook = XLSX.read(bytes, { type: 'array', cellDates: false })
    const verifiedSheet = verifiedWorkbook.Sheets[csvInfo.selectedSheet]
    if (!verifiedSheet) throw new Error('Validasi ekspor gagal: sheet hasil tidak ditemukan. Tidak ada file yang diunduh.')
    const verifiedRows = XLSX.utils.sheet_to_json<unknown[]>(verifiedSheet, { header: 1, raw: false, defval: '', blankrows: true })
    if (verifiedRows.length !== outputRows.length) throw new Error('Validasi ekspor gagal: jumlah baris XLSX berubah. Tidak ada file yang diunduh.')
    for (let rowIndex = 0; rowIndex < outputRows.length; rowIndex += 1) {
      if (verifiedRows[rowIndex].length !== outputRows[rowIndex].length) throw new Error(`Validasi ekspor gagal pada record XLSX ${rowIndex + 1}: jumlah kolom berubah.`)
      for (let column = 0; column < outputRows[rowIndex].length; column += 1) {
        const value = verifiedRows[rowIndex][column] == null ? '' : String(verifiedRows[rowIndex][column])
        if (value !== outputRows[rowIndex][column]) throw new Error(`Validasi ekspor gagal pada record XLSX ${rowIndex + 1}, kolom ${column + 1}. Tidak ada file yang diunduh.`)
      }
    }
    const copy = new Uint8Array(bytes)
    mainContent = new Blob([copy.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    fileName = `${csvInfo.fileName.replace(/\.xlsx$/i, '')}_cocok_pasti.xlsx`
  } else {
    const outputTextNoBom = serialize(outputRows, csvInfo.delimiter, csvInfo.linebreak, csvInfo.trailingNewline)
    const reparsed = Papa.parse<string[]>(outputTextNoBom, { delimiter: csvInfo.delimiter, header: false, dynamicTyping: false, skipEmptyLines: false })
    const validatedRows = [...reparsed.data]
    if (csvInfo.trailingNewline && validatedRows.at(-1)?.every(value => value === '')) validatedRows.pop()
    if (reparsed.errors.length || validatedRows.length !== outputRows.length) throw new Error('Validasi ekspor gagal: jumlah record berubah. Tidak ada file yang diunduh.')
    for (let r = 0; r < outputRows.length; r += 1) {
      if (validatedRows[r].length !== outputRows[r].length) throw new Error(`Validasi ekspor gagal pada record ${r + 1}: jumlah kolom berubah.`)
      for (let c = 0; c < outputRows[r].length; c += 1) {
        if (validatedRows[r][c] !== outputRows[r][c]) throw new Error(`Validasi ekspor gagal pada record ${r + 1}, kolom ${c + 1}. Tidak ada file yang diunduh.`)
      }
    }
    mainContent = (csvInfo.bom ? '\uFEFF' : '') + outputTextNoBom
    fileName = `${csvInfo.fileName.replace(/\.csv$/i, '')}_cocok_pasti.csv`
  }
  const reviewUnmatchedRows = matchRows
    .filter(row => row.status === 'review' || row.status === 'unmatched')
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
  let reviewUnmatchedContent: string | Blob | null = null
  let reviewUnmatchedName: string
  const reviewUnmatchedMime = csvInfo.format === 'xlsx'
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv;charset=utf-8'
  if (csvInfo.format === 'xlsx') {
    reviewUnmatchedName = `${csvInfo.fileName.replace(/\.xlsx$/i, '')}_perlu_tinjau_belum_cocok.xlsx`
    if (reviewUnmatchedRows.length > 0) {
      if (!csvInfo.selectedSheet) throw new Error('Sheet XLSX yang dipilih tidak tersedia. Pilih kembali sheet sumber sebelum ekspor.')
      const reviewRows = [
        [...sourceRows[0]],
        ...reviewUnmatchedRows.map(result => [...sourceRows[result.sourceIndex + 1]]),
      ]
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(reviewRows), csvInfo.selectedSheet)
      const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
      const verifiedWorkbook = XLSX.read(bytes, { type: 'array', cellDates: false })
      const verifiedSheet = verifiedWorkbook.Sheets[csvInfo.selectedSheet]
      if (!verifiedSheet) throw new Error('Validasi ekspor tinjau gagal: sheet hasil tidak ditemukan. Tidak ada file yang diunduh.')
      const verifiedRows = XLSX.utils.sheet_to_json<unknown[]>(verifiedSheet, { header: 1, raw: false, defval: '', blankrows: true })
      if (verifiedRows.length !== reviewRows.length) throw new Error('Validasi ekspor tinjau gagal: jumlah baris XLSX berubah. Tidak ada file yang diunduh.')
      for (let rowIndex = 0; rowIndex < reviewRows.length; rowIndex += 1) {
        if (verifiedRows[rowIndex].length !== reviewRows[rowIndex].length) throw new Error(`Validasi ekspor tinjau gagal pada record XLSX ${rowIndex + 1}: jumlah kolom berubah.`)
        for (let column = 0; column < reviewRows[rowIndex].length; column += 1) {
          const value = verifiedRows[rowIndex][column] == null ? '' : String(verifiedRows[rowIndex][column])
          if (value !== reviewRows[rowIndex][column]) throw new Error(`Validasi ekspor tinjau gagal pada record XLSX ${rowIndex + 1}, kolom ${column + 1}. Tidak ada file yang diunduh.`)
        }
      }
      reviewUnmatchedContent = new Blob([new Uint8Array(bytes).buffer], { type: reviewUnmatchedMime })
    }
  } else {
    reviewUnmatchedName = `${csvInfo.fileName.replace(/\.csv$/i, '')}_perlu_tinjau_belum_cocok.csv`
    if (reviewUnmatchedRows.length > 0) {
      const reviewRows = [
        [...sourceRows[0]],
        ...reviewUnmatchedRows.map(result => [...sourceRows[result.sourceIndex + 1]]),
      ]
      const reviewTextNoBom = serialize(reviewRows, csvInfo.delimiter, csvInfo.linebreak, csvInfo.trailingNewline)
      const reparsed = Papa.parse<string[]>(reviewTextNoBom, { delimiter: csvInfo.delimiter, header: false, dynamicTyping: false, skipEmptyLines: false })
      const verifiedRows = [...reparsed.data]
      if (csvInfo.trailingNewline && verifiedRows.at(-1)?.every(value => value === '')) verifiedRows.pop()
      if (reparsed.errors.length || verifiedRows.length !== reviewRows.length) throw new Error('Validasi ekspor tinjau gagal: jumlah record berubah. Tidak ada file yang diunduh.')
      for (let rowIndex = 0; rowIndex < reviewRows.length; rowIndex += 1) {
        if (verifiedRows[rowIndex].length !== reviewRows[rowIndex].length) throw new Error(`Validasi ekspor tinjau gagal pada record ${rowIndex + 1}: jumlah kolom berubah.`)
        for (let column = 0; column < reviewRows[rowIndex].length; column += 1) {
          if (verifiedRows[rowIndex][column] !== reviewRows[rowIndex][column]) throw new Error(`Validasi ekspor tinjau gagal pada record ${rowIndex + 1}, kolom ${column + 1}. Tidak ada file yang diunduh.`)
        }
      }
      reviewUnmatchedContent = (csvInfo.bom ? '\uFEFF' : '') + reviewTextNoBom
    }
  }
  const reportHeaders = ['Nomor record sumber', 'ID atau SKU', 'Merek CSV', 'Nama CSV', 'Varian CSV', 'Referensi JSON', 'Kandidat', 'Skor', 'Metode', 'Alasan', 'Keputusan', 'Nama akhir']
  const report = [reportHeaders, ...matchRows.map(row => {
    const reportCandidate = row.candidates.find(c => c.id === row.chosenId) ?? row.candidates[0]
    return [String(row.sourceIndex + 2), row.identifier, row.brand, row.sourceName, row.variant, reportCandidate?.refs.join('; ') ?? '', reportCandidate?.name ?? '', String(reportCandidate?.score ?? ''), row.manualConfirmation && row.status === 'certain' ? 'Dikonfirmasi operator' : row.status === 'certain' ? 'Cocok pasti (varian/spec cocok)' : row.status === 'review' ? 'Fuzzy / tinjauan' : 'Tidak cocok', row.reason, row.unmatchedOverride ? 'Ditandai belum cocok oleh operator' : row.decision === 'use-json' ? 'Gunakan JSON' : row.decision === 'keep-csv' ? 'Pertahankan CSV' : 'Belum dipilih', row.finalName]
  })]
  const reportText = serialize(report, ',', '\r\n', false)
  const exportSummary = {
    included: includedRows.length,
    changed: includedRows.filter(row => row.decision === 'use-json' && row.finalName !== row.sourceName).length,
    same: includedRows.filter(row => row.decision === 'use-json' && row.finalName === row.sourceName).length,
    kept: includedRows.filter(row => row.decision !== 'use-json').length,
    excluded: matchRows.length - includedRows.length,
  }
  const reportName = `${csvInfo.fileName.replace(/\.(csv|xlsx)$/i, '')}_laporan_pencocokan.csv`
  post('export-ready', { mainContent, mainMime: csvInfo.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv;charset=utf-8', fileName, reviewUnmatchedContent, reviewUnmatchedMime, reviewUnmatchedName, reviewUnmatchedCount: reviewUnmatchedRows.length, report: reportText, reportName, summary: summarize(), exportSummary })
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  try {
    if (message.type === 'load-files') await loadFiles(message.source, message.json)
    if (message.type === 'select-sheet') selectSourceSheet(message.sheetName)
    if (message.type === 'match') await runMatch({ targetIndex: message.targetIndex, brandIndex: message.brandIndex, variantIndex: message.variantIndex, jsonNameField: message.jsonNameField, identifierIndex: message.identifierIndex })
    if (message.type === 'search') searchMaster(message.query, message.rowId)
    if (message.type === 'recommendations') updateRecommendations(message.rowId)
    if (message.type === 'decide') decide(message.rowId, message.decision, message.candidateId)
    if (message.type === 'mark-unmatched') markUnmatched(message.rowId)
    if (message.type === 'restore-match') restoreMatch(message.rowId)
    if (message.type === 'export') exportFiles()
    if (message.type === 'cancel') { canceled = true; matchComplete = false; post('canceled') }
    if (message.type === 'reset') { sourceRows = []; masterRecords = []; masterTokenIndex = new Map(); masterExactNameIndex = new Map(); sourceWorkbook = null; sourceSheetNames = []; selectedSheet = ''; csvInfo = null; jsonInfo = null; matchRows = []; mappings = null; matchComplete = false; canceled = true; post('reset') }
  } catch (error) {
    post('error', { message: error instanceof Error ? error.message : 'Terjadi kesalahan saat memproses file.' })
  }
}

import Papa from 'papaparse'
