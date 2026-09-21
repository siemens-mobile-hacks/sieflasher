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
// The patch tests apply the real VKP patches of the tests/patches submodule
// (github.com/siemens-mobile-hacks/patches) with `sieflasher apply`: every
// patch of the firmware of the fullflash, each on its own fresh copy of it,
// each verified against the flash afterwards, byte for byte.
//
// Every patch is applied to the copy as a file (`patch-file:` labels,
// `sieflasher apply --file`), which takes seconds, and reverted again to
// check that the fullflash is restored. The 10 most unusual ones per phone
// (`patch:` labels, see patchUnusualness) are additionally applied in a real
// flasher session and checked against the flash the emulator persisted; the
// most unusual patch of every phone is also reverted over the serial port,
// in a second emulator session.
//
// Patches that do not apply cleanly (their old data is not in this
// fullflash, or they do not even parse) are not failures: such a patch is
// expected to change nothing, and its status is tracked in
// tests/patches-status.json. A patch whose status differs from the tracked
// one fails the run; --update-patch-status rewrites the file from the
// results.
//
// Every phone also has a `patch-recovery:` test: a patch that does not apply
// cleanly to its fullflash is forced through with --yes over the serial
// port, which must save a recovery patch before the first write, and undoing
// that recovery patch must restore the fullflash byte for byte. When all the
// patches of the firmware apply cleanly (EL71v41), a patch of another
// firmware version of the same model is used.
//
// --smoke keeps only the tests that run under a minute each (everything
// except the whole-fullflash reads and writes and the serial patches other
// than the round trip and the recovery test), for quick iteration.
//
// Every matrix entry runs as an independent test: its own emulator instance
// and its own TCP port, so the tests run fully isolated. The tests are
// executed in parallel, one test per CPU core (see --jobs).
//
// Usage: node run-e2e.mjs [--loader=<file.vkd>] [--jobs=N] [--only=<substr>] [--keep-emu] [--smoke]
//                         [--emu=<pmb887x-emu>] [--update-patch-status]
// The same knobs exist as E2E_LOADER / E2E_JOBS / E2E_ONLY / E2E_EMU env.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseVkd } from "@sie-js/flasher";
import { vkpNormalize, vkpParse } from "@sie-js/vkp";

const require = createRequire(import.meta.url);

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fullflashesDir = path.join(testsDir, "fullflashes");
// The patches submodule: patches/<firmware>/<id>-<name>.vkp.
const patchesDir = path.join(testsDir, "patches", "patches");
// The tracked status of the patches that do not apply cleanly.
const patchStatusFile = path.join(testsDir, "patches-status.json");
// The emulator built by scripts/setup-emu.sh; --emu / E2E_EMU runs another
// one instead (an installation of the package, or a build of its own when
// tests/.emu is shared with a machine whose libraries differ).
const defaultEmuBin = path.join(testsDir, ".emu", "build", "pmb887x-emu");
// Resolved from the options before the first test starts.
let emuBin = "";
const cliDist = path.join(path.dirname(require.resolve("@sie-js/flasher-cli/package.json")), "dist", "index.js");

// The default loader (the .vkd wrapping the emulator-compatible boots);
// override with --loader=... / E2E_LOADER.
const defaultLoader = path.join(testsDir, "loaders", "emulator.vkd");

// Every speed of the loader's optBaudCmdCodes table.
const SPEEDS = [57600, 115200, 230400, 460800, 614400, 921600, 1228800, 1600000, 1500000, 3250000];

// One test set per fullflash. KE800v11b.bin (lg-ke800) is not supported by
// the loaders yet, so it is not run. `patches` names the directory of the
// patches submodule with the patches of exactly this firmware.
const PHONES = [
	{ phone: "EL71", fullflash: "EL71v41lg91.bin", device: "siemens-el71", patches: "EL71v41" },
	{ phone: "S75", fullflash: "S75v40lg1.bin", device: "siemens-s75", patches: "S75v40" },
];

