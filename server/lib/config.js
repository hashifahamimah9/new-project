'use strict'

const fs = require('fs')
const path = require('path')
const { ensureDir } = require('./util')

const ROOT = path.resolve(__dirname, '..', '..')

function loadEnvFile() {
	const file = path.join(ROOT, '.env')
	if (!fs.existsSync(file)) return
	const raw = fs.readFileSync(file, 'utf8')
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eq = trimmed.indexOf('=')
		if (eq === -1) continue
		const key = trimmed.slice(0, eq).trim()
		let value = trimmed.slice(eq + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		if (process.env[key] === undefined) process.env[key] = value
	}
}

loadEnvFile()

const env = process.env
const bool = (value, fallback = false) => {
	if (value === undefined || value === '') return fallback
	return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}
const num = (value, fallback) => {
	const n = Number(value)
	return Number.isFinite(n) ? n : fallback
}

const PATHS = {
	root: ROOT,
	public: path.join(ROOT, 'public'),
	data: path.join(ROOT, 'data'),
	storage: path.join(ROOT, 'storage'),
	uploads: path.join(ROOT, 'storage', 'uploads'),
	renders: path.join(ROOT, 'storage', 'renders'),
	audio: path.join(ROOT, 'storage', 'audio'),
	music: path.join(ROOT, 'storage', 'music'),
	thumbs: path.join(ROOT, 'storage', 'thumbs'),
	tmp: path.join(ROOT, 'storage', 'tmp'),
	inbox: path.join(ROOT, 'storage', 'inbox'),
	cache: path.join(ROOT, 'cache'),
	storageCache: path.join(ROOT, 'storage', 'cache'),
	logs: path.join(ROOT, 'data', 'logs'),
	backups: path.join(ROOT, 'data', 'backups'),
	dbFile: path.join(ROOT, 'data', 'db.json'),
}

for (const dir of [
	PATHS.data,
	PATHS.storage,
	PATHS.uploads,
	PATHS.renders,
	PATHS.audio,
	PATHS.music,
	PATHS.thumbs,
	PATHS.tmp,
	PATHS.inbox,
	PATHS.cache,
	PATHS.storageCache,
	PATHS.logs,
]) {
	ensureDir(dir)
}

const SERVER = {
	port: num(env.PORT, 8787),
	host: env.HOST || '0.0.0.0',
	appName: env.APP_NAME || 'UGC Flow Studio',
	version: '1.1.0',
}

const FISH_TTS = !env.TTS_PROVIDER || /^(fish|fishaudio|simulate)$/i.test(String(env.TTS_PROVIDER).trim())

