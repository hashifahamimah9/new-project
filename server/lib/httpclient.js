'use strict'

/** HTTP client kecil dengan retry + download file (dipakai adapter Flow & TTS). */

const fs = require('fs')
const path = require('path')
const { ensureDir, sleep } = require('./util')

async function request(url, options) {
	const o = options || {}
	const retries = o.retries === undefined ? 2 : o.retries
	let lastError = null
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		const controller = new AbortController()
		const timer = setTimeout(function () {
			controller.abort()
		}, o.timeoutMs || 60000)
		try {
			const res = await fetch(url, {
				method: o.method || 'GET',
				headers: o.headers || {},
				body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
				signal: controller.signal,
			})
			clearTimeout(timer)
			const contentType = res.headers.get('content-type') || ''
			const payload = contentType.indexOf('json') !== -1 ? await res.json() : await res.text()
			if (!res.ok) {
				const message = typeof payload === 'string' ? payload.slice(0, 400) : JSON.stringify(payload).slice(0, 400)
				const err = new Error('HTTP ' + res.status + ': ' + message)
				err.status = res.status
				if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(err, { noRetry: true })
				throw err
			}
			return { status: res.status, data: payload }
		} catch (err) {
			clearTimeout(timer)
			lastError = err
			if (err.noRetry || attempt === retries) break
			await sleep(1200 * (attempt + 1))
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
	const controller = new AbortController()
	const timer = setTimeout(function () {
		controller.abort()
	}, o.timeoutMs || 300000)
	try {
		const res = await fetch(url, { headers: o.headers || {}, signal: controller.signal })
		if (!res.ok) throw new Error('Download gagal HTTP ' + res.status)
		const buffer = Buffer.from(await res.arrayBuffer())
		fs.writeFileSync(destination, buffer)
		return destination
	} finally {
		clearTimeout(timer)
	}
}

function saveBase64(data, destination) {
	ensureDir(path.dirname(destination))
	const clean = String(data).replace(/^data:[^,]+,/, '')
	fs.writeFileSync(destination, Buffer.from(clean, 'base64'))
	return destination
}

module.exports = { request: request, download: download, saveBase64: saveBase64 }