const READ_LENGTH = 512 * 1024;
// The smallest erase block of the supported phones, for the patch ranking.
const FLASH_BLOCK_SIZE = 128 * 1024;
// How many patches per phone are applied over the serial port (the most
// unusual ones, see patchUnusualness); the rest are applied to a file.
const SERIAL_PATCHES_PER_PHONE = 10;
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
		emu: process.env.E2E_EMU ?? "",
		keepEmu: false,
		smoke: process.env.E2E_SMOKE == "1",
		updatePatchStatus: false,
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

function runCli(args, timeoutMS, env) {
	return new Promise((resolve) => {
		const child = spawn("node", [cliDist, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			...(env ? { env: { ...process.env, ...env } } : {}),
		});
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

async function waitForSerialPort(port, timeoutMS, emu) {
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
		// An emulator that died (no X server, no free display, a bad
		// fullflash) never opens its port: say so instead of waiting out the
		// whole timeout.
		if (emu && emu.exitCode !== null)
			throw new Error(`the emulator exited with ${emu.exitCode} before opening its serial port`);
		await delay(500);
	}
	throw new Error(`the emulator serial port 127.0.0.1:${port} did not open within ${timeoutMS} ms`);
}

// A binary that does not start here (a build of tests/.emu carried over
// from another machine: "libaio.so.1t64: cannot open shared object file")
// used to surface as every single emulator dying on startup, so it is
// checked once, up front. The QEMU next to it only starts when a phone
// boots, far too late to tell a missing library from a broken test.
function whyNotRunnable(bin) {
	if (!fs.existsSync(bin))
		return `the emulator ${bin} does not exist`;
	for (const binary of [bin, path.join(path.dirname(bin), "qemu-install", "bin", "qemu-system-arm")]) {
		if (!fs.existsSync(binary))
			continue;
		const probe = spawnSync(binary, ["--version"], { encoding: "utf8" });
		if (probe.status === 0)
			continue;
		const why = (probe.stderr || probe.error?.message || "").trim().split("\n")[0];
		return `${binary} does not start here${why ? `: ${why}` : ""}`;
	}
	return undefined;
}

function resolveEmuBin(options) {
	if (!options.emu && !fs.existsSync(defaultEmuBin)) {
		console.log("▸ Building pmb887x-emu (the first run takes a while)");
		run("bash", [path.join(testsDir, "scripts", "setup-emu.sh")], { stdio: "inherit" });
	}
	const bin = options.emu || defaultEmuBin;
	const problem = whyNotRunnable(bin);
	if (problem)
		throw new Error(`${problem}\nBuild it with tests/scripts/setup-emu.sh or pass --emu=/path/to/pmb887x-emu`);
	return bin;
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

// The virtual X server of the run (see startXvfb): one for all the tests,
// instead of the xvfb-run of every single emulator.
let xvfbProcess;

// Headless hosts need an X server for the QEMU GTK display (the emulator
// frontend passes no -display none). One Xvfb is started for the whole run
// and exported as DISPLAY: `xvfb-run -a` per emulator used to leave its Xvfb
// behind on the group kill, and with every leftover the display scan of the
// next one got slower until the emulators stopped coming up at all.
async function startXvfb() {
	if (process.env.DISPLAY)
		return;
	if (!spawnSync("which", ["Xvfb"], { encoding: "utf8" }).stdout.trim()) {
		console.log("▸ neither DISPLAY nor Xvfb: the emulator may fail to start (install xvfb)");
		return;
	}
	// -displayfd lets the server pick a free display itself and report it
	// back, so parallel runs cannot race for the same number.
	const xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
		detached: true,
		stdio: ["ignore", "ignore", "pipe", "pipe"],
	});
	const display = await new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => reject(new Error("Xvfb did not report its display within 30 s")), 30_000);
		xvfb.stdio[3].on("data", (chunk) => {
			out += chunk;
			if (!out.includes("\n"))
				return;
			clearTimeout(timer);
			resolve(out.trim());
		});
		xvfb.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Xvfb exited with ${code}`));
		});
	});
	xvfbProcess = xvfb;
	process.env.DISPLAY = `:${display}`;
	console.log(`▸ Xvfb on DISPLAY=${process.env.DISPLAY}`);
}

function stopXvfb() {
	if (!xvfbProcess)
		return;
	try {
		process.kill(-xvfbProcess.pid, "SIGTERM");
	} catch {
		xvfbProcess.kill("SIGTERM");
	}
	xvfbProcess = undefined;
}

function startEmulator(test, port, flashPath) {
	const args = [];
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
	// The write and patch tests need a writable flash: --rw maps the
	// fullflash as a writable QEMU pflash drive (they always run on a
	// private copy).
	if (test.op !== "read")
		args.push("--rw");
	const emuLog = [];
	// detached: the emulator gets its own process group, so it and its QEMU
	// can be stopped with a group kill.
	const emu = spawn(emuBin, args, {
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
	// Signal the whole process group (the emulator and its QEMU).
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

// ---------------------------------------------------------------------
// The patch tests.

// The status of a patch on a fullflash:
//   applied - it was written and the flash matches the patch afterwards
//   noop    - the phone already has the new data (nothing to apply)
//   dirty   - the old data of the patch is not in this flash: the CLI warns
//             and writes nothing without a confirmation
//   invalid - the patch does not parse
//   outside - the patch addresses are outside of the flash
// Everything but "applied" is tracked in tests/patches-status.json.
const PATCH_STATUSES = ["applied", "noop", "dirty", "invalid", "outside"];

function loadPatchStatus() {
	if (!fs.existsSync(patchStatusFile))
		return {};
	const data = JSON.parse(fs.readFileSync(patchStatusFile, "utf8"));
	const tracked = {};
	for (const [firmware, patches] of Object.entries(data)) {
		if (firmware.startsWith("_"))
			continue;
		tracked[firmware] = patches;
	}
	return tracked;
}

function savePatchStatus(tracked) {
	const sorted = { _comment: PATCH_STATUS_COMMENT };
	for (const firmware of Object.keys(tracked).sort()) {
		const patches = tracked[firmware];
		const names = Object.keys(patches).sort();
		if (!names.length)
			continue;
		sorted[firmware] = Object.fromEntries(names.map((name) => [name, patches[name]]));
	}
	fs.writeFileSync(patchStatusFile, JSON.stringify(sorted, null, "\t") + "\n");
}

const PATCH_STATUS_COMMENT =
	"The patches of tests/patches that do not apply cleanly to the fullflashes of tests/fullflashes, " +
	"per firmware: noop = already applied, dirty = the old data of the patch is not in this flash, " +
	"invalid = the patch does not parse, outside = the patch addresses are outside of the flash. " +
	"Patches that apply cleanly are not listed. Regenerate with: node run-e2e.mjs --update-patch-status";

// The patch text, decoded like the CLI does it: UTF-8 when the bytes are
// valid UTF-8, cp1251 (the canonical VKP encoding) otherwise.
function decodePatchText(raw) {
	const text = raw.toString("utf8");
	return text.includes("�") ? vkpNormalize(raw) : text.replace(/\r\n|\r/g, "\n");
}

// The writes of a patch, or an empty list when it does not parse (such a
// patch is expected to be rejected by the CLI).
function parsePatchWrites(file) {
	try {
		const vkp = vkpParse(decodePatchText(fs.readFileSync(file)), { allowEmptyOldData: true });
		return vkp.valid && !vkp.errors.length ? vkp.writes : [];
	} catch {
		return [];
	}
}

// How unusual a patch is, for picking the ones worth a real flasher session.
//
// A typical patch is one or two short writes inside a single flash block with
// the old data present. The rare ones — many blocks, long data, writes
// without old data (the recovery patch path), non-default pragmas — exercise
// far more of the flasher, so they are the ones applied over the serial port;
// everything else is applied to a fullflash file, which covers the same patch
// engine without an emulator.
function patchUnusualness(writes) {
	if (!writes.length)
		return -1;
	const bytes = writes.reduce((sum, write) => sum + write.new.length, 0);
	const blocks = new Set(writes.map((write) => Math.floor(write.addr / FLASH_BLOCK_SIZE))).size;
	const noOld = writes.filter((write) => !write.old).length;
	const pragmas = writes.filter((write) => write.pragmas &&
		Object.entries(write.pragmas).some(([name, value]) => value !== DEFAULT_PRAGMAS[name])).length;
	return writes.length + bytes / 16 + blocks * 16 + noOld * 8 + pragmas * 8;
}

// The parser defaults of the VKP pragmas (a write with anything else set is
// unusual).
const DEFAULT_PRAGMAS = {
	warn_no_old_on_apply: true,
	warn_if_new_exist_on_apply: true,
	warn_if_old_exist_on_undo: true,
	undo: true,
	old_equal_ff: false,
};

// What the CLI run says about the patch.
function classifyPatchRun(result) {
	const output = `${result.stdout}${result.stderr}`;
	if (result.killed)
		return { status: "failed", reason: "the CLI timed out" };
	if (result.status === 0) {
		if (/the patch is already applied|the patch is not applied/.test(result.stdout))
			return { status: "noop", reason: "the phone already has the new data of the patch" };
		return { status: "applied", reason: "" };
	}
	const warning = /^! (WARNING: .*)$/m.exec(output);
	if (/cancelled, nothing was written/.test(output))
		return { status: "dirty", reason: warning ? warning[1] : "the patch does not apply cleanly" };
	if (/is not a valid patch|cannot parse/.test(output)) {
		const error = /^.*: error: (.*)$/m.exec(output) ?? /^.*: warning: (.*)$/m.exec(output);
		return { status: "invalid", reason: error ? error[1] : "the patch does not parse" };
	}
	const outside = /write\(s\) are outside/.test(output) && /^sieflasher: .*?: (\d+ of \d+ write\(s\) are outside)/m.exec(output);
	if (outside)
		return { status: "outside", reason: outside[1] };
	return { status: "failed", reason: `sieflasher exited with ${result.status ?? "a signal"}` };
}

// Whether the patch fits the fullflash, following the rule of
// applyVkpToDevice: a patch address is the offset from the flash start, so a
// fullflash dump is indexed by it directly.
function patchFits(writes, size) {
	return writes.every((write) => write.addr >= 0 && write.addr + write.new.length <= size);
}

// The fullflash as it must look after the patch was applied.
function patchedFullflash(original, writes) {
	if (!patchFits(writes, original.length))
		throw new Error("the patch does not fit the fullflash");
	const expected = Buffer.from(original);
	for (const write of writes)
		expected.set(write.new, write.addr);
	return expected;
}

// Whether applying this patch to this fullflash warns the user: some of its
// blocks have no old data (the undo would be impossible), or their old data
// is not what the flash holds. The CLI then writes nothing without a
// confirmation, and saves a recovery patch when it is confirmed. This mirrors
// the classification of applyVkpToDevice, so the recovery test can pick its
// patch without asking a phone first.
function patchWarnsOn(writes, flash) {
	if (!patchFits(writes, flash.length))
		return false;
	for (const write of writes) {
		const current = flash.subarray(write.addr, write.addr + write.new.length);
		// A block that already holds the new data is skipped silently.
		if (current.equals(write.new))
			continue;
		if (!write.old || !current.equals(write.old))
			return true;
	}
	return false;
}

// The patch of the recovery test: one that does not apply cleanly to this
// fullflash. Every phone gets one, so when all the patches of its firmware
// apply cleanly (EL71v41), the patches of the other firmware versions of the
// same model are taken - applying one of those is exactly the situation the
// recovery patch exists for.
function pickRecoveryPatch(entry, ownPatches) {
	const model = entry.patches.replace(/v\d+[a-z]*$/i, "");
	const siblings = fs.readdirSync(patchesDir)
		.filter((dir) => dir !== entry.patches && new RegExp(`^${model}v\\d+`, "i").test(dir))
		.sort();
	const candidates = [
		...ownPatches.map((patch) => ({ ...patch, firmware: entry.patches })),
		...siblings.flatMap((firmware) => fs.readdirSync(path.join(patchesDir, firmware))
			.filter((name) => name.toLowerCase().endsWith(".vkp"))
			.sort()
			.map((name) => ({ name, firmware, patchPath: path.join(patchesDir, firmware, name) }))),
	];
	for (const candidate of candidates) {
		const writes = candidate.writes ?? parsePatchWrites(candidate.patchPath);
		if (writes.length && patchWarnsOn(writes, entry.expected))
			return { ...candidate, writes };
	}
	return undefined;
}

// One emulator session: a fresh emulator on the given flash file, one CLI
// command over its serial port, and the emulator stopped afterwards so that
// it flushes the flash back into the file.
async function emulatorSession(options, test, flashPath, command, cliArgs, cliTimeout, say, env) {
	const port = await allocatePort();
	say(`starting pmb887x-emu (${test.device}) with the serial port on tcp/127.0.0.1:${port}`);
	const { emu, emuLog } = startEmulator(test, port, flashPath);
	try {
		await waitForSerialPort(port, SERIAL_WAIT_TIMEOUT, emu);
		const result = await runCli([command, "--serial", `tcp://127.0.0.1:${port}`, ...cliArgs], cliTimeout, env);
		return { result, emuLog };
	} finally {
		// Always stopped, even with --keep-emu: the flash file is only written
		// back on exit, and a second session (the patch round trip) starts its
		// own emulator on that very file.
		await stopEmulator(emu, false).catch(() => {});
		await delay(200);
	}
}

