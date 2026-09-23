'use strict'

/** Live 24 jam ke YouTube (atau RTMP lain) dengan auto-reconnect. */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const { PATHS } = require('../lib/config')
const store = require('../lib/store')
const events = require('../lib/events')
const ff = require('../lib/ffmpeg')
const util = require('../lib/util')

const procs = new Map()
const timers = new Map()

const SIZES = { 2160: [3840, 2160], 1080: [1920, 1080], 720: [1280, 720], 480: [854, 480] }

function streamsDir() {
	return util.ensureDir(path.join(PATHS.tmp, 'streams'))
}

function log(stream, message, level) {
	const entry = { at: util.nowIso(), level: level || 'info', message: String(message).slice(0, 400) }
	const current = store.get('streams', stream.id)
	const logs = ((current && current.logs) || []).concat([entry]).slice(-200)
	store.update('streams', stream.id, { logs: logs })
	events.emit('stream:log', { streamId: stream.id, name: stream.name, entry: entry })
}

function resolveItems(stream) {
	const files = []
	const items = stream.items || []
	items.forEach(function (item) {
		let file = null
		if (typeof item === 'string') {
			const video = store.get('videos', item)
			const asset = video ? null : store.get('assets', item)
			file = (video && video.file) || (asset && asset.file) || (fs.existsSync(item) ? item : null)
		} else if (item && item.file) {
			file = item.file
		} else if (item && item.videoId) {
			const video = store.get('videos', item.videoId)
			file = video && video.file
		} else if (item && item.assetId) {
			const asset = store.get('assets', item.assetId)
			file = asset && asset.file
		}
		if (file && fs.existsSync(file)) files.push(file)
	})
	return files
}

function writePlaylist(stream, files) {
	const file = path.join(streamsDir(), 'playlist_' + stream.id + '.txt')
	const body = files
		.map(function (item) {
			const safe = String(item).split('\\').join('/').split("'").join("'\\''")
			return "file '" + safe + "'"
		})
		.join(String.fromCharCode(10))
	fs.writeFileSync(file, body + String.fromCharCode(10))
	return file
}

async function decideMode(stream, files) {
	const wanted = stream.mode || 'auto'
	if (wanted === 'copy' || wanted === 'encode') return wanted
	try {
		const info = await ff.mediaInfo(files[0])
		const sameCodec = info.videoCodec === 'h264' && (info.audioCodec === 'aac' || stream.audioMode !== 'source')
		if (sameCodec && files.length >= 1) return 'copy'
	} catch (err) {}
	return 'encode'
}

function target(stream) {
	const base = String(stream.rtmpUrl || '').replace(/\/+$/, '')
	const key = String(stream.streamKey || '').trim()
	if (!base) throw new Error('RTMP URL belum diisi')
	if (!key) throw new Error('Stream key belum diisi')
	return base + '/' + key
}

function buildArgs(stream, playlist, mode) {
	const fps = Number(stream.fps) || 30
	const size = SIZES[String(stream.resolution || '1080')] || SIZES['1080']
	const audioMode = stream.audioMode || 'source'
	const args = ['-hide_banner', '-loglevel', 'error', '-stats', '-re']
	if (stream.loop !== false) args.push('-stream_loop', '-1')
	args.push('-f', 'concat', '-safe', '0', '-i', playlist)

	let musicFile = null
	if (audioMode === 'music') {
		const asset = stream.musicAssetId ? store.get('assets', stream.musicAssetId) : null
		musicFile = (asset && asset.file) || stream.musicFile || null
		if (musicFile && fs.existsSync(musicFile)) args.push('-stream_loop', '-1', '-i', musicFile)
		else musicFile = null
	}
	if (audioMode === 'silent' || (audioMode === 'music' && !musicFile)) {
		args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100')
	}

	const externalAudio = audioMode !== 'source'
	args.push('-map', '0:v:0')
	args.push('-map', externalAudio ? '1:a:0' : '0:a:0?')

	if (mode === 'copy') {
		args.push('-c:v', 'copy')
		args.push('-c:a', 'aac', '-b:a', stream.audioBitrate || '128k', '-ar', '44100', '-ac', '2')
	} else {
		const bitrate = stream.videoBitrate || '4500k'
		args.push(
			'-vf', 'scale=' + size[0] + ':' + size[1] + ':force_original_aspect_ratio=decrease,pad=' + size[0] + ':' + size[1] + ':(ow-iw)/2:(oh-ih)/2,fps=' + fps + ',format=yuv420p',
			'-c:v', 'libx264',
			'-preset', stream.preset || 'veryfast',
			'-tune', 'zerolatency',
			'-b:v', bitrate,
			'-maxrate', bitrate,
			'-bufsize', String(parseInt(bitrate, 10) * 2) + 'k',
			'-g', String(fps * 2),
			'-keyint_min', String(fps),
			'-sc_threshold', '0',
			'-c:a', 'aac',
			'-b:a', stream.audioBitrate || '128k',
			'-ar', '44100',
			'-ac', '2',
		)
	}
	args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', target(stream))
	return args
}

