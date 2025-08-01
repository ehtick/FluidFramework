/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";

import {
	stringToBuffer,
	type ILayerCompatDetails,
	type IProvideLayerCompatDetails,
} from "@fluid-internal/client-utils";
import { AttachState, ICriticalContainerError } from "@fluidframework/container-definitions";
import {
	ContainerErrorTypes,
	IContainerContext,
	type IBatchMessage,
} from "@fluidframework/container-definitions/internal";
import { IContainerRuntime } from "@fluidframework/container-runtime-definitions/internal";
import {
	ConfigTypes,
	FluidObject,
	IConfigProviderBase,
	IResponse,
} from "@fluidframework/core-interfaces";
import type {
	IErrorBase,
	ISignalEnvelope,
	ITelemetryBaseLogger,
	OpaqueJsonDeserialized,
} from "@fluidframework/core-interfaces/internal";
import { ISummaryTree } from "@fluidframework/driver-definitions";
import {
	ISnapshot,
	ISummaryContext,
	type ISnapshotTree,
	MessageType,
	ISequencedDocumentMessage,
	type IVersion,
	type FetchSource,
	type IDocumentAttributes,
	SummaryType,
} from "@fluidframework/driver-definitions/internal";
import {
	ISummaryTreeWithStats,
	FluidDataStoreRegistryEntry,
	FlushMode,
	FlushModeExperimental,
	IFluidDataStoreContext,
	IFluidDataStoreFactory,
	IFluidDataStoreRegistry,
	NamedFluidDataStoreRegistryEntries,
	type IRuntimeMessageCollection,
	type ISequencedMessageEnvelope,
	type IEnvelope,
	type ITelemetryContext,
	type ISummarizeInternalResult,
	type IRuntimeStorageService,
} from "@fluidframework/runtime-definitions/internal";
import { defaultMinVersionForCollab } from "@fluidframework/runtime-utils/internal";
import {
	IFluidErrorBase,
	MockLogger,
	createChildLogger,
	isFluidError,
	isILoggingError,
	mixinMonitoringContext,
} from "@fluidframework/telemetry-utils/internal";
import {
	MockAudience,
	MockDeltaManager,
	MockFluidDataStoreRuntime,
	MockQuorumClients,
} from "@fluidframework/test-runtime-utils/internal";
import Sinon, { type SinonFakeTimers } from "sinon";

import { ChannelCollection } from "../channelCollection.js";
import { CompressionAlgorithms, enabledCompressionConfig } from "../compressionDefinitions.js";
import {
	ContainerRuntime,
	IContainerRuntimeOptions,
	IPendingRuntimeState,
	defaultPendingOpsWaitTimeoutMs,
	getSingleUseLegacyLogCallback,
	type ContainerRuntimeOptionsInternal,
	type IContainerRuntimeOptionsInternal,
	type UnknownIncomingTypedMessage,
} from "../containerRuntime.js";
import {
	ContainerMessageType,
	type InboundSequencedContainerRuntimeMessage,
	type LocalContainerRuntimeMessage,
	type UnknownContainerRuntimeMessage,
} from "../messageTypes.js";
import type {
	BatchResubmitInfo,
	InboundMessageResult,
	LocalBatchMessage,
} from "../opLifecycle/index.js";
import { pkgVersion } from "../packageVersion.js";
import {
	IPendingLocalState,
	IPendingMessage,
	PendingStateManager,
} from "../pendingStateManager.js";
import {
	ISummaryCancellationToken,
	neverCancelledSummaryToken,
	recentBatchInfoBlobName,
	type IRefreshSummaryAckOptions,
} from "../summary/index.js";

type Patch<T, U> = Omit<T, keyof U> & U;

type ContainerRuntime_WithPrivates = Patch<
	ContainerRuntime,
	{ flush: (resubmitInfo?: BatchResubmitInfo) => void; channelCollection: ChannelCollection }
>;

function submitDataStoreOp(
	runtime: Pick<ContainerRuntime, "submitMessage">,
	id: string,
	contents: unknown,
	localOpMetadata?: unknown,
) {
	runtime.submitMessage(
		ContainerMessageType.FluidDataStoreOp,
		{
			address: id,
			contents,
		},
		localOpMetadata,
	);
}

const changeConnectionState = (
	runtime: Omit<ContainerRuntime, "submit">,
	connected: boolean,
	clientId: string,
) => {
	const audience = runtime.getAudience() as MockAudience;
	audience.setCurrentClientId(clientId);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Modifying private property
	(runtime as any)._getClientId = () => clientId;

	runtime.setConnectionState(connected, clientId);
};

interface ISignalEnvelopeWithClientIds {
	envelope: ISignalEnvelope<UnknownIncomingTypedMessage>;
	clientId: string;
	targetClientId?: string;
}

function isSignalEnvelope(obj: unknown): obj is ISignalEnvelope<UnknownIncomingTypedMessage> {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"contents" in obj &&
		typeof obj.contents === "object" &&
		obj.contents !== null &&
		"content" in obj.contents &&
		"type" in obj.contents &&
		typeof obj.contents.type === "string" &&
		(!("address" in obj) || typeof obj.address === "string" || obj.address === undefined) &&
		(!("clientBroadcastSignalSequenceNumber" in obj) ||
			typeof obj.clientBroadcastSignalSequenceNumber === "number")
	);
}

let sandbox: Sinon.SinonSandbox;

function stubChannelCollection(
	containerRuntime: ContainerRuntime_WithPrivates,
): Sinon.SinonStubbedInstance<ChannelCollection> {
	// Pass data store op right back to ContainerRuntime
	const reSubmitFake = sandbox
		.stub<[type: string, content: unknown, localOpMetadata: unknown, squash: boolean], void>()
		.callsFake((type: string, content: unknown, localOpMetadata: unknown, squash: boolean) => {
			const envelope = content as IEnvelope;
			submitDataStoreOp(
				containerRuntime,
				envelope.address,
				envelope.contents,
				localOpMetadata,
			);
		});

	const stub = Sinon.createStubInstance(ChannelCollection, {
		setConnectionState: sandbox.stub(),
		reSubmit: reSubmitFake,
		rollback: sandbox.stub(),
		notifyStagingMode: sandbox.stub(),
		dispose: sandbox.stub(),
	});

	containerRuntime.channelCollection = stub;
	return stub;
}

function assertSignalContentIsAString(
	content: OpaqueJsonDeserialized<unknown> | string,
): asserts content is string {
	assert(typeof content === "string", "Signal content expected to be a string");
}

