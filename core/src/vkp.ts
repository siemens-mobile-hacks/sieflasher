// VKP patch application over a flasher device (phone or fullflash dump).
// The patch parsing itself is done by @sie-js/vkp (see CPatchPage::DoPatchApply
// in the original V_KLay for the apply/undo semantics).
//
// The apply flow is the port of CPatchPage::PatchDataConvert() +
// PatchDataWrite(): every write is first read back from the device and
// classified; the "old data not found in the flash" and "no old data in the
// patch" situations are confirmed by the caller (the analogs of the V_KLay
// message boxes) and, when confirmed, a repair patch is generated and saved
// before anything is written (CPatchPage::RepairPatchSave() +
// VPatchBlock::MakeTextLine()). Undoing the repair patch restores the original
// device data - the equivalent of loading the "*_REPAIR.vkp" file in V_KLay
// and pressing "Undo Patch".

import { Buffer } from "buffer";
import { sprintf } from "sprintf-js";
import { VkpParseResult, VkpWrite } from "@sie-js/vkp";
import { FlasherDevice } from "./device.js";

export interface VkpWriteReport {
	addr: number;
	size: number;
	status: "applied" | "skipped" | "error";
	reason: string;
}

export interface VkpMismatchInfo {
	// Writes whose checked data does not match the device data
	// (V_KLay's noOldCounter).
	mismatchCount: number;
	// Total writes in the patch.
	totalWrites: number;
	// Address of the first differing byte of the first mismatching write.
	addr: number;
	// The byte the device has at that address.
	deviceByte: number;
	// The old data byte of the patch there (undefined when the patch has no
	// old data).
	oldByte?: number;
	// The new data byte of the patch there.
	newByte: number;
	// The patch text line of the mismatching write.
	line?: number;
}

export interface VkpApplyOptions {
	// Undo the patch instead of applying it.
	revert?: boolean;
	// Only check, do not write anything.
	dryRun?: boolean;
	// Apply even when the old data does not match.
	force?: boolean;
	// Interactive confirmations, the analogs of the V_KLay message boxes in
	// PatchDataConvert(). Returning false cancels the whole operation before
	// anything is written.
	// V_KLay's msgNoOldInPatch: "some or all blocks in the patch do not have
	// the old data" - applying makes the undo impossible, undoing skips such
	// writes.
	confirmNoOld?: () => boolean | Promise<boolean>;
	// V_KLay's msgOldExist (shown once, after the whole patch was converted,
	// by PatchDataTest_ShowNoOldWarning): "The old data of N from M blocks of
	// patch is not found in flash".
	confirmMismatch?: (info: VkpMismatchInfo) => boolean | Promise<boolean>;
	// Repair patch saving (V_KLay: RepairPatchGetFileName() +
	// RepairPatchSave()). Called with the generated text and the suggested
	// file name before any data is written. Return the name the patch was
	// saved as, undefined/null to continue without saving, or false to cancel
	// the operation (V_KLay aborts when its "Save Repair Patch As..." dialog
	// is cancelled, o_bIsRepairPatchCanSkip=FALSE).
	saveRepairPatch?: (text: string, fileName: string) =>
		string | false | undefined | null | Promise<string | false | undefined | null>;
	// The repair patch header embeds the patch document name and the
	// beginning of the patch text, like RepairPatchSave() does.
	patchName?: string;
	patchText?: string;
	toolName?: string;
}

// The repair patch of an operation (V_KLay's m_strLastRepairPatchFileName).
export interface VkpRepairPatchInfo {
	// The generated repair patch text.
	text: string;
	// The suggested file name ({patch}_REPAIR.vkp).
	fileName: string;
	// The name returned by saveRepairPatch, when it was saved.
	savedAs?: string;
}

