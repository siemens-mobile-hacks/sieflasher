// Patch history and recovery patch storage of the CLI.
//
// The file system analog of the web tools patch history (web-tools
// src/pages/Flasher/history.ts), which itself is the analog of V_KLay's patch
// logging (CPatchPage::DoPatchLogging in PatchPage.cpp): V_KLay saves the
// applied patch text into its log directory and hands it to log.exe/log.bat
// together with the device unique name and the /a (apply) or /u (undo) flag.
// Here every run of `sieflasher apply` / `sieflasher revert` writes the patch
// text and a JSON sidecar with the same metadata the web history keeps:
//
//   ~/.sieflasher/history/2026-09/2026-09-13_12-30-01_apply_S55_mypatch.vkp
//   ~/.sieflasher/history/2026-09/2026-09-13_12-30-01_apply_S55_mypatch.json
//   ~/.sieflasher/recovery/2026-09-13_12-30-01_mypatch_REPAIR.vkp
//
// Nothing is ever deleted automatically: the history is the only record of
// what was written into a phone.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { vkpCanonicalize } from "@sie-js/vkp";

// One logged apply/revert run.
export interface PatchHistoryEntry {
	id: string;
	// When the operation finished, ISO timestamp.
	date: string;
	// apply = patch written to the device, revert = undo.
	action: "apply" | "revert";
	// ok = everything applied or skipped, partial = some writes failed,
	// cancelled = a warning was declined and nothing was written.
	status: "ok" | "partial" | "cancelled";
	// Where it was applied: a real phone or a fullflash dump file.
	source: "phone" | "file";
	// Phone model from the driver (or the dump file name prefix).
	model: string;
	// Phone IMEI, when the loader reports it (x65 flash info v3).
	imei: string;
	// Device name analog of V_KLay's VDevice::GetUniqueName().
	deviceName: string;
	// Flash info line (fw version) or the dump address/size description.
	info: string;
	// The patched serial port or the dump file path.
	target: string;
	// The .vkd driver and the phone definition of a phone run.
	loader?: string;
	phone?: string;
	// The .vkp file name (or the generated patch name for a stdin patch).
	patchName: string;
	// First comment line of the patch, like V_KLay shows in the open dialog.
	patchTitle: string;
	// Number of writes in the patch and bytes actually written.
	writes: number;
	written: number;
	// The recovery ("repair") patch of the run, when one was saved.
	recoveryPatch?: string;
	// The tool that wrote the entry.
	tool: string;
}

// The root of the CLI state: ~/.sieflasher, %APPDATA%\sieflasher on Windows.
// SIEFLASHER_HOME overrides both (used by the tests).
export function sieflasherHome(env: NodeJS.ProcessEnv = process.env): string {
	if (env.SIEFLASHER_HOME)
		return path.resolve(env.SIEFLASHER_HOME);
	if (process.platform == "win32" && env.APPDATA)
		return path.join(env.APPDATA, "sieflasher");
	return path.join(homedir(), ".sieflasher");
}

export function historyDir(env?: NodeJS.ProcessEnv): string {
	return path.join(sieflasherHome(env), "history");
}

export function recoveryDir(env?: NodeJS.ProcessEnv): string {
	return path.join(sieflasherHome(env), "recovery");
}

// YYYY-MM-DD_HH-MM-SS in the local time, like the V_KLay file names
// (GetDefaultFlashFileName / GetDefaultFileName).
export function historyStamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
		`_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

// A file name part: everything that is not a letter, a digit, a dot or a dash
// becomes an underscore, so the names stay portable (and shell friendly).
export function sanitizeName(name: string): string {
	const clean = name.replace(/[^A-Za-z0-9.\-]+/g, "_").replace(/^_+|_+$/g, "");
	return clean.slice(0, 64);
}

// The patch title: the first comment line, like V_KLay uses it as the
// caption of a patch.
export function vkpPatchTitle(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^\s*;\s*(.*\S)/);
		if (match)
			return match[1];
	}
	return "";
}

// Best-effort phone model guess from a dump file name
// ("S55_2020-..._From_40.bin" -> "S55"). Siemens model names start with a
// capital letter (S55, CXV70, M65, SL45).
export function dumpModelFromFileName(name: string): string {
	const base = name.replace(/\.(bin|fls|ful|vkp)$/i, "");
	const first = base.split(/[\s_]+/)[0] ?? "";
	return /^[A-Z][A-Za-z0-9-]{0,9}$/.test(first) ? first : "";
}

export function newPatchHistoryId(): string {
	return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// VKP files are canonically cp1251 with CRLF line endings (V_KLay writes
// them that way); patch text that cp1251 cannot represent is kept as UTF-8.
function patchFileData(text: string): Buffer {
	try {
		const encoded = vkpCanonicalize(text);
		// iconv replaces the characters cp1251 has no room for with "?":
		// when that happened, the UTF-8 text is kept instead of a lossy copy.
		let lost = 0;
		for (const byte of encoded) {
			if (byte == 0x3f)
				lost++;
		}
		if (lost == (text.match(/\?/g)?.length ?? 0))
			return Buffer.from(encoded);
	} catch {
		// Fall through to UTF-8.
	}
	return Buffer.from(text.replace(/\r\n|\r|\n/g, "\r\n"), "utf8");
}

// Picks a free file name in dir: "name.vkp", then "name_2.vkp", ...
function uniquePath(dir: string, base: string, ext: string): string {
	for (let i = 1; ; i++) {
		const file = path.join(dir, i == 1 ? `${base}${ext}` : `${base}_${i}${ext}`);
		try {
			writeFileSync(file, "", { flag: "wx" });
			return file;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code != "EEXIST")
				throw error;
		}
	}
}

export interface SavedHistoryEntry {
	// The patch text copy and its JSON sidecar.
	patchFile: string;
	metaFile: string;
}

// Logs one apply/revert run: the patch text next to a JSON sidecar with the
// entry (the V_KLay DoPatchLogging analog).
export function savePatchHistoryEntry(
	entry: PatchHistoryEntry,
	patchText: string,
	env?: NodeJS.ProcessEnv,
): SavedHistoryEntry {
	const date = new Date(entry.date);
	const dir = path.join(historyDir(env), `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
	mkdirSync(dir, { recursive: true });

	const device = sanitizeName(entry.deviceName || entry.model || "device");
	const patch = sanitizeName(entry.patchName.replace(/\.vkp$/i, "") || "patch");
	const base = [historyStamp(date), entry.action, device, patch].filter(Boolean).join("_");
	const patchFile = uniquePath(dir, base, ".vkp");
	const metaFile = patchFile.replace(/\.vkp$/, ".json");

	writeFileSync(patchFile, patchFileData(patchText));
	writeFileSync(metaFile, JSON.stringify({ ...entry, patchFile: path.basename(patchFile) }, null, "\t") + "\n");
	return { patchFile, metaFile };
}

// Saves a recovery ("repair") patch generated by the core before a risky
// write; returns its absolute path (V_KLay's "Save Repair Patch As..."
// dialog writes {patch}_REPAIR.vkp next to the patch).
export function saveRecoveryPatch(
	text: string,
	fileName: string,
	date = new Date(),
	env?: NodeJS.ProcessEnv,
): string {
	const dir = recoveryDir(env);
	mkdirSync(dir, { recursive: true });
	const base = `${historyStamp(date)}_${sanitizeName(fileName.replace(/\.vkp$/i, "")) || "patch_REPAIR"}`;
	const file = uniquePath(dir, base, ".vkp");
	writeFileSync(file, patchFileData(text));
	return file;
}
