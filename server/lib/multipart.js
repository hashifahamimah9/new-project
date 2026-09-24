'use strict'

/**
 * Parser multipart/form-data streaming.
 * File langsung ditulis ke disk (aman untuk video besar), field biasa ditahan di memori.
 */

const fs = require('fs')
const path = require('path')
const { uid, safeName, ensureDir } = require('./util')

const CR = 13
const LF = 10

function boundaryOf(req) {
	const header = req.headers['content-type'] || ''
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(header)
	if (!match) return null
	return (match[1] || match[2] || '').trim()
}

function parseHeaders(raw) {
	const headers = {}
	raw.split(/\r?\n/).forEach(function (line) {
		const idx = line.indexOf(':')
		if (idx === -1) return
		headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
	})
	const disposition = headers['content-disposition'] || ''
	const nameMatch = /name="([^"]*)"/i.exec(disposition)
	const fileMatch = /filename\*?=(?:UTF-8''([^;]+)|"([^"]*)")/i.exec(disposition)
	let filename = null
	if (fileMatch) {
		filename = fileMatch[2]
		if (fileMatch[1]) {
			try {
				filename = decodeURIComponent(fileMatch[1])
			} catch (err) {
				filename = fileMatch[1]
			}
		}
	}
	return {
		name: nameMatch ? nameMatch[1] : '',
		filename: filename || null,
		contentType: headers['content-type'] || 'application/octet-stream',
	}
}

/**
 * parse(req, { dir, maxBytes }) -> { fields, files }
 * files: [{ field, filename, contentType, path, size }]
 */
function parse(req, options) {
	const o = options || {}
	const dir = ensureDir(o.dir)
	const maxBytes = o.maxBytes || 4 * 1024 * 1024 * 1024
	const boundary = boundaryOf(req)
	return new Promise(function (resolve, reject) {
		if (!boundary) {
			reject(new Error('Content-Type bukan multipart/form-data'))
			return
		}
		const delim = Buffer.from('--' + boundary)
		const needle = Buffer.concat([Buffer.from([CR, LF]), delim])
		const headerEnd = Buffer.from([CR, LF, CR, LF])
		let buffer = Buffer.alloc(0)
		let state = 'start'
		let current = null
		const fields = {}
		const files = []
		let total = 0
		let finished = false

		function cleanupOnError(err) {
			if (finished) return
			finished = true
			if (current && current.fd !== undefined) {
				try {
					fs.closeSync(current.fd)
					fs.unlinkSync(current.path)
				} catch (e) {}
			}
			reject(err)
		}

		function writeChunk(chunk) {
			if (!current || !chunk.length) return
			if (current.filename) {
				fs.writeSync(current.fd, chunk)
				current.size += chunk.length
			} else {
				current.chunks.push(chunk)
				current.size += chunk.length
			}
		}

		function finishPart() {
			if (!current) return
			if (current.filename) {
				fs.closeSync(current.fd)
				if (current.size === 0) {
					try {
						fs.unlinkSync(current.path)
					} catch (e) {}
				} else {
					files.push({
						field: current.name,
						filename: current.filename,
						contentType: current.contentType,
						path: current.path,
						size: current.size,
					})
				}
			} else {
				const value = Buffer.concat(current.chunks).toString('utf8')
				if (fields[current.name] === undefined) fields[current.name] = value
				else if (Array.isArray(fields[current.name])) fields[current.name].push(value)
				else fields[current.name] = [fields[current.name], value]
			}
			current = null
		}

		function process() {
			let keepGoing = true
			while (keepGoing) {
				keepGoing = false
				if (state === 'start') {
					const idx = buffer.indexOf(delim)
					if (idx === -1) {
						if (buffer.length > delim.length * 4) buffer = buffer.slice(buffer.length - delim.length * 2)
						return
					}
					if (buffer.length < idx + delim.length + 2) return
					const marker = buffer.slice(idx + delim.length, idx + delim.length + 2).toString('latin1')
					if (marker === '--') {
						state = 'done'
						return
					}
					buffer = buffer.slice(idx + delim.length + 2)
					state = 'headers'
					keepGoing = true
				} else if (state === 'headers') {
					const idx = buffer.indexOf(headerEnd)
					if (idx === -1) return
					const info = parseHeaders(buffer.slice(0, idx).toString('utf8'))
					buffer = buffer.slice(idx + headerEnd.length)
					if (info.filename) {
						const base = safeName(info.filename)
						const target = path.join(dir, uid('', 8) + '_' + (base || 'file'))
						current = {
							name: info.name,
							filename: info.filename,
							contentType: info.contentType,
							path: target,
							fd: fs.openSync(target, 'w'),
							size: 0,
						}
					} else {
						current = { name: info.name, filename: null, contentType: info.contentType, chunks: [], size: 0 }
					}
					state = 'body'
					keepGoing = true
				} else if (state === 'body') {
					const idx = buffer.indexOf(needle)
					if (idx === -1) {
						const keep = needle.length
						if (buffer.length > keep) {
							writeChunk(buffer.slice(0, buffer.length - keep))
							buffer = buffer.slice(buffer.length - keep)
						}
						return
					}
					writeChunk(buffer.slice(0, idx))
					buffer = buffer.slice(idx + 2)
					finishPart()
					state = 'start'
					keepGoing = true
				}
			}
		}

		req.on('data', function (chunk) {
			if (finished) return
			total += chunk.length
			if (total > maxBytes) {
				req.destroy()
				cleanupOnError(new Error('Ukuran upload melebihi batas'))
				return
			}
			try {
				buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
				process()
			} catch (err) {
				cleanupOnError(err)
			}
		})
		req.on('end', function () {
			if (finished) return
			try {
				process()
				finishPart()
				finished = true
				resolve({ fields: fields, files: files, bytes: total })
			} catch (err) {
				cleanupOnError(err)
			}
		})
		req.on('error', cleanupOnError)
		req.on('aborted', function () {
			cleanupOnError(new Error('Upload dibatalkan'))
		})
	})
}

module.exports = { parse: parse, boundaryOf: boundaryOf }
