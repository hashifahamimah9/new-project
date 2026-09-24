'use strict'

const fs = require('fs')
const path = require('path')
const { PATHS, DEFAULT_SETTINGS, ENV_SETTINGS } = require('./config')
const { writeJsonAtomic, uid, nowIso, deepMerge, ensureDir } = require('./util')

const BACKUP_KEEP = 7

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

function readDbFile() {
	if (!fs.existsSync(PATHS.dbFile)) return { raw: null, corrupt: false }
	try {
		const text = fs.readFileSync(PATHS.dbFile, 'utf8').replace(/^\uFEFF/, '')
		if (!text.trim()) return { raw: null, corrupt: true }
		return { raw: JSON.parse(text), corrupt: false }
	} catch (err) {
		return { raw: null, corrupt: true, error: err.message }
	}
}

/** Backup terbaru yang masih valid (dipakai kalau db.json rusak). */
function latestBackup() {
	try {
		const files = fs
			.readdirSync(PATHS.backups)
			.filter((name) => /^db-.*\.json$/.test(name))
			.sort()
			.reverse()
		for (const name of files) {
			try {
				return { name, raw: JSON.parse(fs.readFileSync(path.join(PATHS.backups, name), 'utf8')) }
			} catch (err) {}
		}
	} catch (err) {}
	return null
}

function getPath(obj, dotted) {
	return dotted.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj)
}

function setPath(obj, dotted, value) {
	const keys = dotted.split('.')
	let cursor = obj
	for (let i = 0; i < keys.length - 1; i += 1) {
		if (!cursor[keys[i]] || typeof cursor[keys[i]] !== 'object') cursor[keys[i]] = {}
		cursor = cursor[keys[i]]
	}
	cursor[keys[keys.length - 1]] = value
}

/**
 * Sinkronkan nilai dari .env ke settings:
 * - nilai .env yang berubah sejak server terakhir jalan -> dipakai (menimpa db.json)
 * - setting yang masih kosong di db.json -> diisi dari .env
 */
function syncEnvSettings() {
	const meta = db.meta || (db.meta = {})
	const previous = meta.envSnapshot && typeof meta.envSnapshot === 'object' ? meta.envSnapshot : null
	const snapshot = {}
	const applied = []
	for (const [dotted, names] of ENV_SETTINGS) {
		const current = names.map((name) => process.env[name] || '').join('|')
		snapshot[dotted] = current
		const hasEnv = names.some((name) => process.env[name] !== undefined && process.env[name] !== '')
		if (!hasEnv) continue
		const fromEnv = getPath(DEFAULT_SETTINGS, dotted)
		if (fromEnv === undefined) continue
		const stored = getPath(db.settings, dotted)
		const changed = previous && previous[dotted] !== undefined && previous[dotted] !== current
		const empty = stored === undefined || stored === null || stored === ''
		if ((changed || empty) && stored !== fromEnv) {
			setPath(db.settings, dotted, JSON.parse(JSON.stringify(fromEnv)))
			applied.push(dotted)
		}
	}
	meta.envSnapshot = snapshot
	return applied
}

let loadInfo = { corrupt: false, restoredFrom: null, envApplied: [] }

/**
 * Muat data/db.json. options.readOnly = true (dipakai `npm run doctor`) hanya membaca,
 * tidak menulis apa pun, supaya aman walau server sedang jalan.
 */
function load(options) {
	const readOnly = Boolean(options && options.readOnly)
	const result = readDbFile()
	let raw = result.raw
	loadInfo = { corrupt: result.corrupt, restoredFrom: null, envApplied: [], readOnly: readOnly }
	if (result.corrupt) {
		// Simpan file rusak supaya tidak hilang, lalu coba pulihkan dari backup harian.
		if (!readOnly) {
			const broken = PATHS.dbFile + '.corrupt-' + Date.now()
			try {
				fs.copyFileSync(PATHS.dbFile, broken)
				loadInfo.brokenCopy = broken
			} catch (err) {}
		}
		const backup = latestBackup()
		if (backup) {
			raw = backup.raw
			loadInfo.restoredFrom = backup.name
		}
	} else if (!raw && !fs.existsSync(PATHS.dbFile)) {
		// db.json hilang (mis. terhapus saat git pull / salah hapus) tapi ada backup harian -> pulihkan otomatis
		const backup = latestBackup()
		if (backup && backup.raw && typeof backup.raw === 'object') {
			raw = backup.raw
			loadInfo.restoredFrom = backup.name
			loadInfo.missing = true
		}
	}
	if (raw && typeof raw === 'object') {
		db = Object.assign(EMPTY(), raw)
		db.settings = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), raw.settings || {})
		db.brand = deepMerge(EMPTY().brand, raw.brand || {})
		if (!db.usage || typeof db.usage !== 'object') db.usage = {}
		if (!db.meta || typeof db.meta !== 'object') db.meta = { createdAt: nowIso(), version: 1 }
		for (const key of COLLECTIONS) if (!Array.isArray(db[key])) db[key] = []
	} else {
		db = EMPTY()
	}
	loadInfo.envApplied = syncEnvSettings()
	if (readOnly) return db
	pruneUsage()
	persist()
	backupDaily()
	return db
}

function info() {
	return loadInfo
}

/** Simpan counter pemakaian 90 hari terakhir saja. */
function pruneUsage() {
	const keys = Object.keys(db.usage || {}).sort()
	const extra = keys.length - 90
	for (let i = 0; i < extra; i += 1) delete db.usage[keys[i]]
}

/** Satu backup per hari di data/backups (7 terakhir disimpan). */
function backupDaily() {
	try {
		ensureDir(PATHS.backups)
		const name = 'db-' + new Date().toISOString().slice(0, 10) + '.json'
		const target = path.join(PATHS.backups, name)
		if (!fs.existsSync(target) && fs.existsSync(PATHS.dbFile)) fs.copyFileSync(PATHS.dbFile, target)
		const files = fs
			.readdirSync(PATHS.backups)
			.filter((file) => /^db-.*\.json$/.test(file))
			.sort()
		for (let i = 0; i < files.length - BACKUP_KEEP; i += 1) fs.unlinkSync(path.join(PATHS.backups, files[i]))
	} catch (err) {}
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
		if (dirty) {
			try {
				persist()
			} catch (err) {
				console.error('Gagal menyimpan database:', err.message)
				save()
			}
		}
	}, 400)
}

function flush() {
	if (saveTimer) {
		clearTimeout(saveTimer)
		saveTimer = null
	}
	persist()
}

/** Tandai ada perubahan, tulis ke disk paling lambat 3 detik lagi (untuk update progress yang sering). */
function touch() {
	dirty = true
	if (saveTimer) return
	saveTimer = setTimeout(() => {
		saveTimer = null
		if (dirty) {
			try {
				persist()
			} catch (err) {
				console.error('Gagal menyimpan database:', err.message)
			}
		}
	}, 3000)
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
	const current = list[index]
	const next = deepMerge(current, patch)
	// id & createdAt tidak boleh berubah lewat patch
	next.id = current.id
	if (current.createdAt) next.createdAt = current.createdAt
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
function pruneJobs(max = 300) {
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
	info,
	backupDaily,
	save,
	touch,
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