function parseStats(line) {
	const out = {}
	const frame = /frame=\s*(\d+)/.exec(line)
	const fps = /fps=\s*([\d.]+)/.exec(line)
	const bitrate = /bitrate=\s*([\w./]+)/.exec(line)
	const speed = /speed=\s*([\d.]+)x/.exec(line)
	const time = /time=\s*([\d:.]+)/.exec(line)
	if (frame) out.frame = Number(frame[1])
	if (fps) out.fps = Number(fps[1])
	if (bitrate) out.bitrate = bitrate[1]
	if (speed) out.speed = Number(speed[1])
	if (time) out.time = time[1]
	return Object.keys(out).length ? out : null
}

async function start(id, options) {
	const o = options || {}
	const stream = store.get('streams', id)
	if (!stream) throw new Error('Stream tidak ditemukan')
	if (procs.has(id)) stop(id, true)

	const files = resolveItems(stream)
	if (!files.length) throw new Error('Belum ada video di playlist')
	const playlist = writePlaylist(stream, files)
	const mode = await decideMode(stream, files)
	const args = buildArgs(stream, playlist, mode)
	const restarts = o.restarts || 0

	const proc = spawn(ff.FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
	procs.set(id, { proc: proc, startedAt: Date.now(), restarts: restarts, stats: null, stopping: false, mode: mode })
	store.update('streams', id, {
		status: 'live',
		startedAt: util.nowIso(),
		stoppedAt: null,
		pid: proc.pid,
		modeUsed: mode,
		itemsResolved: files.length,
		restarts: restarts,
		lastError: null,
	})
	log(stream, 'Streaming dimulai (' + mode + ', ' + files.length + ' video)')
	events.emit('stream:started', { streamId: id, name: stream.name, mode: mode, files: files.length })

	proc.stderr.on('data', function (chunk) {
		const text = String(chunk)
		const stats = parseStats(text)
		const entry = procs.get(id)
		if (stats && entry) {
			entry.stats = stats
			events.emit('stream:stats', { streamId: id, stats: stats })
			return
		}
		const clean = text.trim()
		if (clean && clean.indexOf('frame=') === -1) log(stream, clean.slice(0, 300), 'warn')
	})

	proc.on('error', function (err) {
		log(stream, 'Gagal menjalankan ffmpeg: ' + err.message, 'error')
		store.update('streams', id, { status: 'error', lastError: err.message })
	})

	proc.on('close', function (code) {
		const entry = procs.get(id)
		procs.delete(id)
		const current = store.get('streams', id)
		if (!current) return
		const uptime = entry ? Math.round((Date.now() - entry.startedAt) / 1000) : 0
		store.update('streams', id, { totalUptimeSeconds: (current.totalUptimeSeconds || 0) + uptime, pid: null })
		if (entry && entry.stopping) {
			store.update('streams', id, { status: 'stopped', stoppedAt: util.nowIso() })
			log(current, 'Streaming dihentikan')
			events.emit('stream:stopped', { streamId: id, name: current.name })
			return
		}
		const maxRestarts = current.maxRestarts === undefined ? 0 : Number(current.maxRestarts)
		const nextRestart = (entry ? entry.restarts : 0) + 1
		if (maxRestarts > 0 && nextRestart > maxRestarts) {
			store.update('streams', id, { status: 'error', stoppedAt: util.nowIso(), lastError: 'Melebihi batas restart (' + maxRestarts + ')' })
			log(current, 'Berhenti: melebihi batas restart', 'error')
			notifyDown(current, 'melebihi batas restart')
			return
		}
		const settings = store.settings().stream || {}
		const backoff = Math.min(Number(settings.restartBackoffMs) || 5000, 60000) * Math.min(nextRestart, 6)
		store.update('streams', id, { status: 'reconnecting', restarts: nextRestart, lastError: 'ffmpeg keluar dengan kode ' + code })
		log(current, 'Koneksi putus (kode ' + code + '), reconnect dalam ' + Math.round(backoff / 1000) + ' detik', 'warn')
		events.emit('stream:reconnecting', { streamId: id, name: current.name, inSeconds: Math.round(backoff / 1000) })
		notifyDown(current, 'reconnect otomatis')
		const timer = setTimeout(function () {
			timers.delete(id)
			start(id, { restarts: nextRestart }).catch(function (err) {
				store.update('streams', id, { status: 'error', lastError: err.message })
				log(current, 'Restart gagal: ' + err.message, 'error')
			})
		}, backoff)
		timers.set(id, timer)
	})

	return status(id)
}

function notifyDown(stream, reason) {
	const settings = store.settings().notifications || {}
	if (!settings.webhookUrl || settings.onStreamDown === false) return
	try {
		const { request } = require('../lib/httpclient')
		request(settings.webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: { event: 'stream_down', stream: stream.name, reason: reason, at: util.nowIso() },
			timeoutMs: 10000,
			retries: 0,
		}).catch(function () {})
	} catch (err) {}
}

