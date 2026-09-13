// sieflasher apply / revert: write a VKP patch into a phone or a fullflash
// dump file, or undo it.
//
// The patch engine itself lives in the core library (applyVkpToDevice, the
// port of V_KLay's CPatchPage::DoPatchApply): it reads every written range
// back from the device, classifies it and asks the caller to confirm the
// situations V_KLay shows a message box for. Here the confirmations are
// terminal prompts, and the recovery ("repair") patch the core generates
// before a risky write is saved into ~/.sieflasher/recovery. Every real run
// is logged into ~/.sieflasher/history (see history.ts).

import { createReadStream, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import {
	applyVkpToDevice, FlasherDevice, FlasherTransport, FullFlashDevice, getAddrFromFileName,
	hexPreview, PhoneDevice, phoneDisplayName, VkpApplyResult, VkpMismatchInfo, VkpWriteReport,
} from "@sie-js/flasher";
import { vkpDetectContent, vkpNormalize, vkpParse, VkpParseResult } from "@sie-js/vkp";
import { createRequire } from "node:module";
import { openSerialTransport } from "./transport.js";
import {
	CliProgress, formatPhoneInfo, formatRange, formatSize, hex, loadLoaderPhone, parsePatchArgs,
	PatchOptions,
} from "./util.js";
import {
	dumpModelFromFileName, newPatchHistoryId, PatchHistoryEntry, savePatchHistoryEntry,
	saveRecoveryPatch, vkpPatchTitle,
} from "./history.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const TOOL_NAME = `sieflasher ${version}`;

const usage = (command: string): string =>
	`sieflasher ${command} [--serial <device> --loader <file.vkd> [--phone <name>] [--baud <rate>] | ` +
	`--file <dump.bin> [--base_addr <hex>]] [--dry-run] [--yes] [--force] [--no-history] [<patch.vkp>]`;

export async function cmdApply(args: string[]): Promise<number> {
	return runPatch(args, false);
}

export async function cmdRevert(args: string[]): Promise<number> {
	return runPatch(args, true);
}

async function runPatch(args: string[], revert: boolean): Promise<number> {
	const command = revert ? "revert" : "apply";
	let options: PatchOptions;
	try {
		options = parsePatchArgs(args);
	} catch (error) {
		console.error(`sieflasher: ${(error as Error).message}`);
		console.error(`usage: ${usage(command)}`);
		return 2;
	}

	// ------------------------------------------------------------------
	// The patch: a .vkp file or stdin. Reading a patch from the terminal is
	// never what the user wants: without a path stdin must be a pipe.
	if (!options.patch && process.stdin.isTTY) {
		console.error("sieflasher: no patch given: pass a .vkp file or pipe the patch into stdin");
		console.error(`usage: ${usage(command)}`);
		return 2;
	}
	let raw: Buffer;
	try {
		raw = options.patch ? readFileSync(options.patch) : readFileSync(0);
	} catch (error) {
		const source = options.patch ? `the patch ${options.patch}` : "the patch from stdin";
		console.error(`sieflasher: cannot read ${source}: ${(error as Error).message}`);
		return 1;
	}
	const patchSource = options.patch ?? "<stdin>";
	const patchName = options.patch ? path.basename(options.patch) : "";
	const text = decodePatch(raw);
	if (!text.trim()) {
		console.error(`sieflasher: ${patchSource} is empty`);
		return 1;
	}
	if (vkpDetectContent(text) == "RTF") {
		console.error(`sieflasher: ${patchSource} is an RTF document; save the patch as a plain text .vkp file first`);
		return 1;
	}

	let vkp: VkpParseResult;
	try {
		vkp = vkpParse(text, { allowEmptyOldData: true });
	} catch (error) {
		console.error(`sieflasher: cannot parse ${patchSource}: ${(error as Error).message}`);
		return 1;
	}
	for (const warning of vkp.warnings)
		console.error(`${patchSource}:${warning.loc.line}:${warning.loc.column}: warning: ${warning.message}`);
	if (!vkp.valid || vkp.errors.length) {
		for (const error of vkp.errors)
			console.error(`${patchSource}:${error.loc.line}:${error.loc.column}: error: ${error.message}`);
		console.error(`sieflasher: ${patchSource} is not a valid patch`);
		return 1;
	}
	if (!vkp.writes.length) {
		console.error(`sieflasher: ${patchSource} has no data blocks, there is nothing to ${command}`);
		return 0;
	}

	const title = vkpPatchTitle(text);
	console.error(`patch: ${patchSource}: ${vkp.writes.length} write(s)${title ? `, "${title}"` : ""}`);

	// ------------------------------------------------------------------
	// The target: a phone over the serial transport or a fullflash dump.
	const target = options.file ? path.resolve(options.file) : options.serial!;
	const prompt = new TtyPrompt(options);
	const progress = new CliProgress();

	let device: FlasherDevice;
	let phone: PhoneDevice | undefined;
	let dump: { buffer: Buffer; device: FullFlashDevice } | undefined;
	let phoneInfo: ReturnType<PhoneDevice["getFlashInfo"]>;
	let loaderPhoneName = "";

	if (options.file) {
		let buffer: Buffer;
		try {
			buffer = readFileSync(options.file);
		} catch (error) {
			console.error(`sieflasher: cannot read the dump ${options.file}: ${(error as Error).message}`);
			return 1;
		}
		if (!buffer.length) {
			console.error(`sieflasher: the dump ${options.file} is empty`);
			return 1;
		}
		// The dump start: --base_addr, or the V_KLay "_From_XX" file name
		// suffix (getAddrFromFileName), or the flash start.
		const baseAddr = options.baseAddr ?? getAddrFromFileName(path.basename(options.file)) ?? 0;
		const outside = outsideOfMemory(vkp, baseAddr, buffer.length);
		if (outside) {
			console.error(`sieflasher: ${patchSource}: ${outside} of the dump ${formatRange(baseAddr, buffer.length)}`);
			return 1;
		}
		const fullflash = new FullFlashDevice(buffer, baseAddr);
		dump = { buffer, device: fullflash };
		device = fullflash;
		await fullflash.open();
		console.error(`file: ${options.file}: ${formatRange(baseAddr, buffer.length)}`);
	} else {
		let loaded;
		try {
			loaded = loadLoaderPhone(options.loader!, options.phone);
		} catch (error) {
			console.error(`sieflasher: ${(error as Error).message}`);
			return 1;
		}
		const { vkd, phone: vkdPhone } = loaded;
		loaderPhoneName = vkdPhone.name;
		console.error(`loader: ${options.loader}: ${phoneDisplayName(vkdPhone)}, fullflash ${formatRange(vkdPhone.fullflash.addr, vkdPhone.fullflash.size)}`);
		console.error(`serial: ${options.serial}`);

		// Checked before the phone is booted: a patch reaching outside of the
		// flash is never written, not even partially.
		const outside = outsideOfMemory(vkp, vkdPhone.fullflash.addr, vkdPhone.fullflash.size);
		if (outside) {
			console.error(`sieflasher: ${patchSource}: ${outside} of the fullflash ` +
				`${formatRange(vkdPhone.fullflash.addr, vkdPhone.fullflash.size)} of ${phoneDisplayName(vkdPhone)}`);
			return 1;
		}

		let transport: FlasherTransport;
		try {
			transport = await openSerialTransport(options.serial!);
		} catch (error) {
			console.error(`sieflasher: cannot open ${options.serial}: ${(error as Error).message}`);
			return 1;
		}
		phone = new PhoneDevice(transport, vkdPhone, vkd, {
			onStatus: (status) => console.error(`  ${status}`),
		});
		phone.onProgress = (p) => progress.update(p);
		device = phone;
		try {
			await phone.open(options.baud);
		} catch (error) {
			await phone.disconnect().catch(() => {});
			console.error(`sieflasher: ${(error as Error).message}`);
			return 1;
		}
		phoneInfo = phone.getFlashInfo();
		if (phoneInfo)
			console.error(`phone: ${formatPhoneInfo(phoneInfo)}`);
	}

	// ------------------------------------------------------------------
	// The operation itself.
	let result: VkpApplyResult;
	let recoveryPatch: string | undefined;
	const started = Date.now();
	try {
		console.error(options.dryRun
			? `testing the ${command} of ${patchSource} on ${target}`
			: `${revert ? "reverting" : "applying"} ${patchSource} on ${target}`);
		result = await applyVkpToDevice(device, vkp, {
			revert,
			dryRun: options.dryRun,
			force: options.force,
			patchName: patchName || undefined,
			patchText: text,
			toolName: TOOL_NAME,
			confirmNoOld: () => prompt.confirm(noOldMessage(revert, options.dryRun)),
			confirmMismatch: (info) => prompt.confirm(mismatchMessage(info, revert, options.dryRun)),
			// A dry run writes nothing, so it does not need a recovery patch
			// either (V_KLay saves it only before the real writes).
			...(options.dryRun ? {} : {
				saveRepairPatch: (patch: string, fileName: string) => {
					try {
						recoveryPatch = saveRecoveryPatch(patch, fileName);
					} catch (error) {
						console.error(`sieflasher: cannot save the recovery patch: ${(error as Error).message}`);
						return false;
					}
					console.error(`recovery patch saved: ${recoveryPatch}`);
					console.error(`  undo the changes of this ${command} with: sieflasher revert ${quoteArg(recoveryPatch)} ...`);
					return recoveryPatch;
				},
			}),
		});
		progress.finish();
	} catch (error) {
		progress.finish();
		console.error(`sieflasher: ${(error as Error).message}`);
		return 1;
	} finally {
		prompt.close();
		await phone?.disconnect().catch(() => {});
	}

	// The patched dump is written back only when something changed.
	if (dump && dump.device.modified && !options.dryRun) {
		try {
			writeFileSync(options.file!, dump.buffer);
		} catch (error) {
			console.error(`sieflasher: cannot write the patched dump ${options.file}: ${(error as Error).message}`);
			return 1;
		}
	}

	printReports(result.reports);

	// ------------------------------------------------------------------
	// The history log (the V_KLay DoPatchLogging analog): every real run,
	// successful or not; a dry run changes nothing and is not logged.
	if (options.history && !options.dryRun && !result.empty) {
		const entry: PatchHistoryEntry = {
			id: newPatchHistoryId(),
			date: new Date().toISOString(),
			action: result.action,
			status: result.cancelled ? "cancelled" : result.ok ? "ok" : "partial",
			source: options.file ? "file" : "phone",
			model: options.file
				? dumpModelFromFileName(path.basename(options.file))
				: (loaderPhoneName || phoneInfo?.model || ""),
			imei: phoneInfo?.kind == "v3" ? phoneInfo.imei : "",
			// V_KLay logs VDevice::GetUniqueName(); for a dump the file name
			// says more than the "fulldump_<addr>" of FullFlashDevice.
			deviceName: options.file
				? path.basename(options.file).replace(/\.(bin|fls|ful)$/i, "")
				: device.getUniqueName(),
			info: options.file
				? `Dump ${hex(device.getMemoryStart())} + ${formatSize(device.getMemorySize())}`
				: (phoneInfo ? formatPhoneInfo(phoneInfo) : ""),
			target,
			...(options.file ? {} : { loader: options.loader, phone: loaderPhoneName }),
			patchName: patchName || `${result.action}_from_stdin.vkp`,
			patchTitle: title,
			writes: vkp.writes.length,
			written: result.written,
			recoveryPatch,
			tool: TOOL_NAME,
		};
		try {
			const saved = savePatchHistoryEntry(entry, text);
			console.error(`history: ${saved.patchFile}`);
		} catch (error) {
			console.error(`sieflasher: cannot write the patch history: ${(error as Error).message}`);
		}
	}

	const seconds = (Date.now() - started) / 1000;
	const counts = countReports(result.reports);
	const summary = `${patchSource}: ${vkp.writes.length} write(s): ` +
		`${counts.applied} ${options.dryRun ? "to write" : result.action == "apply" ? "applied" : "reverted"}, ` +
		`${counts.skipped} skipped, ${counts.error} failed; ` +
		`${formatSize(result.written)} written to ${target} in ${seconds.toFixed(1)}s`;

	if (result.cancelled) {
		console.error(`sieflasher: cancelled, nothing was written to ${target}`);
		return 1;
	}
	if (!result.ok) {
		console.error(summary);
		console.error(`sieflasher: the patch does not ${command} cleanly on ${target}` +
			(options.force ? "" : " (see the errors above; --force writes anyway)"));
		return 1;
	}
	if (result.alreadyDone) {
		console.log(`${patchSource}: ${revert ? "the patch is not applied" : "the patch is already applied"} on ${target}, nothing to do`);
		return 0;
	}
	if (options.dryRun)
		console.log(`${summary} (dry run: nothing was written)`);
	else
		console.log(summary);
	return 0;
}

// The writes of a patch that do not fit the device memory, as a message.
//
// V_KLay patch addresses are flash offsets, but patches written with absolute
// CPU addresses exist as well: applyVkpToDevice() shifts the whole patch by
// the flash base when it only fits that way. The same rule is applied here
// before the device is touched, so that a patch made for another phone (or
// another memory area) is rejected as a whole instead of being written
// partially.
function outsideOfMemory(vkp: VkpParseResult, start: number, size: number): string | undefined {
	const end = start + size;
	const fits = (offset: number) =>
		vkp.writes.every((write) => write.addr + offset >= start && write.addr + offset + write.new.length <= end);
	if (fits(0) || (start != 0 && fits(start)))
		return undefined;
	const offset = start != 0 && vkp.writes.some((write) => write.addr < start) ? start : 0;
	const bad = vkp.writes.filter((write) =>
		write.addr + offset < start || write.addr + offset + write.new.length > end);
	const shown = bad.slice(0, 3)
		.map((write) => `${hex(write.addr + offset)} (${write.new.length} B, line ${write.loc?.line})`)
		.join(", ");
	return `${bad.length} of ${vkp.writes.length} write(s) are outside ` +
		`[${shown}${bad.length > 3 ? ", ..." : ""}]`;
}

// VKP files are canonically cp1251, but a CLI patch is just as likely to be
// UTF-8: the bytes are decoded as UTF-8 when they are valid UTF-8 (pure
// ASCII patches take this path too) and as cp1251 otherwise.
function decodePatch(raw: Buffer): string {
	const text = raw.toString("utf8");
	if (!text.includes("�"))
		return text.replace(/\r\n|\r/g, "\n");
	return vkpNormalize(raw);
}

function countReports(reports: VkpWriteReport[]): { applied: number; skipped: number; error: number } {
	const counts = { applied: 0, skipped: 0, error: 0 };
	for (const report of reports)
		counts[report.status]++;
	return counts;
}

// A big patch can have hundreds of blocks: then only the writes that need
// attention are listed, the rest is left to the summary line.
const MAX_PRINTED_REPORTS = 32;

function printReports(reports: VkpWriteReport[]): void {
	let shown = reports;
	if (reports.length > MAX_PRINTED_REPORTS) {
		shown = reports.filter((report) => report.status != "applied");
		console.error(`  ${reports.length - shown.length} of ${reports.length} write(s) applied` +
			(shown.length ? ":" : ""));
	}
	for (const report of shown) {
		const head = `  ${hex(report.addr)}  ${String(report.size).padStart(5)} B  ${report.status}`;
		const reason = report.reason.trim();
		if (!reason) {
			console.error(head);
			continue;
		}
		const [first, ...rest] = reason.split("\n");
		console.error(`${head}: ${first}`);
		for (const line of rest)
			console.error(`      ${line}`);
	}
}

// V_KLay's msgNoOldInPatch message box (PatchDataConvert): the patch has
// blocks without old data.
function noOldMessage(revert: boolean, dryRun: boolean): string {
	const lines = [
		"WARNING: some blocks of the patch have no old data.",
		revert
			? "Such blocks cannot be undone and will be skipped."
			: "After applying them this patch can no longer be undone.",
	];
	if (!dryRun)
		lines.push("A recovery patch will be saved before anything is written, so that the changes of this run can be undone.");
	return lines.join("\n") + `\nContinue the ${revert ? "revert" : "apply"}?`;
}

// V_KLay's msgOldExist message box, shown once after the whole patch was
// converted (PatchDataTest_ShowNoOldWarning).
function mismatchMessage(info: VkpMismatchInfo, revert: boolean, dryRun: boolean): string {
	const lines = [
		`WARNING: the ${revert ? "patched" : "old"} data of ${info.mismatchCount} of ${info.totalWrites} block(s) of the patch is not found in the flash.`,
		`First mismatch at ${hex(info.addr)}${info.line ? ` (patch line ${info.line})` : ""}: ` +
			`the flash has ${hexPreview(Uint8Array.of(info.deviceByte))}, ` +
			`the patch expects ${info.oldByte === undefined ? "nothing" : hexPreview(Uint8Array.of(revert ? info.newByte : info.oldByte))}.`,
		"A similar patch may have been applied already, or this is a wrong flash version.",
		revert
			? "Writing the old data of the patch anyway may corrupt the phone. Do not use this patch for apply afterwards!"
			: "Writing the new data of the patch anyway may corrupt the phone. Do not use this patch for revert afterwards!",
	];
	if (!dryRun)
		lines.push("A recovery patch will be saved before anything is written, so that the changes of this run can be undone.");
	return lines.join("\n") + `\n${revert ? "Revert" : "Apply"} anyway?`;
}

function quoteArg(value: string): string {
	return /[\s"']/.test(value) ? `"${value}"` : value;
}

// The confirmation prompts of the warnings above.
//
// The patch itself may come from stdin, so the answers are read from the
// terminal (/dev/tty) rather than from stdin. Without a terminal the
// warnings are declined unless --yes / --force was given: the core then
// cancels the operation before anything is written.
class TtyPrompt {
	private tty?: Readable;

	constructor(private readonly options: PatchOptions) {}

	async confirm(message: string): Promise<boolean> {
		console.error("");
		console.error(message.split("\n").map((line) => `! ${line}`).join("\n"));
		if (this.options.yes) {
			console.error("! yes (--yes)");
			console.error("");
			return true;
		}
		const input = this.open();
		if (!input) {
			console.error("! no terminal to ask on: cancelled (re-run with --yes to confirm)");
			console.error("");
			return false;
		}
		const rl = createInterface({ input, output: process.stderr, terminal: true });
		try {
			const answer = await rl.question("! [y/N] ");
			console.error("");
			return /^\s*(y|yes)\s*$/i.test(answer);
		} finally {
			rl.close();
		}
	}

	// The terminal to ask on: stdin when it is one (and was not used for the
	// patch), /dev/tty otherwise.
	private open(): Readable | undefined {
		if (this.tty)
			return this.tty;
		// A question is only worth asking when somebody is looking at it: with
		// every standard stream redirected (a test harness, a CI job, a pipe)
		// the controlling terminal of the session may still be open, but the
		// warning was never shown on it.
		if (!process.stdin.isTTY && !process.stderr.isTTY && !process.stdout.isTTY)
			return undefined;
		if (this.options.patch && process.stdin.isTTY)
			return process.stdin;
		if (process.platform == "win32")
			return undefined;
		try {
			// Opened by hand: createReadStream() reports a missing controlling
			// terminal asynchronously, which would hang the prompt instead of
			// declining the warning.
			this.tty = createReadStream("", { fd: openSync("/dev/tty", "r") });
			this.tty.on("error", () => {});
			return this.tty;
		} catch {
			return undefined;
		}
	}

	close(): void {
		this.tty?.destroy();
		this.tty = undefined;
	}
}
