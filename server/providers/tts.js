'use strict'

/** Voice engine: text-to-speech + pemrosesan "ubah suara jadi natural". */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const store = require('../lib/store')
const ff = require('../lib/ffmpeg')
const { PATHS } = require('../lib/config')
const { uid, ensureDir, estimateSpeechSeconds, dayKey } = require('../lib/util')

const VOICE_PRESETS = [
	{ id: 'nadia', label: 'Nadia - hangat, cocok review produk (Fish Audio / UGC)', pitch: 0, speed: 1, preset: 'ugc-bright', referenceId: '1b0b8ad55c6d49db94e1a9eadf6f4643' },
	{ id: 'raka', label: 'Raka - santai, cocok storytelling', pitch: -1, speed: 0.98, preset: 'podcast-warm', referenceId: '1b0b8ad55c6d49db94e1a9eadf6f4643' },
	{ id: 'sari', label: 'Sari - ceria, cocok promo', pitch: 1, speed: 1.05, preset: 'ugc-bright' },
	{ id: 'bima', label: 'Bima - berat, cocok voice over', pitch: -2, speed: 0.96, preset: 'voice-over-tv' },
	{ id: 'aira', label: 'Aira - lembut, cocok skincare / ASMR', pitch: 0.5, speed: 0.95, preset: 'asmr-soft' },
	{ id: 'host-a', label: 'Host A - podcast utama', pitch: 0, speed: 1, preset: 'podcast-warm' },
	{ id: 'host-b', label: 'Host B - co-host podcast', pitch: -1.5, speed: 1.02, preset: 'podcast-warm' },
]

function getTtsCacheKey(provider, voice, text) {
	return crypto.createHash('md5').update(String(provider || '') + ':' + String(voice || '') + ':' + String(text || '').trim()).digest('hex')
}

function getCachedTts(cacheKey) {
	const dirs = [PATHS.cache, PATHS.storageCache, path.join(PATHS.storage, 'cache')].filter(Boolean)
	for (const dir of dirs) {
		for (const ext of ['mp3', 'wav']) {
			const candidate = path.join(dir, cacheKey + '.' + ext)
			if (fs.existsSync(candidate)) {
				try {
					return { file: candidate, buffer: fs.readFileSync(candidate), ext: ext }
				} catch (err) {}
			}
		}
	}
	return null
}

function saveTtsCache(cacheKey, buffer, ext = 'mp3') {
	try {
		const targetDir = ensureDir(PATHS.cache || path.join(PATHS.storage, 'cache'))
		fs.writeFileSync(path.join(targetDir, cacheKey + '.' + ext), buffer)
	} catch (err) {
		console.error('Gagal menyimpan cache TTS:', err.message)
	}
}

function config() {
	return store.settings().tts || {}
}

function voicePreset(voiceId) {
	return (
		VOICE_PRESETS.find(function (v) {
			return v.id === voiceId
		}) || VOICE_PRESETS[0]
	)
}

function providerVoiceId(voiceId) {
	const c = config()
	return (c.voiceMap || {})[voiceId] || c.defaultVoice || voiceId
}

function cleanText(text) {
	return String(text || '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim()
}

async function fetchBinary(url, options) {
	const o = options || {}
	const controller = new AbortController()
	const timer = setTimeout(function () {
		controller.abort()
	}, o.timeoutMs || 120000)
	try {
		const res = await fetch(url, { method: o.method || 'POST', headers: o.headers || {}, body: o.body ? JSON.stringify(o.body) : undefined, signal: controller.signal })
		if (!res.ok) throw new Error('TTS HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300))
		const contentType = res.headers.get('content-type') || ''
		if (contentType.indexOf('application/json') !== -1) {
			const data = await res.json()
			const b64 = data.audio_base64 || data.audioContent || data.audio || (data.data && data.data[0] && data.data[0].b64_json)
			if (b64) return Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64')
			const link = data.url || data.audio_url || (data.data && data.data[0] && data.data[0].url)
			if (link) return Buffer.from(await (await fetch(link)).arrayBuffer())
			throw new Error('Respons TTS tidak berisi audio')
		}
		return Buffer.from(await res.arrayBuffer())
	} finally {
		clearTimeout(timer)
	}
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
				const words = part.split(' ')
				for (const word of words) {
					if ((current + ' ' + word).length <= limit) {
						current = (current + ' ' + word).trim()
					} else {
						if (current.trim()) parts.push(current.trim())
						current = word
					}
				}
			}
		}
	}
	if (current.trim()) parts.push(current.trim())
	return parts.length ? parts : [clean.slice(0, limit)]
}

