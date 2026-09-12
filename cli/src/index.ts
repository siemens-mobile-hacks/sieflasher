#!/usr/bin/env node
// sieflasher: the CLI of the Siemens phone flasher (the V_KLay
// reimplementation). Work in progress: vkd-dump and the phone flash
// read/write are implemented; the remaining phone operations
// (info/bootcore/vkp) are exercised by the e2e tests against the
// pmb887x-emu emulator.

import { createRequire } from "node:module";
import { cmdVkdDump } from "./vkd-dump.js";
import { cmdRead } from "./read.js";
import { cmdWrite } from "./write.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `sieflasher ${version} — Siemens phone flasher (V_KLay reimplementation)

Usage:
  sieflasher <command> [arguments]

Commands:
  vkd-dump <file.vkd>         Parse a V_KLay phone driver (.vkd) and dump its contents
  read [options] <output>     Read the phone flash memory into a file
  write [options] <input>     Write a file to the phone flash memory
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

write options:
  --serial <device>           Required. The serial port of the phone (see read)
  --loader <file.vkd>         Required. The V_KLay phone driver (.vkd)
  --phone <name>              The phone definition of the loader to use
  --base_addr <hex>           The flash offset to start writing at
                              (default: 0, the flash start)
  --length <size>             How many bytes of the input to write (default: the
                              whole input file)
  --baud <rate>               The loader connection speed in baud (see read)

Planned (not implemented yet):
  info                        Boot the phone and read its flash info
  bootcore                   Restore the phone bootcore
  vkp                         Apply / undo / dry-run a VKP patch

The phone commands talk to the phone over a serial transport (a service cable
or the pmb887x-emu emulator, see the e2e tests). The built-in .vkd drivers
live in the vklay-loaders package.`;

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
		case "write":
			return await cmdWrite(args);
		case "info":
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
