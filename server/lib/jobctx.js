'use strict'

/**
 * Konteks job yang sedang berjalan (AsyncLocalStorage).
 * Dipakai supaya proses ffmpeg / request HTTP yang dijalankan di dalam sebuah job
 * bisa langsung dihentikan ketika job dibatalkan dari dashboard.
 */

const { AsyncLocalStorage } = require('async_hooks')

const als = new AsyncLocalStorage()

function create(jobId) {
	return { jobId: jobId, children: new Set(), listeners: new Set(), canceled: false }
}

function run(ctx, fn) {
	return als.run(ctx, fn)
}

function current() {
	return als.getStore() || null
}

function canceledError() {
	const err = new Error('Job dibatalkan')
	err.canceled = true
	return err
}

function isCanceled() {
	const ctx = current()
	return Boolean(ctx && ctx.canceled)
}

function throwIfCanceled() {
	if (isCanceled()) throw canceledError()
}

function killChild(child) {
	try {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
	} catch (err) {}
}

/** Daftarkan child process ke job aktif (kalau ada). */
function track(child) {
	const ctx = current()
	if (!ctx || !child) return
	ctx.children.add(child)
	child.once('close', function () {
		ctx.children.delete(child)
	})
	if (ctx.canceled) killChild(child)
}

/**
 * Jalankan fn ketika job aktif dibatalkan (misal abort request HTTP).
 * Mengembalikan fungsi untuk melepas listener.
 */
function onCancel(fn) {
	const ctx = current()
	if (!ctx || typeof fn !== 'function') return function () {}
	if (ctx.canceled) {
		try {
			fn()
		} catch (err) {}
		return function () {}
	}
	ctx.listeners.add(fn)
	return function () {
		ctx.listeners.delete(fn)
	}
}

/** Tandai job batal lalu matikan semua proses ffmpeg + request miliknya. */
function cancel(ctx) {
	if (!ctx) return 0
	ctx.canceled = true
	let killed = 0
	ctx.children.forEach(function (child) {
		killChild(child)
		killed += 1
	})
	ctx.listeners.forEach(function (fn) {
		try {
			fn()
		} catch (err) {}
	})
	ctx.listeners.clear()
	return killed
}

/** sleep yang berhenti lebih cepat kalau job dibatalkan. */
function sleep(ms) {
	return new Promise(function (resolve, reject) {
		let off = function () {}
		const timer = setTimeout(function () {
			off()
			resolve()
		}, Math.max(0, Number(ms) || 0))
		off = onCancel(function () {
			clearTimeout(timer)
			reject(canceledError())
		})
	})
}

module.exports = { create, run, current, track, cancel, isCanceled, throwIfCanceled, canceledError, onCancel, sleep }
