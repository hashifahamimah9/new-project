'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function uid(prefix = 'id', size = 10) {
	let out = ''
	const bytes = crypto.randomBytes(size)
	for (let i = 0; i < size; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length]
	return prefix ? `${prefix}_${out}` : out
}

function token(size = 24) {
	return crypto.randomBytes(size).toString('hex')
}

function nowIso() {
	return new Date().toISOString()
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true })
	return dir
}

function readJson(file, fallback = null) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'))
	} catch (err) {
		return fallback
	}
}

function writeJsonAtomic(file, data) {
	ensureDir(path.dirname(file))
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
	fs.renameSync(tmp, file)
}

function slugify(input, fallback = 'item') {
	const slug = String(input || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)+/g, '')
		.slice(0, 60)
	return slug || fallback
}

function safeFileName(name) {
	return String(name || 'file')
		.replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 140)
}

/** Bangun cue subtitle dari daftar segmen bersuara (dipakai render UGC & podcast). */
function buildSrtFromSegments(segments, options = {}) {
	const gap = options.gap === undefined ? 0 : options.gap
	const maxChars = options.maxChars || 34
	const cues = []
	let cursor = options.startAt || 0
	for (const segment of segments) {
		const duration = Math.max(0.4, Number(segment.duration) || 1)
		const lines = chunkText(segment.text || '', maxChars)
		const per = duration / Math.max(1, lines.length)
		lines.forEach((line, i) => {
			cues.push({ start: cursor + per * i, end: cursor + per * (i + 1) - 0.02, text: line })
		})
		cursor += duration + gap
	}
	return { srt: buildSrt(cues), cues, total: cursor }
}

/** Tipe file berdasarkan ekstensi: image | video | audio | other */
function kindOf(file) {
	const ext = String(path.extname(file || '')).toLowerCase().replace('.', '')
	if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'avif'].includes(ext)) return 'image'
	if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'ts'].includes(ext)) return 'video'
	if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(ext)) return 'audio'
	return 'other'
}

function clamp(value, min, max) {
	const n = Number(value)
	if (!Number.isFinite(n)) return min
	return Math.min(max, Math.max(min, n))
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatBytes(n) {
	const num = Number(n) || 0
	if (num < 1024) return `${num} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let v = num / 1024
	let i = 0
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024
		i += 1
	}
	return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

function formatDuration(seconds) {
	const s = Math.max(0, Math.round(Number(seconds) || 0))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
	return `${m}:${String(sec).padStart(2, '0')}`
}

function srtTime(seconds) {
	const total = Math.max(0, Number(seconds) || 0)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = Math.floor(total % 60)
	const ms = Math.round((total - Math.floor(total)) * 1000)
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function buildSrt(cues) {
	return cues
		.map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${String(cue.text || '').trim()}\n`)
		.join('\n')
}

/** Split a sentence into short caption chunks (good for vertical video). */
function chunkText(text, maxChars = 34) {
	const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
	const lines = []
	let current = ''
	for (const word of words) {
		if (!current) current = word
		else if ((current + ' ' + word).length <= maxChars) current += ` ${word}`
		else {
			lines.push(current)
			current = word
		}
	}
	if (current) lines.push(current)
	return lines
}

/** Rough narration length estimate. Indonesian ~2.6 words/sec at normal pace. */
function estimateSpeechSeconds(text, wordsPerSecond = 2.6) {
	const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
	return Math.max(1.2, words / wordsPerSecond + 0.35)
}

function pick(list, seed) {
	if (!list || !list.length) return undefined
	if (seed === undefined) return list[Math.floor(Math.random() * list.length)]
	let h = 0
	const str = String(seed)
	for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 100000
	return list[h % list.length]
}

function shuffle(list, seed = Date.now()) {
	const arr = list.slice()
	let s = Number(seed) || 1
	for (let i = arr.length - 1; i > 0; i -= 1) {
		s = (s * 9301 + 49297) % 233280
		const j = Math.floor((s / 233280) * (i + 1))
		;[arr[i], arr[j]] = [arr[j], arr[i]]
	}
	return arr
}

const WIN_FONT_DIR = process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : 'C:\\Windows\\Fonts'

