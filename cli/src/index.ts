#!/usr/bin/env node
// sieflasher: the CLI of the Siemens phone flasher (the V_KLay
// reimplementation). Work in progress: only vkd-dump is implemented; the
// phone operations (info/read/write/bootcore/vkp) need a serial transport
// and are exercised by the e2e tests against the pmb887x-emu emulator.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseVkd, phoneDisplayName } from "@sie-js/flasher";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `sieflasher ${version} — Siemens phone flasher (V_KLay reimplementation)

Usage:
  sieflasher <command> [arguments]

Commands:
  vkd-dump <file.vkd>    Parse a V_KLay phone driver (.vkd) and dump its contents
  help                   Show this help
  version                Show the version

Planned (not implemented yet):
  info                   Boot the phone and read its flash info
  read                   Read the phone flash into a fullflash dump
  write                  Write a fullflash dump (or a part of it) to the phone
  bootcore               Restore the phone bootcore
  vkp                    Apply / undo / dry-run a VKP patch

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

function main(argv: string[]): number {
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
		case "info":
		case "read":
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

process.exit(main(process.argv.slice(2)));
