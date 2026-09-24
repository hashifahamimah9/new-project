'use strict'

/**
 * Voice engine: text-to-speech + pemrosesan "ubah suara jadi natural".
 *
 * Provider:
 *  - fishaudio  : Fish Audio (https://fish.audio) - API key + Voice ID (reference_id)
 *  - elevenlabs : ElevenLabs
 *  - openai     : OpenAI TTS (atau API lain yang kompatibel)
 *  - custom     : endpoint sendiri (POST JSON -> audio)
 *  - simulate   : otomatis - Fish Audio kalau FISHAUDIO_API_KEY ada, selain itu Google TTS gratis
 *  - google     : selalu Google TTS gratis (butuh internet). Kalau offline -> suara placeholder.
 * Kalau provider berbayar gagal, otomatis fallback ke Google TTS lalu placeholder,
 * dan alasan kegagalannya dicatat di log job (field "warning").
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const store = require('../lib/store')
const ff = require('../lib/ffmpeg')
const jobctx = require('../lib/jobctx')
const { request } = require('../lib/httpclient')
const { PATHS } = require('../lib/config')
const { uid, ensureDir, estimateSpeechSeconds, dayKey, clamp } = require('../lib/util')

const DEFAULT_FISH_VOICE = '1b0b8ad55c6d49db94e1a9eadf6f4643'
const DEFAULT_ELEVEN_VOICE = '21m00Tcm4TlvDq8ikWAM'
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']

const VOICE_PRESETS = [
	{ id: 'nadia', label: 'Nadia - hangat, cocok review produk (Fish Audio / UGC)', pitch: 0, speed: 1, preset: 'ugc-bright', referenceId: DEFAULT_FISH_VOICE, openai: 'nova' },
	{ id: 'raka', label: 'Raka - santai, cocok storytelling', pitch: -1, speed: 0.98, preset: 'podcast-warm', referenceId: DEFAULT_FISH_VOICE, openai: 'echo' },
	{ id: 'sari', label: 'Sari - ceria, cocok promo', pitch: 1, speed: 1.05, preset: 'ugc-bright', openai: 'shimmer' },
	{ id: 'bima', label: 'Bima - berat, cocok voice over', pitch: -2, speed: 0.96, preset: 'voice-over-tv', openai: 'onyx' },
	{ id: 'aira', label: 'Aira - lembut, cocok skincare / ASMR', pitch: 0.5, speed: 0.95, preset: 'asmr-soft', openai: 'shimmer' },
	{ id: 'host-a', label: 'Host A - podcast utama', pitch: 0, speed: 1, preset: 'podcast-warm', openai: 'alloy' },
	{ id: 'host-b', label: 'Host B - co-host podcast', pitch: -1.5, speed: 1.02, preset: 'podcast-warm', openai: 'onyx' },
]

const LABELS = { fishaudio: 'Fish Audio', elevenlabs: 'ElevenLabs', openai: 'OpenAI TTS', custom: 'TTS custom', google: 'Google TTS', placeholder: 'placeholder' }
const PAID = ['fishaudio', 'elevenlabs', 'openai', 'custom']
const CACHE_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'webm']

function config() {
	return store.settings().tts || {}
}

function todayKey() {
	return dayKey(new Date(), (store.settings().workspace || {}).timezone)
}

function voicePreset(voiceId) {
	return (
		VOICE_PRESETS.find(function (v) {
			return v.id === voiceId
		}) || VOICE_PRESETS[0]
	)
}

function isPresetId(voiceId) {
	return VOICE_PRESETS.some(function (v) {
		return v.id === voiceId
	})
}

function cleanText(text) {
	return String(text || '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim()
}

function shortMsg(err) {
	return String((err && err.message) || err || 'error').replace(/\s+/g, ' ').slice(0, 180)
}

function unlink(file) {
	try {
		if (file) fs.unlinkSync(file)
	} catch (err) {}
}

/* ------------------------------- provider -------------------------------- */

