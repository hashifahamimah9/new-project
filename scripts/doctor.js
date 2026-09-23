'use strict'

/** Cek kesiapan sistem: node, ffmpeg, folder, dan konfigurasi. */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const { PATHS, SERVER, APP } = require('../server/lib/config')
const store = require('../server/lib/store')

const OK = '  [OK]   '
const WARN = '  [WARN] '
const FAIL = '  [FAIL] '

let problems = 0
let warnings = 0

function line(status, message) {
	if (status === FAIL) problems += 1
	if (status === WARN) warnings += 1
	console.log(status + message)
}

function section(title) {
	console.log('')
	console.log(title)
}

function binVersion(bin, args) {
	try {
		const out = execFileSync(bin, args || ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		return String(out).split('\n')[0].trim()
	} catch (err) {
		return null
	}
}

function mask(value) {
	if (!value) return '(kosong)'
	const text = String(value)
	if (text.length <= 6) return '******'
	return text.slice(0, 3) + '******' + text.slice(-3)
}

console.log('')
console.log('=== ' + (APP.name || 'UGC Flow Studio') + ' - Doctor ===')

section('Runtime')
const major = Number(process.versions.node.split('.')[0])
line(major >= 18 ? OK : FAIL, 'Node.js ' + process.versions.node + (major >= 18 ? '' : ' (butuh Node 18 atau lebih baru)'))
line(OK, 'Platform ' + process.platform + ' ' + process.arch)

section('FFmpeg')
function findBinary(name) {
	const envKey = name.toUpperCase() + '_PATH'
	if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey]
	const candidates = [
		path.join(PATHS.root, 'tools', 'ffmpeg', 'bin', name + '.exe'),
		path.join(PATHS.root, 'tools', 'ffmpeg', name + '.exe'),
		path.join(PATHS.root, 'tools', name + '.exe'),
		path.join(PATHS.root, 'tools', name, 'bin', name + '.exe'),
	]
	const ffmpegBase = path.join(PATHS.root, 'tools', 'ffmpeg')
	if (fs.existsSync(ffmpegBase)) {
		try {
			const subdirs = fs.readdirSync(ffmpegBase)
			for (const sub of subdirs) {
				candidates.push(path.join(ffmpegBase, sub, 'bin', name + '.exe'))
				candidates.push(path.join(ffmpegBase, sub, name + '.exe'))
			}
		} catch (e) {}
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}
	return process.env[envKey] || name
}
const ffmpegBin = findBinary('ffmpeg')
const ffprobeBin = findBinary('ffprobe')
const ffmpegVersion = binVersion(ffmpegBin)
const ffprobeVersion = binVersion(ffprobeBin)
line(ffmpegVersion ? OK : FAIL, 'ffmpeg: ' + (ffmpegVersion || 'tidak ditemukan. Install ffmpeg atau set FFMPEG_PATH'))
line(ffprobeVersion ? OK : FAIL, 'ffprobe: ' + (ffprobeVersion || 'tidak ditemukan. Install ffmpeg atau set FFPROBE_PATH'))
if (ffmpegVersion) {
	try {
		const encoders = execFileSync(ffmpegBin, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		line(encoders.indexOf('libx264') !== -1 ? OK : FAIL, 'Encoder libx264 (video)')
		line(encoders.indexOf('aac') !== -1 ? OK : FAIL, 'Encoder aac (audio)')
		line(encoders.indexOf('libmp3lame') !== -1 ? OK : WARN, 'Encoder libmp3lame (export MP3)')
	} catch (err) {
		line(WARN, 'Tidak bisa membaca daftar encoder ffmpeg')
	}
	try {
		const filters = execFileSync(ffmpegBin, ['-hide_banner', '-filters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		line(filters.indexOf('subtitles') !== -1 ? OK : WARN, 'Filter subtitles (subtitle otomatis)')
		line(filters.indexOf('drawtext') !== -1 ? OK : WARN, 'Filter drawtext (teks + watermark)')
		line(filters.indexOf('showwaves') !== -1 ? OK : WARN, 'Filter showwaves (visual podcast)')
	} catch (err) {
		line(WARN, 'Tidak bisa membaca daftar filter ffmpeg')
	}
}

section('Folder')
const folders = ['storage', 'uploads', 'renders', 'audio', 'music', 'thumbs', 'tmp', 'inbox', 'data', 'logs']
folders.forEach(function (key) {
	const dir = PATHS[key]
	if (!dir) return
	try {
		fs.mkdirSync(dir, { recursive: true })
		const probe = path.join(dir, '.doctor-write-test')
		fs.writeFileSync(probe, 'ok')
		fs.unlinkSync(probe)
		line(OK, key + ' -> ' + dir)
	} catch (err) {
		line(FAIL, key + ' tidak bisa ditulis: ' + err.message)
	}
})

section('Font')
const fontDirs = ['/usr/share/fonts', '/usr/local/share/fonts', 'C:\\Windows\\Fonts', '/System/Library/Fonts', path.join(process.env.HOME || '', '.fonts')]
const foundFont = fontDirs.filter(function (dir) {
	try {
		return dir && fs.existsSync(dir)
	} catch (err) {
		return false
	}
})
line(foundFont.length ? OK : WARN, foundFont.length ? 'Font tersedia: ' + foundFont[0] : 'Font sistem tidak terdeteksi. Teks di video akan dilewati')

section('Server')
line(OK, 'Host ' + SERVER.host + ' port ' + SERVER.port + ' -> http://localhost:' + SERVER.port)
const authEnabled = APP.auth && APP.auth.enabled && APP.auth.password
line(authEnabled ? OK : WARN, authEnabled ? 'Login aktif (user: ' + APP.auth.user + ')' : 'Login belum diaktifkan (isi AUTH_ENABLED=true dan AUTH_PASSWORD di .env kalau dipakai online)')

section('Konfigurasi')
const settings = store.settings()
const flow = settings.flow || {}
const tts = settings.tts || {}
const llm = settings.llm || {}
const stream = settings.stream || {}
line(flow.provider === 'flow' && flow.apiKey ? OK : WARN, 'Flow Ultra: provider ' + flow.provider + ', key ' + mask(flow.apiKey) + (flow.provider === 'flow' && flow.apiKey ? '' : ' (mode simulasi: video tetap jadi, tapi visual placeholder)'))
line(OK, 'Flow lane default: ' + flow.defaultLane + ' | lower priority concurrency: ' + flow.lowConcurrency + ' | fallback ke low: ' + (flow.autoFallbackToLow ? 'ya' : 'tidak'))
line(tts.provider === 'simulate' ? WARN : OK, 'TTS: ' + tts.provider + ', key ' + mask(tts.apiKey) + ', voice ' + tts.defaultVoice)
line(llm.provider === 'local' ? WARN : OK, 'Penulis skrip: ' + llm.provider + (llm.provider === 'local' ? ' (template bawaan, tanpa API)' : ' model ' + llm.model))
line(OK, 'RTMP default: ' + stream.rtmpUrl)
line(OK, 'Zona waktu: ' + ((settings.workspace || {}).timezone || 'UTC'))

section('Database')
try {
	const stats = store.stats()
	const keys = Object.keys(stats)
	line(OK, 'db.json siap (' + keys.length + ' koleksi)')
	console.log('         ' + keys.map(function (key) { return key + '=' + stats[key] }).join('  '))
} catch (err) {
	line(FAIL, 'db.json bermasalah: ' + err.message)
}

console.log('')
if (problems === 0 && warnings === 0) console.log('Semua siap. Jalankan: npm start')
else if (problems === 0) console.log('Siap dipakai dengan ' + warnings + ' catatan di atas. Jalankan: npm start')
else console.log('Ada ' + problems + ' masalah yang harus dibereskan dulu (lihat baris [FAIL]).')
console.log('')
process.exit(problems === 0 ? 0 : 1)
