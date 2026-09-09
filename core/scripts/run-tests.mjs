#!/usr/bin/env node
// Runs the TypeScript tests with Node's built-in test runner.
// Compiles the needed sources into .test-build/ first, since the project
// has no test bundler installed.
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const buildDir = path.join(root, ".test-build");

const testSuites = [
	{
		sources: [
			"src/index.ts",
			"src/web/transport.ts",
			"tests/flasher.test.ts",
		],
		run: [".test-build/tests/flasher.test.js"],
	},
];

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir);

for (const suite of testSuites) {
	execSync(`pnpm exec tsc ${suite.sources.join(" ")} --outDir ${buildDir} ` +
		"--module esnext --target esnext --moduleResolution bundler --skipLibCheck --esModuleInterop --strict",
		{ stdio: "inherit", cwd: root });
}

// node_modules for the compiled tests (symlink: fast).
const nodeModulesLink = path.join(buildDir, "node_modules");
if (!existsSync(nodeModulesLink))
	symlinkSync(path.join(root, "node_modules"), nodeModulesLink, "dir");

let failed = false;
for (const testPath of testSuites.flatMap((s) => s.run)) {
	try {
		execSync(`node --test --test-reporter spec ${testPath}`, { stdio: "inherit", cwd: root });
	} catch (e) {
		failed = true;
	}
}

if (failed)
	process.exit(1);

if (!existsSync(path.join(buildDir, "keep")))
	rmSync(buildDir, { recursive: true, force: true });