describe("Runtime", () => {
	const configProvider = (settings: Record<string, ConfigTypes>): IConfigProviderBase => ({
		getRawConfig: (name: string): ConfigTypes => settings[name],
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let submittedOps: any[] = [];
	let submittedSignals: ISignalEnvelopeWithClientIds[] = [];
	let opFakeSequenceNumber = 1;
	let clock: SinonFakeTimers;

	before(() => {
		clock = Sinon.useFakeTimers();
	});

	beforeEach(() => {
		submittedOps = [];
		opFakeSequenceNumber = 1;
		submittedSignals = [];
		sandbox = Sinon.createSandbox();
	});

	afterEach(() => {
		clock.reset();
	});

	after(() => {
		clock.restore();
	});

	const mockClientId = "mockClientId";

	// Mock the storage layer so "submitSummary" works.
	const defaultMockStorage: Partial<IRuntimeStorageService> = {
		uploadSummaryWithContext: async (summary: ISummaryTree, context: ISummaryContext) => {
			return "fakeHandle";
		},
	};
	const getMockContext = (
		params: {
			settings?: Record<string, ConfigTypes>;
			logger?: ITelemetryBaseLogger;
			mockStorage?: Partial<IRuntimeStorageService>;
			loadedFromVersion?: IVersion;
			baseSnapshot?: ISnapshotTree;
			connected?: boolean;
			attachState?: AttachState;
		} = {},
		clientId: string = mockClientId,
	): Partial<IContainerContext> => {
		const {
			settings = {},
			logger = new MockLogger(),
			mockStorage = defaultMockStorage,
			loadedFromVersion,
			baseSnapshot,
			connected = true,
			attachState = AttachState.Attached,
		} = params;

		const mockContext = {
			attachState,
			deltaManager: new MockDeltaManager(),
			audience: new MockAudience(),
			quorum: new MockQuorumClients(),
			taggedLogger: mixinMonitoringContext(logger, configProvider(settings)).logger,
			clientDetails: { capabilities: { interactive: true } },
			closeFn: (_error?: ICriticalContainerError): void => {},
			updateDirtyContainerState: (_dirty: boolean) => {},
			getLoadedFromVersion: () => loadedFromVersion,
			submitFn: (
				_type: MessageType,
				contents: object,
				_batch: boolean,
				metadata?: unknown,
			) => {
				submittedOps.push({ ...contents, metadata }); // Note: this object shape is for testing only. Not representative of real ops.
				return opFakeSequenceNumber++;
			},
			submitSignalFn: (content: unknown, targetClientId?: string) => {
				assert(isSignalEnvelope(content), "Invalid signal envelope");
				submittedSignals.push({
					envelope: content,
					clientId,
					targetClientId,
				}); // Note: this object shape is for testing only. Not representative of real signals.
			},
			clientId,
			connected,
			storage: mockStorage as IRuntimeStorageService,
			baseSnapshot,
		} satisfies Partial<IContainerContext>;

		// Update the delta manager's last message which is used for validation during summarization.
		mockContext.deltaManager.lastMessage = {
			clientId: mockClientId,
			type: MessageType.Operation,
			sequenceNumber: 0,
			timestamp: Date.now(),
			minimumSequenceNumber: 0,
			referenceSequenceNumber: 0,
			clientSequenceNumber: 0,
			contents: undefined,
		};
		return mockContext;
	};

	const mockProvideEntryPoint = async () => ({
		myProp: "myValue",
	});

	describe("Container Runtime", () => {
		describe("IdCompressor", () => {
			it("finalizes idRange on attach", async () => {
				const logger = new MockLogger();
				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});

				logger.clear();

				const compressor = containerRuntime.idCompressor;
				assert(compressor !== undefined);
				compressor.generateCompressedId();
				containerRuntime.createSummary();

				const range = compressor.takeNextCreationRange();
				assert.equal(
					range.ids,
					undefined,
					"All Ids should have been finalized after calling createSummary()",
				);
			});
		});

		describe("Batching", () => {
			it("Default flush mode", async () => {
				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				});

				assert.strictEqual(containerRuntime.flushMode, FlushMode.TurnBased);
			});

			it("Override default flush mode using options", async () => {
				const runtimeOptions: IContainerRuntimeOptionsInternal = {
					flushMode: FlushMode.Immediate,
				};
				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions,
					provideEntryPoint: mockProvideEntryPoint,
				});

				assert.strictEqual(containerRuntime.flushMode, FlushMode.Immediate);
			});

			it("Process empty batch", async () => {
				let batchBegin = 0;
				let batchEnd = 0;
				let callsToEnsure = 0;
				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext({
						settings: {
							"Fluid.Container.enableOfflineLoad": true,
						},
					}) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				});
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				(containerRuntime as any).ensureNoDataModelChanges = (callback: () => void) => {
					callback();
					callsToEnsure++;
				};
				changeConnectionState(containerRuntime, false, mockClientId);

				// Not connected, so nothing is submitted on flush - just queued in PendingStateManager
				submitDataStoreOp(containerRuntime, "1", "test", { emptyBatch: true });
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
				(containerRuntime as any).flush();
				changeConnectionState(containerRuntime, true, mockClientId);

				containerRuntime.on("batchBegin", () => batchBegin++);
				containerRuntime.on("batchEnd", () => batchEnd++);
				containerRuntime.process(
					{
						clientId: mockClientId,
						sequenceNumber: 10,
						clientSequenceNumber: 1,
						type: MessageType.Operation,
						contents: JSON.stringify({
							type: "groupedBatch",
							contents: [],
						}),
					} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
					true,
				);
				assert.strictEqual(callsToEnsure, 1);
				assert.strictEqual(batchBegin, 1);
				assert.strictEqual(batchEnd, 1);
				assert.strictEqual(containerRuntime.isDirty, false);
			});

			for (const enableOfflineLoad of [true, undefined])
				it("Replaying ops should resend in correct order, with batch ID if applicable", async () => {
					const containerRuntime = (await ContainerRuntime.loadRuntime({
						context: getMockContext({
							settings: {
								"Fluid.Container.enableOfflineLoad": enableOfflineLoad, // batchId only stamped if true
							},
						}) as IContainerContext,
						registryEntries: [],
						existing: false,
						runtimeOptions: {},
						provideEntryPoint: mockProvideEntryPoint,
					})) as unknown as ContainerRuntime_WithPrivates;

					stubChannelCollection(containerRuntime);

					changeConnectionState(containerRuntime, false, mockClientId);

					// Not connected, so nothing is submitted on flush - just queued in PendingStateManager
					submitDataStoreOp(containerRuntime, "1", "test");
					// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
					(containerRuntime as any).flush();

					submitDataStoreOp(containerRuntime, "2", "test");
					changeConnectionState(containerRuntime, true, mockClientId);
					// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
					(containerRuntime as any).flush();

					assert.strictEqual(submittedOps.length, 2);
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
					assert.strictEqual(submittedOps[0].contents.address, "1");
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
					assert.strictEqual(submittedOps[1].contents.address, "2");

					function batchIdMatchesUnsentFormat(batchId?: string) {
						return (
							batchId !== undefined &&
							batchId.length === "00000000-0000-0000-0000-000000000000_[-1]".length &&
							batchId.endsWith("_[-1]")
						);
					}

					if (enableOfflineLoad) {
						assert(
							batchIdMatchesUnsentFormat(
								// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
								submittedOps[0].metadata?.batchId as string | undefined,
							),
							"expected unsent batchId format (0)",
						);
						assert(
							batchIdMatchesUnsentFormat(
								// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
								submittedOps[1].metadata?.batchId as string | undefined,
							),
							"expected unsent batchId format (0)",
						);
					} else {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						assert(submittedOps[0].metadata?.batchId === undefined, "Expected no batchId (0)");
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						assert(submittedOps[1].metadata?.batchId === undefined, "Expected no batchId (1)");
					}
				});

			// NOTE: This test is examining a case that only occurs with an old Loader that doesn't tell ContainerRuntime when processing system ops.
			// In other words, when the MockDeltaManager bumps its lastSequenceNumber, ContainerRuntime.process would be called in the current code, but not with legacy loader.
			for (const skipSafetyFlushDuringProcessStack of [true, undefined]) {
				it(`Inbound (non-runtime) op triggers flush due to refSeq changing [skipSafetyFlush=${skipSafetyFlushDuringProcessStack}]`, async () => {
					const submittedBatches: {
						messages: IBatchMessage[];
						referenceSequenceNumber: number;
					}[] = [];

					const mockContext = getMockContext({
						settings: {
							"Fluid.ContainerRuntime.DisableFlushBeforeProcess":
								skipSafetyFlushDuringProcessStack,
						},
					});
					(
						mockContext as { submitBatchFn: IContainerContext["submitBatchFn"] }
					).submitBatchFn = (
						messages: IBatchMessage[],
						referenceSequenceNumber: number = -1,
					) => {
						submittedOps.push(...messages); // Reusing submittedOps since submitFn won't be invoked due to submitBatchFn's presence
						submittedBatches.push({ messages, referenceSequenceNumber });
						return 999; // CSN not used in test asserts below
					};

					const containerRuntime = await ContainerRuntime.loadRuntime({
						context: mockContext as IContainerContext,
						registryEntries: [],
						existing: false,
						runtimeOptions: {},
						provideEntryPoint: mockProvideEntryPoint,
					});

					// Submit the first message
					submitDataStoreOp(containerRuntime, "1", "testMessage1");
					assert.strictEqual(submittedOps.length, 0, "No ops submitted yet");

					// Bump lastSequenceNumber and trigger the "op" event artificially to simulate processing a non-runtime op
					// When [skipSafetyFlushDuringProcessStack: FALSE], this will trigger a flush, which allows us to safely submit more ops next
					const mockDeltaManager = mockContext.deltaManager as MockDeltaManager;
					++mockDeltaManager.lastSequenceNumber;
					mockDeltaManager.emit("op", {
						clientId: mockClientId,
						sequenceNumber: mockDeltaManager.lastSequenceNumber,
						clientSequenceNumber: 1,
						type: MessageType.ClientJoin,
						contents: "test content",
					});

					const expectedSubmitCount = skipSafetyFlushDuringProcessStack ? 0 : 1;
					assert.equal(
						submittedOps.length,
						expectedSubmitCount,
						"Submitted op count wrong after first op",
					);

					// Submit the second message
					// When [skipSafetyFlushDuringProcessStack: TRUE], this will trigger a flush via Outbox.maybeFlushPartialBatch
					submitDataStoreOp(containerRuntime, "2", "testMessage2");
					assert.equal(
						submittedOps.length,
						1,
						"By now we expect the first op to have been submitted in both configurations",
					);

					// Wait for the next tick for the second message to be flushed
					await Promise.resolve();

					// Validate that the messages were submitted
					assert.equal(submittedOps.length, 2, "Two messages should be submitted");
					assert.deepEqual(
						submittedBatches,
						[
							{ messages: [submittedOps[0]], referenceSequenceNumber: 0 }, // The first op
							{ messages: [submittedOps[1]], referenceSequenceNumber: 1 }, // The second op
						],
						"Two batches should be submitted with different refSeq",
					);
				});
			}

			it("IdAllocation op from replayPendingStates is flushed, preventing outboxSequenceNumberCoherencyCheck error", async () => {
				// Start out disconnected since step 1 is to trigger ID Allocation op on reconnect
				const connected = false;
				const mockContext = getMockContext({ connected }) as IContainerContext;
				const mockDeltaManager = mockContext.deltaManager as MockDeltaManager;

				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: mockContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: { enableRuntimeIdCompressor: "on" },
					provideEntryPoint: mockProvideEntryPoint,
				});

				// 1st compressed id – queued while disconnected (goes to idAllocationBatch).
				containerRuntime.idCompressor?.generateCompressedId();

				// Re-connect – replayPendingStates will submit only an idAllocation op.
				// It's now in the Outbox and a flush is scheduled (including this flush was a bug fix)
				changeConnectionState(containerRuntime, true, mockClientId);

				// Simulate a remote op arriving before we submit anything else.
				// Bump refSeq and continue execution at the end of the microtask queue.
				// This is how Inbound Queue works, and this is necessary to simulate here to allow scheduled flush to happen
				++mockDeltaManager.lastSequenceNumber;
				await Promise.resolve();

				// 2nd compressed id – its idAllocation op will enter Outbox *after* the ref seq# bumped.
				const id2 = containerRuntime.idCompressor?.generateCompressedId();

				// This would throw a DataProcessingError from codepath "outboxSequenceNumberCoherencyCheck"
				// if we didn't schedule a flush after the idAllocation op submitted during the reconnect.
				// (On account of the two ID Allocation ops having different refSeqs but being in the same batch)
				submitDataStoreOp(containerRuntime, "someDS", { id: id2 });

				// Let the Outbox flush so we can check submittedOps length
				await Promise.resolve();
				assert(
					submittedOps.length === 3,
					"Expected 3 ops to be submitted (2 ID Allocation, 1 data)",
				);
			});
		});

		const expectedOrderSequentiallyErrorMessage = "orderSequentially callback exception";
		describe("orderSequentially (rollback not enabled)", () => {
			for (const flushMode of [
				FlushMode.TurnBased,
				FlushMode.Immediate,
				FlushModeExperimental.Async as unknown as FlushMode,
			]) {
				const fakeClientId = "fakeClientId";

				describe(`orderSequentially with flush mode: ${
					FlushMode[flushMode] ?? FlushModeExperimental[flushMode]
				}`, () => {
					let containerRuntime: ContainerRuntime_WithPrivates;
					let mockContext: Partial<IContainerContext>;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const submittedOpsMetadata: any[] = [];
					const containerErrors: ICriticalContainerError[] = [];
					const getMockContextForOrderSequentially = (): Partial<IContainerContext> => {
						return {
							attachState: AttachState.Attached,
							deltaManager: new MockDeltaManager(),
							audience: new MockAudience(),
							quorum: new MockQuorumClients(),
							taggedLogger: new MockLogger(),
							supportedFeatures: new Map([["referenceSequenceNumbers", true]]),
							clientDetails: { capabilities: { interactive: true } },
							closeFn: (error?: ICriticalContainerError): void => {
								if (error !== undefined) {
									containerErrors.push(error);
								}
							},
							updateDirtyContainerState: (_dirty: boolean) => {},
							submitFn: (
								_type: MessageType,
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								contents: any,
								_batch: boolean,
								appData?: unknown,
							) => {
								// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
								if (contents.type === "groupedBatch") {
									// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
									for (const subMessage of contents.contents) {
										// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
										submittedOpsMetadata.push(subMessage.metadata);
									}
								} else {
									submittedOpsMetadata.push(appData);
								}
								return opFakeSequenceNumber++;
							},
							connected: true,
							clientId: fakeClientId,
							getLoadedFromVersion: () => undefined,
						};
					};

					const getFirstContainerError = (): ICriticalContainerError => {
						assert.ok(containerErrors.length > 0, "Container should have errors");
						return containerErrors[0];
					};

					beforeEach(async () => {
						mockContext = getMockContextForOrderSequentially();
						const runtimeOptions: IContainerRuntimeOptionsInternal = {
							summaryOptions: {
								summaryConfigOverrides: {
									state: "disabled",
								},
							},
							flushMode,
						};

						containerRuntime = (await ContainerRuntime.loadRuntime({
							context: mockContext as IContainerContext,
							registryEntries: [],
							existing: false,
							runtimeOptions,
							provideEntryPoint: mockProvideEntryPoint,
						})) as unknown as ContainerRuntime_WithPrivates;
						containerErrors.length = 0;
						submittedOpsMetadata.length = 0;
					});

					it("Can't call flush() inside orderSequentially's callback", () => {
						assert.throws(() =>
							containerRuntime.orderSequentially(() => {
								// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
								(containerRuntime as any).flush();
							}),
						);

						const error = getFirstContainerError();
						assert(isFluidError(error));
						assert.strictEqual(error.errorType, ContainerErrorTypes.genericError);
						assert.strictEqual(error.message, "0x24c");
						assert.strictEqual(error.getTelemetryProperties().orderSequentiallyCalls, 1);
					});

					it("Can't call flush() inside orderSequentially's callback when nested", () => {
						assert.throws(() =>
							containerRuntime.orderSequentially(() =>
								containerRuntime.orderSequentially(() => {
									// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
									(containerRuntime as any).flush();
								}),
							),
						);

						const error = getFirstContainerError();
						assert(isFluidError(error));
						assert.strictEqual(error.errorType, ContainerErrorTypes.genericError);
						assert.strictEqual(error.message, "0x24c");
						assert.strictEqual(error.getTelemetryProperties().orderSequentiallyCalls, 2);
					});

					it("Can't call flush() inside orderSequentially's callback when nested ignoring exceptions", () => {
						containerRuntime.orderSequentially(() => {
							try {
								containerRuntime.orderSequentially(() => {
									// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
									(containerRuntime as any).flush();
								});
							} catch {
								// ignore
							}
						});

						const error = getFirstContainerError();
						assert(isFluidError(error));
						assert.strictEqual(error.errorType, ContainerErrorTypes.genericError);
						assert.strictEqual(error.message, "0x24c");
						assert.strictEqual(error.getTelemetryProperties().orderSequentiallyCalls, 2);
					});

					it("Errors propagate to the container", () => {
						assert.throws(() =>
							containerRuntime.orderSequentially(() => {
								throw new Error("Any");
							}),
						);

						const error = getFirstContainerError();
						assert(isFluidError(error));
						assert.strictEqual(error.errorType, ContainerErrorTypes.genericError);
						assert.strictEqual(error.message, `${expectedOrderSequentiallyErrorMessage}: Any`);
						assert.strictEqual(error.getTelemetryProperties().orderSequentiallyCalls, 1);
					});

					it("Errors propagate to the container when nested", () => {
						assert.throws(() =>
							containerRuntime.orderSequentially(() =>
								containerRuntime.orderSequentially(() => {
									throw new Error("Any");
								}),
							),
						);

						const error = getFirstContainerError();
						assert(isFluidError(error));
						assert.strictEqual(error.errorType, ContainerErrorTypes.genericError);
						assert.strictEqual(error.message, `${expectedOrderSequentiallyErrorMessage}: Any`);
						assert.strictEqual(error.getTelemetryProperties().orderSequentiallyCalls, 2);
					});

					it("Batching property set properly", () => {
						containerRuntime.orderSequentially(() => {
							submitDataStoreOp(containerRuntime, "1", "test");
							submitDataStoreOp(containerRuntime, "2", "test");
							submitDataStoreOp(containerRuntime, "3", "test");
						});
						// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
						(containerRuntime as any).flush();

						assert.strictEqual(submittedOpsMetadata.length, 3, "3 messages should be sent");
						assert.strictEqual(
							// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
							submittedOpsMetadata[0].batch,
							true,
							"first message should be the batch start",
						);
						assert.strictEqual(
							submittedOpsMetadata[1],
							undefined,
							"second message should not hold batch info",
						);
						assert.strictEqual(
							// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
							submittedOpsMetadata[2].batch,
							false,
							"third message should be the batch end",
						);
					});

					it("Resubmitting batch preserves original batches", async () => {
						stubChannelCollection(containerRuntime);

						changeConnectionState(containerRuntime, false, fakeClientId);

						containerRuntime.orderSequentially(() => {
							submitDataStoreOp(containerRuntime, "1", "test");
							submitDataStoreOp(containerRuntime, "2", "test");
							submitDataStoreOp(containerRuntime, "3", "test");
						});
						// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
						(containerRuntime as any).flush();

						containerRuntime.orderSequentially(() => {
							submitDataStoreOp(containerRuntime, "4", "test");
							submitDataStoreOp(containerRuntime, "5", "test");
							submitDataStoreOp(containerRuntime, "6", "test");
						});
						// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
						(containerRuntime as any).flush();

						assert.strictEqual(submittedOpsMetadata.length, 0, "no messages should be sent");

						changeConnectionState(containerRuntime, true, fakeClientId);

						assert.strictEqual(submittedOpsMetadata.length, 6, "6 messages should be sent");

						const expectedBatchMetadata = [
							{ batch: true },
							undefined,
							{ batch: false },
							{ batch: true },
							undefined,
							{ batch: false },
						];

						assert.deepStrictEqual(
							submittedOpsMetadata,
							expectedBatchMetadata,
							"batch metadata does not match",
						);
					});
				});
			}
		});

		describe("orderSequentially with rollback", () => {
			for (const flushMode of [
				FlushMode.TurnBased,
				FlushMode.Immediate,
				FlushModeExperimental.Async as unknown as FlushMode,
			]) {
				describe(`orderSequentially with flush mode: ${
					FlushMode[flushMode] ?? FlushModeExperimental[flushMode]
				}`, () => {
					let containerRuntime: ContainerRuntime_WithPrivates;
					const containerErrors: ICriticalContainerError[] = [];
					let submittedOpsCount: number = 0;

					const getMockContextForOrderSequentially = (): Partial<IContainerContext> => ({
						attachState: AttachState.Attached,
						connected: true,
						clientId: "client-id",
						supportedFeatures: new Map([["referenceSequenceNumbers", true]]),
						deltaManager: new MockDeltaManager(),
						audience: new MockAudience(),
						quorum: new MockQuorumClients(),
						taggedLogger: mixinMonitoringContext(
							new MockLogger(),
							configProvider({
								"Fluid.ContainerRuntime.EnableRollback": true,
							}),
						) as unknown as MockLogger,
						clientDetails: { capabilities: { interactive: true } },
						closeFn: (error?: ICriticalContainerError): void => {
							if (error !== undefined) {
								containerErrors.push(error);
							}
						},
						submitFn: (...args) => {
							return ++submittedOpsCount; // clientSequenceNumber
						},
						updateDirtyContainerState: (dirty: boolean) => {},
						getLoadedFromVersion: () => undefined,
					});

					beforeEach(async () => {
						const runtimeOptions: IContainerRuntimeOptionsInternal = {
							summaryOptions: {
								summaryConfigOverrides: { state: "disabled" },
							},
							flushMode,
						};
						containerRuntime = (await ContainerRuntime.loadRuntime({
							context: getMockContextForOrderSequentially() as IContainerContext,
							registryEntries: [],
							existing: false,
							runtimeOptions,
							provideEntryPoint: mockProvideEntryPoint,
						})) as unknown as ContainerRuntime_WithPrivates;
						containerErrors.length = 0;
						submittedOpsCount = 0;
					});

					it("No errors propagate to the container on rollback", () => {
						assert.throws(() =>
							containerRuntime.orderSequentially(() => {
								throw new Error("Any");
							}),
						);
						assert.equal(containerRuntime.inStagingMode, false, "Still in Staging Mode");
						assert.equal(containerRuntime.isDirty, false, "Dirty after rollback");

						assert.strictEqual(containerErrors.length, 0);
					});

					it("No errors on successful callback with rollback set", () => {
						containerRuntime.orderSequentially(() => {});
						assert.equal(containerRuntime.inStagingMode, false, "Still in Staging Mode");

						assert.strictEqual(containerErrors.length, 0);
					});

					it("orderSequentially while in StagingMode works", async () => {
						stubChannelCollection(containerRuntime);

						const stageControls = containerRuntime.enterStagingMode();

						containerRuntime.orderSequentially(() => {
							submitDataStoreOp(containerRuntime, "1", "test");
						});
						assert.strictEqual(
							submittedOpsCount,
							0,
							"No ops should be submitted in Staging Mode",
						);

						stageControls.commitChanges();

						assert.strictEqual(
							submittedOpsCount,
							1,
							"One (Grouped) op should have been submitted",
						);
					});

					// The purpose of these tests is to illustrate the current behavior of this unspecified scenario
					describe("Exiting staging mode under orderSequentially - expected behavior has not been specified", () => {
						it("commitChanges under orderSequentially (happens to fail)", async () => {
							stubChannelCollection(containerRuntime);

							const stageControls = containerRuntime.enterStagingMode();

							assert.throws(() => {
								containerRuntime.orderSequentially(() => {
									submitDataStoreOp(containerRuntime, "1", "test");
									stageControls.commitChanges();
								});
							});
						});

						it("discardChanges under orderSequentially (does not happen to fail)", async () => {
							stubChannelCollection(containerRuntime);

							const stageControls = containerRuntime.enterStagingMode();

							assert.doesNotThrow(() => {
								containerRuntime.orderSequentially(() => {
									submitDataStoreOp(containerRuntime, "1", "test");
									stageControls.discardChanges();
								});
							});
						});
					});

					it("Entering Staging Mode under orderSequentially not supported", async () => {
						assert.throws(
							() =>
								containerRuntime.orderSequentially(() => {
									containerRuntime.enterStagingMode();
								}),
							(e: Error & IErrorBase) =>
								e.errorType === ContainerErrorTypes.usageError &&
								e.message === "Already in staging mode",
							"Entering Staging Mode inside orderSequentially should throw",
						);
						assert.equal(containerRuntime.inStagingMode, false, "Still in Staging Mode");
						assert.equal(containerRuntime.isDirty, false, "Dirty after rollback");

						assert.strictEqual(containerErrors.length, 0);
					});
				});
			}
		});

		describe("Dirty flag", () => {
			const createMockContext = (
				attachState: AttachState,
				addPendingMsg: boolean,
			): Partial<IContainerContext> => {
				const pendingState = {
					pending: {
						pendingStates: [
							{
								type: "message",
								content: `{"type": "${ContainerMessageType.BlobAttach}", "contents": {}}`,
							},
						],
					},
					savedOps: [],
				};

				return {
					deltaManager: new MockDeltaManager(),
					audience: new MockAudience(),
					quorum: new MockQuorumClients(),
					taggedLogger: new MockLogger(),
					clientDetails: { capabilities: { interactive: true } },
					updateDirtyContainerState: (_dirty: boolean) => {},
					attachState,
					pendingLocalState: addPendingMsg ? pendingState : undefined,
					getLoadedFromVersion: () => undefined,
				};
			};

			it("should NOT be set to dirty if context is attached with no pending ops", async () => {
				const mockContext = createMockContext(AttachState.Attached, false);
				const updateDirtyStateStub = sandbox.stub(mockContext, "updateDirtyContainerState");
				await ContainerRuntime.loadRuntime({
					context: mockContext as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: undefined,
					containerScope: {},
					provideEntryPoint: mockProvideEntryPoint,
				});
				assert.deepStrictEqual(updateDirtyStateStub.calledOnce, true);
				assert.deepStrictEqual(updateDirtyStateStub.args, [[false]]);
			});

			it("should be set to dirty if context is attached with pending ops", async () => {
				const mockContext = createMockContext(AttachState.Attached, true);
				const updateDirtyStateStub = sandbox.stub(mockContext, "updateDirtyContainerState");
				await ContainerRuntime.loadRuntime({
					context: mockContext as IContainerContext,
					registryEntries: [],
					existing: false,
					requestHandler: undefined,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				});
				assert.deepStrictEqual(updateDirtyStateStub.calledOnce, true);
				assert.deepStrictEqual(updateDirtyStateStub.args, [[true]]);
			});

			it("should be set to dirty if context is attaching", async () => {
				const mockContext = createMockContext(AttachState.Attaching, false);
				const updateDirtyStateStub = sandbox.stub(mockContext, "updateDirtyContainerState");
				await ContainerRuntime.loadRuntime({
					context: mockContext as IContainerContext,
					registryEntries: [],
					existing: false,
					requestHandler: undefined,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				});
				assert.deepStrictEqual(updateDirtyStateStub.calledOnce, true);
				assert.deepStrictEqual(updateDirtyStateStub.args, [[true]]);
			});

			it("should be set to dirty if context is detached", async () => {
				const mockContext = createMockContext(AttachState.Detached, false);
				const updateDirtyStateStub = sandbox.stub(mockContext, "updateDirtyContainerState");
				await ContainerRuntime.loadRuntime({
					context: mockContext as IContainerContext,
					registryEntries: [],
					existing: false,
					requestHandler: undefined,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				});
				assert.deepStrictEqual(updateDirtyStateStub.calledOnce, true);
				assert.deepStrictEqual(updateDirtyStateStub.args, [[true]]);
			});
		});

		describe("Pending state progress tracking", () => {
			const maxReconnects = 7; // 7 is the default used by ContainerRuntime for the max reconnection attempts

			let containerRuntime: ContainerRuntime;
			const mockLogger = new MockLogger();
			const containerErrors: ICriticalContainerError[] = [];
			const fakeClientId = "fakeClientId";
			const getMockContextForPendingStateProgressTracking = (): Partial<IContainerContext> => {
				return {
					connected: false,
					attachState: AttachState.Attached,
					deltaManager: new MockDeltaManager(),
					audience: new MockAudience(),
					quorum: new MockQuorumClients(),
					taggedLogger: mockLogger,
					clientDetails: { capabilities: { interactive: true } },
					closeFn: (error?: ICriticalContainerError): void => {
						if (error !== undefined) {
							containerErrors.push(error);
						}
					},
					updateDirtyContainerState: (_dirty: boolean) => {},
					getLoadedFromVersion: () => undefined,
				};
			};
			const getMockPendingStateManager = (): PendingStateManager => {
				let pendingMessages = 0;
				return {
					replayPendingStates: () => {},
					hasPendingMessages: (): boolean => pendingMessages > 0,
					hasPendingUserChanges: (): boolean => pendingMessages > 0,
					processInboundMessages: (inbound: InboundMessageResult, _local: boolean) => {
						const messages =
							inbound.type === "fullBatch" ? inbound.messages : [inbound.nextMessage];
						return messages.map<{
							message: InboundSequencedContainerRuntimeMessage;
							localOpMetadata?: unknown;
						}>((message) => ({
							message,
							localOpMetadata: undefined,
						}));
					},
					get pendingMessagesCount() {
						return pendingMessages;
					},
					onFlushBatch: (batch: LocalBatchMessage[], _csn?: number) =>
						(pendingMessages += batch.length),
				} satisfies Partial<PendingStateManager> as unknown as PendingStateManager;
			};
			const getMockChannelCollection = (): ChannelCollection => {
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
				return {
					processMessages: (..._args) => {},
					setConnectionState: (..._args) => {},
				} as ChannelCollection;
			};

			const getFirstContainerError = (): ICriticalContainerError => {
				assert.ok(containerErrors.length > 0, "Container should have errors");
				return containerErrors[0];
			};

			beforeEach(async () => {
				containerErrors.length = 0;
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContextForPendingStateProgressTracking() as IContainerContext,
					registryEntries: [],
					existing: false,
					requestHandler: undefined,
					runtimeOptions: {
						summaryOptions: {
							summaryConfigOverrides: {
								state: "disabled",
							},
						},
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
			});

			function patchRuntime(
				pendingStateManager: PendingStateManager,
				_maxReconnects: number | undefined = undefined,
			): void {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Modifying private properties
				const runtime = containerRuntime as any;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				runtime.pendingStateManager = pendingStateManager;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				runtime.channelCollection = getMockChannelCollection();
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
				runtime.maxConsecutiveReconnects = _maxReconnects ?? runtime.maxConsecutiveReconnects;
			}

			/**
			 * Connects with a new clientId and then immediately disconnects, returning that brief connection's clientId
			 */
			const toggleConnection = (runtime: ContainerRuntime, salt: number) => {
				const clientId = salt === undefined ? fakeClientId : `${fakeClientId}-${salt}`;
				changeConnectionState(runtime, true, clientId);
				changeConnectionState(runtime, false, clientId);
				return clientId;
			};

			const addPendingMessage = (pendingStateManager: PendingStateManager): void =>
				pendingStateManager.onFlushBatch(
					[
						{
							// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
							runtimeOp: {
								type: ContainerMessageType.FluidDataStoreOp,
								contents: "" as unknown,
							} as LocalContainerRuntimeMessage,
							referenceSequenceNumber: 0,
						},
					],
					1,
					false /* staged */,
				);

			// biome-ignore format: https://github.com/biomejs/biome/issues/4202
			it(
				`No progress for ${maxReconnects} connection state changes, with pending state, should ` +
					"generate telemetry event and throw an error that closes the container",
				async () => {
					const pendingStateManager = getMockPendingStateManager();
					patchRuntime(pendingStateManager);

					for (let i = 0; i < maxReconnects; i++) {
						addPendingMessage(pendingStateManager);
						toggleConnection(containerRuntime, i);
					}

					// NOTE: any errors returned by getFirstContainerError() are from a variable set in a mock closeFn function passed
					// around during test setup, which executes when the container runtime causes the context (container) to close.
					const error = getFirstContainerError();
					assert.strictEqual(error.errorType, ContainerErrorTypes.dataProcessingError);
					assert.strictEqual(
						error.message,
						"Runtime detected too many reconnects with no progress syncing local ops.",
					);
					assert(isILoggingError(error));
					assert.strictEqual(error.getTelemetryProperties().attempts, maxReconnects);
					assert.strictEqual(error.getTelemetryProperties().pendingMessages, maxReconnects);
					mockLogger.assertMatchAny([
						{
							eventName: "ContainerRuntime:ReconnectsWithNoProgress",
							attempts: 3,
							pendingMessages: 3,
						},
					]);
				},
			);

			// biome-ignore format: https://github.com/biomejs/biome/issues/4202
			it(
				`No progress for ${maxReconnects} / 2 connection state changes, with pending state, should ` +
					"generate telemetry event but not throw an error that closes the container",
				async () => {
					const pendingStateManager = getMockPendingStateManager();
					patchRuntime(pendingStateManager);
					addPendingMessage(pendingStateManager);

					for (let i = 0; i < maxReconnects / 2 + 1; i++) {
						toggleConnection(containerRuntime, i);
					}

					// The particulars of the setup for this test mean that no errors here indicate the container did not close.
					assert.equal(containerErrors.length, 0);
					mockLogger.assertMatchAny([
						{
							eventName: "ContainerRuntime:ReconnectsWithNoProgress",
							attempts: 3,
							pendingMessages: 1,
						},
					]);
				},
			);

			// biome-ignore format: https://github.com/biomejs/biome/issues/4202
			it(
				`No progress for ${maxReconnects} connection state changes, with pending state, with ` +
					"feature disabled, should not generate telemetry event nor throw an error that closes the container",
				async () => {
					const pendingStateManager = getMockPendingStateManager();
					patchRuntime(pendingStateManager, -1 /* maxConsecutiveReconnects */);

					for (let i = 0; i < maxReconnects; i++) {
						addPendingMessage(pendingStateManager);
						toggleConnection(containerRuntime, i);
					}

					// The particulars of the setup for this test mean that no errors here indicate the container did not close.
					assert.equal(containerErrors.length, 0);
					mockLogger.assertMatchNone([
						{
							eventName: "ContainerRuntime:ReconnectsWithNoProgress",
						},
					]);
				},
			);

			// biome-ignore format: https://github.com/biomejs/biome/issues/4202
			it(
				`No progress for ${maxReconnects} connection state changes, with no pending state, should ` +
					"not generate telemetry event nor throw an error that closes the container",
				async () => {
					const pendingStateManager = getMockPendingStateManager();
					patchRuntime(pendingStateManager);

					for (let i = 0; i < maxReconnects; i++) {
						toggleConnection(containerRuntime, i);
					}

					// The particulars of the setup for this test mean that no errors here indicate the container did not close.
					assert.equal(containerErrors.length, 0);
					mockLogger.assertMatchNone([
						{
							eventName: "ContainerRuntime:ReconnectsWithNoProgress",
						},
					]);
				},
			);

			// biome-ignore format: https://github.com/biomejs/biome/issues/4202
			it(
				`No progress for ${maxReconnects} connection state changes, with pending state, successfully ` +
					"processing local op, should not generate telemetry event nor throw an error that closes the container",
				async () => {
					const pendingStateManager = getMockPendingStateManager();
					patchRuntime(pendingStateManager);
					addPendingMessage(pendingStateManager);

					for (let i = 0; i < maxReconnects; i++) {
						const clientId = toggleConnection(containerRuntime, i);
						containerRuntime.process(
							{
								type: "op",
								clientId,
								sequenceNumber: i,
								contents: {
									address: "address",
								},
								clientSequenceNumber: 0,
								minimumSequenceNumber: 0,
							} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
							true /* local */,
						);
					}

					// The particulars of the setup for this test mean that no errors here indicate the container did not close.
					assert.equal(containerErrors.length, 0);
					mockLogger.assertMatchNone([
						{
							eventName: "ContainerRuntime:ReconnectsWithNoProgress",
						},
					]);
				},
			);

			// biome-ignore format: https://github.com/biomejs/biome/issues/4202
			it(
				`No progress for ${maxReconnects} connection state changes, with pending state, successfully ` +
					"processing remote op and local chunked op, should generate telemetry event and throw an error that closes the container",
				async () => {
					const pendingStateManager = getMockPendingStateManager();
					patchRuntime(pendingStateManager);

					let seqNum = 1;
					for (let i = 0; i < maxReconnects; i++) {
						addPendingMessage(pendingStateManager);
						toggleConnection(containerRuntime, i);
						containerRuntime.process(
							{
								type: "op",
								clientId: `a unique, remote clientId - ${i}`,
								sequenceNumber: seqNum++,
								clientSequenceNumber: 1,
								contents: {
									address: "address",
								},
								minimumSequenceNumber: 0,
							} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
							false /* local */,
						);
						containerRuntime.process(
							{
								type: "op",
								clientId: "clientId",
								sequenceNumber: seqNum++,
								contents: {
									address: "address",
									contents: {
										chunkId: i + 1,
										totalChunks: maxReconnects + 1,
									},
									type: "chunkedOp",
								},
								minimumSequenceNumber: 0,
							} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
							true /* local */,
						);
					}

					// NOTE: any errors returned by getFirstContainerError() are from a variable set in a mock closeFn function passed
					// around during test setup, which executes when the container runtime causes the context (container) to close.
					const error = getFirstContainerError();
					assert.strictEqual(error.errorType, ContainerErrorTypes.dataProcessingError);
					assert.strictEqual(
						error.message,
						"Runtime detected too many reconnects with no progress syncing local ops.",
					);
					assert(isILoggingError(error));
					assert.strictEqual(error.getTelemetryProperties().attempts, maxReconnects);
					assert.strictEqual(error.getTelemetryProperties().pendingMessages, maxReconnects);
					mockLogger.assertMatchAny([
						{
							eventName: "ContainerRuntime:ReconnectsWithNoProgress",
							attempts: 3,
							pendingMessages: 3,
						},
					]);
				},
			);
		});

		describe("Unrecognized types not supported", () => {
			let containerRuntime: ContainerRuntime;
			beforeEach(async () => {
				const runtimeOptions: IContainerRuntimeOptionsInternal = {
					enableGroupedBatching: false,
				};
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					registryEntries: [],
					existing: false,
					requestHandler: undefined,
					runtimeOptions,
					provideEntryPoint: mockProvideEntryPoint,
				});
			});

			/**
			 * Overwrites channelCollection property and exposes private submit function with modified typing
			 */
			function patchContainerRuntime(): Omit<ContainerRuntime, "submit"> & {
				submit: (containerRuntimeMessage: UnknownContainerRuntimeMessage) => void;
			} {
				const patched = containerRuntime as unknown as Omit<
					ContainerRuntime,
					"submit" | "channelCollection"
				> & {
					submit: (containerRuntimeMessage: UnknownContainerRuntimeMessage) => void;
					channelCollection: Partial<ChannelCollection>;
				};

				patched.channelCollection = {
					setConnectionState: (_connected: boolean, _clientId?: string) => {},
					// Pass data store op right back to ContainerRuntime
					reSubmit: (type: string, envelope: IEnvelope, localOpMetadata: unknown) => {
						submitDataStoreOp(
							containerRuntime,
							envelope.address,
							envelope.contents,
							localOpMetadata,
						);
					},
				} satisfies Partial<ChannelCollection>;

				return patched;
			}

			it("Op with unrecognized type is ignored by resubmit", async () => {
				const patchedContainerRuntime = patchContainerRuntime();

				changeConnectionState(patchedContainerRuntime, false, mockClientId);

				submitDataStoreOp(patchedContainerRuntime, "1", "test");
				submitDataStoreOp(patchedContainerRuntime, "2", "test");
				patchedContainerRuntime.submit({
					// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
					type: "FUTURE_TYPE" as any,
					contents: "3",
				});
				submitDataStoreOp(patchedContainerRuntime, "4", "test");

				assert.strictEqual(
					submittedOps.length,
					0,
					"no messages should be sent while disconnected",
				);

				// Connect, which will trigger resubmit
				assert.throws(
					() => changeConnectionState(patchedContainerRuntime, true, mockClientId),
					(error: IErrorBase) => error.errorType === ContainerErrorTypes.dataProcessingError,
					"Ops with unrecognized type and 'Ignore' compat behavior should fail to resubmit",
				);
			});

			it("process remote op with unrecognized type", async () => {
				const futureRuntimeMessage: Record<string, unknown> = {
					type: "FROM_THE_FUTURE",
					contents: "Hello",
				};

				const packedOp: Omit<
					ISequencedDocumentMessage,
					"term" | "clientSequenceNumber" | "referenceSequenceNumber" | "timestamp"
				> = {
					contents: JSON.stringify(futureRuntimeMessage),
					type: MessageType.Operation,
					sequenceNumber: 123,
					clientId: "someClientId",
					minimumSequenceNumber: 0,
				};
				assert.throws(
					() =>
						containerRuntime.process(packedOp as ISequencedDocumentMessage, false /* local */),
					(error: IErrorBase) => error.errorType === ContainerErrorTypes.dataProcessingError,
					"Ops with unrecognized type should fail to process",
				);
			});
		});
		describe("Supports mixin classes", () => {
			it("new loadRuntime method works", async () => {
				const makeMixin = <T>(
					Base: typeof ContainerRuntime,
					methodName: string,
					methodReturn: T,
				) =>
					class MixinContainerRuntime extends Base {
						public static async loadRuntime(params: {
							context: IContainerContext;
							containerRuntimeCtor?: typeof ContainerRuntime;
							provideEntryPoint: (containerRuntime: IContainerRuntime) => Promise<FluidObject>;
							existing: boolean;
							runtimeOptions: IContainerRuntimeOptions;
							registryEntries: NamedFluidDataStoreRegistryEntries;
							containerScope: FluidObject;
						}): Promise<ContainerRuntime> {
							// Note: we're mutating the parameter object here, normally a no-no, but shouldn't be
							// an issue in our tests.
							params.containerRuntimeCtor =
								params.containerRuntimeCtor ?? MixinContainerRuntime;
							params.containerScope = params.containerScope ?? params.context.scope;
							return Base.loadRuntime(params);
						}

						public [methodName](): T {
							return methodReturn;
						}
					} as typeof ContainerRuntime;

				const myEntryPoint: FluidObject = {
					myProp: "myValue",
				};

				const runtime = await makeMixin(
					makeMixin(ContainerRuntime, "method1", "mixed in return"),
					"method2",
					42,
				).loadRuntime({
					context: getMockContext() as IContainerContext,
					provideEntryPoint: async (containerRuntime) => myEntryPoint,
					existing: false,
					registryEntries: [],
				});

				assert.equal(
					(runtime as unknown as { method1: () => unknown }).method1(),
					"mixed in return",
				);
				assert.equal((runtime as unknown as { method2: () => unknown }).method2(), 42);
			});

			// A legacy partner team overrides the summarizeInternal method to add custom data to the Summary.
			// Let's make sure we don't break them inadvertently, while we work to move them to a better pattern.
			it("Ensure private member is stable to support legacy usage", async () => {
				const containerRuntime_withSummarizeInternal = (await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					registryEntries: [],
					existing: false,
					provideEntryPoint: mockProvideEntryPoint,
				})) as unknown as {
					summarizeInternal(
						fullTree: boolean,
						trackState: boolean,
						telemetryContext?: ITelemetryContext,
					): Promise<ISummarizeInternalResult>;
				};

				assert(
					typeof containerRuntime_withSummarizeInternal.summarizeInternal === "function",
					"Expected summarizeInternal to be present (it's a private method)",
				);
				const result = await containerRuntime_withSummarizeInternal.summarizeInternal(
					true,
					true,
				);
				assert(result.summary !== undefined, "Expected a valid result from summarizeInternal");
			});
		});

		describe("EntryPoint initialized correctly", () => {
			it("when using new loadRuntime method", async () => {
				const myEntryPoint: FluidObject = {
					myProp: "myValue",
				};
				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					provideEntryPoint: async (ctrRuntime) => myEntryPoint,
					existing: false,
					registryEntries: [],
				});

				// The entryPoint should come from the provided initialization function.
				const actualEntryPoint = await containerRuntime.getEntryPoint();
				assert(actualEntryPoint !== undefined, "entryPoint was not initialized");
				assert.deepEqual(
					actualEntryPoint,
					myEntryPoint,
					"entryPoint does not match expected object",
				);
			});

			it("loadRuntime accepts both requestHandlers and entryPoint", async () => {
				const myResponse: IResponse = {
					mimeType: "fluid/object",
					value: "hello!",
					status: 200,
				};
				const myEntryPoint: FluidObject = {
					myProp: "myValue",
				};

				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					requestHandler: async (req, ctrRuntime) => myResponse,
					provideEntryPoint: async (ctrRuntime) => myEntryPoint,
					existing: false,
					registryEntries: [],
				});

				// Calling request on the runtime should use the request handler we passed in the runtime's constructor.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
				const responseFromRequestMethod = await (containerRuntime as any).request({
					url: "/",
				});
				assert.deepEqual(
					responseFromRequestMethod,
					myResponse,
					"request method in runtime did not return the expected object",
				);

				// The entryPoint should come from the provided initialization function.
				const actualEntryPoint = await containerRuntime.getEntryPoint();
				assert(actualEntryPoint !== undefined, "entryPoint was not initialized");
				assert.deepEqual(
					actualEntryPoint,
					myEntryPoint,
					"entryPoint does not match expected object",
				);
			});
		});

		describe("Op content modification", () => {
			let containerRuntime: ContainerRuntime;
			let pendingStateManager: PendingStateManager;

			beforeEach(async () => {
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				});
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
				pendingStateManager = (containerRuntime as any).pendingStateManager;
			});

			it("modifying op content after submit does not reflect in PendingStateManager", () => {
				const content = { prop1: 1 };
				submitDataStoreOp(containerRuntime, "1", content);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
				(containerRuntime as any).flush();

				content.prop1 = 2;

				const state = pendingStateManager.getLocalState();

				assert.notStrictEqual(state, undefined, "expect pending local state");
				assert.strictEqual(state?.pendingStates.length, 1, "expect 1 pending message");
				assert.deepStrictEqual(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
					JSON.parse(state?.pendingStates?.[0].content).contents.contents,
					{
						prop1: 1,
					},
					"content of pending local message has changed",
				);
			});
		});

		describe("Container logging when loaded", () => {
			let mockLogger: MockLogger;

			const localGetMockContext = (
				featureGates: Record<string, ConfigTypes> = {},
			): Partial<IContainerContext> => {
				return {
					attachState: AttachState.Attached,
					deltaManager: new MockDeltaManager(),
					audience: new MockAudience(),
					quorum: new MockQuorumClients(),
					taggedLogger: mixinMonitoringContext(
						mockLogger,
						configProvider(featureGates),
					) as unknown as MockLogger,
					supportedFeatures: new Map([["referenceSequenceNumbers", true]]),
					clientDetails: { capabilities: { interactive: true } },
					closeFn: (_error?: ICriticalContainerError): void => {},
					updateDirtyContainerState: (_dirty: boolean) => {},
					getLoadedFromVersion: () => undefined,
				};
			};

			beforeEach(async () => {
				mockLogger = new MockLogger();
			});

			const runtimeOptions = {
				compressionOptions: {
					minimumBatchSizeInBytes: 1024 * 1024,
					compressionAlgorithm: CompressionAlgorithms.lz4,
				},
				chunkSizeInBytes: 800 * 1024,
				flushMode: FlushModeExperimental.Async as unknown as FlushMode,
				enableGroupedBatching: true,
			} as const satisfies IContainerRuntimeOptionsInternal;

			const defaultRuntimeOptions = {
				summaryOptions: {},
				gcOptions: {},
				loadSequenceNumberVerification: "close",
				flushMode: FlushMode.TurnBased,
				compressionOptions: {
					minimumBatchSizeInBytes: 614400,
					compressionAlgorithm: CompressionAlgorithms.lz4,
				},
				maxBatchSizeInBytes: 700 * 1024,
				chunkSizeInBytes: 204800,
				enableRuntimeIdCompressor: undefined,
				enableGroupedBatching: true, // Redundant, but makes the JSON.stringify yield the same result as the logs
				explicitSchemaControl: false,
				createBlobPayloadPending: undefined,
			} as const satisfies ContainerRuntimeOptionsInternal;
			const mergedRuntimeOptions = { ...defaultRuntimeOptions, ...runtimeOptions } as const;

			it("Container load stats", async () => {
				await ContainerRuntime.loadRuntime({
					context: localGetMockContext({}) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions,
					provideEntryPoint: mockProvideEntryPoint,
				});

				mockLogger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(mergedRuntimeOptions),
						idCompressorMode: defaultRuntimeOptions.enableRuntimeIdCompressor,
					},
				]);
			});

			it("Container load stats with feature gate overrides", async () => {
				const featureGates = {
					"Fluid.ContainerRuntime.IdCompressorEnabled": true,
					"Fluid.ContainerRuntime.Test.CloseSummarizerDelayOverrideMs": 1337,
					"Fluid.ContainerRuntime.DisableFlushBeforeProcess": true,
				};
				await ContainerRuntime.loadRuntime({
					context: localGetMockContext(featureGates) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions,
					provideEntryPoint: mockProvideEntryPoint,
				});

				mockLogger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(mergedRuntimeOptions),
						idCompressorMode: "on",
						featureGates: JSON.stringify({
							closeSummarizerDelayOverride: 1337,
							disableFlushBeforeProcess: true,
						}),
						groupedBatchingEnabled: true,
					},
				]);
			});
		});

		describe("Container feature detection", () => {
			const mockLogger = new MockLogger();

			beforeEach(() => {
				mockLogger.clear();
			});

			const localGetMockContext = (
				features?: ReadonlyMap<string, unknown>,
				compatibilityDetails?: ILayerCompatDetails,
			): Partial<IContainerContext & IProvideLayerCompatDetails> => {
				return {
					attachState: AttachState.Attached,
					deltaManager: new MockDeltaManager(),
					audience: new MockAudience(),
					quorum: new MockQuorumClients(),
					taggedLogger: mockLogger,
					supportedFeatures: features,
					clientDetails: { capabilities: { interactive: true } },
					closeFn: (_error?: ICriticalContainerError): void => {},
					updateDirtyContainerState: (_dirty: boolean) => {},
					getLoadedFromVersion: () => undefined,
					ILayerCompatDetails: compatibilityDetails,
				};
			};

			const runtimeOptions: IContainerRuntimeOptionsInternal = {
				flushMode: FlushModeExperimental.Async as unknown as FlushMode,
			};

			for (const features of [
				undefined,
				new Map([["referenceSequenceNumbers", false]]),
				new Map([
					["other", true],
					["feature", true],
				]),
			]) {
				it("Loader not supported for async FlushMode, fallback to TurnBased", async () => {
					const runtime = await ContainerRuntime.loadRuntime({
						context: localGetMockContext(features) as IContainerContext,
						registryEntries: [],
						existing: false,
						runtimeOptions,
						provideEntryPoint: mockProvideEntryPoint,
					});

					assert.equal(runtime.flushMode, FlushMode.TurnBased);
					mockLogger.assertMatchAny([
						{
							eventName: "ContainerRuntime:FlushModeFallback",
							category: "error",
						},
					]);
				});
			}

			it("Loader supported for async FlushMode", async () => {
				const runtime = await ContainerRuntime.loadRuntime({
					context: localGetMockContext(
						new Map([["referenceSequenceNumbers", true]]),
					) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions,
					provideEntryPoint: mockProvideEntryPoint,
				});

				assert.equal(runtime.flushMode, FlushModeExperimental.Async);
				mockLogger.assertMatchNone([
					{
						eventName: "ContainerRuntime:FlushModeFallback",
						category: "error",
					},
				]);
			});

			it("Loader supported for async FlushMode with ILayerCompatDetails", async () => {
				const compatDetails: ILayerCompatDetails = {
					pkgVersion: "0.1.0",
					generation: 1,
					supportedFeatures: new Set(),
				};
				const runtime = await ContainerRuntime.loadRuntime({
					context: localGetMockContext(undefined, compatDetails) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions,
					provideEntryPoint: mockProvideEntryPoint,
				});

				assert.equal(runtime.flushMode, FlushModeExperimental.Async);
				mockLogger.assertMatchNone([
					{
						eventName: "ContainerRuntime:FlushModeFallback",
						category: "error",
					},
				]);
			});
		});

		describe("Summarization", () => {
			let containerRuntime: ContainerRuntime;

			async function yieldEventLoop(): Promise<void> {
				const yieldP = new Promise<void>((resolve) => {
					setTimeout(resolve);
				});
				clock.tick(1);
				await yieldP;
			}

			beforeEach(async () => {
				const settings = {};
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext(settings) as IContainerContext,
					registryEntries: [],
					existing: false,
					provideEntryPoint: mockProvideEntryPoint,
				});
			});

			it("summary is submitted successfully", async () => {
				const summarizeResult = await containerRuntime.submitSummary({
					summaryLogger: createChildLogger(),
					cancellationToken: neverCancelledSummaryToken,
					latestSummaryRefSeqNum: 0,
				});
				assert(summarizeResult.stage === "submit", "Summary did not succeed");
			});

			it("summary fails if summary token is canceled", async () => {
				const cancelledSummaryToken: ISummaryCancellationToken = {
					cancelled: true,
					waitCancelled: new Promise(() => {}),
				};
				const summarizeResult = await containerRuntime.submitSummary({
					summaryLogger: createChildLogger(),
					cancellationToken: cancelledSummaryToken,
					latestSummaryRefSeqNum: 0,
				});
				assert(summarizeResult.stage === "base", "Summary did not fail");
				assert.strictEqual(
					summarizeResult.error?.message,
					"disconnected",
					"Summary was not canceled",
				);
			});

			it("summary fails before generate if there are pending ops", async () => {
				// Submit an op and yield for it to be flushed from outbox to pending state manager.
				submitDataStoreOp(containerRuntime, "fakeId", "fakeContents");
				await yieldEventLoop();

				const summarizeResultP = containerRuntime.submitSummary({
					summaryLogger: createChildLogger(),
					cancellationToken: neverCancelledSummaryToken,
					latestSummaryRefSeqNum: 0,
				});

				// Advance the clock by the time that container runtime would wait for pending ops to be processed.
				clock.tick(defaultPendingOpsWaitTimeoutMs);
				const summarizeResult = await summarizeResultP;
				assert(summarizeResult.stage === "base", "Summary did not fail");
				assert.strictEqual(
					summarizeResult.error?.message,
					"PendingOpsWhileSummarizing",
					"Summary did not fail with the right error",
				);
				assert.strictEqual(
					isILoggingError(summarizeResult.error) &&
						summarizeResult.error.getTelemetryProperties().beforeGenerate,
					true,
					"It should have failed before generating summary",
				);
			});

			it("summary fails after generate if there are pending ops", async () => {
				// Patch the summarize function to submit messages during it. This way there will be pending
				// messages after generating the summary.
				const patch = (fn: (...args: any[]) => Promise<ISummaryTreeWithStats>) => {
					const boundFn = fn.bind(containerRuntime);
					return async (...args: unknown[]) => {
						// Submit an op and yield for it to be flushed from outbox to pending state manager.
						submitDataStoreOp(containerRuntime, "fakeId", "fakeContents");
						await yieldEventLoop();

						return boundFn(...args);
					};
				};
				containerRuntime.summarize = patch(containerRuntime.summarize);

				const summarizeResult = await containerRuntime.submitSummary({
					summaryLogger: createChildLogger(),
					cancellationToken: neverCancelledSummaryToken,
					latestSummaryRefSeqNum: 0,
				});
				assert(summarizeResult.stage === "base", "Summary did not fail");
				assert.strictEqual(
					summarizeResult.error?.message,
					"PendingOpsWhileSummarizing",
					"Summary did not fail with the right error",
				);
				assert.strictEqual(
					isILoggingError(summarizeResult.error) &&
						summarizeResult.error.getTelemetryProperties().beforeGenerate,
					false,
					"It should have failed after generating summary",
				);
			});

			it("summary passes if pending ops are processed during pending op processing timeout", async () => {
				// Create a container runtime type where the submit method is public. This makes it easier to test
				// submission and processing of ops. The other option is to send data store or alias ops whose
				// processing requires creation of data store context and runtime as well.
				type ContainerRuntimeWithSubmit = Omit<ContainerRuntime, "submit"> & {
					submit(
						containerRuntimeMessage: LocalContainerRuntimeMessage,
						localOpMetadata: unknown,
						metadata: Record<string, unknown> | undefined,
					): void;
				};
				const containerRuntimeWithSubmit =
					containerRuntime as unknown as ContainerRuntimeWithSubmit;
				// Submit a rejoin op and yield for it to be flushed from outbox to pending state manager.
				containerRuntimeWithSubmit.submit(
					{
						type: ContainerMessageType.Rejoin,
						contents: undefined,
					},
					undefined,
					undefined,
				);
				await yieldEventLoop();

				// Create a mock logger to validate that pending ops event is generated with correct params.
				const mockLogger = new MockLogger();
				const summaryLogger = createChildLogger({ logger: mockLogger });
				const summarizeResultP = containerRuntime.submitSummary({
					summaryLogger,
					cancellationToken: neverCancelledSummaryToken,
					latestSummaryRefSeqNum: 0,
				});

				// Advance the clock by 1 ms less than the time waited for pending ops to be processed. This will allow
				// summarization to proceed far enough to wait for pending ops.
				clock.tick(defaultPendingOpsWaitTimeoutMs - 1);
				// Process the rejoin op so that there are no pending ops.
				containerRuntime.process(
					{
						type: "op",
						clientId: "fakeClientId",
						sequenceNumber: 0,
						contents: {
							type: ContainerMessageType.Rejoin,
							contents: undefined,
						},
						minimumSequenceNumber: 0,
					} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
					true /* local */,
				);
				// Advance the clock by the remaining time so that pending ops wait is completed.
				clock.tick(1);

				const summarizeResult = await summarizeResultP;
				assert(summarizeResult.stage === "submit", "Summary did not succeed");
				mockLogger.assertMatch([
					{
						eventName: "PendingOpsWhileSummarizing",
						countBefore: 1,
						countAfter: 0,
						saved: true,
					},
				]);
			});
		});

		describe("Snapshots", () => {
			/**
			 * This test tests a scenario where a summarizer gets a newer summary ack, but on fetching the latest snapshot,
			 * it gets a snapshot which is older than the one corresponding to the ack.
			 * This can happen in cases such as database rollbacks in server which results in deleting recent snapshots but
			 * not the corresponding acks.
			 * Summarizers should not close in this scenario. They should continue generating summaries.
			 */
			it("Summary succeeds on receiving summary ack for a deleted snapshot", async () => {
				// The latest snapshot version in storage.
				const latestVersion: IVersion = {
					id: "snapshot1",
					treeId: "snapshotTree1",
				};
				// The latest snapshot tree in storage.
				const latestSnapshotTree: ISnapshotTree = {
					blobs: {},
					trees: {
						".protocol": {
							blobs: {
								"attributes": "attributesBlob",
							},
							trees: {},
						},
					},
				};
				// The version of the snapshot that was deleted say during DB rollback.
				const deletedSnapshotId = "snapshot2";
				// The properties of the ack corresponding to the deleted snapshot.
				const deletedSnapshotAckOptions: IRefreshSummaryAckOptions = {
					proposalHandle: "proposal1",
					ackHandle: deletedSnapshotId,
					summaryRefSeq: 100,
					summaryLogger: createChildLogger({}),
				};
				class MockStorageService implements Partial<IRuntimeStorageService> {
					/**
					 * This always returns the same snapshot. Basically, when container runtime receives an ack for the
					 * deleted snapshot and tries to fetch the latest snapshot, return the latest snapshot.
					 */
					async getSnapshotTree(
						version?: IVersion,
						scenarioName?: string,
					): Promise<ISnapshotTree> {
						assert.strictEqual(
							version,
							latestVersion,
							"getSnapshotTree called with incorrect version",
						);
						return latestSnapshotTree;
					}

					async getVersions(
						// eslint-disable-next-line @rushstack/no-new-null -- base signature uses `null`
						versionId: string | null,
						count: number,
						scenarioName?: string,
						fetchSource?: FetchSource,
					): Promise<IVersion[]> {
						return [latestVersion];
					}

					/**
					 * Validates that this is not called by container runtime with the deleted snapshot id even
					 * though it received an ack for it.
					 */
					async uploadSummaryWithContext(
						summary: ISummaryTree,
						context: ISummaryContext,
					): Promise<string> {
						assert.notStrictEqual(
							context.ackHandle,
							deletedSnapshotId,
							"Summary uploaded with deleted snapshot's ack",
						);
						return "snapshot3";
					}

					/**
					 * Called by container runtime to read document attributes. Return the sequence number as 0 which
					 * is lower than the deleted snapshot's reference sequence number.
					 */
					async readBlob(id: string): Promise<ArrayBufferLike> {
						assert.strictEqual(id, "attributesBlob", "Not implemented");
						const attributes: IDocumentAttributes = {
							sequenceNumber: 0,
							minimumSequenceNumber: 0,
						};
						return stringToBuffer(JSON.stringify(attributes), "utf8");
					}
				}

				const mockContext = getMockContext({
					mockStorage: new MockStorageService(),
					loadedFromVersion: latestVersion,
				});
				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: mockContext as IContainerContext,
					registryEntries: [],
					existing: false,
					provideEntryPoint: mockProvideEntryPoint,
				});

				// Call refresh latest summary with the deleted snapshot's options. Container runtime should
				// ignore this but not close.
				await assert.doesNotReject(
					containerRuntime.refreshLatestSummaryAck(deletedSnapshotAckOptions),
					"Container runtime should not close",
				);

				// Submit a summary. This should upload a summary with the snapshot container runtime loaded
				// from and not the deleted snapshot.
				const summarizeResult = await containerRuntime.submitSummary({
					summaryLogger: createChildLogger(),
					cancellationToken: neverCancelledSummaryToken,
					latestSummaryRefSeqNum: 0,
				});
				assert(summarizeResult.stage === "submit", "Summary should not fail");
			});
		});

		describe("GetPendingState", () => {
			it("No Props. No pending state", async () => {
				const logger = new MockLogger();

				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});

				const mockPendingStateManager = new Proxy<PendingStateManager>(
					{} as unknown as PendingStateManager,
					{
						get: (_t, p: keyof PendingStateManager, _r) => {
							switch (p) {
								case "getLocalState": {
									return () => undefined;
								}
								case "pendingMessagesCount": {
									return 0;
								}
								default: {
									assert.fail(`unexpected access to pendingStateManager.${p}`);
								}
							}
						},
					},
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				(containerRuntime as any).pendingStateManager = mockPendingStateManager;

				const state = containerRuntime.getPendingLocalState() as Partial<IPendingRuntimeState>;
				assert.ok(state.sessionExpiryTimerStarted !== undefined);
			});
			it("No Props. Some pending state", async () => {
				const logger = new MockLogger();

				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
				const pendingStates: IPendingMessage[] = Array.from({ length: 5 }, (_, i) => ({
					content: i.toString(),
					type: "message",
					referenceSequenceNumber: 0,
					localOpMetadata: undefined,
					opMetadata: undefined,
					batchInfo: { clientId: "CLIENT_ID", batchStartCsn: 1, length: 5, staged: false },
					runtimeOp: undefined,
				}));
				const mockPendingStateManager = new Proxy<PendingStateManager>(
					{} as unknown as PendingStateManager,
					{
						get: (_t, p: keyof PendingStateManager, _r) => {
							switch (p) {
								case "getLocalState": {
									return (): IPendingLocalState => ({
										pendingStates,
									});
								}
								case "pendingMessagesCount": {
									return 5;
								}
								default: {
									assert.fail(`unexpected access to pendingStateManager.${p}`);
								}
							}
						},
					},
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				(containerRuntime as any).pendingStateManager = mockPendingStateManager;

				const state = containerRuntime.getPendingLocalState() as Partial<IPendingRuntimeState>;
				assert.strictEqual(typeof state, "object");
				assert.strictEqual(state.pending?.pendingStates, pendingStates);
			});

			it("sessionExpiryTimerStarted. No pending state", async () => {
				const logger = new MockLogger();

				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});

				const state = (await containerRuntime.getPendingLocalState({
					notifyImminentClosure: false,
					sessionExpiryTimerStarted: 100,
				})) as Partial<IPendingRuntimeState>;
				assert.strictEqual(typeof state, "object");
				assert.strictEqual(state.sessionExpiryTimerStarted, 100);
			});

			it("sessionExpiryTimerStarted. Some pending state", async () => {
				const logger = new MockLogger();

				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
				const pendingStates: IPendingMessage[] = Array.from({ length: 5 }, (_, i) => ({
					content: i.toString(),
					type: "message",
					referenceSequenceNumber: 0,
					localOpMetadata: undefined,
					opMetadata: undefined,
					batchInfo: { clientId: "CLIENT_ID", batchStartCsn: 1, length: 5, staged: false },
					runtimeOp: undefined,
				}));
				const mockPendingStateManager = new Proxy<PendingStateManager>(
					{} as unknown as PendingStateManager,
					{
						get: (_t, p: keyof PendingStateManager, _r) => {
							switch (p) {
								case "getLocalState": {
									return (): IPendingLocalState => ({
										pendingStates,
									});
								}
								case "pendingMessagesCount": {
									return 5;
								}
								default: {
									assert.fail(`unexpected access to pendingStateManager.${p}`);
								}
							}
						},
					},
				);

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				(containerRuntime as any).pendingStateManager = mockPendingStateManager;

				const state = (await containerRuntime.getPendingLocalState({
					notifyImminentClosure: false,
					sessionExpiryTimerStarted: 100,
				})) as Partial<IPendingRuntimeState>;
				assert.strictEqual(state.sessionExpiryTimerStarted, 100);
			});
		});

		describe("Duplicate Batch Detection", () => {
			for (const enableOfflineLoad of [undefined, true]) {
				it(`DuplicateBatchDetector enablement matches Offline load (${enableOfflineLoad ? "ENABLED" : "DISABLED"})`, async () => {
					const containerRuntime = await ContainerRuntime.loadRuntime({
						context: getMockContext({
							settings: { "Fluid.Container.enableOfflineLoad": enableOfflineLoad },
						}) as IContainerContext,
						registryEntries: [],
						existing: false,
						runtimeOptions: {
							enableRuntimeIdCompressor: "on",
						},
						provideEntryPoint: mockProvideEntryPoint,
					});

					// Process batch "batchId1" with seqNum 123
					containerRuntime.process(
						{
							sequenceNumber: 123,
							type: MessageType.Operation,
							contents: { type: ContainerMessageType.Rejoin, contents: undefined },
							metadata: { batchId: "batchId1" },
						} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
						false,
					);
					// Process a duplicate batch "batchId1" with different seqNum 234
					const assertThrowsOnlyIfExpected = enableOfflineLoad
						? assert.throws
						: assert.doesNotThrow;
					const errorPredicate = (e: Error) =>
						e.message === "Duplicate batch - The same batch was sequenced twice";
					assertThrowsOnlyIfExpected(
						() => {
							containerRuntime.process(
								{
									sequenceNumber: 234,
									type: MessageType.Operation,
									contents: { type: ContainerMessageType.Rejoin, contents: undefined },
									metadata: { batchId: "batchId1" },
								} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
								false,
							);
						},
						errorPredicate,
						"Expected duplicate batch detection to match Offline Load enablement",
					);
				});
			}

			it("Can roundrip DuplicateBatchDetector state through summary/snapshot", async () => {
				// Duplicate Batch Detection requires OfflineLoad enabled
				const settings_enableOfflineLoad = { "Fluid.Container.enableOfflineLoad": true };
				const containerRuntime = await ContainerRuntime.loadRuntime({
					context: getMockContext({
						settings: settings_enableOfflineLoad,
					}) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});

				// Add batchId1 to DuplicateBatchDetected via ContainerRuntime.process,
				// and get its serialized representation from summarizing
				containerRuntime.process(
					{
						sequenceNumber: 123,
						type: MessageType.Operation,
						contents: { type: ContainerMessageType.Rejoin, contents: undefined },
						metadata: { batchId: "batchId1" },
					} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
					false,
				);
				const { summary } = await containerRuntime.summarize({ fullTree: true });
				const blob = summary.tree[recentBatchInfoBlobName];
				assert(blob.type === SummaryType.Blob, "Expected blob");
				assert.equal(blob.content, '[[123,"batchId1"]]', "Expected single batchId mapping");

				// Load a new ContainerRuntime with the serialized DuplicateBatchDetector state.
				const mockStorage = {
					// Hardcode readblob fn to return the blob contents put in the summary
					readBlob: async (_id) => stringToBuffer(blob.content as string, "utf8"),
				};
				const containerRuntime2 = await ContainerRuntime.loadRuntime({
					context: getMockContext({
						settings: settings_enableOfflineLoad,
						baseSnapshot: {
							trees: {},
							blobs: { [recentBatchInfoBlobName]: "nonempty_id_ignored_by_mockStorage" },
						},
						mockStorage,
					}) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});

				// Process an op with a duplicate batchId to what was loaded with
				assert.throws(
					() => {
						containerRuntime2.process(
							{
								sequenceNumber: 234,
								type: MessageType.Operation,
								contents: { type: ContainerMessageType.Rejoin, contents: undefined },
								metadata: { batchId: "batchId1" },
							} satisfies Partial<ISequencedDocumentMessage> as ISequencedDocumentMessage,
							false,
						);
					},
					(e: Error) => e.message === "Duplicate batch - The same batch was sequenced twice",
					"Expected duplicate batch detected after loading with recentBatchInfo",
				);
			});
		});

		describe("Load Partial Snapshot with datastores with GroupId", () => {
			let snapshotWithContents: ISnapshot;
			let blobContents: Map<string, ArrayBuffer>;
			let ops: ISequencedDocumentMessage[];
			let containerRuntime: ContainerRuntime;
			let containerContext: IContainerContext;
			let entryDefault: FluidDataStoreRegistryEntry;
			let snapshotTree: ISnapshotTree;
			let missingDataStoreRuntime: MockFluidDataStoreRuntime;
			beforeEach(async () => {
				snapshotTree = {
					id: "SnapshotId",
					blobs: { ".metadata": "bARD4RKvW4LL1KmaUKp6hUMSp" },
					trees: {
						".channels": {
							blobs: {},
							trees: {
								default: {
									blobs: {
										".component": "bARC6dCXlcrPxQHw3PeROtmKc",
									},
									trees: {
										".channels": {
											blobs: {},
											trees: {
												root: { blobs: {}, trees: {} },
											},
										},
									},
								},
							},
							unreferenced: true,
						},
						".blobs": { blobs: {}, trees: {} },
						"gc": {
							id: "e8ed0760ac37fd8042020559779ce80b1d88f266",
							blobs: {
								__gc_root: "018d97818f8b519f99c418cb3c33ce5cc4e38e3f",
							},
							trees: {},
						},
					},
				};

				blobContents = new Map<string, ArrayBuffer>([
					[
						"bARD4RKvW4LL1KmaUKp6hUMSp",
						stringToBuffer(JSON.stringify({ summaryFormatVersion: 1, gcFeature: 3 }), "utf8"),
					],
					[
						"bARC6dCXlcrPxQHw3PeROtmKc",
						stringToBuffer(
							JSON.stringify({
								pkg: '["@fluid-example/smde"]',
								summaryFormatVersion: 2,
								isRootDataStore: true,
							}),
							"utf8",
						),
					],
					[
						"018d97818f8b519f99c418cb3c33ce5cc4e38e3f",
						stringToBuffer(
							JSON.parse(
								JSON.stringify(
									'{"gcNodes":{"/":{"outboundRoutes":["/rootDOId"]},"/rootDOId":{"outboundRoutes":["/rootDOId/de68ca53-be31-479e-8d34-a267958997e4","/rootDOId/root"]},"/rootDOId/de68ca53-be31-479e-8d34-a267958997e4":{"outboundRoutes":["/rootDOId"]},"/rootDOId/root":{"outboundRoutes":["/rootDOId","/rootDOId/de68ca53-be31-479e-8d34-a267958997e4"]}}}',
								),
							) as string,
							"utf8",
						),
					],
				]);

				ops = [
					{
						clientId: "X",
						clientSequenceNumber: -1,
						// eslint-disable-next-line unicorn/no-null
						contents: null,
						minimumSequenceNumber: 0,
						referenceSequenceNumber: -1,
						sequenceNumber: 1,
						timestamp: 1623883807452,
						type: "join",
					},
					{
						clientId: "Y",
						clientSequenceNumber: -1,
						// eslint-disable-next-line unicorn/no-null
						contents: null,
						minimumSequenceNumber: 0,
						referenceSequenceNumber: -1,
						sequenceNumber: 2,
						timestamp: 1623883811928,
						type: "join",
					},
				];
				snapshotWithContents = {
					blobContents,
					ops,
					snapshotTree,
					sequenceNumber: 0,
					snapshotFormatV: 1,
					latestSequenceNumber: 2,
				};

				const logger = new MockLogger();
				containerContext = getMockContext({ logger }) as IContainerContext;

				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Modifying private property
				(containerContext as any).snapshotWithContents = snapshotWithContents;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Modifying private property
				(containerContext as any).baseSnapshot = snapshotWithContents.snapshotTree;
				containerContext.storage.readBlob = async (id: string) => {
					return blobContents.get(id) as ArrayBuffer;
				};
				missingDataStoreRuntime = new MockFluidDataStoreRuntime();
				const entryA = createDataStoreRegistryEntry([]);
				const entryB = createDataStoreRegistryEntry([]);
				entryDefault = createDataStoreRegistryEntry([
					["default", Promise.resolve(entryA)],
					["missingDataStore", Promise.resolve(entryB)],
				]);

				logger.clear();
			});

			function createSnapshot(addMissingDatastore: boolean, setGroupId: boolean = true): void {
				if (addMissingDatastore) {
					snapshotTree.trees[".channels"].trees.missingDataStore = {
						blobs: { ".component": "id" },
						trees: {
							".channels": {
								blobs: {},
								trees: {
									root: { blobs: {}, trees: {} },
								},
							},
						},
						groupId: setGroupId ? "G1" : undefined,
					};
				}
			}

			// Helper function that creates a FluidDataStoreRegistryEntry with the registry entries
			// provided to it.
			function createDataStoreRegistryEntry(
				entries: NamedFluidDataStoreRegistryEntries,
			): FluidDataStoreRegistryEntry {
				const registryEntries = new Map(entries);
				const factory: IFluidDataStoreFactory = {
					type: "store-type",
					get IFluidDataStoreFactory() {
						return factory;
					},
					instantiateDataStore: async (context: IFluidDataStoreContext) => {
						if (context.id === "missingDataStore") {
							return missingDataStoreRuntime;
						}
						return new MockFluidDataStoreRuntime();
					},
				};
				const registry: IFluidDataStoreRegistry = {
					get IFluidDataStoreRegistry() {
						return registry;
					},
					// Returns the registry entry as per the entries provided in the param.
					get: async (pkg) => registryEntries.get(pkg),
				};

				const entry: FluidDataStoreRegistryEntry = {
					get IFluidDataStoreFactory() {
						return factory;
					},
					get IFluidDataStoreRegistry() {
						return registry;
					},
				};
				return entry;
			}

			it("Load snapshot with missing snapshot contents for datastores should fail when groupId not specified", async () => {
				// In this test we will try to load the container runtime with a snapshot which has 2 datastores. However,
				// snapshot for datastore "missingDataStore" is omitted and we will check that the container runtime loads fine
				// but the "missingDataStore" is aliased, it fails if the snapshot for it does not have loadingGroupId to fetch
				// the omitted snapshot contents.
				createSnapshot(true /* addMissingDatastore */, false /* Don't set groupId property */);
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: containerContext,
					registryEntries: [["@fluid-example/smde", Promise.resolve(entryDefault)]],
					existing: true,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
				const defaultDataStore =
					await containerRuntime.getAliasedDataStoreEntryPoint("default");
				assert(defaultDataStore !== undefined, "data store should load and is attached");
				await assert.rejects(async () => {
					await containerRuntime.getAliasedDataStoreEntryPoint("missingDataStore");
				}, "Resolving missing datastore should reject");
			});

			it("Load snapshot with missing snapshot contents for datastores should fail for summarizer in case group snapshot is ahead of initial snapshot seq number", async () => {
				// In this test we will try to load the container runtime with a snapshot which has 2 datastores. However,
				// snapshot for datastore "missingDataStore" is omitted and we will check that the container runtime loads fine
				// but the "missingDataStore" is requested/aliased, it fails to because for summarizer the fetched snapshot could
				// not be ahead of the base snapshot as that means that a snapshot is missing and the summarizer is not up to date.
				containerContext.storage.getSnapshot = async (snapshotFetchOptions) => {
					snapshotWithContents.sequenceNumber = 10;
					return snapshotWithContents;
				};
				createSnapshot(true /* addMissingDatastore */);
				containerContext.clientDetails.type = "summarizer";
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: containerContext,
					registryEntries: [["@fluid-example/smde", Promise.resolve(entryDefault)]],
					existing: true,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
				const defaultDataStore =
					await containerRuntime.getAliasedDataStoreEntryPoint("default");
				assert(defaultDataStore !== undefined, "data store should load and is attached");
				await assert.rejects(
					async () => {
						await containerRuntime.getAliasedDataStoreEntryPoint("missingDataStore");
					},
					(err: IFluidErrorBase) => {
						assert(
							err.message ===
								"Summarizer client behind, loaded newer snapshot with loadingGroupId",
							"summarizer client is behind",
						);
						return true;
					},
				);
			});

			it("Load snapshot with missing snapshot contents for datastores should load properly", async () => {
				// In this test we will try to load the container runtime with a snapshot which has 2 datastores. However,
				// snapshot for datastore "missingDataStore" is omitted and we will check that the container runtime loads fine
				// and when the "missingDataStore" is requested/aliased, it does that successfully.
				let getSnapshotCalledTimes = 0;
				containerContext.storage.getSnapshot = async (snapshotFetchOptions) => {
					getSnapshotCalledTimes++;
					snapshotWithContents.blobContents.set(
						"id",
						stringToBuffer(
							JSON.stringify({
								pkg: '["@fluid-example/smde"]',
								summaryFormatVersion: 2,
								isRootDataStore: true,
							}),
							"utf8",
						),
					);
					return snapshotWithContents;
				};
				createSnapshot(true /* addMissingDatastore */);
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: containerContext,
					registryEntries: [["@fluid-example/smde", Promise.resolve(entryDefault)]],
					existing: true,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
				const defaultDataStore =
					await containerRuntime.getAliasedDataStoreEntryPoint("default");
				assert(defaultDataStore !== undefined, "data store should load and is attached");
				const datastore1 = await containerRuntime.resolveHandle({
					url: "/missingDataStore",
				});
				// Mock Datastore runtime will return null when requested for "/".
				// eslint-disable-next-line unicorn/no-null
				assert.strictEqual(datastore1, null, "resolveHandle should work fine");

				// Now try to get snapshot for missing data store again from container runtime. It should be returned
				// from cache.
				const snapshot = await containerRuntime.getSnapshotForLoadingGroupId(
					["G1"],
					["missingDataStore"],
				);
				assert.deepStrictEqual(
					snapshotTree.trees[".channels"].trees.missingDataStore,
					snapshot.snapshotTree,
					"snapshot should be equal",
				);
				assert(getSnapshotCalledTimes === 1, "second time should be from cache");

				// Set api to undefined to see that it should not be called again.
				containerContext.storage.getSnapshot = undefined;
				const datastore2 = await containerRuntime.resolveHandle({
					url: "/missingDataStore",
				});
				assert(datastore2 !== undefined, "resolveHandle should work fine");
			});

			it("Load snapshot with missing snapshot contents for datastores should work in case group snapshot is ahead of initial snapshot seq number", async () => {
				// In this test we will try to load the container runtime with a snapshot which has 2 datastores. However,
				// snapshot for datastore "missingDataStore" is omitted and we will check that the container runtime loads fine
				// and the container runtime waits for delta manager to reach snapshot seq number before returning the snapshot.
				containerContext.storage.getSnapshot = async (snapshotFetchOptions) => {
					snapshotWithContents.blobContents.set(
						"id",
						stringToBuffer(
							JSON.stringify({
								pkg: '["@fluid-example/smde"]',
								summaryFormatVersion: 2,
								isRootDataStore: true,
							}),
							"utf8",
						),
					);
					snapshotWithContents.sequenceNumber = 5;
					return snapshotWithContents;
				};
				createSnapshot(true /* addMissingDatastore */);
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: containerContext,
					registryEntries: [["@fluid-example/smde", Promise.resolve(entryDefault)]],
					existing: true,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
				const defaultDataStore =
					await containerRuntime.getAliasedDataStoreEntryPoint("default");
				assert(defaultDataStore !== undefined, "data store should load and is attached");
				// Set it to seq number of partial fetched snapshot so that it is returned successfully by container runtime.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				(containerContext.deltaManager as any).lastSequenceNumber = 5;
				const missingDataStore = await containerRuntime.resolveHandle({
					url: "/missingDataStore",
				});
				// Mock Datastore runtime will return null when requested for "/".
				// eslint-disable-next-line unicorn/no-null
				assert.strictEqual(missingDataStore, null, "resolveHandle should work fine");
			});

			it("Load snapshot with missing snapshot contents for datastores should only process ops in datastore context which are after the snapshot seq number", async () => {
				// In this test we will try to load the container runtime with a snapshot which has 2 datastores. However,
				// snapshot for datastore "missingDataStore" is omitted and we will check that the container runtime loads fine
				// and the data store context only process ops which are after the snapshot seq number.
				containerContext.storage.getSnapshot = async (snapshotFetchOptions) => {
					snapshotWithContents.sequenceNumber = 2;
					snapshotWithContents.blobContents.set(
						"id",
						stringToBuffer(
							JSON.stringify({
								pkg: '["@fluid-example/smde"]',
								summaryFormatVersion: 2,
								isRootDataStore: true,
							}),
							"utf8",
						),
					);
					return snapshotWithContents;
				};
				createSnapshot(true /* addMissingDatastore */);
				containerRuntime = await ContainerRuntime.loadRuntime({
					context: containerContext,
					registryEntries: [["@fluid-example/smde", Promise.resolve(entryDefault)]],
					existing: true,
					runtimeOptions: {
						enableRuntimeIdCompressor: "on",
					},
					provideEntryPoint: mockProvideEntryPoint,
				});
				const defaultDataStore =
					await containerRuntime.getAliasedDataStoreEntryPoint("default");
				assert(defaultDataStore !== undefined, "data store should load and is attached");
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const missingDataStoreContext =
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
					(containerRuntime as any).channelCollection.contexts.get("missingDataStore");
				assert(missingDataStoreContext !== undefined, "context should be there");
				const envelopes: ISequencedMessageEnvelope[] = [
					{ sequenceNumber: 1 },
					{ sequenceNumber: 2 },
					{ sequenceNumber: 3 },
					{ sequenceNumber: 4 },
				] as unknown as ISequencedMessageEnvelope[];
				for (const envelope of envelopes) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
					missingDataStoreContext.processMessages({
						envelope,
						messagesContent: [
							{ contents: "message", localOpMetadata: undefined, clientSequenceNumber: 1 },
						],
						local: false,
					});
				}

				// Set it to seq number of partial fetched snapshot so that it is returned successfully by container runtime.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				(containerContext.deltaManager as any).lastSequenceNumber = 2;

				let opsProcessed = 0;
				let opsStart: number | undefined;
				const processMessagesStub = (messageCollection: IRuntimeMessageCollection) => {
					if (opsProcessed === 0) {
						opsStart = messageCollection.envelope.sequenceNumber;
					}
					opsProcessed += messageCollection.messagesContent.length;
				};
				const stub = sandbox
					.stub(missingDataStoreRuntime, "processMessages")
					.callsFake(processMessagesStub);
				await assert.doesNotReject(async () => {
					await containerRuntime.resolveHandle({ url: "/missingDataStore" });
				}, "resolveHandle should work fine");

				stub.restore();

				assert(opsProcessed === 2, "only 2 ops should be processed with seq number 3 and 4");
				assert(opsStart === 3, "first op processed should have seq number 3");
			});
		});

		it("Only log legacy codepath once", async () => {
			const mockLogger = new MockLogger();

			let legacyLogger = getSingleUseLegacyLogCallback(
				createChildLogger({ logger: mockLogger }),
				"someType",
			);
			assert.equal(mockLogger.events.length, 0, "Expected no event logged");

			legacyLogger = getSingleUseLegacyLogCallback(
				createChildLogger({ logger: mockLogger }),
				"someType",
			);
			legacyLogger("codePath1");
			mockLogger.assertMatch([{ eventName: "LegacyMessageFormat" }]);

			legacyLogger = getSingleUseLegacyLogCallback(
				createChildLogger({ logger: mockLogger }),
				"someType",
			);
			legacyLogger("codePath2");
			assert.equal(mockLogger.events.length, 0, "Expected no more events logged");
		});

		describe("Signal Telemetry", () => {
			let containerRuntime: ContainerRuntime_WithPrivates;
			let logger: MockLogger;
			let droppedSignals: ISignalEnvelopeWithClientIds[];
			let runtimes: Map<string, ContainerRuntime | ContainerRuntime_WithPrivates>;

			beforeEach(async () => {
				runtimes = new Map();
				logger = new MockLogger();
				droppedSignals = [];
				const runtimeOptions: IContainerRuntimeOptionsInternal = {
					enableGroupedBatching: false,
				};
				containerRuntime = (await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					requestHandler: undefined,
					runtimeOptions,
					provideEntryPoint: mockProvideEntryPoint,
				})) as unknown as ContainerRuntime_WithPrivates;
				// Assert that clientId is not undefined
				assert(containerRuntime.clientId !== undefined, "clientId should not be undefined");

				runtimes.set(containerRuntime.clientId, containerRuntime);
				logger.clear();
			});

			function sendSignals(count: number): void {
				for (let i = 0; i < count; i++) {
					containerRuntime.submitSignal("TestSignalType", `TestSignalContent ${i + 1}`);
					const { type, content } =
						submittedSignals[submittedSignals.length - 1].envelope.contents;
					assert(type === "TestSignalType", "Signal type should match");
					assertSignalContentIsAString(content);
					assert(content === `TestSignalContent ${i + 1}`, "Signal content should match");
				}
			}

			function processSignals(signals: ISignalEnvelopeWithClientIds[], count: number): void {
				const signalsToProcess = signals.splice(0, count);
				for (const signal of signalsToProcess) {
					if (signal.targetClientId === undefined) {
						for (const runtime of runtimes.values()) {
							runtime.processSignal(
								{
									clientId: signal.clientId,
									content: {
										clientBroadcastSignalSequenceNumber:
											signal.envelope.clientBroadcastSignalSequenceNumber,
										contents: signal.envelope.contents,
									},
									targetClientId: signal.targetClientId,
								},
								true,
							);
						}
					} else {
						const runtime = runtimes.get(signal.targetClientId);
						if (runtime) {
							runtime.processSignal(
								{
									clientId: signal.clientId,
									content: {
										clientBroadcastSignalSequenceNumber:
											signal.envelope.clientBroadcastSignalSequenceNumber,
										contents: signal.envelope.contents,
									},
									targetClientId: signal.targetClientId,
								},
								true,
							);
						}
					}
				}
			}

			function processWithNoTargetSupport(count: number): void {
				const signalsToProcess = submittedSignals.splice(0, count);
				for (const signal of signalsToProcess) {
					for (const runtime of runtimes.values()) {
						runtime.processSignal(
							{
								clientId: signal.clientId,
								content: {
									clientBroadcastSignalSequenceNumber:
										signal.envelope.clientBroadcastSignalSequenceNumber,
									contents: signal.envelope.contents,
								},
							},
							true,
						);
					}
				}
			}

			function processSubmittedSignals(count: number): void {
				processSignals(submittedSignals, count);
			}

			function processDroppedSignals(count: number): void {
				processSignals(droppedSignals, count);
			}

			function dropSignals(count: number): void {
				const signalsToDrop = submittedSignals.splice(0, count);
				droppedSignals.push(...signalsToDrop);
			}

			it("emits signal latency telemetry after 100 signals", () => {
				// Send 1st signal and process it to prime the system
				sendSignals(1);
				processSubmittedSignals(1);

				// Send 100 more signals and process each of them in order
				sendSignals(100);
				processSubmittedSignals(100);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 1,
							lost: 0,
							outOfOrder: 0,
							reconnectCount: 0,
						},

						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 100,
							lost: 0,
							outOfOrder: 0,
							reconnectCount: 0,
						},
					],
					"Signal latency telemetry should be logged after 100 signals",
					/* inlineDetailsProp = */ true,
				);
			});

			it("emits SignalLost error event when signal is dropped", () => {
				sendSignals(4);
				processSubmittedSignals(1);
				dropSignals(2);
				processSubmittedSignals(1);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLost",
							signalsLost: 2,
							expectedSequenceNumber: 2,
							clientBroadcastSignalSequenceNumber: 4,
						},
					],
					"SignalLost telemetry should be logged when signal is dropped",
					/* inlineDetailsProp = */ true,
				);
			});

			it("emits SignalOutOfOrder error event when missing signal is received non-sequentially", () => {
				sendSignals(3);
				processSubmittedSignals(1);
				dropSignals(1);
				processSubmittedSignals(1);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLost",
							signalsLost: 1,
							expectedSequenceNumber: 2,
							clientBroadcastSignalSequenceNumber: 3,
						},
					],
					"SignalLost telemetry should be logged when signal is dropped",
					/* inlineDetailsProp = */ true,
					false,
				);

				logger.assertMatchNone(
					[
						{
							eventName: "ContainerRuntime:SignalOutOfOrder",
						},
					],
					"SignalOutOfOrder telemetry should not be logged on lost signal",
				);

				processDroppedSignals(1);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalOutOfOrder",
						},
					],
					"SignalOutOfOrder telemetry should be logged when missing signal is received non-sequentially",
				);
			});

			it("does not emit error events when signals are processed in order", () => {
				sendSignals(100);

				processSubmittedSignals(100);

				logger.assertMatchNone(
					[
						{
							eventName: "ContainerRuntime:SignalLost",
						},
						{
							eventName: "ContainerRuntime:SignalOutOfOrder",
						},
					],
					"SignalLost and SignalOutOfOrder telemetry should not be logged when signals are processed in order",
				);
			});

			it("logs relative lost signal count in SignalLost telemetry", () => {
				sendSignals(5);
				dropSignals(1);
				processSubmittedSignals(1);

				// Missing signal should be detected
				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLost",
							signalsLost: 1,
							expectedSequenceNumber: 1,
							clientBroadcastSignalSequenceNumber: 2,
						},
					],
					"SignalLost telemetry should be logged when signal is dropped",
					/* inlineDetailsProp = */ true,
				);

				dropSignals(2);
				processSubmittedSignals(1);

				// Missing 3rd and 4th signals should be detected
				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLost",
							signalsLost: 2,
							expectedSequenceNumber: 3,
							clientBroadcastSignalSequenceNumber: 5,
						},
					],
					"SignalLost telemetry should be logged when signal is dropped",
					/* inlineDetailsProp = */ true,
				);
			});

			it("ignores signals sent before disconnect and resets stats on reconnect", () => {
				// Define resubmit and setConnectionState on channel collection
				// This is needed to submit test data store ops
				stubChannelCollection(containerRuntime);

				sendSignals(4);

				// Submit op so message is queued in PendingStateManager
				// This is needed to increase reconnect count
				submitDataStoreOp(containerRuntime, "1", "test");

				// Disconnect + Reconnect
				changeConnectionState(containerRuntime, false, mockClientId);
				changeConnectionState(containerRuntime, true, mockClientId);

				// Temporarily lose two old signals
				dropSignals(2);

				// Receive old signals sent before disconnect
				processSubmittedSignals(2);

				// Receive old out of order signals
				processDroppedSignals(2);

				// No error events should be logged for signals sent before disconnect
				logger.assertMatchNone(
					[
						{
							eventName: "ContainerRuntime:SignalOutOfOrder",
						},
						{
							eventName: "ContainerRuntime:SignalLost",
						},
					],
					"SignalOutOfOrder/SignalLost telemetry should not be logged on reconnect",
				);

				sendSignals(100);
				processSubmittedSignals(100);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 97, // 101 (tracked latency signal) - 5 (earliest sent signal on reconnect) + 1 = 97
							lost: 0,
							outOfOrder: 0,
							reconnectCount: 1,
						},
					],
					"SignalLatency telemetry should be logged with correct reconnect count",
					/* inlineDetailsProp = */ true,
				);
			});

			it("ignores signals sent while disconnected and resets stats on reconnect", () => {
				// SETUP - define resubmit and setConnectionState on channel collection.
				// This is needed to submit test data store ops. Once defined, submit a test data store op
				// so that message is queued in PendingStateManager and reconnect count is increased.
				stubChannelCollection(containerRuntime);
				// Send and process an initial signal to prime the system.
				submitDataStoreOp(containerRuntime, "1", "test");
				sendSignals(1); // 1st signal (#1)
				processSubmittedSignals(1);

				// ACT - Disconnect client and send signals while disconnected.
				// Reconnect client and continue sending signals.
				changeConnectionState(containerRuntime, false, mockClientId);
				// Send and drop 150 signals (#2 to #151)
				sendSignals(150);
				dropSignals(150);
				changeConnectionState(containerRuntime, true, mockClientId);
				// Send and process 100 signals (#152 to #251)
				// This should include tracked latency signal (#251)
				sendSignals(100);
				processSubmittedSignals(100);

				// VERIFY - SignalLatency telemetry should be logged with correct reconnect count
				// No error events should be logged for signals sent before disconnect
				logger.assertMatchNone(
					[
						{
							eventName: "ContainerRuntime:SignalOutOfOrder",
						},
						{
							eventName: "ContainerRuntime:SignalLost",
						},
					],
					"SignalOutOfOrder/SignalLost telemetry should not be logged on reconnect",
					/* inlineDetailsProp = */ true,
					/* clearEventsAfterCheck = */ false,
				);
				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 50, // 201 (tracked latency signal) - 152 (earliest sent signal on reconnect) + 1 = 50
							lost: 0,
							outOfOrder: 0,
							reconnectCount: 1,
						},
					],
					"SignalLatency telemetry should be logged with correct reconnect count",
					/* inlineDetailsProp = */ true,
				);
			});

			it("counts both relative and absolute lost signal counts", () => {
				sendSignals(60);
				processSubmittedSignals(10);
				dropSignals(1);
				processSubmittedSignals(39);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLost",
							signalsLost: 1,
							expectedSequenceNumber: 11,
							clientBroadcastSignalSequenceNumber: 12,
						},
					],
					"SignalLost telemetry should log relative lost signal count when a signal is dropped",
					/* inlineDetailsProp = */ true,
				);

				dropSignals(5);
				sendSignals(45);
				processSubmittedSignals(30);
				dropSignals(4);

				// Process remaining signals
				processSubmittedSignals(16);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLost",
							signalsLost: 5,
							expectedSequenceNumber: 51,
							clientBroadcastSignalSequenceNumber: 56,
						},
						{
							eventName: "ContainerRuntime:SignalLost",
							signalsLost: 4,
							expectedSequenceNumber: 86,
							clientBroadcastSignalSequenceNumber: 90,
						},
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 100,
							lost: 10,
							outOfOrder: 0,
							reconnectCount: 0,
						},
					],
					"SignalLost telemetry should log relative lost signal count and SignalLatency telemetry should log absolute lost signal count for each batch of 100 signals",
					/* inlineDetailsProp = */ true,
				);
			});

			it("accurately reports amount of sent and lost signals with multiple SignalLatency events", () => {
				// Send 50 signals and drop 10
				sendSignals(50);
				dropSignals(10);
				processSubmittedSignals(40);

				// Send 60 signals and drop 10
				sendSignals(60);
				processSubmittedSignals(40);
				dropSignals(10);

				// Here we should detect that 100 signals have been sent and 20 signals were lost
				processSubmittedSignals(10);

				// Send 100 signals and drop 1
				sendSignals(100);
				dropSignals(1);

				// Here we should detect that 100 more signals have been sent and 1 signal was lost
				processSubmittedSignals(99);

				// Check SignalLatency logs amount of sent and lost signals
				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 101,
							lost: 20,
							outOfOrder: 0,
							reconnectCount: 0,
						},
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 100,
							lost: 1,
							outOfOrder: 0,
							reconnectCount: 0,
						},
					],
					"SignalLatency telemetry should log absolute lost signal count for each batch of 100 signals",
					/* inlineDetailsProp = */ true,
				);
			});

			it("accurately reports amount of sent and lost signals when roundtrip tracked signal is dropped", () => {
				// Send 50 signals and drop 10
				sendSignals(50);
				dropSignals(10);
				processSubmittedSignals(40);

				// Send 60 signals and drop 15 (including roundtrip tracked signal)
				sendSignals(60);
				processSubmittedSignals(40);
				dropSignals(15); // Drop roundtrip tracked signal

				// Since roundtrip signal is lost, we don't expect to see SignalLatency telemetry for the first 100 signals
				processSubmittedSignals(5);

				// Send 100 signals and drop 1
				sendSignals(100);
				dropSignals(1);

				// Here we should detect that 200 signals have been sent and 26 signals were lost
				processSubmittedSignals(99);

				// Check SignalLatency logs amount of sent and lost signals
				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 201,
							lost: 26,
							outOfOrder: 0,
							reconnectCount: 0,
						},
					],
					"SignalLatency telemetry should log absolute lost signal count for each batch of 100 signals",
					/* inlineDetailsProp = */ true,
				);
			});

			it("accurately reports amount of sent and lost signals when rapid fire more than 100+ signals", () => {
				sendSignals(1);
				processSubmittedSignals(1);
				sendSignals(101);
				dropSignals(10);
				processSubmittedSignals(91);

				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 100,
							lost: 10,
							outOfOrder: 0,
							reconnectCount: 0,
						},
					],
					"SignalLatency telemetry should log correct amount of sent and lost signals",
					/* inlineDetailsProp = */ true,
				);
			});

			it("should log out of order signal in between signal latency events", () => {
				// Send 1st signal and process it to prime the system
				sendSignals(1);
				processSubmittedSignals(1);

				// Send 150 signals and temporarily lose 1
				sendSignals(150); //           150 outstanding including 1 tracked signal (#101); max #151
				processSubmittedSignals(95); // 55 outstanding including 1 tracked signal (#101)
				dropSignals(1); //              54 outstanding including 1 tracked signal (#101)
				processSubmittedSignals(14); // 40 outstanding; none tracked
				processDroppedSignals(1); //    40 outstanding; none tracked *out of order signal*
				processSubmittedSignals(40); //  0 outstanding; none tracked

				// Send 60 signals including tracked signal
				sendSignals(60); //             60 outstanding including 1 tracked signal (#201); max #211
				processSubmittedSignals(60); //  0 outstanding; none tracked

				// Check SignalLatency logs amount of sent and lost signals
				logger.assertMatch(
					[
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 100,
							lost: 1,
							outOfOrder: 0,
							reconnectCount: 0,
						},
						{
							eventName: "ContainerRuntime:SignalOutOfOrder",
						},
						{
							eventName: "ContainerRuntime:SignalLatency",
							sent: 100,
							lost: 0,
							outOfOrder: 1,
							reconnectCount: 0,
						},
					],
					"SignalLatency telemetry should log absolute lost signal count for each batch of 100 signals and SignalOutOfOrder event",
					/* inlineDetailsProp = */ true,
				);
			});
			describe("multi-client", () => {
				let remoteContainerRuntime: ContainerRuntime;
				let remoteLogger: MockLogger;

				function sendRemoteSignals(count: number): void {
					for (let i = 0; i < count; i++) {
						remoteContainerRuntime.submitSignal(
							"TestSignalType",
							`TestSignalContent ${i + 1}`,
						);
					}
				}

				beforeEach(async () => {
					remoteLogger = new MockLogger();
					const runtimeOptions: IContainerRuntimeOptionsInternal = {
						enableGroupedBatching: false,
					};
					remoteContainerRuntime = await ContainerRuntime.loadRuntime({
						context: getMockContext(
							{ logger: remoteLogger },
							"remoteMockClientId",
						) as IContainerContext,
						registryEntries: [],
						existing: false,
						requestHandler: undefined,
						runtimeOptions,
						provideEntryPoint: mockProvideEntryPoint,
					});
					// Assert that clientId is not undefined
					assert(
						remoteContainerRuntime.clientId !== undefined,
						"clientId should not be undefined",
					);

					runtimes.set(remoteContainerRuntime.clientId, remoteContainerRuntime);
				});

				it("ignores remote targeted signal in signalLatency telemetry", () => {
					// Send 1st signal and process it to prime the system
					sendSignals(1);
					processSubmittedSignals(1);

					// Send 101 signals (one targeted)
					sendSignals(50); //             50 outstanding; none tracked;
					containerRuntime.submitSignal(
						"TargetedSignalType",
						"TargetedSignalContent",
						remoteContainerRuntime.clientId,
					); //                           51 outstanding; none tracked; one remote targeted

					sendSignals(49); //            100 outstanding including 1 tracked signals (#101); one targeted
					processSubmittedSignals(100); // 0 outstanding; none tracked

					// Check that remote targeted signal is ignored
					logger.assertMatchNone(
						[
							{
								eventName: "ContainerRuntime:SignalLatency",
								sent: 100,
								lost: 0,
								outOfOrder: 0,
								reconnectCount: 0,
							},
						],
						"SignalLatency telemetry should log correct amount of sent and lost signals",
						/* inlineDetailsProp = */ true,
					);
					sendSignals(1); //               1 outstanding including 1 tracked signals (#101); one targeted
					processSubmittedSignals(1); //   0 outstanding; none tracked

					// Check for logged SignalLatency event
					logger.assertMatch(
						[
							{
								eventName: "ContainerRuntime:SignalLatency",
								sent: 100,
								lost: 0,
								outOfOrder: 0,
								reconnectCount: 0,
							},
						],
						"SignalLatency telemetry should log correct amount of sent and lost signals",
						/* inlineDetailsProp = */ true,
					);

					// Repeat the same for remote runtime which recevied targeted signal
					sendRemoteSignals(1);
					processSubmittedSignals(1);

					sendRemoteSignals(99);
					processSubmittedSignals(99);

					remoteLogger.assertMatchNone(
						[
							{
								eventName: "ContainerRuntime:SignalLatency",
								sent: 100,
								lost: 0,
								outOfOrder: 0,
								reconnectCount: 0,
							},
						],
						"SignalLatency telemetry should log correct amount of sent and lost signals",
						/* inlineDetailsProp = */ true,
					);

					sendRemoteSignals(1);
					processSubmittedSignals(1);

					// Check for logged SignalLatency event
					remoteLogger.assertMatch(
						[
							{
								eventName: "ContainerRuntime:SignalLatency",
								sent: 100,
								lost: 0,
								outOfOrder: 0,
								reconnectCount: 0,
							},
						],
						"SignalLatency telemetry should log correct amount of sent and lost signals",
						/* inlineDetailsProp = */ true,
					);
				});
				it("can detect dropped signal while ignoring non-self targeted signal in signalLatency telemetry", () => {
					// Send 1st signal and process it to prime the system
					sendSignals(1);
					processSubmittedSignals(1);

					// Send 100 signals (one targeted) and drop 10
					sendSignals(40); //              40 outstanding; none tracked;
					containerRuntime.submitSignal(
						"TargetedSignalType",
						"TargetedSignalContent",
						remoteContainerRuntime.clientId,
					); //                            41 outstanding; none tracked; one remote targeted
					sendSignals(40); //              81 outstanding; none tracked; one remote targeted
					dropSignals(10); //              71 outstanding; none tracked; one remote targeted
					sendSignals(20); //              91 outstanding; none tracked; one remote targeted

					// Process all signals (5 out of order)
					processSubmittedSignals(85); //   6 outstanding; none tracked;
					processDroppedSignals(5); //      6 outstanding; none tracked; *out of order signals*
					processSubmittedSignals(6); //    0 outstanding; none tracked;

					// Check for logged SignalLatency event
					logger.assertMatch(
						[
							{
								eventName: "ContainerRuntime:SignalLatency",
								sent: 100,
								lost: 10,
								outOfOrder: 5,
								reconnectCount: 0,
							},
						],
						"SignalLatency telemetry should log correct amount of sent and lost signals",
						/* inlineDetailsProp = */ true,
					);
				});

				it("ignores unexpected targeted signal for a remote client", () => {
					// Send 1st signal and process it to prime the system
					sendSignals(1);
					processSubmittedSignals(1);

					// Send 101 signals (one targeted)
					sendSignals(50); //                50 outstanding; none tracked;
					containerRuntime.submitSignal(
						"TargetedSignalType",
						"TargetedSignalContent",
						remoteContainerRuntime.clientId,
					); //                              51 outstanding; none tracked; one remote targeted
					sendSignals(49); //               100 outstanding; none tracked; one remote targeted
					processWithNoTargetSupport(100); // 0 outstanding; none tracked

					// Check that 'targeted signal' is ignored
					logger.assertMatchNone(
						[
							{
								eventName: "ContainerRuntime:SignalLatency",
								sent: 100,
								lost: 0,
								outOfOrder: 0,
								reconnectCount: 0,
							},
						],
						"SignalLatency telemetry should log correct amount of sent and lost signals",
						/* inlineDetailsProp = */ true,
					);

					sendSignals(1); //             	     1 outstanding including 1 tracked signals (#101); one targeted

					processWithNoTargetSupport(1); //    0 outstanding; none tracked

					// Check for logged SignalLatency event
					logger.assertMatch(
						[
							{
								eventName: "ContainerRuntime:SignalLatency",
								sent: 100,
								lost: 0,
								outOfOrder: 0,
								reconnectCount: 0,
							},
						],
						"SignalLatency telemetry should log correct amount of sent and lost signals",
						/* inlineDetailsProp = */ true,
					);
				});
			});
			describe("Validate runtime options", () => {
				it("Throws when op compression is on and op grouping is off", async () => {
					await assert.rejects(
						async () =>
							ContainerRuntime.loadRuntime({
								context: getMockContext() as IContainerContext,
								registryEntries: [],
								existing: false,
								runtimeOptions: {
									enableGroupedBatching: false,
									compressionOptions: {
										compressionAlgorithm: CompressionAlgorithms.lz4,
										minimumBatchSizeInBytes: 1,
									},
								},
								provideEntryPoint: mockProvideEntryPoint,
							}),
						(error: IErrorBase) => {
							return (
								error.errorType === ContainerErrorTypes.usageError &&
								error.message === "If compression is enabled, op grouping must be enabled too"
							);
						},
						"Container should throw when op compression is on and op grouping is off",
					);
				});
			});
		});

		describe("Default Configurations", () => {
			it("minVersionForCollab not provided", async () => {
				const logger = new MockLogger();
				await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				});

				const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
					summaryOptions: {},
					gcOptions: {},
					loadSequenceNumberVerification: "close",
					flushMode: FlushMode.TurnBased,
					compressionOptions: {
						minimumBatchSizeInBytes: 614400,
						compressionAlgorithm: CompressionAlgorithms.lz4,
					},
					maxBatchSizeInBytes: 716800,
					chunkSizeInBytes: 204800,
					enableRuntimeIdCompressor: undefined,
					enableGroupedBatching: true,
					explicitSchemaControl: false,
				};

				logger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(expectedRuntimeOptions),
						minVersionForCollab: defaultMinVersionForCollab,
					},
				]);
			});

			// These are examples of minVersionForCollab inputs that are not valid.
			// minVersionForCollab should be at least 1.0.0 and less than or equal to
			// the current pkgVersion.
			const invalidVersions = ["0.50.0", "100.0.0"] as const;
			for (const version of invalidVersions) {
				it(`throws when minVersionForCollab = ${version}`, async () => {
					const logger = new MockLogger();
					await assert.rejects(async () => {
						await ContainerRuntime.loadRuntime({
							context: getMockContext({ logger }) as IContainerContext,
							registryEntries: [],
							existing: false,
							runtimeOptions: {},
							provideEntryPoint: mockProvideEntryPoint,
							// @ts-expect-error - Invalid version strings are not castable to MinimumVersionForCollab
							minVersionForCollab: version,
						});
					});
				});
			}

			it("minVersionForCollab = 1.0.0", async () => {
				const minVersionForCollab = "1.0.0";
				const logger = new MockLogger();
				await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
					minVersionForCollab,
				});

				const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
					summaryOptions: {},
					gcOptions: {},
					loadSequenceNumberVerification: "close",
					flushMode: FlushMode.Immediate,
					compressionOptions: {
						minimumBatchSizeInBytes: Number.POSITIVE_INFINITY,
						compressionAlgorithm: CompressionAlgorithms.lz4,
					},
					maxBatchSizeInBytes: 716800,
					chunkSizeInBytes: 204800,
					enableRuntimeIdCompressor: undefined,
					enableGroupedBatching: false,
					explicitSchemaControl: false,
				};

				logger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(expectedRuntimeOptions),
						minVersionForCollab,
					},
				]);
			});

			it('minVersionForCollab = 2.0.0-defaults ("default")', async () => {
				const minVersionForCollab = "2.0.0-defaults";
				const logger = new MockLogger();
				await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
					minVersionForCollab,
				});

				const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
					summaryOptions: {},
					gcOptions: {},
					loadSequenceNumberVerification: "close",
					flushMode: FlushMode.TurnBased,
					compressionOptions: {
						minimumBatchSizeInBytes: 614400,
						compressionAlgorithm: CompressionAlgorithms.lz4,
					},
					maxBatchSizeInBytes: 716800,
					chunkSizeInBytes: 204800,
					enableRuntimeIdCompressor: undefined,
					enableGroupedBatching: true,
					explicitSchemaControl: false,
				};

				logger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(expectedRuntimeOptions),
						minVersionForCollab: defaultMinVersionForCollab,
					},
				]);
			});

			it("minVersionForCollab = 2.0.0 (explicit)", async () => {
				const minVersionForCollab = "2.0.0";
				const logger = new MockLogger();
				await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
					minVersionForCollab,
				});

				const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
					summaryOptions: {},
					gcOptions: {},
					loadSequenceNumberVerification: "close",
					flushMode: FlushMode.TurnBased,
					compressionOptions: {
						minimumBatchSizeInBytes: 614400,
						compressionAlgorithm: CompressionAlgorithms.lz4,
					},
					maxBatchSizeInBytes: 716800,
					chunkSizeInBytes: 204800,
					enableRuntimeIdCompressor: undefined,
					enableGroupedBatching: true,
					explicitSchemaControl: true,
				};

				logger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(expectedRuntimeOptions),
						minVersionForCollab,
					},
				]);
			});

			it("minVersionForCollab = 2.20.0", async () => {
				const minVersionForCollab = "2.20.0";
				const logger = new MockLogger();
				await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					provideEntryPoint: mockProvideEntryPoint,
					minVersionForCollab,
				});

				const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
					summaryOptions: {},
					gcOptions: {},
					loadSequenceNumberVerification: "close",
					flushMode: FlushMode.TurnBased,
					compressionOptions: {
						minimumBatchSizeInBytes: 614400,
						compressionAlgorithm: CompressionAlgorithms.lz4,
					},
					maxBatchSizeInBytes: 716800,
					chunkSizeInBytes: 204800,
					enableRuntimeIdCompressor: undefined,
					enableGroupedBatching: true,
					explicitSchemaControl: true,
				};

				logger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(expectedRuntimeOptions),
						minVersionForCollab,
					},
				]);
			});

			it("minVersionForCollab not provided, with manual configs", async () => {
				const logger = new MockLogger();
				await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {
						summaryOptions: { initialSummarizerDelayMs: 1 },
						gcOptions: { enableGCSweep: true },
						loadSequenceNumberVerification: "bypass",
						flushMode: FlushMode.Immediate,
						maxBatchSizeInBytes: 100,
						chunkSizeInBytes: 200,
						enableRuntimeIdCompressor: "on",
						enableGroupedBatching: false, // By turning off batching, we will also disable compression automatically
					},
					provideEntryPoint: mockProvideEntryPoint,
				});

				const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
					summaryOptions: { initialSummarizerDelayMs: 1 },
					gcOptions: { enableGCSweep: true },
					loadSequenceNumberVerification: "bypass",
					flushMode: FlushMode.Immediate,
					compressionOptions: {
						minimumBatchSizeInBytes: Number.POSITIVE_INFINITY,
						compressionAlgorithm: CompressionAlgorithms.lz4,
					},
					maxBatchSizeInBytes: 100,
					chunkSizeInBytes: 200,
					enableRuntimeIdCompressor: "on",
					enableGroupedBatching: false,
					explicitSchemaControl: false,
				};

				logger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(expectedRuntimeOptions),
						minVersionForCollab: defaultMinVersionForCollab,
					},
				]);
			});

			for (const { desc, runtimeOptions } of [
				{ desc: "all options unspecified", runtimeOptions: {} },
				{
					// This case tests degenerate specification that is permissible
					// with exactOptionalPropertyTypes disabled. Even when enabled,
					// this should be tested in case callers violate exactness.
					// (use @ts-expect-error or `as` to ignore when needed)
					desc: "all options explicitly undefined",
					runtimeOptions: {
						summaryOptions: undefined,
						gcOptions: undefined,
						loadSequenceNumberVerification: undefined,
						flushMode: undefined,
						maxBatchSizeInBytes: undefined,
						chunkSizeInBytes: undefined,
						enableRuntimeIdCompressor: undefined,
						enableGroupedBatching: undefined,
						compressionOptions: undefined,
						explicitSchemaControl: undefined,
						createBlobPayloadPending: undefined,
					},
				},
			])
				it(desc, async () => {
					const logger = new MockLogger();
					await ContainerRuntime.loadRuntime({
						context: getMockContext({ logger }) as IContainerContext,
						registryEntries: [],
						existing: false,
						runtimeOptions,
						provideEntryPoint: mockProvideEntryPoint,
					});

					const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
						summaryOptions: {},
						gcOptions: {},
						loadSequenceNumberVerification: "close",
						flushMode: FlushMode.TurnBased,
						compressionOptions: {
							minimumBatchSizeInBytes: 614400,
							compressionAlgorithm: CompressionAlgorithms.lz4,
						},
						maxBatchSizeInBytes: 716800,
						chunkSizeInBytes: 204800,
						enableRuntimeIdCompressor: undefined, // idCompressor is undefined, since that represents a logical state (off)
						enableGroupedBatching: true,
						explicitSchemaControl: false,
					};

					logger.assertMatchAny([
						{
							eventName: "ContainerRuntime:ContainerLoadStats",
							category: "generic",
							options: JSON.stringify(expectedRuntimeOptions),
							minVersionForCollab: defaultMinVersionForCollab,
						},
					]);
				});

			// Note: We may need to update `expectedRuntimeOptions` for this test
			// when we bump to certain versions.
			it("minVersionForCollab = pkgVersion", async () => {
				const minVersionForCollab = pkgVersion;
				const logger = new MockLogger();
				await ContainerRuntime.loadRuntime({
					context: getMockContext({ logger }) as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
					minVersionForCollab,
				});

				const expectedRuntimeOptions: IContainerRuntimeOptionsInternal = {
					summaryOptions: {},
					gcOptions: {},
					loadSequenceNumberVerification: "close",
					flushMode: FlushMode.TurnBased,
					compressionOptions: {
						minimumBatchSizeInBytes: 614400,
						compressionAlgorithm: CompressionAlgorithms.lz4,
					},
					maxBatchSizeInBytes: 716800,
					chunkSizeInBytes: 204800,
					enableRuntimeIdCompressor: undefined,
					enableGroupedBatching: true,
					explicitSchemaControl: true,
				};

				logger.assertMatchAny([
					{
						eventName: "ContainerRuntime:ContainerLoadStats",
						category: "generic",
						options: JSON.stringify(expectedRuntimeOptions),
						minVersionForCollab,
					},
				]);
			});

			for (const runtimeOption of [
				{ enableGroupedBatching: true },
				{ enableGroupedBatching: true, compressionOptions: enabledCompressionConfig },
				{ explicitSchemaControl: true },
				{ gcOptions: { enableGCSweep: true } },
				// Adding in an arbitrary entry into the IGCRuntimeOptions object
				{ gcOptions: { enableGCSweep: true, sweepGracePeriodMs: 1 } },
				{ enableRuntimeIdCompressor: "on" },
				{ enableRuntimeIdCompressor: "delayed" },
				{ createBlobPayloadPending: true },
				{ flushMode: FlushMode.TurnBased },
			]) {
				it(`throws if minVersionForCollab is incompatible with runtimeOptions: ${JSON.stringify(runtimeOption)}`, async () => {
					const runtimeOptions = {
						...runtimeOption,
					} as unknown as IContainerRuntimeOptionsInternal;
					const logger = new MockLogger();
					const minVersionForCollab = "1.0.0";
					await assert.rejects(async () => {
						await ContainerRuntime.loadRuntime({
							context: getMockContext({ logger }) as IContainerContext,
							registryEntries: [],
							existing: false,
							runtimeOptions,
							provideEntryPoint: mockProvideEntryPoint,
							minVersionForCollab,
						});
					});
				});
			}
			it("does not throw if minVersionForCollab is not set and the default is incompatible with runtimeOptions", async () => {
				const logger = new MockLogger();
				await assert.doesNotReject(async () => {
					await ContainerRuntime.loadRuntime({
						context: getMockContext({ logger }) as IContainerContext,
						registryEntries: [],
						existing: false,
						// We would normally throw (since `createBlobPayloadPending` requires 2.40), but since we did
						// not explicity set minVersionForCollab, we allow it.
						runtimeOptions: { createBlobPayloadPending: true },
						provideEntryPoint: mockProvideEntryPoint,
					});
				});
			});
		});

		describe("Staging Mode", () => {
			let containerRuntime: ContainerRuntime_WithPrivates;

			beforeEach("init", async () => {
				containerRuntime = (await ContainerRuntime.loadRuntime({
					context: getMockContext() as IContainerContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				})) as unknown as ContainerRuntime_WithPrivates;
				submittedOps.length = 0; // reuse array defined higher in this file
			});

			afterEach("dispose", () => {
				containerRuntime.dispose();
				containerRuntime = undefined as unknown as ContainerRuntime_WithPrivates;
			});

			it("entering and exiting updates inStagingMode flag", () => {
				assert(
					containerRuntime.attachState === AttachState.Attached,
					"PRECONDITION: Expected Attached container",
				);
				const controls = containerRuntime.enterStagingMode();
				assert.equal(
					containerRuntime.inStagingMode,
					true,
					"Runtime should be in staging mode after entry",
				);

				controls.commitChanges();
				assert.equal(
					containerRuntime.inStagingMode,
					false,
					"Runtime should exit staging mode after commit",
				);

				// Enter / discard as a second exit-path
				containerRuntime.enterStagingMode().discardChanges();
				assert.equal(
					containerRuntime.inStagingMode,
					false,
					"Runtime should exit staging mode after discard",
				);
			});

			it("entering staging mode twice not allowed", () => {
				const controls = containerRuntime.enterStagingMode();
				assert.throws(
					() => containerRuntime.enterStagingMode(),
					(error: Error & IErrorBase) =>
						error.errorType === ContainerErrorTypes.usageError &&
						error.message === "Already in staging mode",
					"Should not allow entering staging mode while already in staging mode",
				);
				controls.discardChanges();
				// Now we can enter staging mode again
				containerRuntime.enterStagingMode();
				assert.equal(
					containerRuntime.inStagingMode,
					true,
					"Runtime should be in staging mode after re-entry",
				);
			});

			it("can enter staging mode while attaching", async () => {
				const mockContext = getMockContext({
					attachState: AttachState.Attaching,
				}) as IContainerContext;
				containerRuntime = (await ContainerRuntime.loadRuntime({
					context: mockContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				})) as unknown as ContainerRuntime_WithPrivates;

				assert.doesNotThrow(
					() => containerRuntime.enterStagingMode(),
					"Should allow entering staging mode while Attaching",
				);
			});

			it("cannot enter staging mode while detached", async () => {
				const mockContext = getMockContext({
					attachState: AttachState.Detached,
				}) as IContainerContext;
				containerRuntime = (await ContainerRuntime.loadRuntime({
					context: mockContext,
					registryEntries: [],
					existing: false,
					runtimeOptions: {},
					provideEntryPoint: mockProvideEntryPoint,
				})) as unknown as ContainerRuntime_WithPrivates;

				assert.throws(
					() => containerRuntime.enterStagingMode(),
					(error: Error & IErrorBase) =>
						error.errorType === ContainerErrorTypes.usageError &&
						error.message === "Cannot enter staging mode while Detached",
					"Should not allow entering staging mode while Detached",
				);
			});

			it("commitChanges submits staged ops", () => {
				const channelCollectionStub = stubChannelCollection(containerRuntime);

				// Won't be resubmitted when exiting staging mode
				submitDataStoreOp(containerRuntime, "1", "pre-staging", "LOCAL_OP_METADATA");

				const controls = containerRuntime.enterStagingMode();
				assert(
					channelCollectionStub.notifyStagingMode.calledOnceWithExactly(true),
					"Expected notifyStagingMode to be called with true",
				);

				// Entering staging mode triggers a flush, so we should see the pre-staging op sent,
				// but not the staged op (even with flush)
				assert.equal(submittedOps.length, 1, "Pre-staging op expected to be submitted");

				submitDataStoreOp(containerRuntime, "2", "staged-op", "LOCAL_OP_METADATA");
				containerRuntime.flush();
				assert.equal(submittedOps.length, 1, "Only expected the 1 pre-staging op");

				// default options: { squash: false }
				controls.commitChanges();

				assert(
					channelCollectionStub.reSubmit.calledOnce,
					"Expected reSubmit to be called once. Prestaging op should not be resubmitted",
				);
				assert(
					channelCollectionStub.reSubmit.calledWithExactly(
						"component",
						{ address: "2", contents: "staged-op" },
						"LOCAL_OP_METADATA",
						/* squash: */ false, // False by default on commitChanges
					),
					"Unexpected args for reSubmit",
				);
				assert(
					channelCollectionStub.notifyStagingMode.getCall(1)?.calledWithExactly(false),
					"Expected notifyStagingMode to be called with false on the second call",
				);

				assert.equal(
					submittedOps.length,
					2,
					"Staged op should be resubmitted after commitChanges",
				);
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				assert.equal(submittedOps[1].contents.address, "2", "Unexpected staged op address");
			});

			it("discardChanges drops staged ops", () => {
				const channelCollectionStub = stubChannelCollection(containerRuntime);

				// Won't be rolled back when exiting staging mode
				submitDataStoreOp(containerRuntime, "1", "pre-staging", "LOCAL_OP_METADATA");

				const controls = containerRuntime.enterStagingMode();

				// Entering staging mode triggers a flush, so we should see the pre-staging op sent,
				// but not the staged op (even with flush)
				assert.equal(submittedOps.length, 1, "Pre-staging op expected to be submitted");

				submitDataStoreOp(containerRuntime, "2", "staged-op", "LOCAL_OP_METADATA");
				submitDataStoreOp(containerRuntime, "3", "staged-op", "LOCAL_OP_METADATA");
				containerRuntime.flush();
				assert.equal(submittedOps.length, 1, "No more ops expected while staged");

				controls.discardChanges();

				assert.deepEqual(
					channelCollectionStub.rollback.getCalls().map((call) => call.args),
					[
						// LIFO order for rolling back
						["component", { address: "3", contents: "staged-op" }, "LOCAL_OP_METADATA"],
						["component", { address: "2", contents: "staged-op" }, "LOCAL_OP_METADATA"],
						// Doesn't rollback the op from before staging mode
					],
					"Unexpected args for rollback",
				);
				assert(
					channelCollectionStub.notifyStagingMode.getCall(1)?.calledWithExactly(false),
					"Expected notifyStagingMode to be called with false on the second call",
				);

				assert.equal(
					submittedOps.length,
					1, // From before staging mode
					"Staged op should NOT be submitted after discardChanges",
				);
			});

			it("discardChanges resets isDirty state", () => {
				stubChannelCollection(containerRuntime);

				const controls = containerRuntime.enterStagingMode();

				submitDataStoreOp(containerRuntime, "1", "staged-op", "LOCAL_OP_METADATA");
				submitDataStoreOp(containerRuntime, "2", "staged-op", "LOCAL_OP_METADATA");
				assert.equal(containerRuntime.isDirty, true, "Runtime should be dirty (from Outbox)");
				containerRuntime.flush();
				assert.equal(containerRuntime.isDirty, true, "Runtime should be dirty (from PSM)");

				controls.discardChanges();

				assert.equal(containerRuntime.isDirty, false, "Runtime should not be dirty anymore");
			});
		});
	});
});
