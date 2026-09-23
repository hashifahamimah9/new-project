'use strict'

const { PATHS, DEFAULT_SETTINGS } = require('./config')
const { readJson, writeJsonAtomic, uid, nowIso, deepMerge } = require('./util')

const COLLECTIONS = [
	'assets',
	'jobs',
	'videos',
	'audios',
	'scripts',
	'podcasts',
	'streams',
	'playlists',
	'automations',
	'schedules',
	'apiKeys',
	'webhooks',
	'events',
	'products',
	'personas',
	'templates',
]

const EMPTY = () => {
	const base = {
		settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
		brand: {
			name: '',
			tagline: '',
			logoAssetId: '',
			primaryColor: '#5E9FE8',
			accentColor: '#72BC8F',
			font: 'system',
			ctaText: 'Cek link di bio',
			hashtags: '#ugc #review #fyp',
			tone: 'santai tapi meyakinkan',
			audience: 'anak muda 18-34 di Indonesia',
			bannedWords: '',
			watermarkText: '',
		},
		usage: {},
		meta: { createdAt: nowIso(), version: 1 },
	}
	for (const key of COLLECTIONS) base[key] = []
	return base
}

let db = EMPTY()
let saveTimer = null
let dirty = false

function load() {
	const raw = readJson(PATHS.dbFile, null)
	if (raw) {
		db = Object.assign(EMPTY(), raw)
		db.settings = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), raw.settings || {})
		for (const key of COLLECTIONS) if (!Array.isArray(db[key])) db[key] = []
	} else {
		db = EMPTY()
		persist()
	}
	return db
}

function persist() {
	writeJsonAtomic(PATHS.dbFile, db)
	dirty = false
}

function save() {
	dirty = true
	if (saveTimer) return
	saveTimer = setTimeout(() => {
		saveTimer = null
		if (dirty) persist()
	}, 250)
}

function flush() {
	if (saveTimer) {
		clearTimeout(saveTimer)
		saveTimer = null
	}
	persist()
}

function coll(name) {
	if (!Array.isArray(db[name])) db[name] = []
	return db[name]
}

function insert(name, doc, prefix) {
	const record = Object.assign(
		{ id: doc.id || uid(prefix || name.slice(0, 3)), createdAt: nowIso(), updatedAt: nowIso() },
		doc,
	)
	coll(name).unshift(record)
	save()
	return record
}

function update(name, id, patch) {
	const list = coll(name)
	const index = list.findIndex((item) => item.id === id)
	if (index === -1) return null
	const next = deepMerge(list[index], patch)
	next.updatedAt = nowIso()
	list[index] = next
	save()
	return next
}

function replace(name, id, doc) {
	const list = coll(name)
	const index = list.findIndex((item) => item.id === id)
	if (index === -1) return null
	list[index] = Object.assign({}, doc, { id, updatedAt: nowIso() })
	save()
	return list[index]
}

function get(name, id) {
	return coll(name).find((item) => item.id === id) || null
}

function find(name, predicate) {
	return coll(name).find(predicate) || null
}

function list(name, { filter, sort, limit, offset = 0 } = {}) {
	let items = coll(name).slice()
	if (filter) items = items.filter(filter)
	if (sort) items.sort(sort)
	const total = items.length
	if (limit !== undefined) items = items.slice(offset, offset + limit)
	else if (offset) items = items.slice(offset)
	return { items, total }
}

function remove(name, id) {
	const arr = coll(name)
	const index = arr.findIndex((item) => item.id === id)
	if (index === -1) return false
	arr.splice(index, 1)
	save()
	return true
}

function settings() {
	return db.settings
}

function updateSettings(patch) {
	db.settings = deepMerge(db.settings, patch)
	save()
	return db.settings
}

function brand() {
	return db.brand
}

function updateBrand(patch) {
	db.brand = deepMerge(db.brand, patch)
	save()
	return db.brand
}

/** Daily usage counters, e.g. usage['2026-09-07'] = { low: 12, standard: 3, renderSeconds: 480 } */
function usageFor(key) {
	if (!db.usage[key]) db.usage[key] = { low: 0, standard: 0, renderSeconds: 0, images: 0, ttsChars: 0 }
	return db.usage[key]
}

function addUsage(key, patch) {
	const bucket = usageFor(key)
	for (const [k, v] of Object.entries(patch)) bucket[k] = (bucket[k] || 0) + v
	save()
	return bucket
}

function filter(name, predicate) {
	return coll(name).filter(predicate)
}

/** Alias supaya modul lain bisa pakai saveSettings(). */
function saveSettings(patch) {
	return updateSettings(patch)
}

/** Buang job lama supaya db.json tidak membengkak. */
function pruneJobs(max = 400) {
	const jobs = coll('jobs')
	if (jobs.length <= max) return 0
	const finished = jobs
		.filter((job) => ['done', 'failed', 'canceled'].includes(job.status))
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
	const toRemove = Math.min(finished.length, jobs.length - max)
	for (let i = 0; i < toRemove; i += 1) remove('jobs', finished[i].id)
	return toRemove
}

function stats() {
	const counts = {}
	for (const key of COLLECTIONS) counts[key] = coll(key).length
	return counts
}

function resetAll() {
	db = EMPTY()
	persist()
	return db
}

function raw() {
	return db
}

module.exports = {
	load,
	save,
	flush,
	insert,
	update,
	replace,
	get,
	find,
	filter,
	list,
	remove,
	pruneJobs,
	stats,
	resetAll,
	saveSettings,
	coll,
	settings,
	updateSettings,
	brand,
	updateBrand,
	usageFor,
	addUsage,
	raw,
	COLLECTIONS,
}
