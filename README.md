# CSV Matcher

Aplikasi lokal untuk mencocokkan nama barang pada CSV dengan master barang JSON, meninjau pasangan, lalu mengekspor CSV hasil beserta laporan pencocokan.

## Menjalankan aplikasi

```sh
npm install
npm run dev
```

Buka alamat lokal yang ditampilkan Vite. Untuk membuat build produksi, jalankan `npm run build`; hasilnya tersedia di `dist/`.

## Format file

- CSV harus UTF-8, memiliki header, dan tidak lebih dari 10 MB atau 20.000 baris data.
- JSON harus berupa array objek pada root, dengan field nama yang dipetakan oleh operator; batasnya 50 MB atau 50.000 record.
- Delimiter CSV koma, titik koma, dan tab dideteksi dari header.
- Nama barang CSV, varian, dan field nama JSON dipilih pada tahap mapping.

File diproses di browser melalui Web Worker. Aplikasi tidak memiliki backend dan tidak mengirim file ke server. Memuat ulang halaman mengakhiri sesi.

## Perilaku pencocokan dan ekspor

Pencocokan tepat yang unik dapat dipilih otomatis. Kandidat fuzzy memerlukan keputusan operator; skor adalah kemiripan teks, bukan probabilitas benar. Konflik spesifikasi tetap perlu ditinjau. Keputusan yang belum dibuat memakai nama CSV asli.

Ekspor mempertahankan seluruh record dan kolom sumber, hanya memperbarui kolom nama yang disetujui, lalu memvalidasi ulang struktur dan semua nilai sebelum file tersedia untuk diunduh. Laporan pencocokan diunduh sebagai CSV terpisah.