export interface VkpApplyResult {
	action: "apply" | "revert";
	dryRun: boolean;
	reports: VkpWriteReport[];
	// Number of actually written bytes (0 in dry run).
	written: number;
	read: number;
	// All writes are applied/skipped without errors.
	ok: boolean;
	// Patch is already applied (or not applied in revert mode):
	// every write was skipped without errors.
	alreadyDone: boolean;
	// Nothing to do at all.
	empty: boolean;
	// The user declined one of the confirmations: nothing was written
	// (V_KLay's VPB_PATCH_USER_SAY_NO / VPB_PATCH_USER_CANCELS_REPAIR_SAVE).
	cancelled: boolean;
	// The repair patch, when one was needed.
	repairPatch?: VkpRepairPatchInfo;
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length != b.length)
		return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] != b[i])
			return false;
	}
	return true;
}

function firstMismatch(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] != b[i])
			return i;
	}
	return -1;
}

// V_KLay's pre-scan warning suppression (VPB_FLAG_DIS_UNDO /
// VPB_FLAG_DIS_WARN_APPLY_NO_OLD): #pragma disable undo always, and
// #pragma disable warn_no_old_on_apply on apply.
function noOldWarningSuppressed(write: VkpWrite, revert: boolean): boolean {
	if (write.pragmas?.undo === false)
		return true;
	return !revert && write.pragmas?.warn_no_old_on_apply === false;
}

