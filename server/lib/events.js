'use strict'

const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { PATHS } = require('./config')
const { nowIso, dayKey } = require('./util')

const bus = new EventEmitter()
bus.setMaxListeners(0)

const clients = new Set()
const buffer = []
const MAX_BUFFER = 500
let seq = 0

function emit(type, payload = {}) {
	seq += 1
	const event = Object.assign({ seq, type, at: nowIso() }, payload)
	buffer.push(event)
	if (buffer.length > MAX_BUFFER) buffer.shift()
	const frame = `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`
	for (const res of clients) {
		try {
			res.write(frame)
		} catch (err) {
			clients.delete(res)
		}
	}
	bus.emit(type, event)
	bus.emit('*', event)
	return event
}

function addClient(res) {
	clients.add(res)
	try {
		res.write(`retry: 3000\n\n`)
		res.write(`data: ${JSON.stringify({ type: 'hello', at: nowIso(), seq })}\n\n`)
	} catch (err) {
		clients.delete(res)
	}
	return () => clients.delete(res)
}

function clientCount() {
	return clients.size
}

function recent(limit = 100, type) {
	const items = type ? buffer.filter((e) => e.type === type) : buffer
	return items.slice(-limit)
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function log(level, scope, message, meta) {
	const entry = {
		level: LEVELS[level] ? level : 'info',
		scope: scope || 'app',
		message: String(message == null ? '' : message),
		meta: meta || undefined,
	}
	const line = `[${nowIso()}] ${entry.level.toUpperCase().padEnd(5)} ${entry.scope} :: ${entry.message}${
		entry.meta ? ` ${JSON.stringify(entry.meta)}` : ''
	}\n`
	try {
		fs.appendFileSync(path.join(PATHS.logs, `${dayKey()}.log`), line)
	} catch (err) {
		/* ignore disk errors */
	}
	if (process.env.QUIET !== 'true') process.stdout.write(line)
	return emit('log', entry)
}

const logger = {
	debug: (scope, msg, meta) => log('debug', scope, msg, meta),
	info: (scope, msg, meta) => log('info', scope, msg, meta),
	warn: (scope, msg, meta) => log('warn', scope, msg, meta),
	error: (scope, msg, meta) => log('error', scope, msg, meta),
}

module.exports = { bus, emit, addClient, clientCount, recent, log, logger }
