'use strict'

/** Helper HTTP: JSON, static file, streaming video (Range), auth basic. */

const fs = require('fs')
const path = require('path')
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
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	})
	res.end(body)
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
	if (o.download) headers['Content-Disposition'] = 'attachment; filename="' + path.basename(o.download === true ? filePath : o.download) + '"'
	const range = req.headers.range
	if (range && /^bytes=\d*-\d*$/.test(range)) {
		const parts = range.replace('bytes=', '').split('-')
		const start = parts[0] ? parseInt(parts[0], 10) : 0
		const end = parts[1] ? Math.min(parseInt(parts[1], 10), stat.size - 1) : stat.size - 1
		if (start >= stat.size || start > end) {
			res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size })
			res.end()
			return
		}
		headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size
		headers['Content-Length'] = end - start + 1
		res.writeHead(206, headers)
		fs.createReadStream(filePath, { start: start, end: end }).pipe(res)
		return
	}
	headers['Content-Length'] = stat.size
	res.writeHead(200, headers)
	if (req.method === 'HEAD') {
		res.end()
		return
	}
	fs.createReadStream(filePath).pipe(res)
}

/** Serve folder public/. Return true kalau ter-handle. */
function serveStatic(req, res, pathname) {
	const clean = decodeURIComponent(pathname.split('?')[0])
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

/** Basic auth opsional (aktif kalau AUTH_ENABLED=true). */
function checkAuth(req) {
	if (!APP.auth.enabled) return true
	const header = req.headers.authorization || ''
	if (header.indexOf('Basic ') !== 0) return false
	const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
	const sep = decoded.indexOf(':')
	const user = decoded.slice(0, sep)
	const pass = decoded.slice(sep + 1)
	return user === APP.auth.user && pass === APP.auth.password
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
	serveStatic: serveStatic,
	checkAuth: checkAuth,
	unauthorized: unauthorized,
	parseQuery: parseQuery,
	pathnameOf: pathnameOf,
}