export async function applyVkpToDevice(device: FlasherDevice, vkp: VkpParseResult, options: VkpApplyOptions = {}): Promise<VkpApplyResult> {
	const revert = !!options.revert;
	const dryRun = !!options.dryRun;
	const force = !!options.force;
	const result: VkpApplyResult = {
		action: revert ? "revert" : "apply",
		dryRun,
		reports: [],
		written: 0,
		read: 0,
		ok: true,
		alreadyDone: true,
		empty: true,
		cancelled: false,
	};

	const writes = vkp.writes;
	if (!writes.length)
		return result;
	result.empty = false;

	const devStart = device.getMemoryStart();
	const devEnd = devStart + device.getMemorySize();

	// V_KLay patch addresses are offsets from the flash start (the phone
	// device addresses the flash relative to its base: "address 0xA15C0000 is
	// 0x015C0000 in V_KLay"), but patches written with absolute CPU addresses
	// exist as well. When the flash base is not 0 and the whole patch fits
	// the flash only as offsets, shift it by the base (the V_KLay
	// PatcherWrapAddr option, applied automatically).
	let patchOffset = 0;
	if (devStart != 0
		&& !writes.every((w) => w.addr >= devStart && w.addr + w.new.length <= devEnd)
		&& writes.every((w) => w.addr + w.new.length <= devEnd - devStart))
		patchOffset = devStart;

	// One planned write: the classification result of the conversion phase
	// plus the data captured for the repair patch.
	interface Plan {
		report: VkpWriteReport;
		// The original patch address (unshifted): the repair patch keeps the
		// address form of the source patch.
		patchAddr: number;
		// Device data before the operation (repair patch "old" column,
		// V_KLay's m_PhoneData).
		current?: Uint8Array;
		// Data written by this operation (repair patch "new" column).
		written?: Uint8Array;
		// Patch data the device data is checked against (repair patch comment
		// column, V_KLay's m_OldData).
		expected?: Uint8Array;
		// The write to perform in the write phase (PatchDataWrite).
		write?: { addr: number; data: Uint8Array };
		// Interactive mismatch: decided after the whole patch was converted.
		deferred?: { forced: VkpWriteReport; write: { addr: number; data: Uint8Array } };
	}
	const plans: Plan[] = [];
	// V_KLay's m_strLastRepairPatchFileName: a repair patch must be saved
	// before the writes when the user confirmed a warning.
	let needRepair = false;
	let mismatch: { info: VkpMismatchInfo; count: number } | undefined;
	let mismatchTotal = 0;

	// V_KLay PatchDataConvert() pre-scan: writes without old data. Applying
	// them makes the undo impossible, undoing skips them; V_KLay warns about
	// it before touching the device and saves a repair patch first
	// (msgNoOldInPatch + msgDescr message boxes). The warning is suppressed
	// per write by #pragma disable undo / #pragma disable warn_no_old_on_apply.
	const hasNoOldWrites = !force && writes.some((w) => !w.old && !noOldWarningSuppressed(w, revert));
	if (hasNoOldWrites && options.confirmNoOld) {
		if (!(await options.confirmNoOld())) {
			result.ok = false;
			result.cancelled = true;
			return result;
		}
		needRepair = true;
	}

	// ------------------------------------------------------------------
	// Phase 1: conversion (PatchDataConvert) - read every write back from
	// the device and classify it. Nothing is written yet; mismatches are
	// decided after the whole patch was converted, exactly like V_KLay does.
	for (const group of groupWrites(writes)) {
		for (const write of group) {
			const newData = write.new;
			const oldData = write.old;
			const addr = write.addr + patchOffset;
			const base: Omit<VkpWriteReport, "status" | "reason"> = { addr, size: newData.length };

			if (addr < devStart || addr + newData.length > devEnd) {
				plans.push({
					report: {
						...base, status: "error",
						reason: sprintf("Address 0x%08X (size 0x%X) is outside of the flash.", addr, newData.length),
					},
					patchAddr: write.addr,
				});
				continue;
			}

			// The first mismatch of a write: V_KLay builds its message from
			// the bytes at the first differing position (msgOldExist +
			// msgApplyDescr / msgUndoDescr).
			const onMismatch = (plan: Plan, current: Uint8Array, expected: Uint8Array): void => {
				const at = Math.max(0, firstMismatch(current, expected));
				const reason = sprintf(
					revert
						? "The patched data at 0x%08X does not match (mismatch at offset 0x%X).\nExpected: %s\nGot:      %s"
						: "The old data at 0x%08X does not match the phone data (mismatch at offset 0x%X).\nExpected: %s\nGot:      %s",
					addr + at, at,
					hexPreview(expected.subarray(at, at + 16)),
					hexPreview(current.subarray(at, at + 16)),
				);
				const forcedReason = revert
					? "Forced undo: the patched data does not match."
					: "Forced apply: the old data does not match.";
				mismatchTotal++;
				if (!force && options.confirmMismatch) {
					// The decision is postponed to the end of the conversion
					// (PatchDataTest_ShowNoOldWarning): one dialog for the
					// whole patch, and a YES forces all the mismatches
					// (V_KLay's writenewanyway).
					if (!mismatch) {
						mismatch = {
							info: {
								mismatchCount: 0,
								totalWrites: writes.length,
								addr: addr + at,
								deviceByte: current[at],
								oldByte: oldData ? oldData[at] : undefined,
								newByte: newData[Math.min(at, newData.length - 1)],
								line: write.loc?.line,
							},
							count: 0,
						};
					}
					mismatch.count++;
					plan.report = { ...base, status: "error", reason };
					plan.deferred = {
						forced: { ...base, status: "applied", reason: forcedReason },
						write: { addr, data: plan.written! },
					};
					plans.push(plan);
					return;
				}
				if (force) {
					plan.report = { ...base, status: "applied", reason: forcedReason };
					plan.write = { addr, data: plan.written! };
				} else {
					plan.report = { ...base, status: "error", reason };
				}
				plans.push(plan);
			};

			if (!revert) {
				const current = await device.read(addr, newData.length);
				result.read += newData.length;
				const plan: Plan = {
					report: { ...base, status: "applied", reason: "" },
					patchAddr: write.addr,
					current,
					written: newData,
					expected: oldData ?? current,
				};

				if (buffersEqual(current, newData)) {
					plan.report = {
						...base, status: "skipped",
						reason: "The new data already exists in the phone (patch is already applied).",
					};
					plans.push(plan);
					continue;
				}

				if (oldData) {
					if (!buffersEqual(current, oldData)) {
						onMismatch(plan, current, oldData);
						continue;
					}
					plan.report = { ...base, status: "applied", reason: "" };
				} else {
					plan.report = {
						...base, status: "applied",
						reason: write.pragmas?.warn_no_old_on_apply
							? "No old data specified, undo will be impossible."
							: "",
					};
				}
				plan.write = { addr, data: newData };
				plans.push(plan);
			} else {
				// Revert. Writes without old data cannot be undone: V_KLay
				// skips them after the confirmed warning (existNewCounter++),
				// otherwise they are errors.
				if (!oldData) {
					const plan: Plan = { report: { ...base, status: "skipped", reason: "" }, patchAddr: write.addr };
					plan.report = options.confirmNoOld
						? { ...base, status: "skipped", reason: "The patch has no old data for this write, it cannot be undone." }
						: { ...base, status: "error", reason: "The patch has no old data, undo is impossible." };
					plans.push(plan);
					continue;
				}

				const current = await device.read(addr, newData.length);
				result.read += newData.length;
				const plan: Plan = {
					report: { ...base, status: "applied", reason: "" },
					patchAddr: write.addr,
					current,
					written: oldData,
					expected: newData,
				};

				if (buffersEqual(current, oldData)) {
					plan.report = {
						...base, status: "skipped",
						reason: "The old data already exists in the phone (patch is not applied).",
					};
					plans.push(plan);
					continue;
				}

				if (!buffersEqual(current, newData)) {
					onMismatch(plan, current, newData);
					continue;
				}
				plan.report = { ...base, status: "applied", reason: "" };
				plan.write = { addr, data: oldData };
				plans.push(plan);
			}
		}
	}

	// V_KLay asks once, after the whole patch was converted, and only when
	// not everything is already applied (VPB_PATCH_ALREADY_EXIST suppresses
	// the warning).
	const allSkipped = plans.every((p) => p.report.status == "skipped");
	if (mismatch && !allSkipped && !force && options.confirmMismatch) {
		const info: VkpMismatchInfo = { ...mismatch.info, mismatchCount: mismatch.count };
		if (!(await options.confirmMismatch(info))) {
			result.ok = false;
			result.cancelled = true;
			result.reports = plans.map((p) => p.report);
			return result;
		}
		needRepair = true;
		for (const plan of plans) {
			if (!plan.deferred)
				continue;
			plan.report = plan.deferred.forced;
			plan.write = plan.deferred.write;
		}
	}

	// ------------------------------------------------------------------
	// The repair patch (CPatchPage::RepairPatchSave): generated whenever the
	// original device data cannot be reconstructed by undoing the patch -
	// a confirmed data mismatch or writes without old data. It is saved
	// through the callback (before any write) when the user confirmed one of
	// the warnings; without a callback the text is still returned with the
	// result so the caller can save it.
	const wantsRepair = needRepair || (!force && (writes.some((w) => !w.old) || mismatchTotal > 0));
	if (wantsRepair) {
		const entries: VkpRepairEntry[] = [];
		for (const plan of plans) {
			if (!plan.current || !plan.written || !plan.expected)
				continue;
			if (plan.current.length != plan.written.length || plan.expected.length != plan.written.length)
				continue;
			entries.push({ addr: plan.patchAddr, device: plan.current, written: plan.written, expected: plan.expected });
		}
		if (entries.length) {
			const fileName = makeRepairPatchFileName(options.patchName);
			const text = makeRepairPatchText({
				action: revert ? "revert" : "apply",
				patchName: options.patchName,
				patchText: options.patchText,
				toolName: options.toolName,
				entries,
			});
			result.repairPatch = { text, fileName };
			if (needRepair && options.saveRepairPatch) {
				const savedAs = await options.saveRepairPatch(text, fileName);
				if (savedAs === false) {
					// V_KLay: cancelling the "Save Repair Patch As..." dialog
					// aborts the operation (o_bIsRepairPatchCanSkip=FALSE).
					result.repairPatch = undefined;
					result.ok = false;
					result.cancelled = true;
					result.reports = plans.map((p) => p.report);
					return result;
				}
				if (savedAs)
					result.repairPatch.savedAs = savedAs;
			}
		}
	}

	// ------------------------------------------------------------------
	// Phase 2: the writes (PatchDataWrite).
	result.reports = plans.map((p) => p.report);
	if (!dryRun) {
		for (const plan of plans) {
			if (!plan.write)
				continue;
			await device.write(plan.write.addr, plan.write.data);
			result.written += plan.write.data.length;
		}
		if (result.written > 0)
			await device.flush();
	}

	// "Already applied" ("not applied" when undoing) is only reported when
	// every write was skipped without any error; errors mean the real state
	// of the patch in the device is unknown.
	result.ok = result.reports.every((r) => r.status != "error");
	result.alreadyDone = result.ok && result.reports.length == writes.length &&
		result.reports.every((r) => r.status == "skipped");
	return result;
}