async function runPatchTest(options, test) {
	const started = Date.now();
	const log = [];
	const say = (msg) => {
		log.push(msg);
		if (process.stdout.isTTY)
			console.log(`  [${test.label}] ${msg}`);
	};

	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), `sieflasher-e2e-${test.label.replace(/[^a-z0-9]+/gi, "-")}-`));
	const flashPath = path.join(outputDir, "flash.bin");
	fs.copyFileSync(test.fullflashPath, flashPath);
	// Every run keeps its patch history and its recovery patches inside the
	// test directory instead of the home directory of the user.
	const env = { SIEFLASHER_HOME: path.join(outputDir, "sieflasher") };
	const cliTimeout = test.cliTimeoutMS ?? options.cliTimeout;

	let emuLogRef = [];
	// One CLI run against the fresh copy of the fullflash: over the serial
	// port of a fresh emulator, or directly on the copy as a file. Both leave
	// the result in flashPath.
	const session = async (command, args = [], patchPath = test.patchPath) => {
		if (test.target === "file") {
			return runCli([
				command,
				"--file", flashPath,
				...args,
				patchPath,
			], cliTimeout, env);
		}
		const { result, emuLog } = await emulatorSession(options, test, flashPath, command, [
			"--loader", options.loader,
			"--phone", test.phone,
			"--baud", String(test.baud),
			...args,
			patchPath,
		], cliTimeout, say, env);
		emuLogRef = emuLog;
		return result;
	};

	// The comparison of the flash against what the run should have left there.
	const mustEqual = (expected, what) => {
		const actual = fs.readFileSync(flashPath);
		const diff = firstDifference(expected, actual);
		if (diff === -1)
			return;
		const preview = (buffer, at) => buffer.subarray(Math.max(0, at - 8), at + 16).toString("hex").toUpperCase();
		throw new Error(`${what} at offset 0x${diff.toString(16)}: ` +
			`expected ${preview(expected, diff)}, got ${preview(actual, diff)}`);
	};

	let failure;
	let status = "failed";
	let reason = "";
	try {
		if (test.recovery) {
			// The recovery patch flow: a patch that does not apply cleanly is
			// forced through with --yes, which must save a recovery patch
			// before the first write; undoing that recovery patch must restore
			// the fullflash byte for byte.
			say(`applying ${test.patchName} with --yes (it does not apply cleanly)`);
			const applied = await session("apply", ["--yes"]);
			if (applied.status !== 0) {
				throw new Error(`sieflasher apply --yes failed (exit ${applied.status ?? "killed"}):\n` +
					`${applied.stdout}${applied.stderr}`);
			}
			mustEqual(patchedFullflash(test.expected, test.writes),
				"the forced patch does not match the fullflash");

			const recoveryDir = path.join(env.SIEFLASHER_HOME, "recovery");
			const saved = fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir) : [];
			if (saved.length !== 1)
				throw new Error(`expected exactly one recovery patch in ${recoveryDir}, got ${saved.length}`);
			say(`recovery patch saved: ${saved[0]}`);

			say("undoing the recovery patch");
			const restored = await session("revert", [], path.join(recoveryDir, saved[0]));
			if (restored.status !== 0) {
				throw new Error(`sieflasher revert of the recovery patch failed (exit ${restored.status ?? "killed"}):\n` +
					`${restored.stdout}${restored.stderr}`);
			}
			mustEqual(test.expected, "the recovery patch did not restore the fullflash");
			say("the recovery patch restored the fullflash");

			const seconds = ((Date.now() - started) / 1000).toFixed(1);
			if (!options.keepEmu)
				fs.rmSync(outputDir, { recursive: true, force: true });
			return { test, log, seconds };
		}

		say(`applying ${test.patchName}`);
		const applied = await session("apply");
		({ status, reason } = classifyPatchRun(applied));
		if (status === "failed") {
			throw new Error(`sieflasher apply failed (exit ${applied.status ?? "killed"}):\n` +
				`${applied.stdout}${applied.stderr}`);
		}
		say(`sieflasher apply: ${status}${reason ? `: ${reason}` : ""}`);

		// The flash the emulator persisted (or the patched dump) must hold the
		// patch when it was applied, and be untouched in every other case (a
		// patch that does not apply cleanly must never write anything).
		mustEqual(
			status === "applied" ? patchedFullflash(test.expected, test.writes) : test.expected,
			status === "applied"
				? "the patched fullflash does not match"
				: `the patch was not applied (${status}) but the fullflash changed`);
		say(status === "applied" ? "the patched fullflash matches" : "the fullflash is untouched");

		// The round trip: undo the patch again (over the serial port that
		// needs a second emulator session — the emulated phone is dead after
		// the loader stop of the first one) and compare against the original
		// fullflash.
		if (test.roundtrip && status === "applied") {
			say(`reverting ${test.patchName}`);
			const reverted = await session("revert");
			if (reverted.status !== 0) {
				throw new Error(`sieflasher revert failed (exit ${reverted.status ?? "killed"}):\n` +
					`${reverted.stdout}${reverted.stderr}`);
			}
			mustEqual(test.expected, "the reverted fullflash does not match the original");
			say("the reverted fullflash matches the original");
		}
	} catch (error) {
		failure = error;
	}

	if (failure) {
		await delay(100);
		const emuOutput = Buffer.concat(emuLogRef ?? []).toString().trimEnd();
		if (emuOutput)
			failure = new Error(`${failure.message}\nEmulator output:\n${emuOutput}`);
	}
	if (!options.keepEmu)
		fs.rmSync(outputDir, { recursive: true, force: true });

	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	return { test, log, failure, seconds, patch: { status, reason } };
}

