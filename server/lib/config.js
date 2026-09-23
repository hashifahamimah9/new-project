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
	version: '1.0.0',
}

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
		defaultVoice: env.TTS_DEFAULT_VOICE || env.FISHAUDIO_VOICE_ID || '',
		fishAudioApiKey: env.FISHAUDIO_API_KEY || '',
		fishAudioVoiceId: env.FISHAUDIO_VOICE_ID || '',
		cache: bool(env.TTS_CACHE, true),
		naturalize: bool(env.TTS_NATURALIZE, true),
		naturalPreset: 'podcast-warm',
	},
	llm: {
		provider: env.LLM_PROVIDER || 'local',
		baseUrl: env.LLM_BASE_URL || '',
		apiKey: env.LLM_API_KEY || '',
		model: env.LLM_MODEL || '',
	},
	stream: {
		rtmpUrl: env.YT_RTMP_URL || 'rtmp://a.rtmp.youtube.com/live2',
		streamKey: env.YT_STREAM_KEY || '',
		mode: env.STREAM_MODE || 'copy',
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
	'9:16': { 1080: [1080, 1920], 720: [720, 1280], 480: [480, 854] },
	'16:9': { 1080: [1920, 1080], 720: [1280, 720], 480: [854, 480] },
	'1:1': { 1080: [1080, 1080], 720: [720, 720], 480: [480, 480] },
	'4:5': { 1080: [1080, 1350], 720: [720, 900], 480: [480, 600] },
}

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

module.exports = { ROOT, PATHS, SERVER, APP, DEFAULT_SETTINGS, RESOLUTIONS, dimensionsFor }
