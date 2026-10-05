import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candidate, CsvInfo, Decision, JsonInfo, MatchRow } from './engine'

type Step = 0 | 1 | 2 | 3
type WorkerMessage = { type: string; payload?: any }
const steps = ['File', 'Mapping', 'Hasil pencocokan', 'Preview ekspor']
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths: Record<string, React.ReactNode> = {
    box: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 17v4h16v-4"/></>,
    x: <path d="m18 6-12 12M6 6l12 12"/>,
    filter: <><path d="M4 7h16M7 12h10m-7 5h4"/><circle cx="8" cy="7" r="1" fill="currentColor"/><circle cx="16" cy="12" r="1" fill="currentColor"/></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></>,
    rotate: <><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/></>,
  }
  return <svg {...common}>{paths[name] ?? paths.file}</svg>
}

export default function App() {
  const workerRef = useRef<Worker | null>(null)
  const selectedIdRef = useRef('')
  const csvInput = useRef<HTMLInputElement>(null)
  const jsonInput = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>(0)
  const [csvFile, setCsvFile] = useState<File | null>(null)
  const [jsonFile, setJsonFile] = useState<File | null>(null)
  const [csv, setCsv] = useState<CsvInfo | null>(null)
  const [json, setJson] = useState<JsonInfo | null>(null)
  const [mapping, setMapping] = useState({ targetIndex: -1, variantIndex: null as number | null, identifierIndex: null as number | null, jsonNameField: '' })
  const [rows, setRows] = useState<MatchRow[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [progress, setProgress] = useState<{ stage: string; value: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('source')
  const [selectedId, setSelectedId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Candidate[]>([])
  const [exportData, setExportData] = useState<{ csv: string; report: string; fileName: string; reportName: string } | null>(null)
  const [dragging, setDragging] = useState<'csv' | 'json' | null>(null)

  selectedIdRef.current = selectedId

  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { type, payload } = event.data
      if (type === 'progress') { setProgress(payload); setBusy(true) }
      if (type === 'files-loaded') {
        setCsv(payload.csv); setJson(payload.json); setMapping(payload.guesses); setBusy(false); setProgress(null); setError('')
      }
      if (type === 'matched') { setRows(payload.rows); setSummary(payload.summary); setBusy(false); setProgress(null); setStep(2); setSelectedId(payload.rows.find((row: MatchRow) => row.status !== 'certain')?.id ?? payload.rows[0]?.id ?? '') }
      if (type === 'decision-updated') { setRows(current => current.map(row => row.id === payload.row.id ? payload.row : row)); setSummary(payload.summary) }
      if (type === 'search-results') { if (payload.rowId === selectedIdRef.current) setSearchResults(payload.results) }
      if (type === 'export-ready') { setExportData(payload); setSummary(payload.summary); setBusy(false); setProgress(null); setStep(3) }
      if (type === 'canceled') { setBusy(false); setProgress(null); setError('Proses dibatalkan. Tidak ada file parsial yang dibuat.') }
      if (type === 'error') { setBusy(false); setProgress(null); setError(payload.message) }
      if (type === 'reset') { setBusy(false); setProgress(null) }
    }
    worker.onerror = () => { setBusy(false); setProgress(null); setError('Worker pemrosesan gagal. Coba file yang lebih kecil.') }
    return () => worker.terminate()
  }, [])

  const selected = rows.find(row => row.id === selectedId) ?? null
  const visibleRows = useMemo(() => {
    let result = rows.filter(row => {
      const text = `${row.sourceName} ${row.variant} ${row.identifier} ${row.candidates.map(c => c.name).join(' ')}`.toLocaleLowerCase('id-ID')
      const matchesQuery = !query || text.includes(query.toLocaleLowerCase('id-ID'))
      const matchesFilter = filter === 'all' || filter === 'review' && row.status === 'review' || filter === 'unmatched' && row.status === 'unmatched' || filter === 'certain' && row.status === 'certain' || filter === 'pending' && row.decision === 'pending'
      return matchesQuery && matchesFilter
    })
    if (sort === 'score') result = [...result].sort((a, b) => (b.candidates[0]?.score ?? 0) - (a.candidates[0]?.score ?? 0))
    if (sort === 'name') result = [...result].sort((a, b) => a.sourceName.localeCompare(b.sourceName, 'id'))
    if (sort === 'status') result = [...result].sort((a, b) => a.status.localeCompare(b.status))
    return result
  }, [rows, query, filter, sort])

  function addFile(kind: 'csv' | 'json', file: File | null) {
    if (!file) return
    setError(''); setExportData(null); setRows([]); setCsv(null); setJson(null); setStep(0)
    if (kind === 'csv') setCsvFile(file)
    else setJsonFile(file)
  }

  function processFiles() {
    if (!csvFile || !jsonFile) { setError('Pilih satu file CSV dan satu file JSON terlebih dahulu.'); return }
    setBusy(true); setError(''); setProgress({ stage: 'Menyiapkan file…', value: 2 })
    workerRef.current?.postMessage({ type: 'load-files', csv: csvFile, json: jsonFile })
  }

  function runMatching() {
    if (!csv || !json) return
    setBusy(true); setError(''); setRows([]); setSummary({}); setSelectedId(''); setExportData(null); setProgress({ stage: 'Menyiapkan pencocokan…', value: 2 })
    workerRef.current?.postMessage({ type: 'match', ...mapping })
  }

  function cancel() { workerRef.current?.postMessage({ type: 'cancel' }) }
  function choose(rowId: string, decision: Decision, candidateId?: string) { workerRef.current?.postMessage({ type: 'decide', rowId, decision, candidateId }) }
  function searchMaster(value: string) {
    setSearchQuery(value)
    workerRef.current?.postMessage({ type: 'search', query: value, rowId: selectedId })
  }
  function prepareExport() {
    setBusy(true); setError(''); setProgress({ stage: 'Memvalidasi seluruh isi ekspor…', value: 30 })
    workerRef.current?.postMessage({ type: 'export' })
  }
  function download(name: string, content: string) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
  }
  function resetSession() {
    workerRef.current?.postMessage({ type: 'reset' })
    setCsvFile(null); setJsonFile(null); setCsv(null); setJson(null); setRows([]); setSummary({}); setExportData(null); setStep(0); setError(''); setQuery(''); setSelectedId('')
  }
  function changeStep(target: Step) {
    if (target === 0 || target === 1 && csv && json || target === 2 && rows.length || target === 3 && exportData) setStep(target)
  }
  function dropHandler(kind: 'csv' | 'json', event: React.DragEvent) {
    event.preventDefault(); setDragging(null)
    const file = event.dataTransfer.files[0]
    if (file) addFile(kind, file)
  }

  const progressLabel = progress?.stage ?? 'Sedang memproses…'
  const percent = progress?.value ?? 0
  const progressText = busy ? <div className="progress-strip"><div className="progress-heading"><span className="spinner" />{progressLabel}<button className="text-button" onClick={cancel}>Batalkan</button></div><div className="progress-track"><span style={{ width: `${percent}%` }} /></div></div> : null

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="box" size={21} /></div><div><strong>CSV Matcher</strong><span>CATALOG WORKSPACE</span></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <button className="workspace-switch"><span className="workspace-avatar">A</span><span><b>Abivape</b><small>Katalog produk</small></span><span className="chevron">⌄</span></button>
      <div className="side-section-title">MENU UTAMA</div>
      <button className="side-link active"><Icon name="grid" /><span>Pencocokan baru</span><span className="nav-dot" /></button>
      <button className="side-link" onClick={() => rows.length && setStep(2)}><Icon name="file" /><span>Hasil pencocokan</span>{rows.length > 0 && <span className="side-count">{rows.length.toLocaleString('id-ID')}</span>}</button>
      <div className="side-section-title side-lower">PREFERENSI</div>
      <div className="privacy-note"><div className="privacy-icon"><Icon name="shield" size={17} /></div><div><b>Data tetap privat</b><p>Semua file diproses di perangkat ini. Tidak ada data yang diunggah.</p></div></div>
      <div className="sidebar-bottom"><div className="avatar">OP</div><div><b>Operator</b><small>Sesi lokal</small></div><button className="more-button" aria-label="Opsi akun">•••</button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span className="crumb-sep">/</span><b>Pencocokan nama barang</b></div><div className="top-actions"><span className="local-status"><i /> Lokal dan aman</span><span className="top-divider" /><button className="help-button" aria-label="Bantuan">?</button></div></header>
      <div className="page-content">
        <div className="page-heading"><div><div className="eyebrow">KATALOG PRODUK <span>•</span> WORKSPACE ABIVAPE</div><h1>Pencocokan nama barang</h1><p>Cocokkan nama dari CSV dengan master katalog. Tinjau setiap perubahan sebelum ekspor.</p></div><button className="button button-quiet" onClick={resetSession}><Icon name="rotate" size={16} /> Proses baru</button></div>
        <section className="stepper" aria-label="Tahapan pencocokan">{steps.map((label, index) => <button key={label} className={`step-item ${step === index ? 'current' : ''} ${step > index ? 'complete' : ''}`} onClick={() => changeStep(index as Step)}><span className="step-number">{step > index ? <Icon name="check" size={14} /> : `0${index + 1}`}</span><span>{label}</span>{index < steps.length - 1 && <span className="step-line" />}</button>)}</section>
        {error && <div className="error-banner" role="alert"><span className="error-mark">!</span><span>{error}</span><button aria-label="Tutup pesan" onClick={() => setError('')}><Icon name="x" size={16} /></button></div>}
        {progressText}

        {step === 0 && <section className="step-panel">
          <div className="section-title-row"><div><span className="section-kicker">LANGKAH 01</span><h2>Tambahkan file sumber</h2><p>Pilih CSV yang ingin diperbarui dan JSON sebagai referensi nama produk.</p></div><div className="format-pills"><span>.CSV</span><span>.JSON</span></div></div>
          <div className="upload-grid">
            <UploadCard kind="csv" title="File CSV sumber" description="CSV ekspor katalog yang akan menjadi template keluaran." file={csvFile} onPick={() => csvInput.current?.click()} onDrop={dropHandler} dragging={dragging} setDragging={setDragging} />
            <UploadCard kind="json" title="Master barang JSON" description="Array objek JSON dengan field nama barang sebagai referensi." file={jsonFile} onPick={() => jsonInput.current?.click()} onDrop={dropHandler} dragging={dragging} setDragging={setDragging} />
          </div>
          <input ref={csvInput} hidden type="file" accept=".csv,text/csv" onChange={event => addFile('csv', event.target.files?.[0] ?? null)} />
          <input ref={jsonInput} hidden type="file" accept=".json,application/json" onChange={event => addFile('json', event.target.files?.[0] ?? null)} />
          <div className="privacy-banner"><div className="privacy-icon"><Icon name="shield" size={17} /></div><div><b>Pemrosesan lokal, data tetap di perangkat</b><span>File tidak dikirim atau disimpan ke server. Batas ukuran CSV 10 MB dan JSON 50 MB.</span></div><span className="secure-tag"><i /> PRIVAT</span></div>
          {csv && json && <div className="loaded-preview"><div className="preview-heading"><div><span className="section-kicker">FILE SIAP DIPROSES</span><h3>Periksa ringkasan sumber</h3></div><span className="ready-chip"><Icon name="check" size={13} /> Siap</span></div><div className="source-summary"><SourceSummary icon="file" label="CSV sumber" name={csv.fileName} meta={`${csv.rows.toLocaleString('id-ID')} record · ${csv.columns} kolom · ${formatBytes(csv.bytes)}`} /><SourceSummary icon="box" label="Master JSON" name={json.fileName} meta={`${json.records.toLocaleString('id-ID')} record · ${json.fields.length} field · ${formatBytes(json.bytes)}${json.invalidNames ? ` · ${json.invalidNames} nama kosong/tidak valid diabaikan` : ''}`} /></div><div className="table-preview"><div className="table-preview-head"><b>Contoh data CSV</b><span>5 baris pertama</span></div><div className="table-scroll"><table><thead><tr>{csv.headers.map((header, i) => <th key={i}>{header || `Kolom ${i + 1}`}</th>)}</tr></thead><tbody>{csv.preview.slice(1).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell || <span className="empty-cell">—</span>}</td>)}</tr>)}</tbody></table></div></div></div>}
          <div className="panel-footer"><span className="footer-hint"><Icon name="shield" size={15} /> CSV UTF-8 · JSON array objek</span><button className="button button-primary" disabled={!csvFile || !jsonFile || busy} onClick={csv && json ? () => changeStep(1) : processFiles}>{csv && json ? 'Lanjut ke mapping' : 'Periksa file'}<Icon name="arrow" size={16} /></button></div>
        </section>}

        {step === 1 && csv && json && <section className="step-panel mapping-panel"><div className="section-title-row"><div><span className="section-kicker">LANGKAH 02</span><h2>Konfirmasi mapping kolom</h2><p>Tentukan field yang akan dibandingkan. Nilai varian tetap dipertahankan pada CSV keluaran.</p></div><span className="mapping-status"><Icon name="check" size={14} /> Saran otomatis tersedia</span></div>
          <div className="mapping-layout"><div className="mapping-form"><div className="mapping-card"><div className="mapping-card-head"><span className="mapping-icon coral"><Icon name="file" size={17} /></span><div><b>Kolom CSV</b><small>Sumber nama dan identitas baris</small></div></div><MappingSelect label="Nama barang CSV" value={mapping.targetIndex < 0 ? '' : String(mapping.targetIndex)} required options={csv.headers.map((name, i) => ({ value: String(i), label: `${name || `Kolom ${i + 1}`} · kolom ${i + 1}` }))} onChange={value => setMapping(current => ({ ...current, targetIndex: Number(value) }))} /><MappingSelect label="Nama varian CSV" optional value={mapping.variantIndex == null ? '' : String(mapping.variantIndex)} options={csv.headers.map((name, i) => ({ value: String(i), label: `${name || `Kolom ${i + 1}`} · kolom ${i + 1}` }))} onChange={value => setMapping(current => ({ ...current, variantIndex: value === '' ? null : Number(value) }))} /><MappingSelect label="ID atau SKU untuk laporan" optional value={mapping.identifierIndex == null ? '' : String(mapping.identifierIndex)} options={csv.headers.map((name, i) => ({ value: String(i), label: `${name || `Kolom ${i + 1}`} · kolom ${i + 1}` }))} onChange={value => setMapping(current => ({ ...current, identifierIndex: value === '' ? null : Number(value) }))} /></div>
            <div className="mapping-card"><div className="mapping-card-head"><span className="mapping-icon lavender"><Icon name="box" size={17} /></span><div><b>Master JSON</b><small>Field nama yang menjadi target pencocokan</small></div></div><MappingSelect label="Nama lengkap JSON" required value={mapping.jsonNameField} options={json.fields.map(field => ({ value: field, label: field }))} onChange={value => setMapping(current => ({ ...current, jsonNameField: value }))} /></div>
          </div><aside className="mapping-aside"><div className="aside-label"><Icon name="spark" size={15} /> PREVIEW PEMBANDING</div><div className="mapping-sample"><span className="sample-label">NAMA CSV</span><b>{csv.preview[1]?.[mapping.targetIndex] || 'Pilih kolom nama barang'}</b><span className="sample-plus">+</span><span className="sample-label">VARIAN</span><b>{mapping.variantIndex == null ? 'Tidak digunakan' : csv.preview[1]?.[mapping.variantIndex] || '—'}</b><div className="sample-divider" /><span className="sample-label">NAMA YANG DIBANDINGKAN</span><strong>{[csv.preview[1]?.[mapping.targetIndex], mapping.variantIndex == null ? '' : csv.preview[1]?.[mapping.variantIndex]].filter(Boolean).join(' - ') || 'Nama CSV - Varian'}</strong></div><div className="matching-note"><div className="note-icon"><Icon name="shield" size={15} /></div><p>Normalisasi hanya digunakan untuk membandingkan. Teks asli tetap disimpan untuk ekspor.</p></div><div className="spec-chips"><span>Angka tetap diperiksa</span><span>Model tidak disamakan</span></div></aside></div>
          <div className="panel-footer"><button className="button button-quiet" onClick={() => setStep(0)}>Kembali</button><span className="footer-hint">Bobot awal: nama 60% · varian 40%</span><button className="button button-primary" disabled={busy || mapping.targetIndex < 0 || !mapping.jsonNameField} onClick={runMatching}>Mulai pencocokan<Icon name="arrow" size={16} /></button></div>
        </section>}

        {step === 2 && <section className="results-panel"><div className="results-heading"><div><span className="section-kicker">LANGKAH 03</span><h2>Tinjau hasil pencocokan</h2><p>Pasangan yang meragukan menunggu keputusan Anda. Baris yang belum dipilih tetap memakai nama asli.</p></div><button className="button button-primary" disabled={!rows.length || busy} onClick={prepareExport}>Preview ekspor<Icon name="arrow" size={16} /></button></div>
          <div className="metric-row"><Metric label="Cocok pasti" value={summary.certain ?? 0} tone="green" /><Metric label="Perlu tinjau" value={summary.review ?? 0} tone="amber" /><Metric label="Belum cocok" value={summary.unmatched ?? 0} tone="gray" /><Metric label="Sudah diputuskan" value={summary.decided ?? 0} tone="purple" /></div>
          <div className="result-workspace"><div className="results-list"><div className="results-toolbar"><div className="search-box"><Icon name="search" size={17} /><input aria-label="Cari nama atau SKU" value={query} onChange={event => setQuery(event.target.value)} placeholder="Cari nama barang atau SKU…" /><kbd>⌘ K</kbd></div><div className="toolbar-select"><Icon name="filter" size={16} /><select aria-label="Filter status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Semua status</option><option value="review">Perlu tinjau</option><option value="unmatched">Belum cocok</option><option value="certain">Cocok pasti</option><option value="pending">Belum diputuskan</option></select></div><select className="sort-select" aria-label="Urutkan hasil" value={sort} onChange={event => setSort(event.target.value)}><option value="source">Urutan sumber</option><option value="score">Skor tertinggi</option><option value="name">Nama A–Z</option><option value="status">Status</option></select></div>
            <div className="list-caption"><b>{visibleRows.length.toLocaleString('id-ID')} <span>baris</span></b><span>Urutan ekspor mengikuti CSV sumber</span></div>
            <div className="match-table-wrap"><table className="match-table"><thead><tr><th>BARIS CSV</th><th>KANDIDAT JSON</th><th>SKOR</th><th>STATUS</th><th></th></tr></thead><tbody>{visibleRows.slice(0, 500).map(row => <tr key={row.id} className={selectedId === row.id ? 'selected' : ''} onClick={() => { setSelectedId(row.id); setSearchResults([]); setSearchQuery('') }}><td><b className="source-name">{row.sourceName || <i>Nama kosong</i>}</b><span className="source-meta">{row.identifier || `Record ${row.sourceIndex + 2}`}{row.variant && ` · ${row.variant}`}</span></td><td><b className="candidate-name">{row.finalName !== row.sourceName ? row.finalName : row.candidates[0]?.name ?? '—'}</b><span className="candidate-meta">{row.decision === 'use-json' ? 'Nama akhir dipilih' : row.candidates.length ? row.candidates[0].reason : 'Tidak ada kandidat'}</span></td><td><span className="score-value">{row.candidates[0] ? `${row.candidates[0].score}%` : '—'}</span></td><td><StatusBadge row={row} /></td><td><span className="row-chevron">›</span></td></tr>)}</tbody></table>{visibleRows.length > 500 && <div className="list-more">Menampilkan 500 dari {visibleRows.length.toLocaleString('id-ID')} baris. Persempit dengan pencarian atau filter.</div>}{visibleRows.length === 0 && <div className="no-results"><Icon name="search" size={22} /><b>Tidak ada baris yang cocok</b><span>Ubah kata pencarian atau filter.</span></div>}</div>
          <div className="list-footer"><span><span className="status-dot green-dot" /> Cocok pasti <span className="status-dot amber-dot" /> Perlu tinjau</span><span>Maks. 500 baris ditampilkan</span></div></div>
          <aside className="detail-panel">{selected ? <><div className="detail-top"><div><span className="section-kicker">DETAIL BARIS</span><span className="record-index">Record {selected.sourceIndex + 2}</span></div><StatusBadge row={selected} /></div><div className="detail-identity"><span>IDENTITAS SUMBER</span><b>{selected.identifier || 'Tanpa ID / SKU'}</b></div><div className="compare-block"><span className="compare-label">NAMA CSV ASLI</span><p>{selected.sourceName || <i>Nama kosong</i>}</p>{selected.variant && <span className="variant-chip">Varian: {selected.variant}</span>}<div className="down-arrow"><Icon name="arrow" size={15} /></div><span className="compare-label">NAMA AKHIR</span><p className={selected.finalName !== selected.sourceName ? 'changed-name' : ''}>{selected.finalName || '—'}</p></div><div className="detail-divider"/><div className="candidate-head"><b>Kandidat teratas</b><span>Skor kemiripan</span></div>{selected.candidates.length ? selected.candidates.map(candidate => <CandidateOption key={candidate.id} candidate={candidate} selected={selected.chosenId === candidate.id} onSelect={() => choose(selected.id, 'use-json', candidate.id)} />) : <div className="empty-candidate"><span className="empty-search-icon"><Icon name="search" size={16} /></span><span>Belum ada kandidat.<br />Cari master secara manual.</span></div>}
            <div className="manual-search"><label htmlFor="master-search">Cari di seluruh master</label><div className="master-search-input"><Icon name="search" size={15} /><input id="master-search" value={searchQuery} onChange={event => searchMaster(event.target.value)} placeholder="Nama barang…" /></div>{searchResults.slice(0, 5).map(result => <button key={result.id} className="search-result" onClick={() => { workerRef.current?.postMessage({ type: 'decide', rowId: selected.id, decision: 'use-json', candidateId: result.id }); setSearchResults([]); setSearchQuery('') }}><span>{result.name}</span><span>Gunakan</span></button>)}</div>
            <div className="detail-actions"><button className={`button ${selected.decision === 'keep-csv' ? 'button-outline-active' : 'button-outline'}`} onClick={() => choose(selected.id, 'keep-csv')}><Icon name="x" size={15} /> Pertahankan nama asli</button>{selected.decision !== 'pending' && <button className="reset-decision" onClick={() => choose(selected.id, 'pending')}>Kembalikan keputusan</button>}</div><div className="detail-reason"><span className="reason-icon">i</span><span>{selected.reason} Skor adalah kemiripan teks, bukan probabilitas benar.</span></div></> : <div className="select-row-empty"><span className="empty-search-icon"><Icon name="grid" size={18} /></span><b>Pilih baris untuk ditinjau</b><span>Detail pasangan dan keputusan akan muncul di sini.</span></div>}</aside></div>
          <div className="results-bottom"><span><b>{(summary.kept ?? 0).toLocaleString('id-ID')}</b> baris akan memakai nama CSV asli sampai dipilih</span><button className="text-button" onClick={() => setStep(1)}>Ubah mapping</button></div>
        </section>}

        {step === 3 && exportData && <section className="step-panel export-panel"><div className="section-title-row"><div><span className="section-kicker">LANGKAH 04</span><h2>Preview ekspor</h2><p>Seluruh record CSV sumber akan disertakan. Filter tabel tidak mengubah isi file.</p></div><span className="validated-tag"><Icon name="check" size={14} /> Struktur CSV tervalidasi</span></div><div className="export-success"><div className="success-icon"><Icon name="check" size={22} /></div><div><b>File siap diunduh</b><span>Semua kolom selain nama barang telah dibandingkan dengan data sumber.</span></div><span className="integrity-label"><Icon name="shield" size={15} /> LULUS VALIDASI</span></div><div className="export-metrics"><ExportMetric icon="spark" label="Nama berubah" value={summary.changed ?? 0} tone="coral" description="Menggunakan nama master JSON" /><ExportMetric icon="check" label="Nama sudah sama" value={summary.same ?? 0} tone="green" description="Nama master dipilih, teks identik" /><ExportMetric icon="file" label="Nama dipertahankan" value={summary.kept ?? 0} tone="gray" description="Termasuk keputusan yang belum dipilih" /></div><div className="export-file-card"><div className="file-type-icon"><span>CSV</span></div><div className="export-file-info"><b>{exportData.fileName}</b><span>{csv?.rows.toLocaleString('id-ID')} record · {csv?.columns} kolom · Delimiter {csv?.delimiter === '\t' ? 'tab' : csv?.delimiter}</span><span className="file-properties">{csv?.bom ? 'BOM UTF-8' : 'UTF-8'} <i /> {csv?.linebreak === '\r\n' ? 'CRLF' : 'LF'} <i /> Urutan asli</span></div><button className="button button-primary" onClick={() => download(exportData.fileName, exportData.csv)}><Icon name="download" size={16} /> Unduh CSV</button></div><div className="report-file-card"><div className="report-icon"><Icon name="file" size={18} /></div><div><b>Laporan pencocokan terpisah</b><span>Memuat kandidat, skor, alasan, keputusan, dan nama akhir setiap baris.</span></div><button className="button button-quiet" onClick={() => download(exportData.reportName, exportData.report)}><Icon name="download" size={15} /> Unduh laporan</button></div><div className="export-preview"><div className="table-preview-head"><b>Contoh nama akhir</b><span>5 baris pertama</span></div><div className="table-scroll"><table><thead><tr><th>Nama CSV asli</th><th>Nama varian</th><th>Nama akhir</th><th>Status keputusan</th></tr></thead><tbody>{rows.slice(0, 5).map(row => <tr key={row.id}><td>{row.sourceName}</td><td>{row.variant || '—'}</td><td className={row.finalName !== row.sourceName ? 'table-changed' : ''}>{row.finalName}</td><td><StatusBadge row={row} /></td></tr>)}</tbody></table></div></div><div className="panel-footer"><button className="button button-quiet" onClick={() => setStep(2)}>Kembali ke hasil</button><span className="footer-hint">Nama file dan seluruh isi sel diperlakukan sebagai teks.</span><button className="button button-primary" onClick={() => download(exportData.fileName, exportData.csv)}><Icon name="download" size={16} /> Unduh CSV</button></div></section>}
      </div>
      <footer className="app-footer"><span>CSV MATCHER <i /> VERSI 1.0</span><span>Dirancang untuk menjaga data katalog tetap utuh</span></footer>
    </main>
  </div>
}