/** Settings are stored in the DB; these are the defaults / first-boot values from .env */
const DEFAULT_SETTINGS = {
	workspace: {
		appName: SERVER.appName,
		brandName: env.BRAND_NAME || '',
		language: env.APP_LANGUAGE || 'id',
		timezone: env.TIMEZONE || 'Asia/Jakarta',
		theme: 'dark',
	},
	auth: {
		enabled: bool(env.AUTH_ENABLED, false),
		password: env.AUTH_PASSWORD || '',
	},
	render: {
		resolution: env.RENDER_RESOLUTION || '1080',
		fps: num(env.RENDER_FPS, 30),
		preset: env.RENDER_PRESET || 'veryfast',
		crf: num(env.RENDER_CRF, 21),
		subtitleStyle: env.RENDER_SUBTITLE_STYLE || 'none',
		musicVolume: 0.12,
		voiceVolume: 1.0,
		watermark: false,
		watermarkText: '',
	},
	flow: {
		provider: env.FLOW_PROVIDER || 'simulate',
		baseUrl: env.FLOW_BASE_URL || '',
		apiKey: env.FLOW_API_KEY || '',
		videoModel: env.FLOW_VIDEO_MODEL || 'flow-ultra-video',
		imageModel: env.FLOW_IMAGE_MODEL || 'flow-ultra-image',
		videoPath: env.FLOW_VIDEO_PATH || '/v1/videos',
		imagePath: env.FLOW_IMAGE_PATH || '/v1/images',
		statusPath: env.FLOW_STATUS_PATH || '/v1/jobs/{id}',
		defaultLane: env.FLOW_DEFAULT_LANE || 'low',
		autoFallbackToLow: bool(env.FLOW_AUTO_FALLBACK_LOW, true),
		lowConcurrency: num(env.FLOW_LOW_CONCURRENCY, 2),
		standardConcurrency: num(env.FLOW_STANDARD_CONCURRENCY, 1),
		standardDailyLimit: num(env.FLOW_STANDARD_DAILY_LIMIT, 50),
		pollIntervalMs: num(env.FLOW_POLL_INTERVAL_MS, 5000),
		maxWaitMs: num(env.FLOW_MAX_WAIT_MS, 900000),
	},
	tts: {
		provider: env.TTS_PROVIDER || (env.FISHAUDIO_API_KEY ? 'fishaudio' : 'simulate'),
		baseUrl: env.TTS_BASE_URL || (env.FISHAUDIO_API_KEY ? 'https://api.fish.audio/v1/tts' : ''),
		apiKey: env.TTS_API_KEY || env.FISHAUDIO_API_KEY || '',
		model: env.TTS_MODEL || '',
		// Fish Audio: FISHAUDIO_VOICE_ID yang dipakai (TTS_DEFAULT_VOICE untuk ElevenLabs/OpenAI/custom)
		defaultVoice: (FISH_TTS && env.FISHAUDIO_VOICE_ID) || env.TTS_DEFAULT_VOICE || env.FISHAUDIO_VOICE_ID || '',
		fishAudioApiKey: env.FISHAUDIO_API_KEY || '',
		fishAudioVoiceId: env.FISHAUDIO_VOICE_ID || '',
		// voice kedua untuk podcast (Host B). Kosong = pakai voice default + pitch sedikit lebih rendah
		voiceMap: env.FISHAUDIO_VOICE_ID_2 ? { 'host-b': env.FISHAUDIO_VOICE_ID_2 } : {},
		cache: bool(env.TTS_CACHE, true),
		naturalize: bool(env.TTS_NATURALIZE, true),
		naturalPreset: 'podcast-warm',
	},
	llm: {
		provider: env.LLM_PROVIDER || (env.LLM_API_KEY && env.LLM_BASE_URL ? 'remote' : 'local'),
		baseUrl: env.LLM_BASE_URL || '',
		apiKey: env.LLM_API_KEY || '',
		model: env.LLM_MODEL || '',
	},
	stream: {
		rtmpUrl: env.YT_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2',
		streamKey: env.YT_STREAM_KEY || '',
		mode: env.STREAM_MODE || 'auto',
		videoBitrate: env.STREAM_VIDEO_BITRATE || '4500k',
		audioBitrate: env.STREAM_AUDIO_BITRATE || '128k',
		fps: num(env.STREAM_FPS, 30),
		resolution: env.STREAM_RESOLUTION || '1080',
		restartBackoffMs: num(env.STREAM_RESTART_BACKOFF_MS, 5000),
		maxRestarts: num(env.STREAM_MAX_RESTARTS, 0),
		healthCheckSeconds: 30,
	},
	queue: {
		concurrency: num(env.QUEUE_CONCURRENCY, 2),
		maxRetries: num(env.QUEUE_MAX_RETRIES, 1),
		paused: false,
	},
	notifications: {
		webhookUrl: env.NOTIFY_WEBHOOK_URL || '',
		onJobDone: true,
		onJobFailed: true,
		onStreamDown: true,
	},
}

const RESOLUTIONS = {
	'9:16': { 2160: [2160, 3840], 1440: [1440, 2560], 1080: [1080, 1920], 720: [720, 1280], 480: [480, 854] },
	'16:9': { 2160: [3840, 2160], 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720], 480: [854, 480] },
	'1:1': { 2160: [2160, 2160], 1440: [1440, 1440], 1080: [1080, 1080], 720: [720, 720], 480: [480, 480] },
	'4:5': { 2160: [2160, 2700], 1440: [1440, 1800], 1080: [1080, 1350], 720: [720, 900], 480: [480, 600] },
}

/**
 * Setting yang berasal dari .env. Kalau nilai di .env diubah (dibanding saat terakhir
 * server jalan), nilai baru otomatis dipakai walau sebelumnya sudah tersimpan di db.json.
 */
