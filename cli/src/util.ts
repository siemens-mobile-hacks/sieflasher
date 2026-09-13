// Shared helpers of the sieflasher commands: number formatting, the common
// --serial/--loader/... phone command options, the .vkd loading and the
// progress bar.

import { readFileSync } from "node:fs";
import { parseVkd, phoneDisplayName, PhoneInfo, VkdFile, VkdPhone, DeviceProgress } from "@sie-js/flasher";

export function hex(value: number): string {
	return "0x" + value.toString(16).toUpperCase();
}

export function formatSize(size: number): string {
	if (size >= 1024 * 1024 && size % (1024 * 1024) === 0)
		return `${size / (1024 * 1024)} MiB`;
	if (size >= 1024 && size % 1024 === 0)
		return `${size / 1024} KiB`;
	return `${size} B`;
}

export function formatRange(addr: number, size: number): string {
	return `${hex(addr)}..${hex(addr + size - 1)} (${formatSize(size)})`;
}

// --base_addr: a V_KLay-style flash offset, hex with an optional 0x prefix
// ("0000", "A00000", "0x10000").
export function parseAddr(value: string): number | undefined {
	const digits = value.replace(/^0x/i, "");
	if (!/^[0-9a-fA-F]+$/.test(digits))
		return undefined;
	return parseInt(digits, 16);
}

// --length: a byte count — decimal with an optional K/M suffix (512K) or
// 0x-prefixed hex (0x80000).
export function parseLength(value: string): number | undefined {
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

// The options shared by the phone commands (read, write): --key value /
// --key=value plus the single required positional file path (the dump to
// write to for read, the image to flash for write).
export interface PhoneFileOptions {
	serial: string;
	loader: string;
	phone?: string;
	baseAddr?: number;
	length?: number;
	baud?: number;
	file: string;
}

export function parsePhoneFileArgs(args: string[], fileRole: "input" | "output"): PhoneFileOptions {
	const options: PhoneFileOptions = { serial: "", loader: "", file: "" };
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
		throw new Error(`exactly one ${fileRole} file path is required`);
	options.file = positional[0];
	return options;
}

// The options of the patch commands (apply, revert): the phone connection
// (--serial + --loader) or a fullflash dump file (--file) as the target, the
// behaviour flags and the optional positional patch path ("-" or nothing
// reads the patch from stdin).
export interface PatchOptions {
	serial?: string;
	file?: string;
	loader?: string;
	phone?: string;
	baseAddr?: number;
	baud?: number;
	dryRun: boolean;
	yes: boolean;
	force: boolean;
	history: boolean;
	// The .vkp path; undefined means stdin.
	patch?: string;
}

export function parsePatchArgs(args: string[]): PatchOptions {
	const options: PatchOptions = { dryRun: false, yes: false, force: false, history: true };
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const inline = /^--([^=]+)=(.*)$/.exec(arg);
		const key = inline ? inline[1] : arg.startsWith("--") ? arg.slice(2) : undefined;
		if (!key) {
			positional.push(arg);
			continue;
		}
		// The flags take no value.
		if (["dry-run", "yes", "force", "no-history"].includes(key)) {
			if (inline)
				throw new Error(`--${key} takes no value`);
			switch (key) {
				case "dry-run": options.dryRun = true; break;
				case "yes": options.yes = true; break;
				// Forcing implies confirming: neither asks anything.
				case "force": options.force = true; options.yes = true; break;
				case "no-history": options.history = false; break;
			}
			continue;
		}
		const value = inline ? inline[2] : args[++i];
		if (value === undefined)
			throw new Error(`missing value for --${key}`);
		switch (key) {
			case "serial": options.serial = value; break;
			case "file": options.file = value; break;
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
					throw new Error(`invalid --base_addr "${value}": expected a hex address like 0x400000`);
				break;
			default:
				throw new Error(`unknown option --${key}`);
		}
	}
	if (options.serial && options.file)
		throw new Error("--serial and --file are mutually exclusive: patch either a phone or a dump file");
	if (!options.serial && !options.file)
		throw new Error("--serial or --file is required");
	if (options.serial && !options.loader)
		throw new Error("--loader is required with --serial");
	if (options.file) {
		const phoneOnly = [
			["loader", options.loader],
			["phone", options.phone],
			["baud", options.baud],
		].find(([, value]) => value !== undefined);
		if (phoneOnly)
			throw new Error(`--${phoneOnly[0]} is only used with --serial`);
	} else if (options.baseAddr !== undefined) {
		throw new Error("--base_addr is only used with --file (the patch addresses select the flash offsets of a phone)");
	}
	if (positional.length > 1)
		throw new Error("at most one patch file path is expected");
	if (positional.length == 1 && positional[0] != "-")
		options.patch = positional[0];
	return options;
}

export function formatPhoneInfo(info: PhoneInfo): string {
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

// Loads the .vkd driver and selects the phone definition of the loader
// (by name, case-insensitive; the first one by default).
export function loadLoaderPhone(loaderFile: string, phoneName?: string): { vkd: VkdFile; phone: VkdPhone } {
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

// A single-line progress bar on stderr (only when it is a terminal).
export class CliProgress {
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
