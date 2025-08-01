/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import assert from "assert";

import { stringToBuffer } from "@fluid-internal/client-utils";
import { describeCompat } from "@fluid-private/test-version-utils";
import { AttachState } from "@fluidframework/container-definitions";
import {
	IContainer,
	IHostLoader,
	IRuntime,
} from "@fluidframework/container-definitions/internal";
// eslint-disable-next-line import/no-internal-modules
import { type IPendingRuntimeState } from "@fluidframework/container-runtime/internal/test/containerRuntime";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions/internal";
import type { IFluidHandle } from "@fluidframework/core-interfaces";
import type {
	ISharedMap,
	ISharedDirectory,
	SharedDirectory,
} from "@fluidframework/map/internal";
import { isFluidHandlePayloadPending } from "@fluidframework/runtime-utils/internal";
import {
	ChannelFactoryRegistry,
	DataObjectFactoryType,
	ITestContainerConfig,
	ITestFluidObject,
	ITestObjectProvider,
	createAndAttachContainer,
} from "@fluidframework/test-utils/internal";

import { driverSupportsBlobs } from "./mockDetachedBlobStorage.js";

const mapId = "map";
const directoryId = "directoryKey";

for (const createBlobPayloadPending of [undefined, true] as const) {
	describeCompat(
		`blob handle isAttached (createBlobPayloadPending: ${createBlobPayloadPending})`,
		"NoCompat",
		(getTestObjectProvider, apis) => {
			const { SharedMap, SharedDirectory } = apis.dds;
			const registry: ChannelFactoryRegistry = [
				[mapId, SharedMap.getFactory()],
				[directoryId, SharedDirectory.getFactory()],
			];

			const testContainerConfig: ITestContainerConfig = {
				fluidDataObjectType: DataObjectFactoryType.Test,
				registry,
				runtimeOptions: {
					createBlobPayloadPending,
				},
			};

			describe("from attached container", () => {
				let provider: ITestObjectProvider;
				let loader: IHostLoader;
				let container: IContainer;

				const runtimeOf = (dataObject: ITestFluidObject): IContainerRuntime & IRuntime =>
					dataObject.context.containerRuntime as IContainerRuntime & IRuntime;

				beforeEach("createContainer", async () => {
					provider = getTestObjectProvider();
					loader = provider.makeTestLoader(testContainerConfig);
					container = await createAndAttachContainer(
						provider.defaultCodeDetails,
						loader,
						provider.driver.createCreateNewRequest(provider.documentId),
					);
					provider.updateDocumentId(container.resolvedUrl);
				});

				it("blob is aborted before uploading", async function () {
					if (createBlobPayloadPending) {
						// Blob creation with pending payload doesn't support abort
						this.skip();
					}
					const testString = "this is a test string";
					const dataStore1 = (await container.getEntryPoint()) as ITestFluidObject;
					const ac = new AbortController();
					ac.abort("abort test");
					let surprisingSuccess = false;
					try {
						await dataStore1.runtime.uploadBlob(
							stringToBuffer(testString, "utf-8"),
							ac.signal,
						);
						surprisingSuccess = true;
					} catch (error: any) {
						assert.strictEqual(error.status, undefined);
						assert.strictEqual(error.uploadTime, undefined);
						assert.strictEqual(error.acked, undefined);
					}
					if (surprisingSuccess) {
						assert.fail("Should not succeed");
					}

					const pendingState = (await runtimeOf(dataStore1).getPendingLocalState()) as
						| IPendingRuntimeState
						| undefined;
					assert.strictEqual(pendingState?.pendingAttachmentBlobs, undefined);
				});

				it("blob is aborted after upload succeds", async function () {
					if (createBlobPayloadPending) {
						// Blob creation with pending payload doesn't support abort
						this.skip();
					}
					const testString = "this is a test string";
					const dataStore1 = (await container.getEntryPoint()) as ITestFluidObject;
					const map = await dataStore1.getSharedObject<ISharedMap>(mapId);
					const ac = new AbortController();
					let blob: IFluidHandle<ArrayBufferLike>;
					try {
						blob = await dataStore1.runtime.uploadBlob(
							stringToBuffer(testString, "utf-8"),
							ac.signal,
						);
						ac.abort();
						map.set("key", blob);
					} catch (error: any) {
						assert.fail("Should succeed");
					}
					const pendingState = (await runtimeOf(dataStore1).getPendingLocalState({
						notifyImminentClosure: false,
					})) as IPendingRuntimeState | undefined;
					assert.strictEqual(pendingState?.pendingAttachmentBlobs, undefined);
				});

				it("blob is attached after usage in map", async function () {
					const testString = "this is a test string";
					const testKey = "a blob";
					const dataStore1 = (await container.getEntryPoint()) as ITestFluidObject;
					const map = await dataStore1.getSharedObject<ISharedMap>(mapId);

					const blobHandle = await dataStore1.runtime.uploadBlob(
						stringToBuffer(testString, "utf-8"),
					);
					assert.strictEqual(blobHandle.isAttached, false);
					map.set(testKey, blobHandle);
					assert.strictEqual(blobHandle.isAttached, true);
				});

				it("blob is attached after usage in directory", async function () {
					const testString = "this is a test string";
					const testKey = "a blob";
					const dataStore1 = (await container.getEntryPoint()) as ITestFluidObject;
					const directory = await dataStore1.getSharedObject<SharedDirectory>(directoryId);

					const blobHandle = await dataStore1.runtime.uploadBlob(
						stringToBuffer(testString, "utf-8"),
					);
					assert.strictEqual(blobHandle.isAttached, false);
					directory.set(testKey, blobHandle);
					assert.strictEqual(blobHandle.isAttached, true);
				});

				it("removes pending blob when waiting for blob to be attached", async function () {
					const testString = "this is a test string";
					const dataStore1 = (await container.getEntryPoint()) as ITestFluidObject;
					const map = await dataStore1.getSharedObject<ISharedMap>(mapId);
					const blobHandle = await dataStore1.runtime.uploadBlob(
						stringToBuffer(testString, "utf-8"),
					);
					const pendingStateP: any = runtimeOf(dataStore1).getPendingLocalState({
						notifyImminentClosure: false,
					});
					map.set("key", blobHandle);
					const pendingState = await pendingStateP;
					assert.strictEqual(pendingState?.pendingAttachmentBlobs, undefined);
				});

				// ADO#44999: Update for placeholder pending blob creation and getPendingLocalState
				// Need to determine if the "attached and acked" tests remain relevant after bookkeeping is updated
				it("removes pending blob after attached and acked", async function () {
					const testString = "this is a test string";
					const testKey = "a blob";
					const dataStore1 = (await container.getEntryPoint()) as ITestFluidObject;

					const map = await dataStore1.getSharedObject<ISharedMap>(mapId);
					const blobHandle = await dataStore1.runtime.uploadBlob(
						stringToBuffer(testString, "utf-8"),
					);
					map.set(testKey, blobHandle);
					if (
						isFluidHandlePayloadPending(blobHandle) &&
						blobHandle.payloadState !== "shared"
					) {
						// The payloadShared event is emitted after the blobAttach op is acked,
						// so if we await all of them we expect to see no pending blobs.
						// NOTE: Without awaiting here, the test would call getPendingLocalState before
						// the blobAttach op is sent - this would result in a bad pass (because this test
						// intends to test the behavior after the blobAttach op is acked).
						await new Promise<void>((resolve) => {
							blobHandle.events.on("payloadShared", resolve);
						});
					}
					const pendingState = (await runtimeOf(dataStore1).getPendingLocalState()) as
						| IPendingRuntimeState
						| undefined;
					assert.strictEqual(pendingState?.pendingAttachmentBlobs, undefined);
				});

				// ADO#44999: Update for placeholder pending blob creation and getPendingLocalState
				// Need to determine if the "attached and acked" tests remain relevant after bookkeeping is updated
				it("removes multiple pending blobs after attached and acked", async function () {
					const dataStore1 = (await container.getEntryPoint()) as ITestFluidObject;
					const map = await dataStore1.getSharedObject<ISharedMap>(mapId);
					const lots = 10;
					for (let i = 0; i < lots; i++) {
						const blobHandle = await dataStore1.runtime.uploadBlob(
							stringToBuffer(`${i}`, "utf-8"),
						);
						map.set(`${i}`, blobHandle);
						if (
							isFluidHandlePayloadPending(blobHandle) &&
							blobHandle.payloadState !== "shared"
						) {
							// The payloadShared event is emitted after the blobAttach op is acked,
							// so if we await all of them we expect to see no pending blobs.
							await new Promise<void>((resolve) => {
								blobHandle.events.on("payloadShared", resolve);
							});
						}
					}
					const pendingState = (await runtimeOf(dataStore1).getPendingLocalState()) as
						| IPendingRuntimeState
						| undefined;
					assert.strictEqual(pendingState?.pendingAttachmentBlobs, undefined);
				});
			});

			describe("from detached container", () => {
				let provider: ITestObjectProvider;
				let loader: IHostLoader;
				let container: IContainer;
				let detachedDataStore: ITestFluidObject;
				let map: ISharedMap;
				let directory: ISharedDirectory;
				let text: string;
				let blobHandle: IFluidHandle<ArrayBufferLike>;

				beforeEach("createContainer", async function () {
					provider = getTestObjectProvider();
					if (!driverSupportsBlobs(provider.driver)) {
						this.skip();
					}
					loader = provider.makeTestLoader({
						...testContainerConfig,
					});
					container = await loader.createDetachedContainer(provider.defaultCodeDetails);
					provider.updateDocumentId(container.resolvedUrl);
					detachedDataStore = (await container.getEntryPoint()) as ITestFluidObject;
					map = SharedMap.create(detachedDataStore.runtime);
					directory = SharedDirectory.create(detachedDataStore.runtime);
					text = "this is some example text";
					blobHandle = await detachedDataStore.runtime.uploadBlob(
						stringToBuffer(text, "utf-8"),
					);
				});

				const checkForDetachedHandles = (dds: ISharedMap | ISharedDirectory) => {
					assert.strictEqual(
						container.attachState,
						AttachState.Detached,
						"container should be detached",
					);
					assert.strictEqual(
						detachedDataStore.handle.isAttached,
						false,
						"data store handle should be detached",
					);
					assert.strictEqual(dds.handle.isAttached, false, "dds handle should be detached");
					assert.strictEqual(blobHandle.isAttached, false, "blob handle should be detached");
				};

				const checkForAttachedHandles = (dds: ISharedMap | ISharedDirectory) => {
					assert.strictEqual(
						container.attachState,
						AttachState.Attached,
						"container should be attached",
					);
					assert.strictEqual(
						detachedDataStore.handle.isAttached,
						true,
						"data store handle should be attached",
					);
					assert.strictEqual(dds.handle.isAttached, true, "dds handle should be attached");
					assert.strictEqual(blobHandle.isAttached, true, "blob handle should be attached");
				};

				it("all detached", async function () {
					checkForDetachedHandles(map);
					checkForDetachedHandles(directory);
				});

				it("after map is set in root directory", async function () {
					detachedDataStore.root.set(mapId, map.handle);
					checkForDetachedHandles(map);
				});

				it("after directory is set in root directory", async function () {
					detachedDataStore.root.set(directoryId, directory.handle);
					checkForDetachedHandles(directory);
				});

				it("after blob handle is set in map", async function () {
					detachedDataStore.root.set("map", map.handle);
					map.set("my blob", blobHandle);
					checkForDetachedHandles(map);
				});

				it("after blob handle is set in directory", async function () {
					detachedDataStore.root.set(directoryId, directory.handle);
					directory.set("my blob", blobHandle);
					checkForDetachedHandles(directory);
				});

				it("after container is attached with map", async function () {
					detachedDataStore.root.set("map", map.handle);
					map.set("my blob", blobHandle);
					await container.attach(provider.driver.createCreateNewRequest(provider.documentId));
					checkForAttachedHandles(map);
				});

				it("after container is attached with directory", async function () {
					detachedDataStore.root.set(directoryId, directory.handle);
					directory.set("my blob", blobHandle);
					await container.attach(provider.driver.createCreateNewRequest(provider.documentId));
					checkForAttachedHandles(directory);
				});

				it("after container is attached and dds is detached in map", async function () {
					map.set("my blob", blobHandle);
					await container.attach(provider.driver.createCreateNewRequest(provider.documentId));
					assert.strictEqual(
						map.handle.isAttached,
						false,
						"map should be detached after container attaches",
					);
					assert.strictEqual(
						blobHandle.isAttached,
						false,
						"blob should be detached in a detached dds and attached container",
					);
					detachedDataStore.root.set(mapId, map.handle);
					assert.strictEqual(
						map.handle.isAttached,
						true,
						"map should be attached after dds attaches",
					);
					assert.strictEqual(
						blobHandle.isAttached,
						true,
						"blob should be attached in an attached dds",
					);
				});

				it("after container is attached and dds is detached in directory", async function () {
					directory.set("my blob", blobHandle);
					await container.attach(provider.driver.createCreateNewRequest(provider.documentId));
					assert.strictEqual(
						directory.handle.isAttached,
						false,
						"directory should be detached after container attaches",
					);
					assert.strictEqual(
						blobHandle.isAttached,
						false,
						"blob should be detached in a detached dds and attached container",
					);
					detachedDataStore.root.set(directoryId, directory.handle);
					assert.strictEqual(
						directory.handle.isAttached,
						true,
						"directory should be attached after dds attaches",
					);
					assert.strictEqual(
						blobHandle.isAttached,
						true,
						"blob should be attached in an attached dds",
					);
				});
			});
		},
	);
}
