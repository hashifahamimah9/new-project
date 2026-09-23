'use strict'

/**
 * Script reset: kosongkan database data/db.json dan bersihkan file temporary di storage/tmp.
 * Dipanggil lewat `npm run reset`.
 */

const fs = require('fs')
const path = require('path')
const { PATHS } = require('../server/lib/config')
const store = require('../server/lib/store')

console.log('')
console.log('=== UGC Flow Studio - Reset ===')
console.log('Mereset database dan membersihkan folder temporary...')

try {
	// 1. Reset database
	store.load()
	store.resetAll()
	console.log('  [OK] Database data/db.json berhasil direset ke setelan awal.')

	// 2. Bersihkan storage/tmp
	if (fs.existsSync(PATHS.tmp)) {
		const entries = fs.readdirSync(PATHS.tmp)
		let cleaned = 0
		for (const entry of entries) {
			const target = path.join(PATHS.tmp, entry)
			try {
				fs.rmSync(target, { recursive: true, force: true })
				cleaned += 1
			} catch (err) {
				/* ignore */
			}
		}
		console.log('  [OK] Membersihkan storage/tmp: ' + cleaned + ' file/folder dihapus.')
	}

	console.log('')
	console.log('Reset selesai. Jalankan "npm start" untuk memulai kembali server.')
	console.log('')
} catch (err) {
	console.error('  [FAIL] Gagal melakukan reset:', err.message)
	process.exit(1)
}
