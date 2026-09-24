'use strict'

/** HTTP client kecil dengan retry + download file (dipakai adapter Flow, TTS & LLM). */

const fs = require('fs')
const path = require('path')
const { ensureDir } = require('./util')
const jobctx = require('./jobctx')

/** AbortController yang otomatis abort saat timeout ATAU saat job dibatalkan. */
function guard(timeoutMs) {
	const controller = new AbortController()
	let timedOut = false
	const timer = setTimeout(function () {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	const off = jobctx.onCancel(function () {
		controller.abort()
	})
	return {
		signal: controller.signal,
		timedOut: function () {
			return timedOut
		},
		done: function () {
			clearTimeout(timer)
			off()
		},
	}
}

function wrapAbort(err, g, url, timeoutMs) {
	if (jobctx.isCanceled()) return jobctx.canceledError()
	if (err && err.name === 'AbortError' && g.timedOut()) {
		const e = new Error('Timeout ' + Math.round(timeoutMs / 1000) + ' detik saat menghubungi ' + safeHost(url))
		e.timeout = true
		return e
	}
	return err
}

function safeHost(url) {
	try {
		return new URL(url).host
	} catch (err) {
		return 'server'
	}
}

async function request(url, options) {
	const o = options || {}
	const retries = o.retries === undefined ? 2 : o.retries
	const timeoutMs = o.timeoutMs || 60000
	let lastError = null
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		jobctx.throwIfCanceled()
		const g = guard(timeoutMs)
		try {
			const res = await fetch(url, {
				method: o.method || 'GET',
				headers: o.headers || {},
				body: o.body === undefined ? undefined : typeof o.body === 'string' || Buffer.isBuffer(o.body) ? o.body : JSON.stringify(o.body),
				signal: g.signal,
			})
			const contentType = res.headers.get('content-type') || ''
			let payload
			if (o.binary && res.ok) {
				payload = Buffer.from(await res.arrayBuffer())
			} else {
				const text = await res.text()
				payload = text
				if (contentType.indexOf('json') !== -1 || /^\s*[[{]/.test(text)) {
					try {
						payload = JSON.parse(text)
					} catch (err) {
						payload = text
					}
				}
			}
			if (!res.ok) {
				const message = typeof payload === 'string' ? payload.slice(0, 400) : JSON.stringify(payload).slice(0, 400)
				const err = new Error('HTTP ' + res.status + ': ' + message)
				err.status = res.status
				if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) err.noRetry = true
				throw err
			}
			return { status: res.status, data: payload, headers: res.headers, contentType: contentType }
		} catch (err) {
			lastError = wrapAbort(err, g, url, timeoutMs)
			if (lastError.canceled || lastError.noRetry || attempt === retries) break
			await jobctx.sleep(1200 * (attempt + 1))
		} finally {
			g.done()
		}
	}
	throw lastError || new Error('Request gagal')
}

async function download(url, destination, options) {
	const o = options || {}
	ensureDir(path.dirname(destination))
	if (String(url).indexOf('data:') === 0) {
		const comma = String(url).indexOf(',')
		fs.writeFileSync(destination, Buffer.from(String(url).slice(comma + 1), 'base64'))
		return destination
	}
	const timeoutMs = o.timeoutMs || 300000
	const g = guard(timeoutMs)
	try {
		const res = await fetch(url, { headers: o.headers || {}, signal: g.signal })
		if (!res.ok) throw new Error('Download gagal HTTP ' + res.status + ' (' + safeHost(url) + ')')
		const buffer = Buffer.from(await res.arrayBuffer())
		if (!buffer.length) throw new Error('Download gagal: file kosong (' + safeHost(url) + ')')
		const tmp = destination + '.part'
		fs.writeFileSync(tmp, buffer)
		fs.renameSync(tmp, destination)
		return destination
	} catch (err) {
		throw wrapAbort(err, g, url, timeoutMs)
	} finally {
		g.done()
	}
}

function saveBase64(data, destination) {
	ensureDir(path.dirname(destination))
	const clean = String(data).replace(/^data:[^,]+,/, '')
	fs.writeFileSync(destination, Buffer.from(clean, 'base64'))
	return destination
}

module.exports = { request: request, download: download, saveBase64: saveBase64 }