/** Tentukan provider yang benar-benar dipakai + API key-nya. */
function resolveProvider(c) {
	const selected = String(c.provider || 'simulate').toLowerCase()
	const fishKey = String(c.fishAudioApiKey || process.env.FISHAUDIO_API_KEY || '').trim()
	const apiKey = String(c.apiKey || '').trim()
	if (selected === 'fishaudio' || selected === 'fish') {
		const key = apiKey || fishKey
		if (key) return { provider: 'fishaudio', key: key }
		return { provider: 'google', key: '', reason: 'API key Fish Audio belum diisi (Settings > Voice / FISHAUDIO_API_KEY di .env)' }
	}
	if (selected === 'elevenlabs' || selected === 'openai') {
		if (apiKey) return { provider: selected, key: apiKey }
		return { provider: 'google', key: '', reason: 'API key ' + LABELS[selected] + ' belum diisi' }
	}
	if (selected === 'custom') {
		if (String(c.baseUrl || '').trim()) return { provider: 'custom', key: apiKey }
		return { provider: 'google', key: '', reason: 'Base URL TTS custom belum diisi' }
	}
	if (selected === 'google' || selected === 'gratis') return { provider: 'google', key: '' }
	// simulate (otomatis): kalau ada key Fish Audio (mis. di .env), langsung pakai Fish Audio
	if (fishKey) return { provider: 'fishaudio', key: fishKey }
	return { provider: 'google', key: '' }
}

const KNOWN_HOSTS = { fishaudio: 'fish.audio', elevenlabs: 'elevenlabs.io', openai: 'openai.com' }

/** Base URL milik provider lain (sisa setting lama) diabaikan supaya request tidak nyasar. */
function baseFor(provider, c) {
	const raw = String(c.baseUrl || '').trim().replace(/\/+$/, '')
	if (!raw || provider === 'custom') return raw
	for (const name of Object.keys(KNOWN_HOSTS)) {
		if (name !== provider && raw.indexOf(KNOWN_HOSTS[name]) !== -1) return ''
	}
	return raw
}

function modelFor(provider, c) {
	const m = String(c.model || '').trim()
	if (!m) return ''
	const lower = m.toLowerCase()
	if (provider === 'fishaudio' && (/^(gpt|tts-|eleven)/.test(lower))) return ''
	if (provider === 'openai' && (/^(eleven|speech-|s1)/.test(lower))) return ''
	if (provider === 'elevenlabs' && !/^eleven/.test(lower)) return ''
	return m
}

/** Voice ID untuk provider tertentu. */
function isFishId(value) {
	return /^[0-9a-f]{32}$/i.test(String(value || '').trim())
}

function resolveVoice(provider, o, c, preset) {
	const map = c.voiceMap && typeof c.voiceMap === 'object' ? c.voiceMap : {}
	const raw = String(o.voice || '').trim()
	// voiceMap: preset -> voice ID (mis. host-b -> voice Fish Audio kedua). Tetap divalidasi per provider.
	const mapped = raw && map[raw] ? String(map[raw]).trim() : ''
	const custom = mapped || (raw && !isPresetId(raw) ? raw : '')
	if (provider === 'fishaudio') {
		if (isFishId(custom)) return custom
		const envVoice = String(c.fishAudioVoiceId || process.env.FISHAUDIO_VOICE_ID || '').trim()
		let chosen = String(c.defaultVoice || '').trim()
		// Masih voice contoh bawaan (atau bukan ID Fish), padahal FISHAUDIO_VOICE_ID diisi voice lain -> pakai milik user
		if ((!isFishId(chosen) || chosen.toLowerCase() === DEFAULT_FISH_VOICE) && isFishId(envVoice)) chosen = envVoice
		if (isFishId(chosen)) return chosen
		return String(preset.referenceId || DEFAULT_FISH_VOICE).trim()
	}
	if (provider === 'elevenlabs') {
		if (/^[A-Za-z0-9]{20}$/.test(custom)) return custom
		return String(c.defaultVoice || DEFAULT_ELEVEN_VOICE).trim()
	}
	if (provider === 'openai') {
		if (OPENAI_VOICES.indexOf(custom.toLowerCase()) !== -1) return custom.toLowerCase()
		return String(c.defaultVoice || preset.openai || 'alloy').trim()
	}
	if (provider === 'custom') return custom || String(c.defaultVoice || preset.id)
	return 'google'
}

/* --------------------------------- cache --------------------------------- */