async function runTest(options, test) {
	if (test.op === "patch")
		return runPatchTest(options, test);

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

		await waitForSerialPort(port, SERIAL_WAIT_TIMEOUT, emu);

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

// The patch summary: what every patch did, and whether that still matches
// tests/patches-status.json. A patch that stopped (or started) applying
// cleanly fails its test here, so that a regression of the patch engine
// cannot hide behind "this patch never applied anyway".
function reportPatchStatus(options, results) {
	const patchResults = results.filter((result) => result.patch);
	if (!patchResults.length)
		return;

	if (options.updatePatchStatus) {
		const updated = loadPatchStatus();
		for (const result of patchResults) {
			if (result.failure)
				continue;
			const firmware = result.test.patchFirmware;
			updated[firmware] ??= {};
			if (result.patch.status === "applied")
				delete updated[firmware][result.test.patchName];
			else
				updated[firmware][result.test.patchName] = { status: result.patch.status, reason: result.patch.reason };
		}
		savePatchStatus(updated);
		console.log(`\n▸ updated ${patchStatusFile}`);
	} else {
		const tracked = loadPatchStatus();
		for (const result of patchResults) {
			if (result.failure)
				continue;
			const expected = tracked[result.test.patchFirmware]?.[result.test.patchName];
			const actual = result.patch.status;
			const now = `"${actual}"${result.patch.reason ? ` (${result.patch.reason})` : ""}`;
			if (expected ? expected.status === actual : actual === "applied")
				continue;
			result.failure = new Error(expected
				? `the patch status changed: tracked "${expected.status}" (${expected.reason}), now ${now}\n` +
					`  update tests/patches-status.json (node run-e2e.mjs --update-patch-status) when this is intended`
				: `the patch does not apply cleanly any more: ${now}\n` +
					`  update tests/patches-status.json (node run-e2e.mjs --update-patch-status) when this is intended`);
		}
	}

	const counts = new Map(PATCH_STATUSES.map((status) => [status, 0]));
	for (const result of patchResults) {
		if (!result.failure || result.patch.status !== "failed")
			counts.set(result.patch.status, (counts.get(result.patch.status) ?? 0) + 1);
	}
	console.log("\n▸ patches: " + [...counts]
		.filter(([, count]) => count > 0)
		.map(([status, count]) => `${count} ${status}`)
		.join(", "));
	for (const result of patchResults.filter((r) => r.patch.status !== "applied" && r.patch.status !== "failed"))
		console.log(`  ${result.test.patchFirmware}/${result.test.patchName}: ${result.patch.status}: ${result.patch.reason}`);
}

async function main() {
	const options = parseOptions(process.argv.slice(2));

	if (!fs.existsSync(options.loader))
		throw new Error(`the loader ${options.loader} not found (pass --loader=<file.vkd>)`);

	// The fullflash dumps (a git submodule), read once for the comparisons.
	const expectedByFile = new Map();
	// The loader must know every phone of the matrix; without this check the
	// first failure would come from a CLI run, once per test.
	const vkd = parseVkd(fs.readFileSync(options.loader, "latin1"));
	for (const entry of PHONES) {
		const file = path.join(fullflashesDir, entry.fullflash);
		if (!fs.existsSync(file))
			throw new Error(`fullflash ${file} not found; run: git submodule update --init`);
		if (!vkd.phones.some((phone) => phone.name.toLowerCase() === entry.phone.toLowerCase()))
			throw new Error(`the loader ${options.loader} has no phone "${entry.phone}"`);
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
	// The patch matrix applies every patch of the firmware of the fullflash,
	// each on its own fresh copy of it: all of them on the copy as a file
	// (seconds each, undone again afterwards), and the 10 most unusual ones
	// per phone (see patchUnusualness) additionally in a real flasher session
	// at the maximum speed. The most unusual patch of every phone is also
	// undone over the serial port in a second emulator session and must
	// restore the fullflash byte for byte, and one patch that does not apply
	// cleanly is forced through to check the recovery patch.
	//
	// --smoke keeps every test that runs under a minute per test (the
	// per-speed 512 KiB matrix, the sub-page writes, all the file patches,
	// one patch round trip and the recovery test per phone) and drops the
	// whole-fullflash tests and the other serial patches: a few minutes
	// instead of the ~1 h full run.
	const maxSpeed = SPEEDS[SPEEDS.length - 1];
	const tracked = loadPatchStatus();
	const tests = [];
	for (const entry of PHONES) {
		for (const baud of SPEEDS) {
			tests.push({ ...entry, op: "read", baseAddr: 0, label: `${entry.fullflash}@${baud}`, baud, length: READ_LENGTH });
			tests.push({ ...entry, op: "write", baseAddr: 0, label: `write:${entry.fullflash}@${baud}`, baud, length: READ_LENGTH });
		}
		tests.push({ ...entry, op: "write", baseAddr: 0x181234, label: `write:${entry.fullflash}@${maxSpeed}-subpage`, baud: maxSpeed, length: 64 * 1024 });

		const patchDir = path.join(patchesDir, entry.patches);
		if (!fs.existsSync(patchDir))
			throw new Error(`the patches of ${entry.patches} not found in ${patchDir}; run: git submodule update --init`);
		const patchNames = fs.readdirSync(patchDir).filter((name) => name.toLowerCase().endsWith(".vkp")).sort();
		if (!patchNames.length)
			throw new Error(`no patches for ${entry.patches} in ${patchDir}`);
		const patches = patchNames.map((name) => {
			const patchPath = path.join(patchDir, name);
			return { name, patchPath, writes: parsePatchWrites(patchPath) };
		});
		// The patches that get a real flasher session: the most unusual ones
		// that are expected to apply cleanly (a patch that writes nothing
		// tests the phone much less than one that does). The ranking is
		// deterministic, so the same patches run on every machine.
		const trackedFirmware = tracked[entry.patches] ?? {};
		const ranked = patches
			.filter((patch) => patch.writes.length && !trackedFirmware[patch.name])
			.sort((a, b) => patchUnusualness(b.writes) - patchUnusualness(a.writes) || a.name.localeCompare(b.name));
		const overSerial = new Set(ranked.slice(0, SERIAL_PATCHES_PER_PHONE).map((patch) => patch.name));
		// The smoke patch: the most unusual one, applied and undone again.
		const smokePatch = ranked[0]?.name ?? patches[0].name;

		for (const patch of patches) {
			const base = {
				...entry,
				op: "patch",
				baud: maxSpeed,
				patchFirmware: entry.patches,
				patchName: patch.name,
				patchPath: patch.patchPath,
				writes: patch.writes,
			};
			// Every patch is applied to a copy of the fullflash as a file and
			// undone again: that takes seconds and covers the patch engine for
			// the whole firmware. --smoke keeps all of them.
			tests.push({ ...base, target: "file", label: `patch-file:${entry.patches}/${patch.name}`, roundtrip: true });

			// The most unusual ones additionally get a real flasher session;
			// --smoke keeps only the round trip of the first of them, because
			// every session costs an emulator boot and a flash erase cycle.
			if (!overSerial.has(patch.name))
				continue;
			if (options.smoke && patch.name !== smokePatch)
				continue;
			tests.push({
				...base,
				target: "serial",
				label: `patch:${entry.patches}/${patch.name}`,
				// Undoing on the phone needs a second flasher session.
				roundtrip: patch.name === smokePatch,
			});
		}

		// One patch that does not apply cleanly is forced through with --yes
		// over the serial port, which must save a recovery patch before the
		// first write; undoing that recovery patch must restore the fullflash
		// (the V_KLay "repair patch" flow, on a real phone).
		const recoveryPatch = pickRecoveryPatch(entry, patches);
		if (!recoveryPatch)
			throw new Error(`no patch that warns on ${entry.fullflash} for the recovery test`);
		tests.push({
			...entry,
			op: "patch",
			target: "serial",
			recovery: true,
			baud: maxSpeed,
			label: `patch-recovery:${entry.patches}/` +
				(recoveryPatch.firmware === entry.patches ? "" : `${recoveryPatch.firmware}/`) + recoveryPatch.name,
			patchFirmware: entry.patches,
			patchName: recoveryPatch.name,
			patchPath: recoveryPatch.patchPath,
			writes: recoveryPatch.writes,
		});

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

	// The emulator (built once into tests/.emu) and the X server for its GTK
	// display; the patch tests against a file need neither.
	if (selected.some((test) => test.op !== "patch" || test.target === "serial")) {
		emuBin = resolveEmuBin(options);
		await startXvfb();
	}
	// --keep-emu leaves the emulators running, so their display has to stay.
	if (!options.keepEmu) {
		process.once("exit", stopXvfb);
		for (const signal of ["SIGINT", "SIGTERM"]) {
			process.once(signal, () => {
				stopXvfb();
				process.exit(1);
			});
		}
	} else {
		xvfbProcess?.unref();
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

	reportPatchStatus(options, results);

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
