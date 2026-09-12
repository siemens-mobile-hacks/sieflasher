#!/usr/bin/env node
// E2E test matrix for the sieflasher CLI against emulated phones:
// pmb887x-emu (https://github.com/siemens-mobile-hacks/pmb887x-emu) is built
// and started directly on the host (no Docker needed) with a fullflash from
// the tests/fullflashes submodule, and its phone serial port is exposed on a
// local TCP port (the QEMU serial chardev).
//
// The matrix reads 512 KiB of the flash with `sieflasher read` at every
// speed the loader supports, for every supported fullflash, plus the whole
// fullflash at the maximum speed. Every dump must match the fullflash file
// byte for byte.
//
// The write tests (`write:` labels) mirror the read matrix with
// `sieflasher write`: a modified copy of the fullflash range is written at
// every speed, plus an unaligned range inside one flash block and one
// whole fullflash per phone at the maximum speed. The write is verified
// against the emulator's persisted flash copy after its exit: it must
// equal the input written over the original fullflash, byte for byte,
// everywhere — not just inside the written range. (A read back in a second
// CLI session is not possible: after the loader stop the emulated phone is
// dead until a power cycle, which the runner cannot do; the read path
// itself is covered by the read matrix.)
//
// --smoke keeps only the tests that run under a minute each (everything
// except the whole-fullflash reads and writes), for quick iteration.
//
// Every matrix entry runs as an independent test: its own emulator instance
// and its own TCP port, so the tests run fully isolated. The tests are
// executed in parallel, one test per CPU core (see --jobs).
//
// Usage: node run-e2e.mjs [--loader=<file.vkd>] [--jobs=N] [--only=<substr>] [--keep-emu] [--smoke]
// The same knobs exist as E2E_LOADER / E2E_JOBS / E2E_ONLY env.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fullflashesDir = path.join(testsDir, "fullflashes");
const emuBin = path.join(testsDir, ".emu", "build", "pmb887x-emu");
const cliDist = path.join(path.dirname(require.resolve("@sie-js/flasher-cli/package.json")), "dist", "index.js");

// The default loader (the .vkd wrapping the emulator-compatible boots);
// override with --loader=... / E2E_LOADER.
const defaultLoader = path.join(testsDir, "loaders", "emulator.vkd");

// Every speed of the loader's optBaudCmdCodes table.
const SPEEDS = [57600, 115200, 230400, 460800, 614400, 921600, 1228800, 1600000, 1500000, 3250000];

// One test set per fullflash. KE800v11b.bin (lg-ke800) is not supported by
// the loaders yet, so it is not run.
const PHONES = [
	{ phone: "EL71", fullflash: "EL71v41lg91.bin", device: "siemens-el71" },
	{ phone: "S75", fullflash: "S75v40lg1.bin", device: "siemens-s75" },
];

const READ_LENGTH = 512 * 1024;
const SERIAL_WAIT_TIMEOUT = 60_000;
const CLI_TIMEOUT_DEFAULT = 15 * 60_000;
// A whole-fullflash write is ~an hour of emulated flash erases per phone
// (measured: ~6 s per 128 KiB block), far beyond the default per-CLI budget.
const FULLFLASH_WRITE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function parseOptions(argv) {
	const options = {
		loader: process.env.E2E_LOADER ?? defaultLoader,
		jobs: Number(process.env.E2E_JOBS ?? 0) || os.cpus().length,
		only: process.env.E2E_ONLY ?? "",
		keepEmu: false,
		smoke: process.env.E2E_SMOKE == "1",
		cliTimeout: Number(process.env.E2E_CLI_TIMEOUT ?? 0) || CLI_TIMEOUT_DEFAULT,
	};
	for (const arg of argv) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
		if (!match)
			throw new Error(`unknown option: ${arg}`);
		// The option keys use the kebab-case form of the fields (--keep-emu).
		const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (!(key in options))
			throw new Error(`unknown option: ${arg}`);
		const value = match[2] ?? "true";
		if (key === "jobs")
			options.jobs = Number(value);
		else
			options[key] = value;
	}
	return options;
}

function run(command, args, opts = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...opts });
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	return result.stdout;
}

function runCli(args, timeoutMS) {
	return new Promise((resolve) => {
		const child = spawn("node", [cliDist, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (result) => {
			if (done)
				return;
			done = true;
			clearTimeout(timer);
			resolve({ ...result, stdout, stderr });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ status: null, killed: true });
		}, timeoutMS);
		child.stdout.on("data", (chunk) => stdout += chunk);
		child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", (error) => finish({ status: null, error }));
		child.on("close", (status) => finish({ status }));
	});
}