function cacheKeyOf(parts) {
	return crypto.createHash('md5').update(parts.map(String).join('|')).digest('hex')
}

function getCachedTts(key) {
	const dirs = [PATHS.cache, PATHS.storageCache]
	for (const dir of dirs) {
		if (!dir) continue
		for (const ext of CACHE_EXTS) {
			const candidate = path.join(dir, key + '.' + ext)
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).size > 200) return { file: candidate, buffer: fs.readFileSync(candidate), ext: ext }
			} catch (err) {}
		}
	}
	return null
}

function saveTtsCache(key, buffer, ext) {
	try {
		const dir = ensureDir(PATHS.cache)
		fs.writeFileSync(path.join(dir, key + '.' + (ext || 'mp3')), buffer)
	} catch (err) {
		console.error('Gagal menyimpan cache TTS:', err.message)
	}
}

/** Deteksi format audio dari isi file (bukan dari nama). */
function detectAudioExt(buf) {
	if (!buf || buf.length < 12) return 'mp3'
	const head4 = buf.slice(0, 4).toString('latin1')
	if (head4 === 'RIFF') return 'wav'
	if (head4 === 'OggS') return 'ogg'
	if (head4 === 'fLaC') return 'flac'
	if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a'
	if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm'
	return 'mp3'
}