function groupWrites(writes: VkpWrite[]): VkpWrite[][] {
	// Keep the original order; grouping here is a placeholder for
	// future optimizations (sorting by address would break pragma semantics).
	return writes.map((w) => [w]);
}

export function hexPreview(data: Uint8Array): string {
	return Buffer.from(data).toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") ?? "";
}

// ---------------------------------------------------------------------
// Repair patch ("restore patch") generation - the port of
// CPatchPage::RepairPatchSave() + VPatchBlock::MakeTextLine().
//
// The repair patch is a regular VKP patch with
//   old data  = the original data read from the device,
//   new data  = the data written by the operation,
// so undoing it ("Undo Patch" in V_KLay) restores the original device data
// even when the applied patch itself has no (or wrong) old data.

// One write of the operated patch, as captured during the conversion.
export interface VkpRepairEntry {
	// The patch address (in the form used by the source patch).
	addr: number;
	// The data the device had before the operation (the "old" column).
	device: Uint8Array;
	// The data written by the operation (the "new" column).
	written: Uint8Array;
	// The patch data the device data was checked against (the comment
	// column; the original device data when the patch has no old data).
	expected: Uint8Array;
}

export interface VkpRepairPatchOptions {
	action: "apply" | "revert";
	patchName?: string;
	patchText?: string;
	toolName?: string;
	entries: VkpRepairEntry[];
}

