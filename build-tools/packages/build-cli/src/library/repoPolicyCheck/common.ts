/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import fs from "node:fs";

/**
 * each handler has a name for filtering and a match regex for matching which files it should resolve
 * the handler function returns an error message or undefined/null for success
 * the resolver function (optional) can attempt to resolve the failed validation
 */
export interface Handler {
	name: string;
	match: RegExp;

	/**
	 *
	 * @param file - Absolute path to the file.
	 * @param root - Path to the repo root. This can be used to make repo-relative paths if needed.
	 * @returns `undefined` if the check is successful. Otherwise returns an error message string.
	 */
	handler: (file: string, root: string) => Promise<string | undefined>;
	resolver?: (
		file: string,
		root: string,
	) =>
		| Promise<{ resolved: boolean; message?: string }>
		| { resolved: boolean; message?: string };
	final?: (root: string, resolve: boolean) => { error?: string } | undefined;
}

export function readFile(file: string): string {
	return fs.readFileSync(file, { encoding: "utf8" });
}

export function writeFile(file: string, data: string): void {
	fs.writeFileSync(file, data, { encoding: "utf8" });
}
