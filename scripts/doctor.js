'use strict'

/** Cek kesiapan sistem: node, ffmpeg, folder, dan konfigurasi. Hanya membaca, aman dijalankan kapan saja. */

const fs = require('fs')
const net = require('net')
const path = require('path')
const { execFileSync } = require('child_process')

const { PATHS, SERVER, APP } = require('../server/lib/config')
const store = require('../server/lib/store')
const ff = require('../server/lib/ffmpeg')
const util = require('../server/lib/util')
const { getDownloadsDir } = require('../server/lib/downloads')
const tts = require('../server/providers/tts')
const flowProvider = require('../server/providers/flow')

const OK = '  [OK]   '
const WARN = '  [WARN] '
const FAIL = '  [FAIL] '
const INFO = '  [INFO] '

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

function run(bin, args) {
	try {
		return String(execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20000 }))
	} catch (err) {
		return null
	}
}

function mask(value) {
	if (!value) return '(kosong)'
	const text = String(value)
	if (text.length <= 8) return '******'
	return '******' + text.slice(-4)
}

function listEnv(name) {
	return String(process.env[name] || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
}

/** Cek apakah port sudah dipakai (server sudah jalan / aplikasi lain). */
function portInUse(port, host) {
	return new Promise(function (resolve) {
		const socket = net.connect({ port: port, host: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host })
		const done = function (used) {
			socket.destroy()
			resolve(used)
		}
		socket.setTimeout(1500)
		socket.once('connect', () => done(true))
		socket.once('timeout', () => done(false))
		socket.once('error', () => done(false))
	})
}

async function main() {
	console.log('')
	console.log('=== ' + (APP.name || 'UGC Flow Studio') + ' v' + APP.version + ' - Doctor ===')

	section('Runtime')
	const major = Number(process.versions.node.split('.')[0])
	line(major >= 18 ? OK : FAIL, 'Node.js ' + process.versions.node + (major >= 18 ? '' : ' (butuh Node 18 atau lebih baru)'))
	line(OK, 'Platform ' + process.platform + ' ' + process.arch)
	const envFile = path.join(PATHS.root, '.env')
	line(fs.existsSync(envFile) ? OK : WARN, fs.existsSync(envFile) ? 'File .env ditemukan' : 'File .env belum ada. Salin .env.example menjadi .env lalu isi API key (launcher .bat membuatnya otomatis)')

	section('FFmpeg')
	const ffmpegVersion = (run(ff.FFMPEG, ['-version']) || '').split('\n')[0].trim()
	const ffprobeVersion = (run(ff.FFPROBE, ['-version']) || '').split('\n')[0].trim()
	line(ffmpegVersion ? OK : FAIL, 'ffmpeg: ' + (ffmpegVersion ? ffmpegVersion + ' (' + ff.FFMPEG + ')' : 'tidak ditemukan. Jalankan KLIK-DISINI-UNTUK-MULAI.bat (download otomatis) atau set FFMPEG_PATH'))
	line(ffprobeVersion ? OK : FAIL, 'ffprobe: ' + (ffprobeVersion ? ffprobeVersion.split(' Copyright')[0] : 'tidak ditemukan. Install ffmpeg atau set FFPROBE_PATH'))
	if (ffmpegVersion) {
		const encoders = run(ff.FFMPEG, ['-hide_banner', '-encoders'])
		if (encoders) {
			line(/^\s*V\S*\s+libx264\s/m.test(encoders) ? OK : FAIL, 'Encoder libx264 (video)')
			line(/^\s*A\S*\s+aac\s/m.test(encoders) ? OK : FAIL, 'Encoder aac (audio)')
			line(/^\s*A\S*\s+libmp3lame\s/m.test(encoders) ? OK : WARN, 'Encoder libmp3lame (export MP3)')
		} else {
			line(WARN, 'Tidak bisa membaca daftar encoder ffmpeg')
		}
		const filters = run(ff.FFMPEG, ['-hide_banner', '-filters'])
		if (filters) {
			const has = (name) => new RegExp('^\\s*\\S+\\s+' + name + '\\s', 'm').test(filters)
			line(has('subtitles') ? OK : WARN, 'Filter subtitles (subtitle otomatis)')
			line(has('drawtext') ? OK : WARN, 'Filter drawtext (teks + watermark)')
			line(has('showwaves') ? OK : WARN, 'Filter showwaves (visual podcast)')
			line(has('zoompan') ? OK : WARN, 'Filter zoompan (gerakan kamera foto)')
		} else {
			line(WARN, 'Tidak bisa membaca daftar filter ffmpeg')
		}
	}

	section('Folder')
	const folders = ['data', 'storage', 'uploads', 'renders', 'audio', 'music', 'thumbs', 'tmp', 'inbox', 'cache', 'logs', 'backups']
	folders.forEach(function (key) {
		const dir = PATHS[key]
		if (!dir) return
		try {
			fs.mkdirSync(dir, { recursive: true })
			const probe = path.join(dir, '.doctor-write-test-' + process.pid)
			fs.writeFileSync(probe, 'ok')
			fs.unlinkSync(probe)
			line(OK, key + ' -> ' + dir)
		} catch (err) {
			line(FAIL, key + ' tidak bisa ditulis: ' + err.message)
		}
	})
	const downloads = getDownloadsDir()
	line(fs.existsSync(downloads) ? OK : WARN, 'Downloads (auto-import video Flow) -> ' + downloads + (fs.existsSync(downloads) ? '' : ' (tidak ada, isi DOWNLOADS_DIR di .env)'))

	section('Font')
	const font = util.findFont()
	line(font ? OK : WARN, font ? 'Font teks video: ' + font : 'Font tidak ditemukan. Teks/subtitle di video akan dilewati (pasang font Arial/DejaVu)')

	section('Server')
	line(OK, 'Host ' + SERVER.host + ' port ' + SERVER.port + ' -> http://localhost:' + SERVER.port)
	const used = await portInUse(SERVER.port, SERVER.host)
	if (used) line(INFO, 'Port ' + SERVER.port + ' sedang dipakai (server mungkin sudah jalan). Kalau bukan server ini, ganti PORT di .env')
	const authEnabled = APP.auth && APP.auth.enabled && APP.auth.password
	line(authEnabled ? OK : INFO, authEnabled ? 'Login aktif (user: ' + APP.auth.user + ')' : 'Login tidak aktif (aman untuk dipakai di PC sendiri; isi AUTH_ENABLED=true dan AUTH_PASSWORD kalau dibuka lewat internet)')
	const hosts = listEnv('ALLOWED_HOSTS')
	const origins = listEnv('CORS_ORIGINS')
	line(OK, 'Domain tambahan (ALLOWED_HOSTS): ' + (hosts.length ? hosts.join(', ') : '(tidak ada - hanya localhost/IP/nama PC)'))
	line(OK, 'Website tambahan (CORS_ORIGINS): ' + (origins.length ? origins.join(', ') : '(tidak ada - hanya Google Flow & ekstensi)'))

	section('Database & konfigurasi')
	store.load({ readOnly: true })
	const loadInfo = store.info() || {}
	if (loadInfo.corrupt) {
		line(WARN, 'data/db.json rusak' + (loadInfo.restoredFrom ? ', saat server start akan dipulihkan dari backup ' + loadInfo.restoredFrom : ' dan tidak ada backup, server akan mulai dengan database kosong'))
	} else if (!fs.existsSync(PATHS.dbFile)) {
		if (loadInfo.restoredFrom) line(WARN, 'data/db.json tidak ada, saat server start data dipulihkan otomatis dari backup ' + loadInfo.restoredFrom)
		else line(OK, 'data/db.json belum ada (akan dibuat otomatis saat server pertama jalan)')
	} else {
		try {
			const stats = store.stats()
			const keys = Object.keys(stats)
			line(OK, 'db.json siap (' + keys.length + ' koleksi)')
			console.log(
				'         ' +
					keys
						.map(function (key) {
							return key + '=' + stats[key]
						})
						.join('  '),
			)
		} catch (err) {
			line(FAIL, 'db.json bermasalah: ' + err.message)
		}
	}
	if (loadInfo.envApplied && loadInfo.envApplied.length) line(INFO, 'Nilai .env baru akan dipakai saat server start: ' + loadInfo.envApplied.join(', '))

	const settings = store.settings()
	const flow = settings.flow || {}
	const ttsSettings = settings.tts || {}
	const llm = settings.llm || {}
	const stream = settings.stream || {}
	const flowSim = flowProvider.isSimulate()
	line(flowSim ? WARN : OK, 'Flow: ' + (flowSim ? 'mode simulasi (video tetap jadi dari foto + gerakan kamera; isi FLOW_API_KEY & FLOW_BASE_URL untuk video AI)' : 'API aktif, key ' + mask(flow.apiKey)))
	line(OK, 'Flow lane default: ' + flow.defaultLane + ' | paralel lane low: ' + flow.lowConcurrency + ' | fallback ke low: ' + (flow.autoFallbackToLow ? 'ya' : 'tidak'))

	const voice = tts.activeProvider()
	const paidVoice = voice.provider !== 'google' && voice.provider !== 'simulate'
	line(paidVoice ? OK : WARN, 'Suara (TTS): ' + (voice.label || voice.provider) + (paidVoice ? ', key ' + mask(ttsSettings.apiKey || process.env.FISHAUDIO_API_KEY) : ' (gratis, kualitas standar)') + (voice.reason ? ' - ' + voice.reason : ''))
	if (voice.provider === 'fishaudio') {
		line(ttsSettings.defaultVoice ? OK : WARN, 'Voice ID Fish Audio (Host A): ' + (ttsSettings.defaultVoice || '(kosong - isi FISHAUDIO_VOICE_ID)'))
		const hostB = (ttsSettings.voiceMap || {})['host-b']
		line(hostB ? OK : INFO, 'Voice ID Host B (podcast): ' + (hostB || '(kosong - 2 host podcast memakai suara yang sama, isi FISHAUDIO_VOICE_ID_2 kalau mau beda)'))
	}
	line(llm.provider === 'remote' && llm.apiKey ? OK : INFO, 'Penulis skrip: ' + (llm.provider === 'remote' ? 'remote, model ' + llm.model + ', key ' + mask(llm.apiKey) : 'local (template bawaan, gratis tanpa API)'))
	line(OK, 'RTMP default: ' + stream.rtmpUrl + ' | stream key: ' + (stream.streamKey ? mask(stream.streamKey) : '(kosong - isi YT_STREAM_KEY atau per channel)'))
	line(OK, 'Render default: ' + ((settings.render || {}).resolution || '1080') + 'p, preset ' + ((settings.render || {}).preset || '-'))
	line(OK, 'Zona waktu jadwal: ' + ((settings.workspace || {}).timezone || APP.timezone || 'UTC'))

	console.log('')
	if (problems === 0 && warnings === 0) console.log('Semua siap. Jalankan: npm start')
	else if (problems === 0) console.log('Siap dipakai dengan ' + warnings + ' catatan [WARN] di atas. Jalankan: npm start')
	else console.log('Ada ' + problems + ' masalah [FAIL] yang harus dibereskan dulu.')
	console.log('')
	return problems === 0 ? 0 : 1
}

main().then(
	function (code) {
		process.exit(code)
	},
	function (err) {
		console.error('Doctor gagal: ' + (err && err.stack ? err.stack : err))
		process.exit(1)
	},
)