function stop(id, silent) {
	const timer = timers.get(id)
	if (timer) {
		clearTimeout(timer)
		timers.delete(id)
	}
	const entry = procs.get(id)
	if (entry) {
		entry.stopping = true
		try {
			entry.proc.kill('SIGINT')
		} catch (err) {}
		setTimeout(function () {
			try {
				if (!entry.proc.killed) entry.proc.kill('SIGKILL')
			} catch (err) {}
		}, 4000)
	} else if (!silent) {
		store.update('streams', id, { status: 'stopped', stoppedAt: util.nowIso(), pid: null })
	}
	return true
}

async function restart(id) {
	stop(id, true)
	await util.sleep(1200)
	return start(id, { restarts: 0 })
}

function status(id) {
	const stream = store.get('streams', id)
	if (!stream) return null
	const entry = procs.get(id)
	return {
		id: id,
		name: stream.name,
		status: stream.status || 'stopped',
		live: Boolean(entry),
		pid: entry ? entry.proc.pid : null,
		mode: stream.modeUsed || stream.mode || 'auto',
		uptimeSeconds: entry ? Math.round((Date.now() - entry.startedAt) / 1000) : 0,
		totalUptimeSeconds: stream.totalUptimeSeconds || 0,
		restarts: stream.restarts || 0,
		stats: entry ? entry.stats : null,
		items: (stream.items || []).length,
		lastError: stream.lastError || null,
	}
}

function statusAll() {
	return store.coll('streams').map(function (stream) {
		return status(stream.id)
	})
}

async function inspect(id) {
	const stream = store.get('streams', id)
	if (!stream) return null
	const files = resolveItems(stream)
	const details = []
	let total = 0
	for (const file of files) {
		let info = {}
		try {
			info = await ff.mediaInfo(file)
		} catch (err) {}
		total += info.duration || 0
		details.push({
			name: path.basename(file),
			duration: info.duration || 0,
			durationText: util.formatDuration(info.duration || 0),
			width: info.width || 0,
			height: info.height || 0,
			fps: info.fps || 0,
			videoCodec: info.videoCodec || '-',
			audioCodec: info.audioCodec || '-',
			size: info.size || 0,
		})
	}
	const bitrateKbps = parseInt(stream.videoBitrate || '4500k', 10) + parseInt(stream.audioBitrate || '128k', 10)
	const readyMode = files.length ? await decideMode(stream, files) : stream.mode || 'auto'
	return {
		files: details,
		totalDuration: total,
		totalDurationText: util.formatDuration(total),
		loopCountPerDay: total > 0 ? Math.round((86400 / total) * 10) / 10 : 0,
		estimatedGbPerDay: Math.round(((bitrateKbps * 1000 * 86400) / 8 / 1024 / 1024 / 1024) * 10) / 10,
		readyMode: readyMode,
		missing: (stream.items || []).length - files.length,
	}
}

/** Cek kesehatan tiap 30 detik: hidupkan lagi stream yang harusnya live. */
function tick() {
	store.coll('streams').forEach(function (stream) {
		if (stream.status !== 'live') return
		if (procs.has(stream.id) || timers.has(stream.id)) return
		log(stream, 'Proses hilang, menyalakan ulang', 'warn')
		start(stream.id, { restarts: (stream.restarts || 0) + 1 }).catch(function (err) {
			store.update('streams', stream.id, { status: 'error', lastError: err.message })
		})
	})
}

function bootstrap() {
	setTimeout(function () {
		store.coll('streams').forEach(function (stream) {
			if (!stream.autoStart && stream.status !== 'live') return
			start(stream.id, { restarts: 0 }).catch(function (err) {
				store.update('streams', stream.id, { status: 'error', lastError: err.message })
				events.logger.warn('stream', 'Auto start gagal (' + stream.name + '): ' + err.message)
			})
		})
	}, 2000)
	setInterval(tick, 30000)
}

function stopAll() {
	Array.from(procs.keys()).forEach(function (id) {
		stop(id, true)
	})
}

module.exports = {
	start: start,
	stop: stop,
	restart: restart,
	status: status,
	statusAll: statusAll,
	bootstrap: bootstrap,
	stopAll: stopAll,
	tick: tick,
	inspect: inspect,
	resolveItems: resolveItems,
}