async function fetchGoogleTts(text, lang) {
	const chunks = splitTextForTts(text, 160)
	const buffers = []
	for (const chunk of chunks) {
		if (!chunk.trim()) continue
		const url =
			'https://translate.google.com/translate_tts?ie=UTF-8&tl=' +
			(lang || 'id') +
			'&client=tw-ob&q=' +
			encodeURIComponent(chunk)
		const res = await fetch(url, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				Referer: 'https://translate.google.com/',
			},
		})
		if (!res.ok) throw new Error('Google TTS HTTP ' + res.status)
		buffers.push(Buffer.from(await res.arrayBuffer()))
	}
	if (!buffers.length) throw new Error('Google TTS buffer kosong')
	return Buffer.concat(buffers)
}

/** Sintesis satu potongan teks -> file audio natural. */
async function synthesize(options) {
	const o = options || {}
	const c = config()
	const text = cleanText(o.text)
	if (!text) throw new Error('Teks kosong')
	const preset = voicePreset(o.voice)
	const outDir = ensureDir(o.outDir || PATHS.audio)
	const rawFile = path.join(ensureDir(PATHS.tmp), 'tts_' + uid('', 8) + '.wav')
	const finalFile = o.out || path.join(outDir, 'voice_' + uid('', 8) + '.wav')
	const useCache = c.cache !== false && (process.env.TTS_CACHE === '1' || process.env.TTS_CACHE === 'true' || c.cache)
	const fishKey = c.fishAudioApiKey || process.env.FISHAUDIO_API_KEY || (c.apiKey && String(c.apiKey).startsWith('') ? c.apiKey : '')
	const fishVoice = (preset && preset.referenceId) || c.fishAudioVoiceId || process.env.FISHAUDIO_VOICE_ID || c.defaultVoice || '1b0b8ad55c6d49db94e1a9eadf6f4643'

	let provider = c.provider || 'simulate'
	if (provider === 'simulate' && fishKey) {
		provider = 'fishaudio'
	}
	if (fishKey && String(c.apiKey).startsWith('')) {
		provider = 'fishaudio'
	}

	let simulated = false
	store.addUsage(dayKey(new Date(), store.settings().workspace.timezone), { ttsChars: text.length })

	const cacheVoiceId = provider === 'fishaudio' ? fishVoice : (providerVoiceId(o.voice) || o.voice || 'default')
	const cacheKey = getTtsCacheKey(provider, cacheVoiceId, text)
	const cached = useCache ? getCachedTts(cacheKey) : null

	if (cached) {
		if (cached.ext === 'wav') {
			fs.writeFileSync(rawFile, cached.buffer)
		} else {
			const tmpMp3 = path.join(ensureDir(PATHS.tmp), 'tts_c_' + uid('', 8) + '.mp3')
			fs.writeFileSync(tmpMp3, cached.buffer)
			await ff.run(['-i', tmpMp3, '-ar', '48000', '-ac', '2', rawFile])
			try {
				fs.unlinkSync(tmpMp3)
			} catch (e) {}
		}
		simulated = false
	} else if (provider === 'fishaudio' && fishKey) {
		try {
			const fishBase = String(c.baseUrl || '').replace(/\/+$/, '') || 'https://api.fish.audio/v1/tts'
			const buffer = await fetchBinary(fishBase, {
				headers: {
					Authorization: 'Bearer ' + fishKey,
					'Content-Type': 'application/json',
				},
				body: {
					text: text,
					reference_id: fishVoice,
					format: 'mp3',
				},
			})
			const tmpMp3 = path.join(ensureDir(PATHS.tmp), 'tts_f_' + uid('', 8) + '.mp3')
			fs.writeFileSync(tmpMp3, buffer)
			await ff.run(['-i', tmpMp3, '-ar', '48000', '-ac', '2', rawFile])
			try {
				fs.unlinkSync(tmpMp3)
			} catch (e) {}
			if (useCache) saveTtsCache(cacheKey, buffer, 'mp3')
			simulated = false
		} catch (fishErr) {
			console.error('Fish Audio error, fallback ke Google TTS:', fishErr.message)
			try {
				const mp3Buffer = await fetchGoogleTts(text, 'id')
				const tmpMp3 = path.join(ensureDir(PATHS.tmp), 'tts_g_' + uid('', 8) + '.mp3')
				fs.writeFileSync(tmpMp3, mp3Buffer)
				await ff.run(['-i', tmpMp3, '-ar', '48000', '-ac', '2', rawFile])
				try {
					fs.unlinkSync(tmpMp3)
				} catch (e) {}
				if (useCache) saveTtsCache(cacheKey, mp3Buffer, 'mp3')
				simulated = false
			} catch (err) {
				simulated = true
				await ff.placeholderNarration({ out: rawFile, duration: estimateSpeechSeconds(text, 2.6 * (o.speed || preset.speed || 1)), seed: text.length })
			}
		}
	} else if (provider === 'simulate' || !c.apiKey) {
		try {
			const mp3Buffer = await fetchGoogleTts(text, 'id')
			const tmpMp3 = path.join(ensureDir(PATHS.tmp), 'tts_g_' + uid('', 8) + '.mp3')
			fs.writeFileSync(tmpMp3, mp3Buffer)
			await ff.run(['-i', tmpMp3, '-ar', '48000', '-ac', '2', rawFile])
			try {
				fs.unlinkSync(tmpMp3)
			} catch (e) {}
			if (useCache) saveTtsCache(cacheKey, mp3Buffer, 'mp3')
			simulated = false
		} catch (err) {
			simulated = true
			await ff.placeholderNarration({ out: rawFile, duration: estimateSpeechSeconds(text, 2.6 * (o.speed || preset.speed || 1)), seed: text.length })
		}
	} else {
		const base = String(c.baseUrl || '').replace(/\/+$/, '')
		let buffer
		if (provider === 'elevenlabs') {
			buffer = await fetchBinary((base || 'https://api.elevenlabs.io') + '/v1/text-to-speech/' + providerVoiceId(o.voice), {
				headers: { 'xi-api-key': c.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
				body: { text: text, model_id: c.model || 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } },
			})
		} else if (provider === 'openai') {
			buffer = await fetchBinary((base || 'https://api.openai.com') + '/v1/audio/speech', {
				headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
				body: { model: c.model || 'gpt-4o-mini-tts', voice: providerVoiceId(o.voice) || 'alloy', input: text, speed: o.speed || preset.speed || 1, response_format: 'mp3' },
			})
		} else {
			if (!base) throw new Error('TTS base URL belum diisi di Settings')
			buffer = await fetchBinary(base, {
				headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
				body: { text: text, voice: providerVoiceId(o.voice), model: c.model || undefined, speed: o.speed || preset.speed || 1, style: o.style || undefined, language: o.language || 'id' },
			})
		}
		fs.writeFileSync(rawFile, buffer)
		if (useCache) saveTtsCache(cacheKey, buffer, 'mp3')
	}

	const wantNatural = o.naturalize === undefined ? c.naturalize !== false : Boolean(o.naturalize)
	if (wantNatural) {
		await ff.naturalizeAudio({
			input: rawFile,
			out: finalFile,
			preset: o.naturalPreset || preset.preset || c.naturalPreset || 'podcast-warm',
			pitch: o.pitch === undefined ? preset.pitch : o.pitch,
			speed: simulated ? 1 : o.speedFilter || 1,
			room: o.room || 0,
			denoise: Boolean(o.denoise),
		})
	} else {
		await ff.run(['-i', rawFile, '-ar', '48000', '-ac', '2', finalFile])
	}
	try {
		fs.unlinkSync(rawFile)
	} catch (err) {}
	return { file: finalFile, duration: await ff.durationOf(finalFile), provider: provider, simulated: simulated, text: text }
}

