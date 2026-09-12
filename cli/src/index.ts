#!/usr/bin/env node
// sieflasher: the CLI of the Siemens phone flasher (the V_KLay
// reimplementation). Work in progress: vkd-dump and the phone flash read are
// implemented; the remaining phone operations (info/write/bootcore/vkp) are
// exercised by the e2e tests against the pmb887x-emu emulator.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseVkd, phoneDisplayName, PhoneDevice, PhoneInfo, VkdFile, VkdPhone, DeviceProgress, FlasherTransport } from "@sie-js/flasher";
import { openSerialTransport } from "./transport.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `sieflasher ${version} — Siemens phone flasher (V_KLay reimplementation)

Usage:
  sieflasher <command> [arguments]

Commands:
  vkd-dump <file.vkd>         Parse a V_KLay phone driver (.vkd) and dump its contents
  read [options] <output>     Read the phone flash memory into a file
  help                        Show this help
  version                     Show the version

read options:
  --serial <device>           Required. The serial port of the phone: a device
                              path (/dev/ttyUSB0, COM3) or a socket for the
                              pmb887x-emu emulator (tcp://127.0.0.1:4444)
  --loader <file.vkd>         Required. The V_KLay phone driver (.vkd)
  --phone <name>              The phone definition of the loader to use
                              (by name, case-insensitive; default: the first)
  --base_addr <hex>           The flash offset to start reading from
                              (default: 0, the flash start)
  --length <size>             How many bytes to read (default: to the end of the
                              fullflash of the loader). Accepts K/M suffixes and
                              0x-prefixed values, e.g. 512K or 0x80000
  --baud <rate>               The loader connection speed in baud
                              (default: 115200; must be one of the speeds the
                              loader driver supports)

Planned (not implemented yet):
  info                        Boot the phone and read its flash info
  write                       Write a fullflash dump (or a part of it) to the phone
  bootcore                   Restore the phone bootcore
  vkp                         Apply / undo / dry-run a VKP patch

The phone commands talk to the phone over a serial transport (a service cable
or the pmb887x-emu emulator, see the e2e tests). The built-in .vkd drivers
live in the vklay-loaders package.`;

function hex(value: number): string {
	return "0x" + value.toString(16).toUpperCase();
}

function formatSize(size: number): string {
	if (size >= 1024 * 1024 && size % (1024 * 1024) === 0)
		return `${size / (1024 * 1024)} MiB`;
	if (size >= 1024 && size % 1024 === 0)
		return `${size / 1024} KiB`;
	return `${size} B`;
}

function formatRange(addr: number, size: number): string {
	return `${hex(addr)}..${hex(addr + size - 1)} (${formatSize(size)})`;
}

// --base_addr: a V_KLay-style flash offset, hex with an optional 0x prefix
// ("0000", "A00000", "0x10000").
function parseAddr(value: string): number | undefined {
	const digits = value.replace(/^0x/i, "");
	if (!/^[0-9a-fA-F]+$/.test(digits))
		return undefined;
	return parseInt(digits, 16);
}

// --length: a byte count — decimal with an optional K/M suffix (512K) or
// 0x-prefixed hex (0x80000).
function parseLength(value: string): number | undefined {
	const match = /^(0x[0-9a-f]+|\d+(?:\.\d+)?)([km])?$/i.exec(value);
	if (!match)
		return undefined;
	if (/^0x/i.test(match[1]))
		return parseInt(match[1].slice(2), 16);
	let size = parseFloat(match[1]);
	if (match[2]?.toLowerCase() == "k")
		size *= 1024;
	else if (match[2]?.toLowerCase() == "m")
		size *= 1024 * 1024;
	return Math.round(size);
}

interface ReadOptions {
	serial: string;
	loader: string;
	phone?: string;
	baseAddr?: number;
	length?: number;
	baud?: number;
	output: string;
}

// Parses the read arguments: --key value / --key=value plus the single
// required positional output file path.
function parseReadArgs(args: string[]): ReadOptions {
	const options: ReadOptions = { serial: "", loader: "", output: "" };
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const inline = /^--([^=]+)=(.*)$/.exec(arg);
		const key = inline ? inline[1] : arg.startsWith("--") ? arg.slice(2) : undefined;
		if (!key) {
			positional.push(arg);
			continue;
		}
		const value = inline ? inline[2] : args[++i];
		if (value === undefined)
			throw new Error(`missing value for --${key}`);
		switch (key) {
			case "serial": options.serial = value; break;
			case "loader": options.loader = value; break;
			case "phone": options.phone = value; break;
			case "baud": {
				options.baud = parseInt(value, 10);
				if (!Number.isInteger(options.baud) || options.baud <= 0)
					throw new Error(`invalid --baud "${value}": expected a baudrate like 115200`);
				break;
			}
			case "base_addr":
				options.baseAddr = parseAddr(value);
				if (options.baseAddr === undefined)
					throw new Error(`invalid --base_addr "${value}": expected a hex address like 0x10000`);
				break;
			case "length":
				options.length = parseLength(value);
				if (options.length === undefined)
					throw new Error(`invalid --length "${value}": expected a size like 512K, 4M or 0x80000`);
				break;
			default:
				throw new Error(`unknown option --${key}`);
		}
	}
	if (!options.serial)
		throw new Error("--serial is required");
	if (!options.loader)
		throw new Error("--loader is required");
	if (positional.length !== 1)
		throw new Error("exactly one output file path is required");
	options.output = positional[0];
	return options;
}

function formatPhoneInfo(info: PhoneInfo): string {
	if (info.kind == "v3") {
		const regions = info.regions.map((r) => `${r.blocksCount}x${formatSize(r.eraseSize)}`).join(", ");
		return `${info.manufacturer} ${info.model}, IMEI ${info.imei}, flash 0x${info.flashPID.toString(16)} @ ${hex(info.flashBaseAddr)} (${regions})`;
	}
	let text = `${info.manufacturer} ${info.model}`;
	if (info.langPack)
		text += ` lp${info.langPack}`;
	if (info.fwVersion)
		text += ` fw${info.fwVersion.toString(16)}`;
	return text;
}

// A single-line progress bar on stderr (only when it is a terminal).
class ReadProgress {
	private readonly started = Date.now();
	private printed = false;

	update(progress: DeviceProgress): void {
		if (!process.stderr.isTTY)
			return;
		const percent = progress.total ? Math.floor((progress.cursor / progress.total) * 100) : 100;
		const seconds = (Date.now() - this.started) / 1000;
		const speed = progress.cursor / Math.max(seconds, 0.001);
		process.stderr.write(`\r  ${formatSize(progress.cursor)} / ${formatSize(progress.total)} (${percent}%, ${formatSize(Math.round(speed))}/s)`);
		this.printed = true;
	}

	finish(): void {
		if (this.printed)
			process.stderr.write("\n");
	}
}

function loadLoaderPhone(loaderFile: string, phoneName?: string): { vkd: VkdFile; phone: VkdPhone } {
	let text: string;
	try {
		text = readFileSync(loaderFile, "latin1");
	} catch (error) {
		throw new Error(`cannot read the loader ${loaderFile}: ${(error as Error).message}`);
	}
	const vkd = parseVkd(text);
	if (!vkd.phones.length)
		throw new Error(`the loader ${loaderFile} does not contain any phone definitions`);
	let phone: VkdPhone = vkd.phones[0];
	if (phoneName) {
		const wanted = phoneName.toLowerCase();
		const found = vkd.phones.find((p) => p.name.toLowerCase() == wanted)
			?? vkd.phones.find((p) => p.name.toLowerCase().includes(wanted));
		if (!found)
			throw new Error(`the loader ${loaderFile} has no phone "${phoneName}" (available: ${vkd.phones.map((p) => p.name).join(", ")})`);
		phone = found;
	}
	return { vkd, phone };
}

async function cmdRead(args: string[]): Promise<number> {
	let options: ReadOptions;
	try {
		options = parseReadArgs(args);
	} catch (error) {
		console.error(`sieflasher: ${(error as Error).message}`);
		console.error("usage: sieflasher read --serial <device> --loader <file.vkd> [--phone <name>] [--base_addr <hex>] [--length <size>] [--baud <rate>] <output>");
		return 2;
	}

	let loaded: { vkd: VkdFile; phone: VkdPhone };
	try {
		loaded = loadLoaderPhone(options.loader, options.phone);
	} catch (error) {
		console.error(`sieflasher: ${(error as Error).message}`);
		return 1;
	}
	const { vkd, phone } = loaded;
	const baseAddr = options.baseAddr ?? 0;
	const length = options.length ?? phone.fullflash.size - baseAddr;
	if (baseAddr < 0 || baseAddr >= phone.fullflash.size || length <= 0 || baseAddr + length > phone.fullflash.size) {
		console.error(`sieflasher: the read range 0x${baseAddr.toString(16)}+0x${length.toString(16)} is outside of the fullflash ${formatRange(0, phone.fullflash.size)} of ${phoneDisplayName(phone)}`);
		return 1;
	}

	console.error(`loader: ${options.loader}: ${phoneDisplayName(phone)}, fullflash ${formatRange(phone.fullflash.addr, phone.fullflash.size)}`);
	console.error(`serial: ${options.serial}`);

	const progress = new ReadProgress();
	let transport: FlasherTransport;
	try {
		transport = await openSerialTransport(options.serial);
	} catch (error) {
		console.error(`sieflasher: cannot open ${options.serial}: ${(error as Error).message}`);
		return 1;
	}
	const device = new PhoneDevice(transport, phone, vkd, {
		onStatus: (status) => console.error(`  ${status}`),
	});
	device.onProgress = (p) => progress.update(p);

	try {
		const started = Date.now();
		await device.open(options.baud);
		const info = device.getFlashInfo();
		if (info)
			console.error(`phone: ${formatPhoneInfo(info)}`);

		console.error(`reading ${formatRange(baseAddr, length)} -> ${options.output}`);
		const data = await device.readMemory(baseAddr, length);
		progress.finish();
		writeFileSync(options.output, data);

		const seconds = (Date.now() - started) / 1000;
		console.log(`${options.output}: ${formatSize(length)} read from 0x${baseAddr.toString(16).toUpperCase()} in ${seconds.toFixed(1)}s`);
	} finally {
		await device.disconnect().catch(() => {});
	}
	return 0;
}

function cmdVkdDump(fileName: string): number {
	let text: string;
	try {
		text = readFileSync(fileName, "latin1");
	} catch (error) {
		console.error(`sieflasher: cannot read ${fileName}: ${(error as Error).message}`);
		return 1;
	}

	const vkd = parseVkd(text);
	console.log(`${fileName}: ${vkd.phones.length} phone(s), ${vkd.boots.size} boot(s)`);
	if (vkd.copyright)
		console.log(`copyright: ${vkd.copyright}`);
	console.log();

	for (const phone of vkd.phones) {
		console.log(`${phone.id}: ${phoneDisplayName(phone)}`);
		console.log(`  fullflash: ${formatRange(phone.fullflash.addr, phone.fullflash.size)}`);

		const areas = phone.memAreas.filter(
			(area) => !(area.name === phone.fullflash.name && area.addr === phone.fullflash.addr && area.size === phone.fullflash.size),
		);
		if (areas.length) {
			console.log("  areas:");
			for (const area of areas) {
				const flags = [
					area.isBootcore ? "bootcore" : undefined,
					area.isNoWrite ? "nowrite" : undefined,
					area.isNoRead ? "noread" : undefined,
				].filter(Boolean).join(", ");
				console.log(`    ${area.name.padEnd(16)} ${formatRange(area.addr, area.size)}${flags ? `  [${flags}]` : ""}`);
			}
		}

		if (phone.memGeometry.length) {
			console.log("  geometry:");
			for (const g of phone.memGeometry)
				console.log(`    ${hex(g.startAddr)}: ${formatSize(g.pageSize)}`);
		}

		if (phone.memFlashBase !== undefined)
			console.log(`  flash base: ${hex(phone.memFlashBase)}`);
		console.log(`  boots: ${phone.boots.join(", ")}`);
		console.log();
	}

	return 0;
}

async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;

	switch (command) {
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return 0;
		case "version":
		case "--version":
		case "-V":
			console.log(version);
			return 0;
		case "vkd-dump":
			if (args.length !== 1) {
				console.error("usage: sieflasher vkd-dump <file.vkd>");
				return 2;
			}
			return cmdVkdDump(args[0]);
		case "read":
			return await cmdRead(args);
		case "info":
		case "write":
		case "bootcore":
		case "vkp":
			console.error(`sieflasher: '${command}' is not implemented yet (see 'sieflasher help')`);
			return 1;
		case undefined:
			console.error(USAGE);
			return 2;
		default:
			console.error(`sieflasher: unknown command '${command}' (see 'sieflasher help')`);
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(`sieflasher: ${(error as Error).message}`);
		process.exit(1);
	});