// V_KLay's separatorPatchText (70 chars) and the MakeTextLine() layout:
// 16 bytes per line, one 32-char hex column per data field.
const REPAIR_SEPARATOR = "______________________________________________________________________";
const REPAIR_BLOCK_LEN = 16;
const REPAIR_COLUMN_LEN = 32;

// V_KLay's strCPPRepairPatchSaveDataHeader.
const REPAIR_DATA_HEADER = [
	";       Old data in the phone:           Current (new) data in the phone: ;Old data in the patch:",
	";addr.  0 1 2 3 4 5 6 7 8 9 A B C D E F  0 1 2 3 4 5 6 7 8 9 A B C D E F  ;0 1 2 3 4 5 6 7 8 9 A B C D E F",
];

// Port of MergeStringsCenter(): the text (with padding spaces) centered
// inside the separator line.
function mergeStringsCenter(dest: string, src: string): string {
	src = " " + src + " ";
	const pos = Math.floor((dest.length - src.length) / 2);
	if (pos <= 0)
		return src;
	return dest.substring(0, pos) + src + dest.substring(pos + src.length);
}

// Port of the VPB_TYPE_DIFFERENT / VPB_TYPE_EQUAL run splitting of
// VPatchBlock::MakeTextLine(): runs never cross a 16-byte boundary, the
// columns hold the bytes at their position inside the block.
function repairEntryLines(entry: VkpRepairEntry, different: boolean): string[] {
	const lines: string[] = [];
	const size = entry.device.length;
	let b = 0;
	while (b < size) {
		const equal = entry.device[b] == entry.expected[b];
		if (different ? equal : !equal) {
			b++;
			continue;
		}
		const blockAddr = (entry.addr + b) & ~(REPAIR_BLOCK_LEN - 1);
		let s = 1;
		while (b + s < size && blockAddr == ((entry.addr + b + s) & ~(REPAIR_BLOCK_LEN - 1))) {
			if (different
				? entry.device[b + s] == entry.expected[b + s]
				: entry.device[b + s] != entry.expected[b + s])
				break;
			s++;
		}
		const ident = (entry.addr + b - blockAddr) * 2;
		lines.push(
			(entry.addr + b).toString(16).toUpperCase().padStart(6, "0") + ": " +
			hexColumn(entry.device, b, s, ident) + " " +
			hexColumn(entry.written, b, s, ident) +
			" ;" + hexColumn(entry.expected, b, s, ident),
		);
		b += s;
	}
	return lines;
}