function looksLikeText(buf) {
	const head = buf.slice(0, 64).toString('utf8').trim()
	return /^[{[<]/.test(head) || /^<!doctype/i.test(head)
}

/* -------------------------------- circuit -------------------------------- */

/** Kalau API key ditolak / saldo habis, jangan coba ulang tiap scene (hemat waktu) selama 10 menit. */
let breaker = null

function fingerprint(route) {
	return crypto.createHash('sha1').update(route.provider + ':' + (route.key || '')).digest('hex').slice(0, 16)
}

function breakerMessage(route) {
	if (!breaker || route.provider === 'google') return ''
	if (breaker.fp !== fingerprint(route) || Date.now() > breaker.until) {
		breaker = null
		return ''
	}
	return breaker.message
}

function tripBreaker(route, err) {
	const status = err && err.status
	if (status !== 401 && status !== 402 && status !== 403) return
	breaker = {
		fp: fingerprint(route),
		until: Date.now() + 10 * 60 * 1000,
		message: LABELS[route.provider] + ' menolak request (HTTP ' + status + ': API key salah / saldo habis). Sementara pakai Google TTS gratis. Perbaiki di Settings lalu klik Tes.',
	}
}

/* -------------------------------- fetchers ------------------------------- */

async function fetchAudio(url, headers, body, label) {
	const res = await request(url, { method: 'POST', headers: headers, body: body, binary: true, timeoutMs: 120000, retries: 1 })
	const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(String(res.data || ''))
	if (String(res.contentType || '').indexOf('json') !== -1 || looksLikeText(buf)) {
		let data = null
		try {
			data = JSON.parse(buf.toString('utf8'))
		} catch (err) {
			throw new Error('Respons ' + label + ' bukan audio: ' + buf.slice(0, 120).toString('utf8'))
		}
		const first = Array.isArray(data.data) ? data.data[0] || {} : {}
		const b64 = data.audio_base64 || data.audioContent || (typeof data.audio === 'string' ? data.audio : '') || first.b64_json || first.audio
		if (b64 && typeof b64 === 'string') return Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64')
		const link = data.url || data.audio_url || first.url
		if (link) {
			const r2 = await request(link, { method: 'GET', binary: true, timeoutMs: 120000, retries: 1 })
			return r2.data
		}
		throw new Error('Respons ' + label + ' tidak berisi audio: ' + JSON.stringify(data).slice(0, 160))
	}
	return buf
}

async function fetchRemote(provider, key, voiceId, model, text, speed, o, c) {
	const base = baseFor(provider, c)
	if (provider === 'fishaudio') {
		let url = base || 'https://api.fish.audio'
		if (!/\/tts$/.test(url)) url = /\/v1$/.test(url) ? url + '/tts' : url + '/v1/tts'
		const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
		if (model) headers.model = model
		return fetchAudio(url, headers, { text: text, reference_id: voiceId, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'normal' }, 'Fish Audio')
	}
	if (provider === 'elevenlabs') {
		const root = (base || 'https://api.elevenlabs.io').replace(/\/v1$/, '')
		return fetchAudio(
			root + '/v1/text-to-speech/' + encodeURIComponent(voiceId),
			{ 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
			{ text: text, model_id: model || 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } },
			'ElevenLabs',
		)
	}
	if (provider === 'openai') {
		const root = (base || 'https://api.openai.com').replace(/\/v1$/, '')
		return fetchAudio(
			root + '/v1/audio/speech',
			{ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
			{ model: model || 'gpt-4o-mini-tts', voice: voiceId, input: text, speed: speed, response_format: 'mp3' },
			'OpenAI TTS',
		)
	}
	const headers = { 'Content-Type': 'application/json' }
	if (key) headers.Authorization = 'Bearer ' + key
	return fetchAudio(base, headers, { text: text, voice: voiceId, model: model || undefined, speed: speed, style: o.style || undefined, language: o.language || 'id' }, 'TTS custom')
}

function splitTextForTts(text, maxLen) {
	const limit = maxLen || 160
	const clean = String(text || '').replace(/\s+/g, ' ').trim()
	if (clean.length <= limit) return [clean]
	const parts = []
	const sentences = clean.split(/([.,!?;\n]+)/)
	let current = ''
	for (let i = 0; i < sentences.length; i += 1) {
		const part = sentences[i]
		if ((current + part).length <= limit) {
			current += part
		} else {
			if (current.trim()) parts.push(current.trim())
			if (part.length <= limit) {
				current = part
			} else {
				current = ''
				for (const word of part.split(' ')) {
					if (!word) continue
					if ((current + ' ' + word).length <= limit) {
						current = (current + ' ' + word).trim()
					} else {
						if (current.trim()) parts.push(current.trim())
						current = word.slice(0, limit)
					}
				}
			}
		}
	}
	if (current.trim()) parts.push(current.trim())
	return parts.length ? parts : [clean.slice(0, limit)]
}

async function fetchGoogleTts(text, lang) {
	const tl = /^[a-z]{2}(-[A-Z]{2})?$/.test(String(lang || '')) ? lang : 'id'
	const buffers = []
	for (const chunk of splitTextForTts(text, 160)) {
		if (!chunk.trim()) continue
		jobctx.throwIfCanceled()
		const url = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=' + tl + '&client=tw-ob&q=' + encodeURIComponent(chunk)
		const res = await request(url, {
			method: 'GET',
			binary: true,
			timeoutMs: 20000,
			retries: 1,
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
				Referer: 'https://translate.google.com/',
			},
		})
		if (!Buffer.isBuffer(res.data) || res.data.length < 200 || looksLikeText(res.data)) throw new Error('Google TTS tidak mengembalikan audio')
		buffers.push(res.data)
	}
	if (!buffers.length) throw new Error('Google TTS buffer kosong')
	return Buffer.concat(buffers)
}

/* ------------------------------- synthesize ------------------------------ */

/**
 * Sintesis satu potongan teks -> file audio (wav 48 kHz stereo).
 * Opsi penting: text, voice, speed, pitch, naturalize, naturalPreset, room, denoise,
 * strict (lempar error kalau provider gagal, dipakai tombol Tes), noCache.
 */
async function synthesize(options) {
	const o = options || {}
	const c = config()
	const text = cleanText(o.text)
	if (!text) throw new Error('Teks kosong')
	jobctx.throwIfCanceled()
	const preset = voicePreset(o.voice)
	const outDir = ensureDir(o.outDir || PATHS.audio)
	const tmpDir = ensureDir(PATHS.tmp)
	const rawFile = path.join(tmpDir, 'tts_' + uid('', 8) + '.wav')
	const finalFile = o.out || path.join(outDir, 'voice_' + uid('', 8) + '.wav')
	const speed = clamp(Number(o.speed) || preset.speed || 1, 0.5, 2)
	const lang = String(o.language || (store.settings().workspace || {}).language || 'id')
	const useCache = !o.noCache && c.cache !== false

	const route = resolveProvider(c)
	const warnings = []
	if (route.reason && o.strict !== true) warnings.push(route.reason + ', pakai Google TTS gratis')
	let provider = route.provider
	if (!o.strict) {
		const tripped = breakerMessage(route)
		if (tripped) {
			warnings.push(tripped)
			provider = 'google'
		}
	}

	const attempt = async function (prov) {
		const voiceId = resolveVoice(prov, o, c, preset)
		const model = prov === 'google' ? '' : modelFor(prov, c)
		const nativeSpeed = prov === 'openai' || prov === 'custom'
		const key = cacheKeyOf([prov, voiceId, model, nativeSpeed ? speed : 1, prov === 'google' ? lang : '', text])
		if (useCache) {
			const hit = getCachedTts(key)
			if (hit) return { buffer: hit.buffer, ext: hit.ext, provider: prov, voiceId: voiceId, nativeSpeed: nativeSpeed, cached: true }
		}
		const buffer = prov === 'google' ? await fetchGoogleTts(text, lang) : await fetchRemote(prov, route.key, voiceId, model, text, speed, o, c)
		if (!buffer || buffer.length < 200) throw new Error('Audio dari ' + LABELS[prov] + ' kosong')
		const ext = detectAudioExt(buffer)
		if (useCache) saveTtsCache(key, buffer, ext)
		if (PAID.indexOf(prov) !== -1) store.addUsage(todayKey(), { ttsChars: text.length })
		return { buffer: buffer, ext: ext, provider: prov, voiceId: voiceId, nativeSpeed: nativeSpeed, cached: false }
	}

	let result = null
	if (provider !== 'google') {
		try {
			result = await attempt(provider)
			if (breaker && breaker.fp === fingerprint(route)) breaker = null
		} catch (err) {
			if (err.canceled || jobctx.isCanceled()) throw err.canceled ? err : jobctx.canceledError()
			if (o.strict) throw err
			tripBreaker(route, err)
			const msg = LABELS[provider] + ' gagal (' + shortMsg(err) + '), pakai Google TTS gratis'
			warnings.push(msg)
			console.error('[tts] ' + msg)
		}
	}
	if (!result) {
		try {
			result = await attempt('google')
		} catch (err) {
			if (err.canceled || jobctx.isCanceled()) throw err.canceled ? err : jobctx.canceledError()
			if (o.strict) throw new Error('Google TTS tidak bisa diakses (' + shortMsg(err) + '). Cek koneksi internet.')
			warnings.push('Google TTS gagal (' + shortMsg(err) + '), pakai suara placeholder')
		}
	}

	const simulated = !result
	if (result) {
		const src = path.join(tmpDir, 'tts_src_' + uid('', 8) + '.' + result.ext)
		fs.writeFileSync(src, result.buffer)
		try {
			await ff.run(['-i', src, '-vn', '-ar', '48000', '-ac', '2', rawFile])
		} finally {
			unlink(src)
		}
	} else {
		await ff.placeholderNarration({ out: rawFile, duration: estimateSpeechSeconds(text, 2.6 * speed), seed: text.length })
	}

	const tempo = simulated || result.nativeSpeed ? 1 : speed
	const wantNatural = o.naturalize === undefined ? c.naturalize !== false : Boolean(o.naturalize)
	try {
		if (wantNatural) {
			await ff.naturalizeAudio({
				input: rawFile,
				out: finalFile,
				preset: o.naturalPreset || preset.preset || c.naturalPreset || 'podcast-warm',
				pitch: o.pitch === undefined || o.pitch === null || o.pitch === '' ? preset.pitch : Number(o.pitch),
				speed: tempo,
				room: o.room || 0,
				denoise: Boolean(o.denoise),
			})
		} else {
			const af = Math.abs(tempo - 1) > 0.01 ? ['-af', 'atempo=' + tempo.toFixed(3)] : []
			await ff.run(['-i', rawFile].concat(af, ['-ar', '48000', '-ac', '2', finalFile]))
		}
	} finally {
		unlink(rawFile)
	}
	return {
		file: finalFile,
		duration: await ff.durationOf(finalFile),
		provider: result ? result.provider : 'placeholder',
		voiceId: result ? result.voiceId : '',
		simulated: simulated,
		cached: Boolean(result && result.cached),
		warning: warnings.length ? warnings.join('; ') : undefined,
		text: text,
	}
}

async function synthesizeMany(items, options) {
	const o = options || {}
	const results = []
	for (let i = 0; i < items.length; i += 1) {
		jobctx.throwIfCanceled()
		const item = items[i]
		if (o.onProgress) o.onProgress(i, items.length, item)
		// Scene tanpa narasi (mis. dikosongkan saat edit skrip) -> jeda hening, jangan gagalkan seluruh render.
		if (!String(item.text || '').trim()) {
			const quiet = path.join(ensureDir(o.outDir || PATHS.audio), 'silence_' + uid('', 6) + '.wav')
			const seconds = Math.max(0.3, Number(item.silenceSeconds) || 0.5)
			await ff.silence({ out: quiet, duration: seconds })
			results.push(Object.assign({}, item, { file: quiet, duration: seconds, provider: 'silence', silent: true }))
			continue
		}
		const res = await synthesize({
			text: item.text,
			voice: item.voice || o.voice,
			speed: item.speed || o.speed,
			pitch: item.pitch === undefined ? o.pitch : item.pitch,
			naturalPreset: item.naturalPreset || o.naturalPreset,
			naturalize: o.naturalize,
			room: o.room,
			denoise: o.denoise,
			language: o.language,
			outDir: o.outDir,
		})
		if (res.warning && o.onWarning) o.onWarning(res.warning)
		results.push(Object.assign({}, item, res))
	}
	return results
}

/** Voice changer untuk audio/video yang diupload user. */
async function transformUpload(options) {
	const o = options || {}
	const out = o.out || path.join(ensureDir(PATHS.audio), 'natural_' + uid('', 8) + '.wav')
	await ff.naturalizeAudio({
		input: o.input,
		out: out,
		preset: o.preset || 'podcast-warm',
		pitch: Number(o.pitch) || 0,
		speed: Number(o.speed) || 1,
		room: Number(o.room) || 0,
		denoise: o.denoise !== false,
	})
	return { file: out, duration: await ff.durationOf(out) }
}

/** Dipakai tombol "Tes" di Settings: benar-benar membuat 1 kalimat audio. */
async function testConnection() {
	const c = config()
	const route = resolveProvider(c)
	try {
		const res = await synthesize({ text: 'Halo, ini tes suara. Koneksi berhasil.', voice: 'nadia', strict: true, noCache: true, naturalize: false })
		unlink(res.file)
		if (res.provider === 'google') {
			return {
				ok: true,
				mode: 'google',
				message: route.reason
					? route.reason + '. Sementara memakai Google TTS gratis (berfungsi).'
					: 'Mode gratis (Google TTS) berfungsi. Isi API key Fish Audio + Voice ID untuk suara AI yang lebih natural.',
			}
		}
		return {
			ok: true,
			mode: res.provider,
			message: 'Koneksi ' + LABELS[res.provider] + ' berhasil (voice: ' + res.voiceId + ', ' + Number(res.duration || 0).toFixed(1) + ' detik audio).',
		}
	} catch (err) {
		return { ok: false, mode: route.provider, message: LABELS[route.provider] + ' gagal: ' + shortMsg(err) }
	}
}

/** Info ringkas provider aktif (untuk dashboard). */
function activeProvider() {
	const route = resolveProvider(config())
	return { provider: route.provider, label: LABELS[route.provider], reason: route.reason || '' }
}

/** Voice ID yang akan dipakai untuk preset/voice tertentu dengan provider aktif. */
function voiceFor(voice) {
	const c = config()
	const route = resolveProvider(c)
	return { provider: route.provider, voice: resolveVoice(route.provider, { voice: voice }, c, voicePreset(voice)) }
}

module.exports = {
	VOICE_PRESETS: VOICE_PRESETS,
	NATURAL_PRESETS: ff.NATURAL_PRESETS,
	synthesize: synthesize,
	synthesizeMany: synthesizeMany,
	transformUpload: transformUpload,
	testConnection: testConnection,
	voicePreset: voicePreset,
	activeProvider: activeProvider,
	voiceFor: voiceFor,
	detectAudioExt: detectAudioExt,
	splitTextForTts: splitTextForTts,
}
