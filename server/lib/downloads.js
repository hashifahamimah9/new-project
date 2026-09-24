'use strict'

/** Lokasi folder Downloads user (dipakai untuk auto-import video dari Google Flow). */

const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')

let cached = null

/** Folder Downloads Windows yang sebenarnya (bisa dipindah user ke drive lain) dari registry. */
function windowsDownloadsDir() {
	try {
		const out = childProcess.execFileSync(
			'reg',
			['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', '{374DE290-123F-4565-9164-39C4925E467B}'],
			{ encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
		)
		const match = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(out)
		if (!match) return ''
		const expanded = match[1].trim().replace(/%([^%]+)%/g, function (all, name) {
			return process.env[name] || all
		})
		return fs.existsSync(expanded) ? expanded : ''
	} catch (err) {
		return ''
	}
}

/** DOWNLOADS_DIR di .env > registry Windows > ~/Downloads. */
function getDownloadsDir() {
	if (cached) return cached
	let dir = String(process.env.DOWNLOADS_DIR || '').trim()
	if (!dir && process.platform === 'win32') dir = windowsDownloadsDir()
	if (!dir) dir = path.join(process.env.USERPROFILE || os.homedir(), 'Downloads')
	cached = path.resolve(dir)
	return cached
}

module.exports = { getDownloadsDir }
