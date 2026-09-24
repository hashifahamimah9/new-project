'use strict'

/** Helper HTTP: JSON, static file, streaming video (Range), auth basic. */

const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const crypto = require('crypto')
const { pipeline } = require('stream')
const { APP, PATHS } = require('./config')

const MIME = {
	html: 'text/html; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	ico: 'image/x-icon',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	ogg: 'audio/ogg',
	srt: 'text/plain; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	zip: 'application/zip',
	pdf: 'application/pdf',
	md: 'text/markdown; charset=utf-8',
}

function mimeFor(file) {
	const ext = path.extname(String(file || '')).toLowerCase().replace('.', '')
	return MIME[ext] || 'application/octet-stream'
}

function json(res, statusCode, data) {
	const body = JSON.stringify(data === undefined ? null : data)
	res.writeHead(statusCode || 200, {
		'Content-Type': MIME.json,
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store',
	})
	res.end(body)
}

/* ------------------------- proteksi akses dari browser ------------------------- */

function listFromEnv(name) {
	return String(process.env[name] || '')
		.split(',')
		.map(function (item) {
			return item.trim().toLowerCase().replace(/\/+$/, '')
		})
		.filter(Boolean)
}

// Website yang boleh memanggil API dari browser (ekstensi Google Flow). Tambah lewat CORS_ORIGINS di .env.
const TRUSTED_ORIGINS = ['https://labs.google', 'https://flow.google.com'].concat(listFromEnv('CORS_ORIGINS'))
const EXTRA_HOSTS = listFromEnv('ALLOWED_HOSTS')
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.internal', '.home.arpa']

function hostnameOf(hostHeader) {
	const value = String(hostHeader || '').trim().toLowerCase()
	if (!value) return ''
	if (value[0] === '[') return value.slice(1, value.indexOf(']'))
	const colon = value.lastIndexOf(':')
	return colon === -1 || value.indexOf(':') !== colon ? value : value.slice(0, colon)
}

/**
 * Tolak Host asing (serangan DNS rebinding). IP, localhost, nama komputer & domain lokal selalu boleh.
 * Pakai tunnel/domain sendiri? isi ALLOWED_HOSTS di .env atau aktifkan login (AUTH_ENABLED).
 */
function hostAllowed(req) {
	if (APP.auth.enabled && APP.auth.password) return true
	const name = hostnameOf(req.headers.host)
	if (!name || net.isIP(name)) return true
	if (name === 'localhost' || name === os.hostname().toLowerCase()) return true
	if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true
	return EXTRA_HOSTS.indexOf('*') !== -1 || EXTRA_HOSTS.indexOf(name) !== -1
}

/** Info Origin request: same-origin, website terpercaya (Flow / ekstensi), atau asing. */
function originInfo(req) {
	const origin = String(req.headers.origin || '').trim()
	if (!origin) return { origin: '', present: false, sameOrigin: true, trusted: true }
	const lower = origin.toLowerCase().replace(/\/+$/, '')
	let host = ''
	try {
		host = new URL(origin).host.toLowerCase()
	} catch (err) {}
	const sameOrigin = Boolean(host) && host === String(req.headers.host || '').toLowerCase()
	const trusted = lower.indexOf('chrome-extension://') === 0 || lower.indexOf('moz-extension://') === 0 || TRUSTED_ORIGINS.indexOf(lower) !== -1 || TRUSTED_ORIGINS.indexOf('*') !== -1
	return { origin: origin, present: true, sameOrigin: sameOrigin, trusted: sameOrigin || trusted }
}

/** Header CORS hanya untuk origin terpercaya (bukan '*'), supaya website lain tidak bisa membaca data. */
function applyCors(req, res) {
	const info = originInfo(req)
	if (info.present && info.trusted) {
		res.setHeader('Access-Control-Allow-Origin', info.origin)
		res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
		if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true')
	}
	res.setHeader('Vary', 'Origin')
	return info
}

function ok(res, data) {
	json(res, 200, data === undefined ? { ok: true } : data)
}

function fail(res, statusCode, message, extra) {
	json(res, statusCode || 400, Object.assign({ ok: false, error: String(message || 'Terjadi kesalahan') }, extra || {}))
}

function notFound(res, message) {
	fail(res, 404, message || 'Endpoint tidak ditemukan')
}

function text(res, statusCode, body, contentType) {
	res.writeHead(statusCode || 200, { 'Content-Type': contentType || MIME.txt })
	res.end(body)
}