const FONT_CANDIDATES = [
	'/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf',
	'/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
	'/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
	'/usr/share/fonts/msttcore/arialbd.ttf',
	'/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf',
	'/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
	'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
	'/Library/Fonts/Arial Bold.ttf',
	'/Library/Fonts/Arial.ttf',
	'/System/Library/Fonts/Helvetica.ttc',
	path.join(WIN_FONT_DIR, 'arialbd.ttf'),
	path.join(WIN_FONT_DIR, 'arial.ttf'),
	path.join(WIN_FONT_DIR, 'segoeuib.ttf'),
	path.join(WIN_FONT_DIR, 'segoeui.ttf'),
	path.join(WIN_FONT_DIR, 'calibrib.ttf'),
	path.join(WIN_FONT_DIR, 'calibri.ttf'),
	'C:/Windows/Fonts/arialbd.ttf',
	'C:/Windows/Fonts/arial.ttf',
]

let cachedFont
function findFont() {
	if (cachedFont !== undefined) return cachedFont
	for (const candidate of FONT_CANDIDATES) {
		try {
			if (candidate && fs.existsSync(candidate)) {
				cachedFont = candidate.split('\\').join('/')
				return cachedFont
			}
		} catch (err) {
			/* ignore */
		}
	}
	// last resort: scan the font dirs
	const roots = [
		'/usr/share/fonts',
		'/usr/local/share/fonts',
		WIN_FONT_DIR,
		'/Library/Fonts',
		'/System/Library/Fonts',
		path.join(os.homedir(), '.fonts'),
	]
	for (const root of roots) {
		try {
			if (!root || !fs.existsSync(root)) continue
			const stack = [root]
			while (stack.length) {
				const dir = stack.pop()
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name)
					if (entry.isDirectory()) stack.push(full)
					else if (/\.(ttf|otf)$/i.test(entry.name)) {
						cachedFont = full.split('\\').join('/')
						return cachedFont
					}
				}
			}
		} catch (err) {
			/* ignore */
		}
	}
	cachedFont = null
	return cachedFont
}

/** Escape text for ffmpeg drawtext. */
function escapeDrawText(text) {
	return String(text || '')
		.replace(/\\/g, '\\\\')
		.replace(/:/g, '\\:')
		.replace(/'/g, "\u2019")
		.replace(/%/g, '\\%')
		.replace(/,/g, '\\,')
		.replace(/\[/g, '\\[')
		.replace(/\]/g, '\\]')
		.replace(/\n/g, ' ')
}

function deepMerge(base, patch) {
	if (Array.isArray(patch)) return patch.slice()
	if (patch === null || patch === undefined) return base
	if (typeof patch !== 'object') return patch
	const out = Array.isArray(base) ? {} : Object.assign({}, base || {})
	for (const [key, value] of Object.entries(patch)) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			out[key] = deepMerge(out[key] || {}, value)
		} else {
			out[key] = value
		}
	}
	return out
}

function dayKey(date = new Date(), timeZone) {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
	} catch (err) {
		return date.toISOString().slice(0, 10)
	}
}

function localTimeParts(date = new Date(), timeZone) {
	try {
		const fmt = new Intl.DateTimeFormat('en-GB', {
			timeZone,
			hour: '2-digit',
			minute: '2-digit',
			weekday: 'short',
			hour12: false,
		})
		const parts = fmt.formatToParts(date)
		const get = (t) => (parts.find((p) => p.type === t) || {}).value
		return { hour: Number(get('hour')), minute: Number(get('minute')), weekday: String(get('weekday') || '').toLowerCase() }
	} catch (err) {
		return { hour: date.getHours(), minute: date.getMinutes(), weekday: 'mon' }
	}
}

module.exports = {
	uid,
	token,
	nowIso,
	ensureDir,
	readJson,
	writeJsonAtomic,
	slugify,
	safeFileName,
	safeName: safeFileName,
	buildSrtFromSegments,
	kindOf,
	clamp,
	sleep,
	formatBytes,
	formatDuration,
	srtTime,
	buildSrt,
	chunkText,
	estimateSpeechSeconds,
	pick,
	shuffle,
	findFont,
	escapeDrawText,
	deepMerge,
	dayKey,
	localTimeParts,
}
