/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { handleResponse } from "@fluidframework/server-services-shared";
import { Router } from "express";
import type nconf from "nconf";

import {
	checkSoftDeleted,
	getFilesystemManagerFactory,
	getRepoManagerParamsFromRequest,
	type IFileSystemManagerFactories,
	type IRepositoryManagerFactory,
	logAndThrowApiError,
} from "../../utils";

export function create(
	store: nconf.Provider,
	fileSystemManagerFactories: IFileSystemManagerFactories,
	repoManagerFactory: IRepositoryManagerFactory,
): Router {
	const router: Router = Router();
	const repoPerDocEnabled: boolean = store.get("git:repoPerDocEnabled") ?? false;

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	router.get("/repos/:owner/:repo/contents/*", async (request, response, next) => {
		const repoManagerParams = getRepoManagerParamsFromRequest(request);
		const resultP = repoManagerFactory
			.open(repoManagerParams)
			.then(async (repoManager) => {
				const fileSystemManagerFactory = getFilesystemManagerFactory(
					fileSystemManagerFactories,
					repoManagerParams.isEphemeralContainer ?? false,
				);
				const fsManager = fileSystemManagerFactory.create({
					...repoManagerParams.fileSystemManagerParams,
					rootDir: repoManager.path,
				});
				await checkSoftDeleted(
					fsManager,
					repoManager.path,
					repoManagerParams,
					repoPerDocEnabled,
				);
				return repoManager.getContent(request.query.ref as string, request.params[0]);
			})
			.catch((error) => logAndThrowApiError(error, request, repoManagerParams));
		handleResponse(resultP, response);
	});

	return router;
}
