#!/usr/bin/env node
// sieflasher: the CLI of the Siemens phone flasher (the V_KLay
// reimplementation). Work in progress: vkd-dump, the phone flash read/write
// and the VKP patch apply/revert are implemented; the remaining phone
// operations (info/bootcore) are exercised by the e2e tests against the
// pmb887x-emu emulator.

import { createRequire } from "node:module";
import { cmdVkdDump } from "./vkd-dump.js";
import { cmdRead } from "./read.js";
import { cmdWrite } from "./write.js";
import { cmdApply, cmdRevert } from "./patch.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `sieflasher ${version} — Siemens phone flasher (V_KLay reimplementation)

Usage:
  sieflasher <command> [arguments]

Commands:
  vkd-dump <file.vkd>         Parse a V_KLay phone driver (.vkd) and dump its contents
  read [options] <output>     Read the phone flash memory into a file
  write [options] <input>     Write a file to the phone flash memory
  apply [options] [patch]     Apply a VKP patch to a phone or a fullflash dump
  revert [options] [patch]    Undo a VKP patch on a phone or a fullflash dump
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

apply / revert options:
  <patch.vkp>                 The patch to apply / undo. Without it (or with
                              "-") the patch is read from stdin
  --serial <device>           The serial port of the phone (see read)
  --loader <file.vkd>         The V_KLay phone driver (.vkd), required
                              with --serial
  --phone <name>              The phone definition of the loader to use
  --baud <rate>               The loader connection speed in baud (see read)
  --file <dump.bin>           Patch a fullflash dump file in place instead of
                              a phone (an alternative to --serial)
  --base_addr <hex>           With --file: the flash address the dump starts
                              at (default: the "_From_XX" suffix of its file
                              name, or 0)
  --dry-run                   Only check whether the patch applies / reverts,
                              write nothing
  --yes                       Answer the warnings with yes (non-interactive)
  --force                     Write even when the data does not match, without
                              asking and without saving a recovery patch
  --no-history                Do not log the run into the patch history

Every apply / revert is logged into ~/.sieflasher/history (the patch text and
a JSON sidecar); when a patch does not apply or revert cleanly, the confirmed
operation first saves a recovery patch into ~/.sieflasher/recovery, which
'sieflasher revert' can apply later to restore the original data.

Planned (not implemented yet):
  info                        Boot the phone and read its flash info
  bootcore                    Restore the phone bootcore

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
		case "apply":
			return await cmdApply(args);
		case "revert":
			return await cmdRevert(args);
		case "info":
		case "bootcore":
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
