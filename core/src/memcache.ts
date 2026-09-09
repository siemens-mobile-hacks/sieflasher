// Memory cache over the device memory (port of VDevCache from VDevice.cpp).

import { MemGeometry } from "./vkd.js";

export interface CachePage {
	addr: number; // Relative to the device memory start
	size: number;
	data: Uint8Array;
	isChanged: boolean;
}

export const DEFAULT_PAGE_SIZE = 0x020000;

export class MemCache {
	private geometry: MemGeometry[] = [];
	private pages: CachePage[] = [];
	private memAreaStart = 0;

	setMemAreaStart(addr: number): void {
		this.memAreaStart = addr;
	}

	getGeometry(): readonly MemGeometry[] {
		return this.geometry;
	}

	isValid(): boolean {
		return this.geometry.length > 0;
	}

	clearParameters(): void {
		this.geometry = [];
	}

	clearCache(): void {
		this.pages = [];
	}

	clear(): void {
		this.clearParameters();
		this.clearCache();
	}

	setGeometry(geometry: MemGeometry[]): void {
		this.geometry = [...geometry].sort((a, b) => a.startAddr - b.startAddr);
	}

	addGeometry(startAddr: number, pageSize: number): void {
		const geometry = [...this.geometry];
		let i = 0;
		while (i < geometry.length && geometry[i].startAddr < startAddr)
			i++;
		geometry.splice(i, 0, { startAddr, pageSize });
		this.geometry = geometry;
	}

	// Returns the geometry index for the address or -1. With extrapolate=true
	// the very first known geometry is used for addresses below it.
	getGeometryIdxForAddr(addr: number, extrapolate: boolean): number {
		let idx = -1;
		const absAddr = addr + this.memAreaStart;
		for (let i = 0; i < this.geometry.length; i++) {
			if (this.geometry[i].startAddr > absAddr)
				break;
			idx = i;
		}
		if (extrapolate && idx == -1 && this.geometry.length != 0)
			idx = 0;
		return idx;
	}

	// Returns the real page size at the address or -1 when unknown.
	realPageSizeAtAddr(addr: number): number {
		const i = this.getGeometryIdxForAddr(addr, false);
		return i == -1 ? -1 : this.geometry[i].pageSize;
	}

	// Returns the page size at the address, using edge sizes for unknown addresses.
	pageSizeAtAddr(addr: number): number {
		const i = this.getGeometryIdxForAddr(addr, true);
		return i == -1 ? DEFAULT_PAGE_SIZE : this.geometry[i].pageSize;
	}

	getPages(): readonly CachePage[] {
		return this.pages;
	}

	getPageAtAddr(addr: number): { page: CachePage; isNew: boolean } | undefined {
		for (const page of this.pages) {
			if (addr < page.addr)
				break;
			if (addr >= page.addr && addr < page.addr + page.size)
				return { page, isNew: false };
		}
		const page = this.makePageForAddr(addr);
		if (!page)
			return undefined;
		this.pages.push(page);
		this.pages.sort((a, b) => a.addr - b.addr);
		return { page, isNew: true };
	}

	dropChangedPages(): void {
		this.pages = this.pages.filter((p) => !p.isChanged);
	}

	private makePageForAddr(addr: number): CachePage | undefined {
		const i = this.getGeometryIdxForAddr(addr, true);
		let base = 0;
		let size = DEFAULT_PAGE_SIZE;
		if (i != -1) {
			base = this.geometry[i].startAddr - this.memAreaStart;
			size = this.geometry[i].pageSize;
		}
		return {
			addr: Math.floor((addr - base) / size) * size + base,
			size,
			data: new Uint8Array(size),
			isChanged: false,
		};
	}
}