const ENV_SETTINGS = [
	['workspace.appName', ['APP_NAME']],
	['workspace.brandName', ['BRAND_NAME']],
	['workspace.language', ['APP_LANGUAGE']],
	['workspace.timezone', ['TIMEZONE']],
	['render.resolution', ['RENDER_RESOLUTION']],
	['render.fps', ['RENDER_FPS']],
	['render.preset', ['RENDER_PRESET']],
	['render.crf', ['RENDER_CRF']],
	['render.subtitleStyle', ['RENDER_SUBTITLE_STYLE']],
	['flow.provider', ['FLOW_PROVIDER']],
	['flow.baseUrl', ['FLOW_BASE_URL']],
	['flow.apiKey', ['FLOW_API_KEY']],
	['flow.videoModel', ['FLOW_VIDEO_MODEL']],
	['flow.imageModel', ['FLOW_IMAGE_MODEL']],
	['flow.videoPath', ['FLOW_VIDEO_PATH']],
	['flow.imagePath', ['FLOW_IMAGE_PATH']],
	['flow.statusPath', ['FLOW_STATUS_PATH']],
	['flow.defaultLane', ['FLOW_DEFAULT_LANE']],
	['flow.autoFallbackToLow', ['FLOW_AUTO_FALLBACK_LOW']],
	['flow.lowConcurrency', ['FLOW_LOW_CONCURRENCY']],
	['flow.standardConcurrency', ['FLOW_STANDARD_CONCURRENCY']],
	['flow.standardDailyLimit', ['FLOW_STANDARD_DAILY_LIMIT']],
	['flow.pollIntervalMs', ['FLOW_POLL_INTERVAL_MS']],
	['flow.maxWaitMs', ['FLOW_MAX_WAIT_MS']],
	['tts.provider', ['TTS_PROVIDER', 'FISHAUDIO_API_KEY']],
	['tts.baseUrl', ['TTS_BASE_URL']],
	['tts.apiKey', ['TTS_API_KEY', 'FISHAUDIO_API_KEY']],
	['tts.model', ['TTS_MODEL']],
	['tts.defaultVoice', ['TTS_DEFAULT_VOICE', 'FISHAUDIO_VOICE_ID']],
	['tts.fishAudioApiKey', ['FISHAUDIO_API_KEY']],
	['tts.fishAudioVoiceId', ['FISHAUDIO_VOICE_ID']],
	['tts.voiceMap.host-b', ['FISHAUDIO_VOICE_ID_2']],
	['tts.cache', ['TTS_CACHE']],
	['tts.naturalize', ['TTS_NATURALIZE']],
	['llm.provider', ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL']],
	['llm.baseUrl', ['LLM_BASE_URL']],
	['llm.apiKey', ['LLM_API_KEY']],
	['llm.model', ['LLM_MODEL']],
	['stream.rtmpUrl', ['YT_RTMP_URL']],
	['stream.streamKey', ['YT_STREAM_KEY']],
	['stream.mode', ['STREAM_MODE']],
	['stream.videoBitrate', ['STREAM_VIDEO_BITRATE']],
	['stream.audioBitrate', ['STREAM_AUDIO_BITRATE']],
	['stream.fps', ['STREAM_FPS']],
	['stream.resolution', ['STREAM_RESOLUTION']],
	['stream.restartBackoffMs', ['STREAM_RESTART_BACKOFF_MS']],
	['stream.maxRestarts', ['STREAM_MAX_RESTARTS']],
	['queue.concurrency', ['QUEUE_CONCURRENCY']],
	['queue.maxRetries', ['QUEUE_MAX_RETRIES']],
	['notifications.webhookUrl', ['NOTIFY_WEBHOOK_URL']],
]

function dimensionsFor(aspect = '9:16', resolution = '1080') {
	const table = RESOLUTIONS[aspect] || RESOLUTIONS['9:16']
	const dims = table[String(resolution)] || table['1080']
	return { width: dims[0], height: dims[1] }
}

const APP = {
	name: SERVER.appName,
	version: SERVER.version,
	port: SERVER.port,
	host: SERVER.host,
	timezone: env.TIMEZONE || 'Asia/Jakarta',
	maxUploadBytes: num(env.MAX_UPLOAD_MB, 2048) * 1024 * 1024,
	auth: {
		enabled: bool(env.AUTH_ENABLED, false),
		user: env.AUTH_USER || 'admin',
		password: env.AUTH_PASSWORD || '',
	},
}

module.exports = { ROOT, PATHS, SERVER, APP, DEFAULT_SETTINGS, RESOLUTIONS, ENV_SETTINGS, dimensionsFor }
