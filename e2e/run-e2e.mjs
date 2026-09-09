#!/usr/bin/env node
// E2E test for the sie-flasher CLI against an emulated phone:
// pmb887x-emu (https://github.com/siemens-mobile-hacks/pmb887x-emu) is built
// and started directly on the host (no Docker needed) with a fullflash from
// https://git.siepatch.dev/siepatch/fullflashes, and its phone serial port is
// exposed on a local TCP port (the QEMU serial chardev).
//
// Usage: node run-e2e.mjs [--device=siemens-el71] [--fullflash=EL71v41lg91.bin]
//                         [--serial-port=4444] [--keep-emu]
// The same knobs exist as E2E_DEVICE / E2E_FULLFLASH / E2E_SERIAL_PORT env.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const fullflashesDir = path.join(e2eDir, "fullflashes");
const emuBin = path.join(e2eDir, ".emu", "build", "pmb887x-emu");
const cliDist = path.join(path.dirname(require.resolve("@sie-js/flasher-cli/package.json")), "dist", "index.js");
const x65Vkd = require.resolve("vklay-loaders/x65.vkd");

const FULLFLASHES_REPO = "https://git.siepatch.dev/siepatch/fullflashes";
const SERIAL_WAIT_TIMEOUT = 30_000;

function parseOptions(argv) {
	const options = {
		device: process.env.E2E_DEVICE ?? "siemens-el71",
		fullflash: process.env.E2E_FULLFLASH ?? "EL71v41lg91.bin",
		serialPort: Number(process.env.E2E_SERIAL_PORT ?? 4444),
		keepEmu: false,
	};
	for (const arg of argv) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
		if (!match || !(match[1] in options))
			throw new Error(`unknown option: ${arg}`);
		const [, key, value = "true"] = match;
		if (key === "serialPort")
			options.serialPort = Number(value);
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

function runCli(args) {
	const result = spawnSync("node", [cliDist, ...args], { encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(`sie-flasher ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
	return result.stdout;
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

async function main() {
	const options = parseOptions(process.argv.slice(2));

	// The fullflash dumps (cloned once, gitignored).
	if (!fs.existsSync(path.join(fullflashesDir, ".git"))) {
		console.log(`▸ Cloning the fullflash dumps from ${FULLFLASHES_REPO}`);
		run("git", ["clone", "--depth", "1", FULLFLASHES_REPO, fullflashesDir], { stdio: "inherit" });
	}
	const fullflash = path.join(fullflashesDir, options.fullflash);
	if (!fs.existsSync(fullflash))
		throw new Error(`fullflash ${fullflash} not found (repo contents: ${fs.readdirSync(fullflashesDir).join(", ")})`);

	// The emulator (built once into e2e/.emu).
	if (!fs.existsSync(emuBin)) {
		console.log("▸ Building pmb887x-emu (the first run takes a while)");
		run("bash", [path.join(e2eDir, "scripts", "setup-emu.sh")], { stdio: "inherit" });
	}

	// Start the emulator with the phone serial port on TCP (QEMU chardev
	// server). Headless hosts need a virtual X server for the QEMU GTK
	// display (the emulator frontend passes no -display none).
	console.log(`▸ Starting pmb887x-emu: device ${options.device}, fullflash ${path.basename(fullflash)}`);
	const xvfb = !process.env.DISPLAY && spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim();
	const emuArgs = [];
	if (xvfb)
		emuArgs.push("-a", emuBin);
	emuArgs.push(
		"--device", options.device,
		"--fullflash", fullflash,
		// The emulator defaults for siemens-* devices (see its src/main.cpp).
		"--siemens-esn=12345678",
		"--siemens-imei=490154203237518",
		"--serial", `tcp:127.0.0.1:${options.serialPort},server=on,wait=off`,
	);
	const emuLog = [];
	const emu = spawn(xvfb || emuBin, emuArgs, {
		env: { ...process.env, QEMU_AUDIO_DRV: "none" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	emu.stdout.on("data", (chunk) => emuLog.push(chunk));
	emu.stderr.on("data", (chunk) => emuLog.push(chunk));

	let failure;
	try {
		await waitForSerialPort(options.serialPort, SERIAL_WAIT_TIMEOUT);
		console.log(`  the serial port 127.0.0.1:${options.serialPort} is open`);

		// The CLI. TODO: run a real flasher session over the TCP transport
		// (boot the emulated phone, read the flash info) once the transport
		// commands are implemented; for now smoke-test the CLI itself.
		console.log("▸ sie-flasher --version");
		console.log(`  ${runCli(["--version"]).trim()}`);

		console.log(`▸ sie-flasher vkd-dump ${path.basename(x65Vkd)}`);
		console.log(`  ${runCli(["vkd-dump", x65Vkd]).split("\n")[0]}`);
	} catch (error) {
		failure = error;
	} finally {
		if (options.keepEmu) {
			console.log(`▸ Keeping the emulator running (pid ${emu.pid})`);
			emu.unref();
		} else {
			emu.kill("SIGTERM");
			const exited = await Promise.race([
				new Promise((resolve) => emu.once("exit", () => resolve(true))),
				delay(5000).then(() => false),
			]);
			if (!exited)
				emu.kill("SIGKILL");
		}
	}

	if (failure) {
		console.error("\nEmulator output:");
		for (const chunk of emuLog)
			console.error(chunk.toString().trimEnd());
		console.error(`\nFAILED: ${failure.message}`);
		process.exit(1);
	}
	console.log("\nPASSED");
}

main().catch((error) => {
	console.error(`FAILED: ${error.message}`);
	process.exit(1);
});