function readBody(req, limitBytes) {
	return new Promise(function (resolve, reject) {
		const chunks = []
		let size = 0
		const limit = limitBytes || 25 * 1024 * 1024
		req.on('data', function (chunk) {
			size += chunk.length
			if (size > limit) {
				reject(new Error('Body terlalu besar'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', function () {
			resolve(Buffer.concat(chunks))
		})
		req.on('error', reject)
	})
}

async function readJson(req) {
	const buffer = await readBody(req)
	if (!buffer.length) return {}
	try {
		return JSON.parse(buffer.toString('utf8'))
	} catch (err) {
		throw new Error('JSON tidak valid')
	}
}

/** Header Content-Disposition yang aman untuk nama file apa pun (emoji, huruf non-latin, tanda kutip). */
function contentDisposition(name) {
	const base = String(name || 'download').replace(/[\r\n"]/g, '')
	const ascii = base.replace(/[^\x20-\x7e]/g, '_') || 'download'
	return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(base)
}

/** Stream file ke response; tutup file kalau koneksi putus / error (tidak bikin server crash). */
function pipeFile(res, filePath, range) {
	const source = fs.createReadStream(filePath, range || undefined)
	pipeline(source, res, function (err) {
		if (err && !res.headersSent) {
			try {
				res.writeHead(500)
			} catch (e) {}
		}
		if (err) {
			try {
				res.destroy()
			} catch (e) {}
		}
	})
}

/** Kirim file dengan dukungan Range supaya video bisa di-seek di browser. */
function sendFile(req, res, filePath, options) {
	const o = options || {}
	if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
		notFound(res, 'File tidak ditemukan')
		return
	}
	const stat = fs.statSync(filePath)
	const type = o.contentType || mimeFor(filePath)
	const headers = {
		'Content-Type': type,
		'Accept-Ranges': 'bytes',
		'Cache-Control': o.cache || 'private, max-age=60',
	}
	if (o.download) headers['Content-Disposition'] = contentDisposition(path.basename(o.download === true ? filePath : String(o.download)))
	const range = req.headers.range
	if (range && /^bytes=\d*-\d*$/.test(range) && range !== 'bytes=-') {
		const parts = range.replace('bytes=', '').split('-')
		let start = parts[0] ? parseInt(parts[0], 10) : 0
		let end = parts[1] ? Math.min(parseInt(parts[1], 10), stat.size - 1) : stat.size - 1
		if (!parts[0] && parts[1]) {
			// "bytes=-500" = 500 byte terakhir
			start = Math.max(0, stat.size - parseInt(parts[1], 10))
			end = stat.size - 1
		}
		if (start >= stat.size || start > end) {
			res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size })
			res.end()
			return
		}
		headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size
		headers['Content-Length'] = end - start + 1
		res.writeHead(206, headers)
		if (req.method === 'HEAD') {
			res.end()
			return
		}
		pipeFile(res, filePath, { start: start, end: end })
		return
	}
	headers['Content-Length'] = stat.size
	res.writeHead(200, headers)
	if (req.method === 'HEAD') {
		res.end()
		return
	}
	pipeFile(res, filePath)
}

/** decodeURIComponent yang tidak melempar error (URL rusak -> null). */
function safeDecode(value) {
	try {
		return decodeURIComponent(value)
	} catch (err) {
		return null
	}
}

/** Serve folder public/. Return true kalau ter-handle. */
function serveStatic(req, res, pathname) {
	let clean = ''
	try {
		clean = decodeURIComponent(pathname.split('?')[0])
	} catch (err) {
		return false
	}
	const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '')
	const target = path.resolve(PATHS.public, rel)
	const relDiff = path.relative(PATHS.public, target)
	if (relDiff.startsWith('..') || path.isAbsolute(relDiff)) return false
	if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return false
	sendFile(req, res, target, { cache: 'no-cache' })
	return true
}

function unauthorized(res) {
	res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="' + APP.name + '"', 'Content-Type': MIME.json })
	res.end(JSON.stringify({ ok: false, error: 'Butuh login' }))
}

function safeEqual(a, b) {
	const x = crypto.createHash('sha256').update(String(a)).digest()
	const y = crypto.createHash('sha256').update(String(b)).digest()
	return crypto.timingSafeEqual(x, y)
}

/** Basic auth opsional (aktif kalau AUTH_ENABLED=true). */
function checkAuth(req) {
	if (!APP.auth.enabled) return true
	const header = req.headers.authorization || ''
	if (header.indexOf('Basic ') !== 0) return false
	const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
	const sep = decoded.indexOf(':')
	if (sep === -1) return false
	const user = decoded.slice(0, sep)
	const pass = decoded.slice(sep + 1)
	const userOk = safeEqual(user, APP.auth.user)
	const passOk = safeEqual(pass, APP.auth.password)
	return userOk && passOk
}

function parseQuery(url) {
	const out = {}
	const qIndex = url.indexOf('?')
	if (qIndex === -1) return out
	const params = new URLSearchParams(url.slice(qIndex + 1))
	params.forEach(function (value, key) {
		out[key] = value
	})
	return out
}

function pathnameOf(url) {
	const qIndex = url.indexOf('?')
	return qIndex === -1 ? url : url.slice(0, qIndex)
}

module.exports = {
	MIME: MIME,
	mimeFor: mimeFor,
	json: json,
	ok: ok,
	fail: fail,
	notFound: notFound,
	text: text,
	readBody: readBody,
	readJson: readJson,
	sendFile: sendFile,
	contentDisposition: contentDisposition,
	serveStatic: serveStatic,
	checkAuth: checkAuth,
	unauthorized: unauthorized,
	parseQuery: parseQuery,
	pathnameOf: pathnameOf,
	safeDecode: safeDecode,
	hostAllowed: hostAllowed,
	originInfo: originInfo,
	applyCors: applyCors,
}
