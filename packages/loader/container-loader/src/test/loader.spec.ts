/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "node:assert";

import type { IProvideLayerCompatDetails } from "@fluid-internal/client-utils";
import { AttachState } from "@fluidframework/container-definitions";
import { FluidErrorTypes, type ConfigTypes } from "@fluidframework/core-interfaces/internal";
import {
	type IDocumentServiceFactory,
	type IResolvedUrl,
	type IUrlResolver,
} from "@fluidframework/driver-definitions/internal";
import {
	isFluidError,
	MockLogger,
	wrapConfigProviderWithDefaults,
	mixinMonitoringContext,
	createChildLogger,
} from "@fluidframework/telemetry-utils/internal";
import { v4 as uuid } from "uuid";

import { Container } from "../container.js";
import { Loader } from "../loader.js";
import type { IPendingDetachedContainerState } from "../serializedStateManager.js";

import { failProxy, failSometimeProxy } from "./failProxy.js";
import {
	createTestCodeLoaderProxy,
	createTestDocumentServiceFactoryProxy,
} from "./testProxies.js";

const documentServiceFactoryFailProxy = failSometimeProxy<
	IDocumentServiceFactory & IProvideLayerCompatDetails
>({
	ILayerCompatDetails: undefined,
});

describe("loader unit test", () => {
	it("rehydrateDetachedContainerFromSnapshot with invalid format", async () => {
		const loader = new Loader({
			codeLoader: failProxy(),
			documentServiceFactory: documentServiceFactoryFailProxy,
			urlResolver: failProxy(),
		});

		try {
			await loader.rehydrateDetachedContainerFromSnapshot(`{"foo":"bar"}`);
			assert.fail("should fail");
		} catch (error) {
			assert.strict(isFluidError(error), `should be a Fluid error: ${error}`);
			assert.strictEqual(
				error.errorType,
				FluidErrorTypes.usageError,
				"should be a usage error",
			);
		}
	});

	it("rehydrateDetachedContainerFromSnapshot with valid format", async () => {
		const loader = new Loader({
			codeLoader: createTestCodeLoaderProxy(),
			documentServiceFactory: documentServiceFactoryFailProxy,
			urlResolver: failProxy(),
		});
		const detached = await loader.createDetachedContainer({ package: "none" });
		const detachedContainerState = detached.serialize();
		const parsedState = JSON.parse(detachedContainerState) as IPendingDetachedContainerState;
		assert.strictEqual(parsedState.attached, false);
		assert.strictEqual(parsedState.hasAttachmentBlobs, false);
		assert.strictEqual(Object.keys(parsedState.snapshotBlobs).length, 4);
		assert.ok(parsedState.baseSnapshot);
		await loader.rehydrateDetachedContainerFromSnapshot(detachedContainerState);
	});

	it("rehydrateDetachedContainerFromSnapshot with valid format and attachment blobs", async () => {
		const loader = new Loader({
			codeLoader: createTestCodeLoaderProxy({ createDetachedBlob: true }),
			documentServiceFactory: documentServiceFactoryFailProxy,
			urlResolver: failProxy(),
		});
		const detached = await loader.createDetachedContainer({ package: "none" });
		const detachedContainerState = detached.serialize();
		const parsedState = JSON.parse(detachedContainerState) as IPendingDetachedContainerState;
		assert.strictEqual(parsedState.attached, false);
		assert.strictEqual(parsedState.hasAttachmentBlobs, true);
		assert.strictEqual(Object.keys(parsedState.snapshotBlobs).length, 4);
		assert.ok(parsedState.baseSnapshot);
		await loader.rehydrateDetachedContainerFromSnapshot(detachedContainerState);
	});

	it("serialize and rehydrateDetachedContainerFromSnapshot while attaching", async () => {
		const loader = new Loader({
			codeLoader: createTestCodeLoaderProxy(),
			documentServiceFactory: documentServiceFactoryFailProxy,
			urlResolver: failProxy(),
			configProvider: {
				getRawConfig: (name): ConfigTypes =>
					name === "Fluid.Container.RetryOnAttachFailure" ? true : undefined,
			},
		});
		const detached = await loader.createDetachedContainer({ package: "none" });
		await detached.attach({ url: "none" }).then(
			() => assert.fail("attach should fail"),
			() => {},
		);

		assert.strictEqual(detached.closed, false);
		assert.strictEqual(detached.attachState, AttachState.Attaching);

		const detachedContainerState = detached.serialize();
		const parsedState = JSON.parse(detachedContainerState) as IPendingDetachedContainerState;
		assert.strictEqual(parsedState.attached, false);
		assert.strictEqual(parsedState.hasAttachmentBlobs, false);
		assert.strictEqual(Object.keys(parsedState.snapshotBlobs).length, 4);
		assert.deepStrictEqual(parsedState.pendingRuntimeState, { pending: [] });
		assert.ok(parsedState.baseSnapshot);
		await loader.rehydrateDetachedContainerFromSnapshot(detachedContainerState);
	});

	it("serialize and rehydrateDetachedContainerFromSnapshot while attaching with valid format and attachment blobs", async () => {
		const resolvedUrl: IResolvedUrl = {
			id: uuid(),
			endpoints: {},
			tokens: {},
			type: "fluid",
			url: "none",
		};
		const loader = new Loader({
			codeLoader: createTestCodeLoaderProxy({ createDetachedBlob: true }),
			documentServiceFactory: createTestDocumentServiceFactoryProxy(resolvedUrl),
			urlResolver: failSometimeProxy<IUrlResolver>({
				resolve: async () => resolvedUrl,
			}),
			configProvider: {
				getRawConfig: (name): ConfigTypes =>
					name === "Fluid.Container.RetryOnAttachFailure" ? true : undefined,
			},
		});
		const detached = await loader.createDetachedContainer({ package: "none" });

		await detached.attach({ url: "none" }).then(
			() => assert.fail("attach should fail"),
			() => {},
		);

		assert.strictEqual(detached.closed, false);
		assert.strictEqual(detached.attachState, AttachState.Attaching);

		const detachedContainerState = detached.serialize();
		const parsedState = JSON.parse(detachedContainerState) as IPendingDetachedContainerState;
		assert.strictEqual(parsedState.attached, false);
		assert.strictEqual(parsedState.hasAttachmentBlobs, true);
		assert.strictEqual(Object.keys(parsedState.snapshotBlobs).length, 4);
		assert.ok(parsedState.baseSnapshot);
		await loader.rehydrateDetachedContainerFromSnapshot(detachedContainerState);
	});

	it("ConnectionStateHandler feature gate overrides", () => {
		const configProvider = wrapConfigProviderWithDefaults(
			undefined, // original provider
			{
				"Fluid.Container.DisableCatchUpBeforeDeclaringConnected": true,
				"Fluid.Container.DisableJoinSignalWait": true,
			},
		);

		const logger = mixinMonitoringContext(
			createChildLogger({ logger: new MockLogger() }),
			configProvider,
		);

		// Ensure that this call does not crash due to potential reentrnacy:
		// - Container.constructor
		// - ConnectionStateHandler.constructor
		// - fetching overwrites from config
		// - logs event about fetching config
		// - calls property getters on logger setup by Container.constructor
		// - containerConnectionState getter
		// - Container.connectionState getter
		// - Container.connectionStateHandler.connectionState - crash, as Container.connectionStateHandler is undefined (not setup yet).
		new Container({
			urlResolver: failProxy(),
			documentServiceFactory: documentServiceFactoryFailProxy,
			codeLoader: createTestCodeLoaderProxy(),
			options: {},
			scope: {},
			subLogger: logger.logger,
		});
	});
});