async function synthesizeMany(items, options) {
	const o = options || {}
	const results = []
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i]
		if (o.onProgress) o.onProgress(i, items.length, item)
		results.push(
			Object.assign(
				{},
				item,
				await synthesize({
					text: item.text,
					voice: item.voice || o.voice,
					speed: item.speed || o.speed,
					pitch: item.pitch === undefined ? o.pitch : item.pitch,
					naturalPreset: item.naturalPreset || o.naturalPreset,
					naturalize: o.naturalize,
					room: o.room,
					denoise: o.denoise,
					outDir: o.outDir,
				}),
			),
		)
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
		pitch: o.pitch || 0,
		speed: o.speed || 1,
		room: o.room || 0,
		denoise: o.denoise !== false,
	})
	return { file: out, duration: await ff.durationOf(out) }
}

async function testConnection() {
	const c = config()
	const fishKey = c.fishAudioApiKey || process.env.FISHAUDIO_API_KEY || (c.apiKey && String(c.apiKey).startsWith('') ? c.apiKey : '')
	if (c.provider === 'simulate' && !fishKey && !c.apiKey) return { ok: true, mode: 'simulate', message: 'Mode simulate aktif (suara Google TTS gratis). Isi API Fish Audio untuk suara AI lebih natural.' }
	try {
		const res = await synthesize({ text: 'Tes koneksi suara Fish Audio berhasil.', voice: 'nadia' })
		try {
			fs.unlinkSync(res.file)
		} catch (err) {}
		const mode = (c.provider === 'fishaudio' || fishKey) ? 'fishaudio' : c.provider
		return { ok: true, mode: mode, message: 'Koneksi ' + (mode === 'fishaudio' ? 'Fish Audio' : mode) + ' TTS berhasil!' }
	} catch (err) {
		return { ok: false, mode: c.provider, message: err.message }
	}
}

module.exports = {
	VOICE_PRESETS: VOICE_PRESETS,
	NATURAL_PRESETS: ff.NATURAL_PRESETS,
	synthesize: synthesize,
	synthesizeMany: synthesizeMany,
	transformUpload: transformUpload,
	testConnection: testConnection,
	voicePreset: voicePreset,
}