function UploadCard({ kind, title, description, file, onPick, onDrop, dragging, setDragging }: { kind: 'csv' | 'json'; title: string; description: string; file: File | null; onPick: () => void; onDrop: (kind: 'csv' | 'json', event: React.DragEvent) => void; dragging: 'csv' | 'json' | null; setDragging: (value: 'csv' | 'json' | null) => void }) {
  return <div className={`upload-card ${dragging === kind ? 'dragging' : ''} ${file ? 'has-file' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(kind) }} onDragLeave={() => setDragging(null)} onDrop={event => onDrop(kind, event)}><div className={`upload-icon ${kind}`}><Icon name={kind === 'csv' ? 'file' : 'box'} size={21} /></div><div className="upload-card-copy"><div className="upload-card-title">{title}{file && <span className="ready-chip compact"><Icon name="check" size={12} /> Siap</span>}</div><p>{description}</p></div>{file ? <div className="uploaded-file"><div className="uploaded-file-icon">{kind.toUpperCase()}</div><div className="uploaded-file-text"><b>{file.name}</b><span>{formatBytes(file.size)}</span></div><button aria-label={`Ganti ${title}`} onClick={onPick} className="file-change">Ganti</button></div> : <button className="dropzone" onClick={onPick}><span className="upload-circle"><Icon name="upload" size={17} /></span><span><b>Tarik file ke sini</b><small>atau <u>pilih dari perangkat</u></small></span><span className="drop-format">{kind === 'csv' ? 'CSV · MAKS. 10 MB' : 'JSON · MAKS. 50 MB'}</span></button>}</div>
}
function SourceSummary({ icon, label, name, meta }: { icon: string; label: string; name: string; meta: string }) { return <div className="source-item"><span className="source-icon"><Icon name={icon} size={17} /></span><div><span>{label}</span><b>{name}</b><small>{meta}</small></div><Icon name="check" size={15} /></div> }
function MappingSelect({ label, value, options, onChange, optional, required }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; optional?: boolean; required?: boolean }) { return <label className="mapping-select"><span>{label} {required && <em>Wajib</em>}{optional && <small>Opsional</small>}</span><select value={value} onChange={event => onChange(event.target.value)}><option value="">{optional ? 'Tidak digunakan' : 'Pilih field…'}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> }
function Metric({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className={`metric-card ${tone}`}><span className="metric-icon"><Icon name={tone === 'green' ? 'check' : tone === 'amber' ? 'search' : tone === 'purple' ? 'grid' : 'file'} size={16} /></span><div><span>{label}</span><b>{value.toLocaleString('id-ID')}</b></div></div> }
function StatusBadge({ row }: { row: MatchRow }) { const label = row.decision === 'use-json' ? 'Dipilih' : row.decision === 'keep-csv' ? 'Dipertahankan' : row.status === 'certain' ? 'Cocok pasti' : row.status === 'review' ? 'Perlu tinjau' : 'Belum cocok'; const tone = row.decision === 'use-json' ? 'badge-green' : row.decision === 'keep-csv' ? 'badge-gray' : row.status === 'certain' ? 'badge-green' : row.status === 'review' ? 'badge-amber' : 'badge-muted'; return <span className={`status-badge ${tone}`}><i />{label}</span> }
function CandidateOption({ candidate, selected, onSelect }: { candidate: Candidate; selected: boolean; onSelect: () => void }) { return <button className={`candidate-option ${selected ? 'picked' : ''}`} onClick={onSelect}><span className="candidate-radio"><i /></span><span className="candidate-option-name"><b>{candidate.name}</b><small>{candidate.refs.length > 1 ? `${candidate.refs.length} record JSON dengan nama sama` : candidate.reason}</small></span><span className={`candidate-score ${candidate.score >= 90 ? 'high-score' : ''}`}>{candidate.score}%</span></button> }
function ExportMetric({ icon, label, value, tone, description }: { icon: string; label: string; value: number; tone: string; description: string }) { return <div className={`export-metric ${tone}`}><span className="export-metric-icon"><Icon name={icon} size={17} /></span><span className="export-metric-label">{label}</span><b>{value.toLocaleString('id-ID')}</b><small>{description}</small></div> }