// The 32-char data column of a line: byte pairs placed at their offset
// inside the 16-byte block (V_KLay writes them without separators).
function hexColumn(data: Uint8Array, offset: number, count: number, ident: number): string {
	const column = new Array<string>(REPAIR_COLUMN_LEN).fill(" ");
	for (let i = 0; i < count; i++, ident += 2) {
		const hex = data[offset + i].toString(16).toUpperCase().padStart(2, "0");
		column[ident] = hex[0];
		column[ident + 1] = hex[1];
	}
	return column.join("");
}

// Port of the patch description embedding in RepairPatchSave(): the first
// maxLines non-empty lines of the patch text, commented like
// CommentAllLinesOfText() does.
function collectPatchDescription(text: string, maxLines: number): string[] {
	const lines: string[] = [];
	for (const raw of text.split(/\r\n|\r|\n/)) {
		if (!raw.trim())
			continue;
		lines.push(/^\s*;/.test(raw) ? raw : raw.replace(/^(\s*)/, "$1;"));
		if (lines.length > maxLines)
			return [...lines.slice(0, maxLines), "; ..."];
	}
	return lines;
}

// V_KLay CPatchPage::GetDefaultFileName(): Patch_%Y-%m-%d_%H-%M-%S.vkp
export function makeDefaultPatchFileName(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `Patch_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.vkp`;
}

// V_KLay CPatchPage::RepairPatchGetFileName(): {title}_REPAIR.{ext} of the
// patch document (the default name for a never saved patch).
export function makeRepairPatchFileName(patchName?: string): string {
	if (!patchName)
		return makeDefaultPatchFileName().replace(/\.vkp$/, "_REPAIR.vkp");
	const dot = patchName.lastIndexOf(".");
	if (dot <= 0)
		return `${patchName}_REPAIR.vkp`;
	return `${patchName.slice(0, dot)}_REPAIR${patchName.slice(dot)}`;
}

// Generates the repair patch text (the file content of
// CPatchPage::RepairPatchSave(), non-simple mode).
export function makeRepairPatchText(options: VkpRepairPatchOptions): string {
	const tool = options.toolName ?? "Siemens Mobile Web Tools";
	const lines: string[] = [];

	lines.push(";" + mergeStringsCenter(REPAIR_SEPARATOR, "*** REPAIR PATCH ***"));
	lines.push("");
	lines.push(`; Made by ${tool}`);
	lines.push("; Press \"Undo Patch\" button to repair phone.");
	lines.push("");
	lines.push(";  !!!WARNING!!! DO NOT UNDO THIS PATCH, IF YOU MAKE SOME MODIFICATION");
	lines.push(`; OF PHONE AFTER ${options.action == "apply" ? "APPLYING" : "UNDOING"} PATCH WITH NAME:`);
	lines.push("");
	lines.push(";" + mergeStringsCenter(REPAIR_SEPARATOR, "PATCH FILE NAME:"));
	lines.push(";  " + (options.patchName || makeDefaultPatchFileName()));
	lines.push("");
	lines.push(";" + mergeStringsCenter(REPAIR_SEPARATOR, "PATCH DESCRIPTION:"));
	lines.push(";");
	lines.push(...collectPatchDescription(options.patchText ?? "", 32));
	lines.push(";" + REPAIR_SEPARATOR);
	lines.push("");
	lines.push("");
	lines.push("#pragma disable warn_if_old_exist_on_undo");
	lines.push("");
	lines.push(";different phone data and old data from the patch:");
	lines.push(...REPAIR_DATA_HEADER);
	for (const entry of options.entries)
		lines.push(...repairEntryLines(entry, true));
	lines.push("");
	lines.push(";same phone data and old data from the patch:");
	lines.push(...REPAIR_DATA_HEADER);
	for (const entry of options.entries)
		lines.push(...repairEntryLines(entry, false));
	lines.push("");
	lines.push("#pragma enable warn_if_old_exist_on_undo");

	return lines.join("\r\n") + "\r\n";
}