async function waitForSerialPort(port, timeoutMS) {
	const deadline = Date.now() + timeoutMS;
	while (Date.now() < deadline) {
		const connected = await new Promise((resolve) => {
			const socket = net.connect({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		if (connected)
			return;
		await delay(500);
	}
	throw new Error(`the emulator serial port 127.0.0.1:${port} did not open within ${timeoutMS} ms`);
}

// Reserves a free TCP port for the emulator serial chardev.
function allocatePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function startEmulator(test, port, flashPath) {
	// Headless hosts need a virtual X server for the QEMU GTK display (the
	// emulator frontend passes no -display none).
	const xvfb = !process.env.DISPLAY && spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim();
	const args = [];
	if (xvfb)
		args.push("-a", emuBin);
	args.push(
		"--device", test.device,
		"--fullflash", flashPath,
		// The emulator defaults for siemens-* devices (see its src/main.cpp).
		"--siemens-esn=12345678",
		"--siemens-imei=490154203237518",
		// The phone serial port on TCP (the QEMU serial chardev server).
		// --wait-for-serial holds the emulated phone in its boot ROM serial
		// monitor until the first byte arrives, so the CLI always catches the
		// service mode window no matter when it connects.
		"--serial", `tcp:127.0.0.1:${port},server=on,wait=off`,
		"--wait-for-serial",
	);
	// The write tests need a writable flash: --rw maps the fullflash as a
	// writable QEMU pflash drive (they always run on a private copy).
	if (test.op === "write")
		args.push("--rw");
	const emuLog = [];
	// detached: the emulator gets its own process group, so the whole tree
	// (xvfb-run -> Xvfb + qemu) can be stopped with a group kill.
	const emu = spawn(xvfb || emuBin, args, {
		detached: true,
		env: { ...process.env, QEMU_AUDIO_DRV: "none" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	emu.stdout.on("data", (chunk) => emuLog.push(chunk));
	emu.stderr.on("data", (chunk) => emuLog.push(chunk));
	return { emu, emuLog };
}

async function stopEmulator(emu, keepEmu) {
	if (!emu || emu.exitCode !== null)
		return;
	if (keepEmu) {
		emu.unref();
		return;
	}
	// Signal the whole process group (xvfb-run, Xvfb and QEMU).
	const killGroup = (signal) => {
		try {
			process.kill(-emu.pid, signal);
			return;
		} catch {
			emu.kill(signal);
		}
	};
	killGroup("SIGTERM");
	const exited = await Promise.race([
		new Promise((resolve) => emu.once("exit", () => resolve(true))),
		delay(5000).then(() => false),
	]);
	if (!exited)
		killGroup("SIGKILL");
}

function firstDifference(a, b) {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i])
			return i;
	}
	return a.length === b.length ? -1 : len;
}

function formatSize(size) {
	if (size >= 1024 * 1024 && size % (1024 * 1024) === 0)
		return `${size / (1024 * 1024)} MiB`;
	if (size >= 1024 && size % 1024 === 0)
		return `${size / 1024} KiB`;
	return `${size} B`;
}

// The write test input: the original fullflash range with a few chunks
// overwritten with a deterministic pattern, so the write must really change
// the flash while the untouched bytes must survive the block erases.
function makeWriteInput(expected, baseAddr, length) {
	const input = Buffer.from(expected.subarray(baseAddr, baseAddr + length));
	for (let off = 0x10000 - 0x1000; off < length; off += 0x10000) {
		for (let i = 0; i < 0x1000; i += 4)
			input.writeUInt32LE((0xDEADBEEF ^ (baseAddr + off + i)) >>> 0, off + i);
	}
	return input;
}

async function runTest(options, test) {
	const started = Date.now();
	const log = [];
	const say = (msg) => {
		log.push(msg);
		if (process.stdout.isTTY)
			console.log(`  [${test.label}] ${msg}`);
	};

	let emu = undefined;
	let failure;
	const emuLogRef = { log: [] };
	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `sieflasher-e2e-${test.label.replace(/[^a-z0-9]+/gi, "-")}-`));
	const output = path.join(outputDir, "read.bin");

	try {
		const port = await allocatePort();
		// The CLI budget: the per-test override (the whole-fullflash write
		// needs far more than the default) or the global option.
		const cliTimeout = test.cliTimeoutMS ?? options.cliTimeout;
		// The write tests modify the flash: the emulator gets --rw on its own
		// private copy of the fullflash, so the pristine submodule file never
		// changes. The read tests use the original fullflash read-only.
		const flashPath = test.op === "write"
			? path.join(outputDir, "flash.bin")
			: test.fullflashPath;
		if (test.op === "write")
			fs.copyFileSync(test.fullflashPath, flashPath);

		say(`starting pmb887x-emu (${test.device}) with the serial port on tcp/127.0.0.1:${port}`);
		const { emu: emuProcess, emuLog } = startEmulator(test, port, flashPath);
		emu = emuProcess;
		emuLogRef.log = emuLog;

		await waitForSerialPort(port, SERIAL_WAIT_TIMEOUT);

		// The CLI arguments shared by the read and the write flows.
		const commonArgs = [
			"--serial", `tcp://127.0.0.1:${port}`,
			"--loader", options.loader,
			"--phone", test.phone,
			"--baud", String(test.baud),
			"--base_addr", `0x${test.baseAddr.toString(16)}`,
			"--length", String(test.length),
		];

		if (test.op === "write") {
			// Write the modified input; the verification happens after the
			// emulator exit, against its persisted flash copy (see the finally
			// block below).
			const inputPath = path.join(outputDir, "input.bin");
			fs.writeFileSync(inputPath, makeWriteInput(test.expected, test.baseAddr, test.length));

			say(`the serial port is open, writing ${test.length === test.fullflashSize ? "the fullflash" : formatSize(test.length)} at ${test.baud}`);
			const result = await runCli(["write", ...commonArgs, inputPath], cliTimeout);
			if (result.status !== 0) {
				throw new Error(`sieflasher write failed (exit ${result.status ?? "killed"}):\n${result.stdout}${result.stderr}` +
					(result.killed ? `(timed out after ${cliTimeout} ms)\n` : ""));
			}
			say(`sieflasher write: ${result.stdout.trim()}`);
		} else {
			say(`the serial port is open, reading ${test.length === test.fullflashSize ? "the fullflash" : formatSize(test.length)} at ${test.baud}`);
			const result = await runCli(["read", ...commonArgs, output], cliTimeout);
			if (result.status !== 0) {
				throw new Error(`sieflasher read failed (exit ${result.status ?? "killed"}):\n${result.stdout}${result.stderr}` +
					(result.killed ? `(timed out after ${cliTimeout} ms)\n` : ""));
			}
			say(`sieflasher read: ${result.stdout.trim()}`);

			const actual = fs.readFileSync(output);
			if (actual.length !== test.length)
				throw new Error(`the dump has ${actual.length} bytes, expected ${test.length}`);
			const expected = test.expected.subarray(0, test.length);
			const diff = firstDifference(expected, actual);
			if (diff !== -1) {
				const preview = (buffer, at) => buffer.subarray(Math.max(0, at - 8), at + 16).toString("hex").toUpperCase();
				throw new Error(`the dump does not match the fullflash at offset 0x${diff.toString(16)}: ` +
					`expected ${preview(expected, diff)}, got ${preview(actual, diff)}`);
			}
			say("the dump matches the fullflash");
		}
	} catch (error) {
		failure = error;
	} finally {
		await stopEmulator(emu, options.keepEmu).catch(() => {});
		if (!failure && test.op === "write") {
			// The emulator persists its flash to the --rw backing file: after
			// its exit the copy must equal the input written over the original
			// fullflash, byte for byte, everywhere (not just in the range).
			try {
				const actual = fs.readFileSync(path.join(outputDir, "flash.bin"));
				const expected = Buffer.from(test.expected);
				expected.set(fs.readFileSync(path.join(outputDir, "input.bin")), test.baseAddr);
				const diff = firstDifference(expected, actual);
				if (diff !== -1)
					throw new Error(`the persisted fullflash does not match at offset 0x${diff.toString(16)}: ` +
					`expected ${expected.subarray(Math.max(0, diff - 8), diff + 16).toString("hex").toUpperCase()}, ` +
					`got ${actual.subarray(Math.max(0, diff - 8), diff + 16).toString("hex").toUpperCase()}`);
				say("the persisted fullflash matches");
			} catch (error) {
				failure = error;
			}
		}
		if (failure) {
			// Give the emulator a moment to flush its output.
			await delay(100);
			const emuOutput = Buffer.concat(emuLogRef?.log ?? []).toString().trimEnd();
			if (emuOutput)
				failure = new Error(`${failure.message}\nEmulator output:\n${emuOutput}`);
			fs.rmSync(outputDir, { recursive: true, force: true });
		}
	}

	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (failure)
		return { test, log, failure, seconds };
	if (!options.keepEmu)
		fs.rmSync(outputDir, { recursive: true, force: true });
	return { test, log, seconds };
}

async function main() {
	const options = parseOptions(process.argv.slice(2));

	if (!fs.existsSync(options.loader))
		throw new Error(`the loader ${options.loader} not found (pass --loader=<file.vkd>)`);

	// The fullflash dumps (a git submodule), read once for the comparisons.
	const expectedByFile = new Map();
	for (const entry of PHONES) {
		const file = path.join(fullflashesDir, entry.fullflash);
		if (!fs.existsSync(file))
			throw new Error(`fullflash ${file} not found; run: git submodule update --init`);
		entry.fullflashPath = file;
		entry.fullflashSize = fs.statSync(file).size;
		entry.expected = fs.readFileSync(file);
		expectedByFile.set(file, entry);
	}

	// The matrix: every (phone, speed) does a 512 KiB read and a 512 KiB
	// write, plus an unaligned write inside one flash block (the
	// read-modify-write path), plus one whole-fullflash read and one
	// whole-fullflash write per phone at the maximum speed. The 512 KiB and
	// the sub-page tests take seconds to ~30 s each; the whole-fullflash
	// read takes a few minutes, and the whole-fullflash write ~an hour of
	// emulated flash erases, so it carries its own generous CLI timeout and
	// is queued last.
	//
	// --smoke keeps every test that runs under a minute per test (the
	// per-speed 512 KiB matrix and the sub-page writes) and drops only the
	// whole-fullflash tests: 42 of the 46 tests, a few minutes instead of
	// the ~1 h full run.
	const maxSpeed = SPEEDS[SPEEDS.length - 1];
	const tests = [];
	for (const entry of PHONES) {
		for (const baud of SPEEDS) {
			tests.push({ ...entry, op: "read", baseAddr: 0, label: `${entry.fullflash}@${baud}`, baud, length: READ_LENGTH });
			tests.push({ ...entry, op: "write", baseAddr: 0, label: `write:${entry.fullflash}@${baud}`, baud, length: READ_LENGTH });
		}
		tests.push({ ...entry, op: "write", baseAddr: 0x181234, label: `write:${entry.fullflash}@${maxSpeed}-subpage`, baud: maxSpeed, length: 64 * 1024 });
		if (options.smoke)
			continue;
		tests.push({ ...entry, op: "read", baseAddr: 0, label: `${entry.fullflash}@${maxSpeed}-fullflash`, baud: maxSpeed, length: entry.fullflashSize });
		tests.push({ ...entry, op: "write", baseAddr: 0, label: `write:${entry.fullflash}@${maxSpeed}-fullflash`, baud: maxSpeed, length: entry.fullflashSize, cliTimeoutMS: FULLFLASH_WRITE_TIMEOUT_MS });
	}

	const selected = options.only
		? tests.filter((test) => test.label.includes(options.only))
		: tests;
	if (!selected.length)
		throw new Error(`no tests match --only=${options.only}`);

	// The emulator (built once into tests/.emu).
	if (!fs.existsSync(emuBin)) {
		console.log("▸ Building pmb887x-emu (the first run takes a while)");
		run("bash", [path.join(testsDir, "scripts", "setup-emu.sh")], { stdio: "inherit" });
	}

	const jobs = Math.max(1, Math.min(options.jobs, selected.length));
	console.log(`▸ ${selected.length} test(s) on ${jobs} parallel job(s), loader ${options.loader}`);

	// A shared queue of tests, one test at a time per worker job
	// (one test per CPU core by default).
	let next = 0;
	const results = (await Promise.all(Array.from({ length: jobs }, async () => {
		const done = [];
		for (;;) {
			const index = next++;
			if (index >= selected.length)
				return done;
			const test = selected[index];
			console.log(`▸ [${test.label}] started`);
			const result = await runTest(options, test);
			console.log(result.failure
				? `▸ [${test.label}] FAILED (${result.seconds}s)`
				: `▸ [${test.label}] passed (${result.seconds}s)`);
			done.push(result);
		}
	}))).flat();

	console.log();
	for (const result of results.sort((a, b) => a.test.label.localeCompare(b.test.label))) {
		if (result.failure) {
			console.error(`✗ ${result.test.label}: ${result.failure.message.trim()}`);
			console.error();
		} else {
			console.log(`✓ ${result.test.label} (${result.seconds}s)`);
		}
	}

	const failed = results.filter((result) => result.failure);
	if (failed.length) {
		console.error(`\nFAILED: ${failed.length} of ${results.length} test(s)`);
		process.exit(1);
	}
	console.log(`\nPASSED: ${results.length} test(s)`);
	process.exit(0);
}

main().catch((error) => {
	console.error(`FAILED: ${error.message}`);
	process.exit(1);
});
