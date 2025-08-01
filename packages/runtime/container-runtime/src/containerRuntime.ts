/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type {
	ILayerCompatDetails,
	IProvideLayerCompatDetails,
} from "@fluid-internal/client-utils";
import { createEmitter, Trace, TypedEventEmitter } from "@fluid-internal/client-utils";
import type {
	IAudience,
	ISelf,
	ICriticalContainerError,
	IAudienceEvents,
} from "@fluidframework/container-definitions";
import { AttachState } from "@fluidframework/container-definitions";
import type {
	IContainerContext,
	IGetPendingLocalStateProps,
	IRuntime,
	IDeltaManager,
	IDeltaManagerFull,
	ILoader,
	IContainerStorageService,
} from "@fluidframework/container-definitions/internal";
import { isIDeltaManagerFull } from "@fluidframework/container-definitions/internal";
import type {
	ContainerExtensionFactory,
	ContainerExtensionId,
	ExtensionHost,
	ExtensionHostEvents,
	ExtensionRuntimeProperties,
	IContainerRuntime,
	IContainerRuntimeEvents,
	IContainerRuntimeInternal,
	// eslint-disable-next-line import/no-deprecated
	IContainerRuntimeWithResolveHandle_Deprecated,
	OutboundExtensionMessage,
	UnverifiedBrand,
} from "@fluidframework/container-runtime-definitions/internal";
import type {
	FluidObject,
	IFluidHandle,
	IRequest,
	IResponse,
	ITelemetryBaseLogger,
	Listenable,
} from "@fluidframework/core-interfaces";
import type {
	IFluidHandleContext,
	IFluidHandleInternal,
	IProvideFluidHandleContext,
	ISignalEnvelope,
	OpaqueJsonDeserialized,
	TypedMessage,
} from "@fluidframework/core-interfaces/internal";
import {
	assert,
	Deferred,
	Lazy,
	LazyPromise,
	PromiseCache,
	delay,
	fail,
	unreachableCase,
} from "@fluidframework/core-utils/internal";
import type {
	IClientDetails,
	IQuorumClients,
	ISummaryTree,
} from "@fluidframework/driver-definitions";
import { SummaryType } from "@fluidframework/driver-definitions";
import type {
	IDocumentMessage,
	ISequencedDocumentMessage,
	ISignalMessage,
	ISnapshot,
	ISnapshotTree,
	ISummaryContent,
	ISummaryContext,
} from "@fluidframework/driver-definitions/internal";
import { FetchSource, MessageType } from "@fluidframework/driver-definitions/internal";
import { readAndParse } from "@fluidframework/driver-utils/internal";
import type { IIdCompressor } from "@fluidframework/id-compressor";
import type {
	IIdCompressorCore,
	IdCreationRange,
	SerializedIdCompressorWithNoSession,
	SerializedIdCompressorWithOngoingSession,
} from "@fluidframework/id-compressor/internal";
import {
	createIdCompressor,
	createSessionId,
	deserializeIdCompressor,
} from "@fluidframework/id-compressor/internal";
import type {
	ISummaryTreeWithStats,
	ITelemetryContext,
	IGarbageCollectionData,
	CreateChildSummarizerNodeParam,
	IDataStore,
	IEnvelope,
	IFluidDataStoreContextDetached,
	IFluidDataStoreRegistry,
	ISummarizeInternalResult,
	InboundAttachMessage,
	NamedFluidDataStoreRegistryEntries,
	SummarizeInternalFn,
	IInboundSignalMessage,
	IRuntimeMessagesContent,
	ISummarizerNodeWithGC,
	// eslint-disable-next-line import/no-deprecated
	StageControlsExperimental,
	// eslint-disable-next-line import/no-deprecated
	IContainerRuntimeBaseExperimental,
	IFluidParentContext,
} from "@fluidframework/runtime-definitions/internal";
import {
	FlushMode,
	FlushModeExperimental,
	channelsTreeName,
	gcTreeKey,
	type MinimumVersionForCollab,
} from "@fluidframework/runtime-definitions/internal";
import {
	defaultMinVersionForCollab,
	isValidMinVersionForCollab,
	type SemanticVersion,
} from "@fluidframework/runtime-utils/internal";
import {
	GCDataBuilder,
	RequestParser,
	RuntimeHeaders,
	TelemetryContext,
	addBlobToSummary,
	addSummarizeResultToSummary,
	calculateStats,
	create404Response,
	exceptionToResponse,
	seqFromTree,
} from "@fluidframework/runtime-utils/internal";
import type {
	IEventSampler,
	IFluidErrorBase,
	ITelemetryGenericEventExt,
	ITelemetryLoggerExt,
	MonitoringContext,
} from "@fluidframework/telemetry-utils/internal";
import {
	DataCorruptionError,
	DataProcessingError,
	extractSafePropertiesFromMessage,
	GenericError,
	LoggingError,
	PerformanceEvent,
	// eslint-disable-next-line import/no-deprecated
	TaggedLoggerAdapter,
	UsageError,
	createChildLogger,
	createChildMonitoringContext,
	createSampledLogger,
	loggerToMonitoringContext,
	raiseConnectedEvent,
	wrapError,
	tagCodeArtifacts,
	normalizeError,
} from "@fluidframework/telemetry-utils/internal";
import { gt } from "semver-ts";
import { v4 as uuid } from "uuid";

import { BindBatchTracker } from "./batchTracker.js";
import {
	BlobManager,
	IPendingBlobs,
	blobManagerBasePath,
	blobsTreeName,
	isBlobPath,
	loadBlobManagerLoadInfo,
	type IBlobManagerLoadInfo,
} from "./blobManager/index.js";
import {
	ChannelCollection,
	getSummaryForDatastores,
	wrapContext,
} from "./channelCollection.js";
import type { ICompressionRuntimeOptions } from "./compressionDefinitions.js";
import { CompressionAlgorithms, disabledCompressionConfig } from "./compressionDefinitions.js";
import { ReportOpPerfTelemetry } from "./connectionTelemetry.js";
import {
	getMinVersionForCollabDefaults,
	type RuntimeOptionsAffectingDocSchema,
	validateRuntimeOptions,
} from "./containerCompatibility.js";
import { ContainerFluidHandleContext } from "./containerHandleContext.js";
import { channelToDataStore } from "./dataStore.js";
import { FluidDataStoreRegistry } from "./dataStoreRegistry.js";
import {
	BaseDeltaManagerProxy,
	DeltaManagerPendingOpsProxy,
	DeltaManagerSummarizerProxy,
} from "./deltaManagerProxies.js";
import { DeltaScheduler } from "./deltaScheduler.js";
import {
	GCNodeType,
	GarbageCollector,
	IGCRuntimeOptions,
	IGCStats,
	IGarbageCollector,
	gcGenerationOptionName,
	type GarbageCollectionMessage,
	type IGarbageCollectionRuntime,
} from "./gc/index.js";
import { InboundBatchAggregator } from "./inboundBatchAggregator.js";
import {
	ContainerMessageType,
	type OutboundContainerRuntimeDocumentSchemaMessage,
	ContainerRuntimeGCMessage,
	type ContainerRuntimeIdAllocationMessage,
	type InboundSequencedContainerRuntimeMessage,
	type LocalContainerRuntimeMessage,
	type UnknownContainerRuntimeMessage,
} from "./messageTypes.js";
import { ISavedOpMetadata } from "./metadata.js";
import {
	LocalBatchMessage,
	BatchStartInfo,
	DuplicateBatchDetector,
	ensureContentsDeserialized,
	IBatchCheckpoint,
	OpCompressor,
	OpDecompressor,
	OpGroupingManager,
	OpSplitter,
	Outbox,
	RemoteMessageProcessor,
	type OutboundBatch,
	type BatchResubmitInfo,
} from "./opLifecycle/index.js";
import { pkgVersion } from "./packageVersion.js";
import {
	PendingMessageResubmitData,
	IPendingLocalState,
	PendingStateManager,
	type PendingBatchResubmitMetadata,
} from "./pendingStateManager.js";
import { BatchRunCounter, RunCounter } from "./runCounter.js";
import {
	runtimeCompatDetailsForLoader,
	validateLoaderCompatibility,
} from "./runtimeLayerCompatState.js";
import { SignalTelemetryManager } from "./signalTelemetryProcessing.js";
// These types are imported as types here because they are present in summaryDelayLoadedModule, which is loaded dynamically when required.
import type {
	IDocumentSchemaChangeMessageIncoming,
	IDocumentSchemaCurrent,
	Summarizer,
	IDocumentSchemaFeatures,
	EnqueueSummarizeResult,
	ISerializedElection,
	ISummarizeResults,
} from "./summary/index.js";
import {
	DocumentsSchemaController,
	IBaseSummarizeResult,
	IConnectableRuntime,
	IContainerRuntimeMetadata,
	ICreateContainerMetadata,
	IEnqueueSummarizeOptions,
	IGenerateSummaryTreeResult,
	IGeneratedSummaryStats,
	IOnDemandSummarizeOptions,
	IRefreshSummaryAckOptions,
	IRootSummarizerNodeWithGC,
	ISubmitSummaryOptions,
	ISummarizerInternalsProvider,
	ISummarizerRuntime,
	ISummaryMetadataMessage,
	IdCompressorMode,
	OrderedClientElection,
	RetriableSummaryError,
	SubmitSummaryResult,
	aliasBlobName,
	chunksBlobName,
	recentBatchInfoBlobName,
	createRootSummarizerNodeWithGC,
	electedSummarizerBlobName,
	extractSummaryMetadataMessage,
	idCompressorBlobName,
	metadataBlobName,
	rootHasIsolatedChannels,
	wrapSummaryInChannelsTree,
	formCreateSummarizerFn,
	summarizerRequestUrl,
	SummaryManager,
	SummarizerClientElection,
	SummaryCollection,
	OrderedClientCollection,
	validateSummaryHeuristicConfiguration,
	ISummaryConfiguration,
	DefaultSummaryConfiguration,
	isSummariesDisabled,
	summarizerClientType,
} from "./summary/index.js";
import { Throttler, formExponentialFn } from "./throttler.js";

/**
 * A {@link ContainerExtension}'s factory function as stored in extension map.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `any` required to allow typed factory to be assignable per ContainerExtension.processSignal
type ExtensionEntry = ContainerExtensionFactory<unknown, any, unknown[]> extends new (
	...args: any[]
) => infer T
	? T
	: never;

/**
 * Creates an error object to be thrown / passed to Container's close fn in case of an unknown message type.
 * The parameters are typed to support compile-time enforcement of handling all known types/behaviors
 *
 * @param unknownContainerRuntimeMessageType - Typed as something unexpected, to ensure all known types have been
 * handled before calling this function (e.g. in a switch statement).
 *
 * @param codePath - The code path where the unexpected message type was encountered.
 *
 * @param sequencedMessage - The sequenced message that contained the unexpected message type.
 *
 */
function getUnknownMessageTypeError(
	unknownContainerRuntimeMessageType: UnknownContainerRuntimeMessage["type"],
	codePath: string,
	sequencedMessage?: ISequencedDocumentMessage,
): IFluidErrorBase {
	return DataProcessingError.create(
		"Runtime message of unknown type",
		codePath,
		sequencedMessage,
		{
			messageDetails: {
				type: unknownContainerRuntimeMessageType,
			},
		},
	);
}

/**
 * @legacy
 * @alpha
 */
export interface ISummaryRuntimeOptions {
	/**
	 * Override summary configurations set by the server.
	 */
	summaryConfigOverrides?: ISummaryConfiguration;

	/**
	 * Delay before first attempt to spawn summarizing container.
	 *
	 * @deprecated Use {@link ISummaryRuntimeOptions.summaryConfigOverrides}'s
	 * {@link ISummaryBaseConfiguration.initialSummarizerDelayMs} instead.
	 */
	initialSummarizerDelayMs?: number;
}

/**
 * Full set of options for container runtime as "required".
 *
 * @remarks
 * {@link IContainerRuntimeOptions} is expected to be used by consumers.
 *
 * @privateRemarks If any new properties are added to this interface (or
 * {@link IContainerRuntimeOptionsInternal}), then we will also need to make
 * changes in {@link file://./containerCompatibility.ts}.
 * If the new property does not change the DocumentSchema, then it must be
 * explicity omitted from {@link RuntimeOptionsAffectingDocSchema}.
 * If it does change the DocumentSchema, then a corresponding entry must be
 * added to `runtimeOptionsAffectingDocSchemaConfigMap` with the appropriate
 * compat configuration info.
 * If neither of the above is done, then the build will fail to compile.
 *
 * @legacy
 * @alpha
 */
export interface ContainerRuntimeOptions {
	readonly summaryOptions: ISummaryRuntimeOptions;
	readonly gcOptions: IGCRuntimeOptions;
	/**
	 * Affects the behavior while loading the runtime when the data verification check which
	 * compares the DeltaManager sequence number (obtained from protocol in summary) to the
	 * runtime sequence number (obtained from runtime metadata in summary) finds a mismatch.
	 * 1. "close" (default) will close the container with an assertion.
	 * 2. "log" will log an error event to telemetry, but still continue to load.
	 * 3. "bypass" will skip the check entirely. This is not recommended.
	 */
	readonly loadSequenceNumberVerification: "close" | "log" | "bypass";

	/**
	 * Enables the runtime to compress ops. See {@link ICompressionRuntimeOptions}.
	 */
	readonly compressionOptions: ICompressionRuntimeOptions;
	/**
	 * If specified, when in FlushMode.TurnBased, if the size of the ops between JS turns exceeds this value,
	 * an error will be thrown and the container will close.
	 *
	 * If unspecified, the limit is 700Kb.
	 *
	 * 'Infinity' will disable any limit.
	 *
	 * @experimental This config should be driven by the connection with the service and will be moved in the future.
	 */
	readonly maxBatchSizeInBytes: number;
	/**
	 * If the op payload needs to be chunked in order to work around the maximum size of the batch, this value represents
	 * how large the individual chunks will be. This is only supported when compression is enabled. If after compression, the
	 * batch content size exceeds this value, it will be chunked into smaller ops of this exact size.
	 *
	 * This value is a trade-off between having many small chunks vs fewer larger chunks and by default, the runtime is configured to use
	 * 200 * 1024 = 204800 bytes. This default value ensures that no compressed payload's content is able to exceed {@link ContainerRuntimeOptions.maxBatchSizeInBytes}
	 * regardless of the overhead of an individual op.
	 *
	 * Any value of `chunkSizeInBytes` exceeding {@link ContainerRuntimeOptions.maxBatchSizeInBytes} will disable this feature, therefore if a compressed batch's content
	 * size exceeds {@link ContainerRuntimeOptions.maxBatchSizeInBytes} after compression, the container will close with an instance of `DataProcessingError` with
	 * the `BatchTooLarge` message.
	 */
	readonly chunkSizeInBytes: number;

	/**
	 * Enable the IdCompressor in the runtime.
	 * @experimental Not ready for use.
	 */
	readonly enableRuntimeIdCompressor: IdCompressorMode;

	/**
	 * If enabled, the runtime will group messages within a batch into a single
	 * message to be sent to the service.
	 * The grouping and ungrouping of such messages is handled by the "OpGroupingManager".
	 *
	 * By default, the feature is enabled. This feature can only be disabled when compression is also disabled.
	 * @deprecated  The ability to disable Grouped Batching is deprecated and will be removed in a future release. This feature is required for the proper functioning of the Fluid Framework.
	 */
	readonly enableGroupedBatching: boolean;

	/**
	 * When this property is set to true, it requires runtime to control is document schema properly through ops
	 * The benefit of this mode is that clients who do not understand schema will fail in predictable way, with predictable message,
	 * and will not attempt to limp along, which could cause data corruptions and crashes in random places.
	 * When this property is not set (or set to false), runtime operates in legacy mode, where new features (modifying document schema)
	 * are engaged as they become available, without giving legacy clients any chance to fail predictably.
	 */
	readonly explicitSchemaControl: boolean;

	/**
	 * Create blob handles with pending payloads when calling createBlob (default is `undefined` (disabled)).
	 * When enabled (`true`), createBlob will return a handle before the blob upload completes.
	 */
	readonly createBlobPayloadPending: true | undefined;
}

/**
 * Options for container runtime.
 *
 * @legacy
 * @alpha
 */
export type IContainerRuntimeOptions = Partial<ContainerRuntimeOptions>;

/**
 * Internal extension of {@link ContainerRuntimeOptions}
 *
 * @privateRemarks
 * These options are not available to consumers when creating a new container runtime,
 * but we do need to expose them for internal use, e.g. when configuring the container runtime
 * to ensure compatibility with older versions.
 *
 * This is defined as a fully required set of options as this package does not yet
 * use `exactOptionalPropertyTypes` and `Required<>` applied to optional type allowing
 * `undefined` like {@link IdCompressorMode} will exclude `undefined`.
 *
 * @internal
 */
export interface ContainerRuntimeOptionsInternal extends ContainerRuntimeOptions {
	/**
	 * Sets the flush mode for the runtime. In Immediate flush mode the runtime will immediately
	 * send all operations to the driver layer, while in TurnBased the operations will be buffered
	 * and then sent them as a single batch at the end of the turn.
	 * By default, flush mode is TurnBased.
	 */
	readonly flushMode: FlushMode;

	/**
	 * Allows Grouped Batching to be disabled by setting to false (default is true).
	 * In that case, batched messages will be sent individually (but still all at the same time).
	 */
	readonly enableGroupedBatching: boolean;
}

/**
 * Internal extension of {@link IContainerRuntimeOptions}
 *
 * @internal
 */
export type IContainerRuntimeOptionsInternal = Partial<ContainerRuntimeOptionsInternal>;

/**
 * Error responses when requesting a deleted object will have this header set to true
 * @internal
 */
export const DeletedResponseHeaderKey = "wasDeleted";
/**
 * Tombstone error responses will have this header set to true
 * @legacy
 * @alpha
 */
export const TombstoneResponseHeaderKey = "isTombstoned";
/**
 * Inactive error responses will have this header set to true
 * @legacy
 * @alpha
 *
 * @deprecated this header is deprecated and will be removed in the future. The functionality corresponding
 * to this was experimental and is no longer supported.
 */
export const InactiveResponseHeaderKey = "isInactive";

/**
 * The full set of parsed header data that may be found on Runtime requests
 * @internal
 */
export interface RuntimeHeaderData {
	wait?: boolean;
	viaHandle?: boolean;
	allowTombstone?: boolean;
}

/**
 * Default values for Runtime Headers
 */
export const defaultRuntimeHeaderData: Required<RuntimeHeaderData> = {
	wait: true,
	viaHandle: false,
	allowTombstone: false,
};

const defaultStagingCommitOptions = { squash: false };

/**
 * @deprecated
 * Untagged logger is unsupported going forward. There are old loaders with old ContainerContexts that only
 * have the untagged logger, so to accommodate that scenario the below interface is used. It can be removed once
 * its usage is removed from TaggedLoggerAdapter fallback.
 */
interface OldContainerContextWithLogger extends Omit<IContainerContext, "taggedLogger"> {
	logger: ITelemetryBaseLogger;
	taggedLogger: undefined;
}

/**
 * State saved when the container closes, to be given back to a newly
 * instantiated runtime in a new instance of the container, so it can load to the
 * same state
 */
export interface IPendingRuntimeState {
	/**
	 * Pending ops from PendingStateManager
	 */
	pending?: IPendingLocalState;
	/**
	 * Pending blobs from BlobManager
	 */
	pendingAttachmentBlobs?: IPendingBlobs;
	/**
	 * Pending idCompressor state
	 */
	pendingIdCompressorState?: SerializedIdCompressorWithOngoingSession;

	/**
	 * Time at which session expiry timer started.
	 */
	sessionExpiryTimerStarted?: number | undefined;
}

const maxConsecutiveReconnectsKey = "Fluid.ContainerRuntime.MaxConsecutiveReconnects";

// The actual limit is 1Mb (socket.io and Kafka limits)
// We can't estimate it fully, as we
// - do not know what properties relay service will add
// - we do not stringify final op, thus we do not know how much escaping will be added.
const defaultMaxBatchSizeInBytes = 700 * 1024;

const defaultChunkSizeInBytes = 204800;

/**
 * The default time to wait for pending ops to be processed during summarization
 */
export const defaultPendingOpsWaitTimeoutMs = 1000;
/**
 * The default time to delay a summarization retry attempt when there are pending ops
 */
export const defaultPendingOpsRetryDelayMs = 1000;

/**
 * Instead of refreshing from latest because we do not have 100% confidence in the state
 * of the current system, we should close the summarizer and let it recover.
 * This delay's goal is to prevent tight restart loops
 */
const defaultCloseSummarizerDelayMs = 5000; // 5 seconds

/**
 * Checks whether a message.type is one of the values in ContainerMessageType
 */
export function isUnpackedRuntimeMessage(message: ISequencedDocumentMessage): boolean {
	return (Object.values(ContainerMessageType) as string[]).includes(message.type);
}

/**
 * Legacy ID for the built-in AgentScheduler.  To minimize disruption while removing it, retaining this as a
 * special-case for document dirty state.  Ultimately we should have no special-cases from the
 * ContainerRuntime's perspective.
 * @internal
 */
export const agentSchedulerId = "_scheduler";

// safely check navigator and get the hardware spec value
export function getDeviceSpec(): {
	deviceMemory?: number | undefined;
	hardwareConcurrency?: number | undefined;
} {
	try {
		if (typeof navigator === "object" && navigator !== null) {
			return {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
				deviceMemory: (navigator as any).deviceMemory,
				hardwareConcurrency: navigator.hardwareConcurrency,
			};
		}
	} catch {
		// Eat the error
	}
	return {};
}

/**
 * Older loader doesn't have a submitBatchFn member, this is the older way of submitting a batch.
 * Rather than exposing the submitFn (now deprecated) and IDeltaManager (dangerous to hand out) to the Outbox,
 * we can provide a partially-applied function to keep those items private to the ContainerRuntime.
 */
export const makeLegacySendBatchFn =
	(
		submitFn: (
			type: MessageType,
			contents: unknown,
			batch: boolean,
			appData?: unknown,
		) => number,
		deltaManager: Pick<IDeltaManager<unknown, unknown>, "flush">,
	) =>
	(batch: OutboundBatch): number => {
		// Default to negative one to match Container.submitBatch behavior
		let clientSequenceNumber: number = -1;
		for (const message of batch.messages) {
			clientSequenceNumber = submitFn(
				MessageType.Operation,
				// For back-compat (submitFn only works on deserialized content)
				message.contents === undefined ? undefined : JSON.parse(message.contents),
				true, // batch
				message.metadata,
			);
		}

		deltaManager.flush();

		return clientSequenceNumber;
	};

/**
 * Extract last message from the snapshot metadata.
 * Uses legacy property if not using explicit schema control, otherwise uses the new property.
 * This allows new runtime to make documents not openable for old runtimes, one explicit document schema control is enabled.
 * Please see addMetadataToSummary() as well
 */
function lastMessageFromMetadata(
	metadata: IContainerRuntimeMetadata | undefined,
): ISummaryMetadataMessage | undefined {
	return metadata?.documentSchema?.runtime?.explicitSchemaControl
		? metadata?.lastMessage
		: metadata?.message;
}

/**
 * There is some ancient back-compat code that we'd like to instrument
 * to understand if/when it is hit.
 * We only want to log this once, to avoid spamming telemetry if we are wrong and these cases are hit commonly.
 */
export let getSingleUseLegacyLogCallback = (logger: ITelemetryLoggerExt, type: string) => {
	return (codePath: string): void => {
		logger.sendTelemetryEvent({
			eventName: "LegacyMessageFormat",
			details: { codePath, type },
		});

		// Now that we've logged, prevent future logging (globally).
		// eslint-disable-next-line unicorn/consistent-function-scoping
		getSingleUseLegacyLogCallback = () => () => {};
	};
};

/**
 * A {@link TypedMessage} that has unknown content explicitly
 * noted as deserialized JSON.
 */
export interface UnknownIncomingTypedMessage extends TypedMessage {
	content: OpaqueJsonDeserialized<unknown>;
}

/**
 * Does nothing helper to apply unverified branding to a value.
 */
function markUnverified<const T>(value: T): T & UnverifiedBrand<T> {
	return value as T & UnverifiedBrand<T>;
}

type UnsequencedSignalEnvelope = Omit<ISignalEnvelope, "clientBroadcastSignalSequenceNumber">;

/**
 * This object holds the parameters necessary for the {@link loadContainerRuntime} function.
 * @legacy
 * @alpha
 */
export interface LoadContainerRuntimeParams {
	/**
	 * Context of the container.
	 */
	context: IContainerContext;
	/**
	 * Mapping from data store types to their corresponding factories
	 */
	registryEntries: NamedFluidDataStoreRegistryEntries;
	/**
	 * Pass 'true' if loading from an existing snapshot.
	 */
	existing: boolean;
	/**
	 * Additional options to be passed to the runtime
	 */
	runtimeOptions?: IContainerRuntimeOptions;
	/**
	 * runtime services provided with context
	 */
	containerScope?: FluidObject;
	/**
	 * Promise that resolves to an object which will act as entryPoint for the Container.
	 */
	provideEntryPoint: (containerRuntime: IContainerRuntime) => Promise<FluidObject>;

	/**
	 * Request handler for the request() method of the container runtime.
	 * Only relevant for back-compat while we remove the request() method and move fully to entryPoint as the main pattern.
	 * @deprecated Will be removed once Loader LTS version is "2.0.0-internal.7.0.0". Migrate all usage of IFluidRouter to the "entryPoint" pattern. Refer to Removing-IFluidRouter.md
	 * */
	requestHandler?: (request: IRequest, runtime: IContainerRuntime) => Promise<IResponse>;

	/**
	 * Minimum version of the FF runtime that is required to collaborate on new documents.
	 * The input should be a string that represents the minimum version of the FF runtime that should be
	 * supported for collaboration. The format of the string must be in valid semver format.
	 *
	 * The inputted version will be used to determine the default configuration for
	 * {@link IContainerRuntimeOptionsInternal} to ensure compatibility with the specified version.
	 *
	 * @example
	 * minVersionForCollab: "2.0.0"
	 *
	 * @privateRemarks
	 * Used to determine the default configuration for {@link IContainerRuntimeOptionsInternal} that affect the document schema.
	 * For example, let's say that feature `foo` was added in 2.0 which introduces a new op type. Additionally, option `bar`
	 * was added to `IContainerRuntimeOptionsInternal` in 2.0 to enable/disable `foo` since clients prior to 2.0 would not
	 * understand the new op type. If a customer were to set minVersionForCollab to 2.0.0, then `bar` would be set to
	 * enable `foo` by default. If a customer were to set minVersionForCollab to 1.0.0, then `bar` would be set to
	 * disable `foo` by default.
	 */
	minVersionForCollab?: MinimumVersionForCollab;
}
/**
 * This is meant to be used by a {@link @fluidframework/container-definitions#IRuntimeFactory} to instantiate a container runtime.
 * @param params - An object which specifies all required and optional params necessary to instantiate a runtime.
 * @returns A runtime which provides all the functionality necessary to bind with the loader layer via the {@link @fluidframework/container-definitions#IRuntime} interface and provide a runtime environment via the {@link @fluidframework/container-runtime-definitions#IContainerRuntime} interface.
 * @legacy
 * @alpha
 */
export async function loadContainerRuntime(
	params: LoadContainerRuntimeParams,
): Promise<IContainerRuntime & IRuntime> {
	return ContainerRuntime.loadRuntime(params);
}

const defaultMaxConsecutiveReconnects = 7;

/**
 * These are the ONLY message types that are allowed to be submitted while in staging mode
 * (Does not apply to pre-StagingMode batches that are resubmitted, those are not considered to be staged)
 */
function canStageMessageOfType(
	type: LocalContainerRuntimeMessage["type"],
): type is
	| ContainerMessageType.FluidDataStoreOp
	| ContainerMessageType.GC
	| ContainerMessageType.DocumentSchemaChange {
	return (
		// These are user changes coming up from the runtime's DataStores
		type === ContainerMessageType.FluidDataStoreOp ||
		// GC ops are used to detect issues in the reference graph so all clients can repair their GC state.
		// These can be submitted at any time, including while in Staging Mode.
		type === ContainerMessageType.GC ||
		// These are typically sent shortly after boot and will not be common in Staging Mode, but it's possible.
		type === ContainerMessageType.DocumentSchemaChange
	);
}

/**
 * Represents the runtime of the container. Contains helper functions/state of the container.
 * It will define the store level mappings.
 *
 * @internal
 */
export class ContainerRuntime
	extends TypedEventEmitter<IContainerRuntimeEvents>
	implements
		IContainerRuntimeInternal,
		// eslint-disable-next-line import/no-deprecated
		IContainerRuntimeBaseExperimental,
		// eslint-disable-next-line import/no-deprecated
		IContainerRuntimeWithResolveHandle_Deprecated,
		IRuntime,
		IGarbageCollectionRuntime,
		ISummarizerRuntime,
		ISummarizerInternalsProvider,
		IFluidParentContext,
		IProvideFluidHandleContext,
		IProvideLayerCompatDetails
{
	/**
	 * Load the stores from a snapshot and returns the runtime.
	 * @param params - An object housing the runtime properties:
	 * - context - Context of the container.
	 * - registryEntries - Mapping from data store types to their corresponding factories.
	 * - existing - Pass 'true' if loading from an existing snapshot.
	 * - requestHandler - (optional) Request handler for the request() method of the container runtime.
	 * Only relevant for back-compat while we remove the request() method and move fully to entryPoint as the main pattern.
	 * - runtimeOptions - Additional options to be passed to the runtime
	 * - containerScope - runtime services provided with context
	 * - containerRuntimeCtor - Constructor to use to create the ContainerRuntime instance.
	 * This allows mixin classes to leverage this method to define their own async initializer.
	 * - provideEntryPoint - Promise that resolves to an object which will act as entryPoint for the Container.
	 * - minVersionForCollab - Minimum version of the FF runtime that this runtime supports collaboration with.
	 * This object should provide all the functionality that the Container is expected to provide to the loader layer.
	 */
	public static async loadRuntime(params: {
		context: IContainerContext;
		registryEntries: NamedFluidDataStoreRegistryEntries;
		existing: boolean;
		runtimeOptions?: IContainerRuntimeOptionsInternal;
		containerScope?: FluidObject;
		containerRuntimeCtor?: typeof ContainerRuntime;
		/**
		 * @deprecated Will be removed once Loader LTS version is "2.0.0-internal.7.0.0". Migrate all usage of IFluidRouter to the "entryPoint" pattern. Refer to Removing-IFluidRouter.md
		 */
		requestHandler?: (request: IRequest, runtime: IContainerRuntime) => Promise<IResponse>;
		provideEntryPoint: (containerRuntime: IContainerRuntime) => Promise<FluidObject>;
		minVersionForCollab?: MinimumVersionForCollab;
	}): Promise<ContainerRuntime> {
		const {
			context,
			registryEntries,
			existing,
			requestHandler,
			provideEntryPoint,
			runtimeOptions = {} satisfies IContainerRuntimeOptionsInternal,
			containerScope = {},
			containerRuntimeCtor = ContainerRuntime,
			minVersionForCollab = defaultMinVersionForCollab,
		} = params;

		// If taggedLogger exists, use it. Otherwise, wrap the vanilla logger:
		// back-compat: Remove the TaggedLoggerAdapter fallback once all the host are using loader > 0.45
		const backCompatContext: IContainerContext | OldContainerContextWithLogger = context;
		const passLogger =
			backCompatContext.taggedLogger ??
			// eslint-disable-next-line import/no-deprecated
			new TaggedLoggerAdapter((backCompatContext as OldContainerContextWithLogger).logger);
		const logger = createChildLogger({
			logger: passLogger,
			properties: {
				all: {
					runtimeVersion: pkgVersion,
				},
			},
		});

		const mc = loggerToMonitoringContext(logger);

		// Some options require a minimum version of the FF runtime to operate, so the default configs will be generated
		// based on the minVersionForCollab.
		// For example, if minVersionForCollab is set to "1.0.0", the default configs will ensure compatibility with FF runtime
		// 1.0.0 or later. If the minVersionForCollab is set to "2.10.0", the default values will be generated to ensure compatibility
		// with FF runtime 2.10.0 or later.
		if (!isValidMinVersionForCollab(minVersionForCollab)) {
			throw new UsageError(
				`Invalid minVersionForCollab: ${minVersionForCollab}. It must be an existing FF version (i.e. 2.22.1).`,
			);
		}
		// We also validate that there is not a mismatch between `minVersionForCollab` and runtime options that
		// were manually set.
		validateRuntimeOptions(minVersionForCollab, runtimeOptions);

		const defaultsAffectingDocSchema = getMinVersionForCollabDefaults(minVersionForCollab);

		// The following are the default values for the options that do not affect the DocumentSchema.
		const defaultsNotAffectingDocSchema: Omit<
			ContainerRuntimeOptionsInternal,
			keyof RuntimeOptionsAffectingDocSchema
		> = {
			summaryOptions: {},
			loadSequenceNumberVerification: "close",
			maxBatchSizeInBytes: defaultMaxBatchSizeInBytes,
			chunkSizeInBytes: defaultChunkSizeInBytes,
		};

		const defaultConfigs = {
			...defaultsAffectingDocSchema,
			...defaultsNotAffectingDocSchema,
		};

		// Here we set each option to its corresponding default config value if it's not provided in runtimeOptions.
		// Note: We cannot do a simple object merge of defaultConfigs/runtimeOptions because in most cases we don't want
		// a option that is undefined in runtimeOptions to override the default value (except for idCompressor, see below).
		const {
			summaryOptions = defaultConfigs.summaryOptions,
			gcOptions = defaultConfigs.gcOptions,
			loadSequenceNumberVerification = defaultConfigs.loadSequenceNumberVerification,
			maxBatchSizeInBytes = defaultConfigs.maxBatchSizeInBytes,
			chunkSizeInBytes = defaultConfigs.chunkSizeInBytes,
			explicitSchemaControl = defaultConfigs.explicitSchemaControl,
			enableGroupedBatching = defaultConfigs.enableGroupedBatching,
			flushMode = defaultConfigs.flushMode,
			// If batching is disabled then we should disable compression as well. If batching is disabled and compression
			// is enabled via runtimeOptions, we will throw an error later.
			compressionOptions = enableGroupedBatching === false
				? disabledCompressionConfig
				: defaultConfigs.compressionOptions,
			createBlobPayloadPending = defaultConfigs.createBlobPayloadPending,
		}: IContainerRuntimeOptionsInternal = runtimeOptions;

		// The logic for enableRuntimeIdCompressor is a bit different. Since `undefined` represents a logical state (off)
		// we need to check it's explicitly set in runtimeOptions. If so, we should use that value even if it's undefined.
		const enableRuntimeIdCompressor =
			"enableRuntimeIdCompressor" in runtimeOptions
				? runtimeOptions.enableRuntimeIdCompressor
				: defaultConfigs.enableRuntimeIdCompressor;

		const registry = new FluidDataStoreRegistry(registryEntries);

		const tryFetchBlob = async <T>(blobName: string): Promise<T | undefined> => {
			const blobId = context.baseSnapshot?.blobs[blobName];
			if (context.baseSnapshot && blobId) {
				// IContainerContext storage api return type still has undefined in 0.39 package version.
				// So once we release 0.40 container-defn package we can remove this check.
				assert(
					context.storage !== undefined,
					0x1f5 /* "Attached state should have storage" */,
				);
				return readAndParse<T>(context.storage, blobId);
			}
		};

		const [
			chunks,
			recentBatchInfo,
			metadata,
			electedSummarizerData,
			aliases,
			serializedIdCompressor,
		] = await Promise.all([
			tryFetchBlob<[string, string[]][]>(chunksBlobName),
			tryFetchBlob<ReturnType<DuplicateBatchDetector["getRecentBatchInfoForSummary"]>>(
				recentBatchInfoBlobName,
			),

			tryFetchBlob<IContainerRuntimeMetadata>(metadataBlobName),

			tryFetchBlob<ISerializedElection>(electedSummarizerBlobName),
			tryFetchBlob<[string, string][]>(aliasBlobName),
			tryFetchBlob<SerializedIdCompressorWithNoSession>(idCompressorBlobName),
		]);

		// read snapshot blobs needed for BlobManager to load
		const blobManagerLoadInfo = await loadBlobManagerLoadInfo(context);

		const messageAtLastSummary = lastMessageFromMetadata(metadata);

		// Verify summary runtime sequence number matches protocol sequence number.
		const runtimeSequenceNumber = messageAtLastSummary?.sequenceNumber;
		const protocolSequenceNumber = context.deltaManager.initialSequenceNumber;
		// When we load with pending state, we reuse an old snapshot so we don't expect these numbers to match
		if (!context.pendingLocalState && runtimeSequenceNumber !== undefined) {
			// Unless bypass is explicitly set, then take action when sequence numbers mismatch.
			// eslint-disable-next-line unicorn/no-lonely-if -- Separate if statements make flow easier to parse
			if (
				loadSequenceNumberVerification !== "bypass" &&
				runtimeSequenceNumber !== protocolSequenceNumber
			) {
				// Message to OCEs:
				// You can hit this error with runtimeSequenceNumber === -1 in < 2.0 RC3 builds.
				// This would indicate that explicit schema control is enabled in current (2.0 RC3+) builds and it
				// results in addMetadataToSummary() creating a poison pill for older runtimes in the form of a -1 sequence number.
				// Older runtimes do not understand new schema, and thus could corrupt document if they proceed, thus we are using
				// this poison pill to prevent them from proceeding.

				// "Load from summary, runtime metadata sequenceNumber !== initialSequenceNumber"
				const error = new DataCorruptionError(
					// pre-0.58 error message: SummaryMetadataMismatch
					"Summary metadata mismatch",
					{ runtimeVersion: pkgVersion, runtimeSequenceNumber, protocolSequenceNumber },
				);

				if (loadSequenceNumberVerification === "log") {
					logger.sendErrorEvent({ eventName: "SequenceNumberMismatch" }, error);
				} else {
					context.closeFn(error);
				}
			}
		}

		let desiredIdCompressorMode: IdCompressorMode;
		switch (mc.config.getBoolean("Fluid.ContainerRuntime.IdCompressorEnabled")) {
			case true: {
				desiredIdCompressorMode = "on";
				break;
			}
			case false: {
				desiredIdCompressorMode = undefined;
				break;
			}
			default: {
				desiredIdCompressorMode = enableRuntimeIdCompressor;
				break;
			}
		}

		// Enabling the IdCompressor is a one-way operation and we only want to
		// allow new containers to turn it on.
		let idCompressorMode: IdCompressorMode;
		if (existing) {
			// This setting has to be sticky for correctness:
			// 1) if compressior is OFF, it can't be enabled, as already running clients (in given document session) do not know
			//    how to process compressor ops
			// 2) if it's ON, then all sessions should load compressor right away
			// 3) Same logic applies for "delayed" mode
			// Maybe in the future we will need to enabled (and figure how to do it safely) "delayed" -> "on" change.
			// We could do "off" -> "on" transition too, if all clients start loading compressor (but not using it initially) and
			// do so for a while - this will allow clients to eventually disregard "off" setting (when it's safe so) and start
			// using compressor in future sessions.
			// Everyting is possible, but it needs to be designed and executed carefully, when such need arises.
			idCompressorMode = metadata?.documentSchema?.runtime
				?.idCompressorMode as IdCompressorMode;

			// This is the only exception to the rule above - we have proper plumbing to load ID compressor on schema change
			// event. It is loaded async (relative to op processing), so this conversion is only safe for off -> delayed conversion!
			// Clients do not expect ID compressor ops unless ID compressor is On for them, and that could be achieved only through
			// explicit schema change, i.e. only if explicitSchemaControl is on.
			// Note: it would be better if we throw on combination of options (explicitSchemaControl = off, desiredIdCompressorMode === "delayed")
			// that is not supported. But our service tests are oblivious to these problems and throwing here will cause a ton of failures
			// We ignored incompatible ID compressor changes from the start (they were sticky), so that's not a new problem being introduced...
			if (
				idCompressorMode === undefined &&
				desiredIdCompressorMode === "delayed" &&
				explicitSchemaControl
			) {
				idCompressorMode = desiredIdCompressorMode;
			}
		} else {
			idCompressorMode = desiredIdCompressorMode;
		}

		const createIdCompressorFn = (): IIdCompressor & IIdCompressorCore => {
			/**
			 * Because the IdCompressor emits so much telemetry, this function is used to sample
			 * approximately 5% of all clients. Only the given percentage of sessions will emit telemetry.
			 */
			const idCompressorEventSampler: IEventSampler = (() => {
				const isIdCompressorTelemetryEnabled = Math.random() < 0.05;
				return {
					sample: () => {
						return isIdCompressorTelemetryEnabled;
					},
				};
			})();

			const compressorLogger = createSampledLogger(logger, idCompressorEventSampler);
			const pendingLocalState = context.pendingLocalState as IPendingRuntimeState;

			if (pendingLocalState?.pendingIdCompressorState !== undefined) {
				return deserializeIdCompressor(
					pendingLocalState.pendingIdCompressorState,
					compressorLogger,
				);
			} else if (serializedIdCompressor === undefined) {
				return createIdCompressor(compressorLogger);
			} else {
				return deserializeIdCompressor(
					serializedIdCompressor,
					createSessionId(),
					compressorLogger,
				);
			}
		};

		const compressionLz4 =
			compressionOptions.minimumBatchSizeInBytes !== Number.POSITIVE_INFINITY &&
			compressionOptions.compressionAlgorithm === "lz4";

		const documentSchemaController = new DocumentsSchemaController(
			existing,
			protocolSequenceNumber,
			metadata?.documentSchema,
			{
				explicitSchemaControl,
				compressionLz4,
				idCompressorMode,
				opGroupingEnabled: enableGroupedBatching,
				createBlobPayloadPending,
				disallowedVersions: [],
			},
			(schema) => {
				runtime.onSchemaChange(schema);
			},
			{ minVersionForCollab },
			logger,
		);

		// If the minVersionForCollab for this client is greater than the existing one, we should use that one going forward.
		const existingMinVersionForCollab =
			documentSchemaController.sessionSchema.info.minVersionForCollab;
		const updatedMinVersionForCollab =
			existingMinVersionForCollab === undefined ||
			gt(minVersionForCollab, existingMinVersionForCollab)
				? minVersionForCollab
				: existingMinVersionForCollab;

		if (compressionLz4 && !enableGroupedBatching) {
			throw new UsageError("If compression is enabled, op grouping must be enabled too");
		}

		const featureGatesForTelemetry: Record<string, boolean | number | undefined> = {};

		// Make sure we've got all the options including internal ones
		const internalRuntimeOptions: Readonly<ContainerRuntimeOptionsInternal> = {
			summaryOptions,
			gcOptions,
			loadSequenceNumberVerification,
			flushMode,
			compressionOptions,
			maxBatchSizeInBytes,
			chunkSizeInBytes,
			enableRuntimeIdCompressor,
			enableGroupedBatching,
			explicitSchemaControl,
			createBlobPayloadPending,
		};

		const runtime = new containerRuntimeCtor(
			context,
			registry,
			metadata,
			electedSummarizerData,
			chunks ?? [],
			aliases ?? [],
			internalRuntimeOptions,
			containerScope,
			logger,
			existing,
			blobManagerLoadInfo,
			context.storage,
			createIdCompressorFn,
			documentSchemaController,
			featureGatesForTelemetry,
			provideEntryPoint,
			updatedMinVersionForCollab,
			requestHandler,
			undefined, // summaryConfiguration
			recentBatchInfo,
		);

		// Initialize the base state of the runtime before it's returned.
		await runtime.initializeBaseState(context.loader);

		// Apply stashed ops with a reference sequence number equal to the sequence number of the snapshot,
		// or zero. This must be done before Container replays saved ops.
		await runtime.pendingStateManager.applyStashedOpsAt(runtimeSequenceNumber ?? 0);

		return runtime;
	}

	public readonly options: Record<string | number, unknown>;

	private readonly _getClientId: () => string | undefined;
	public get clientId(): string | undefined {
		return this._getClientId();
	}

	public readonly clientDetails: IClientDetails;

	private readonly isSummarizerClient: boolean;

	public get storage(): IContainerStorageService {
		return this._storage;
	}

	public get containerRuntime(): ContainerRuntime {
		return this;
	}

	private readonly submitSummaryFn: (
		summaryOp: ISummaryContent,
		referenceSequenceNumber?: number,
	) => number;
	private readonly submitSignalFn: (
		content: UnsequencedSignalEnvelope,
		targetClientId?: string,
	) => void;
	public readonly disposeFn: (error?: ICriticalContainerError) => void;
	public readonly closeFn: (error?: ICriticalContainerError) => void;

	public get flushMode(): FlushMode {
		return this._flushMode;
	}

	public get scope(): FluidObject {
		return this.containerScope;
	}

	public get IFluidDataStoreRegistry(): IFluidDataStoreRegistry {
		return this.registry;
	}

	private readonly _getAttachState: () => AttachState;
	public get attachState(): AttachState {
		return this._getAttachState();
	}

	public readonly isReadOnly = (): boolean => this.deltaManager.readOnlyInfo.readonly === true;

	/**
	 * Current session schema - defines what options are on & off.
	 * It's overlap of document schema (controlled by summary & ops) and options controlling this session.
	 * For example, document schema might have compression ON, but feature gates / runtime options turn it Off.
	 * In such case it will be off in session schema (i.e. this session should not use compression), but this client
	 * has to deal with compressed ops as other clients might send them.
	 * And in reverse, session schema can have compression Off, but feature gates / runtime options want it On.
	 * In such case it will be off in session schema, however this client will propose change to schema, and once / if
	 * this op roundtrips, compression will be On. Client can't send compressed ops until it's change in schema.
	 */
	public get sessionSchema(): {
		[P in keyof IDocumentSchemaFeatures]?: IDocumentSchemaFeatures[P] extends boolean
			? true
			: IDocumentSchemaFeatures[P];
	} {
		return this.documentsSchemaController.sessionSchema.runtime;
	}

	private _idCompressor: (IIdCompressor & IIdCompressorCore) | undefined;

	// We accumulate Id compressor Ops while Id compressor is not loaded yet (only for "delayed" mode)
	// Once it loads, it will process all such ops and we will stop accumulating further ops - ops will be processes as they come in.
	private pendingIdCompressorOps: IdCreationRange[] = [];

	// Id Compressor serializes final state (see getPendingLocalState()). As result, it needs to skip all ops that preceeded that state
	// (such ops will be marked by Loader layer as savedOp === true)
	// That said, in "delayed" mode it's possible that Id Compressor was never initialized before getPendingLocalState() is called.
	// In such case we have to process all ops, including those marked with savedOp === true.
	private readonly skipSavedCompressorOps: boolean;

	/**
	 * {@inheritDoc @fluidframework/runtime-definitions#IContainerRuntimeBase.idCompressor}
	 */
	public get idCompressor(): (IIdCompressor & IIdCompressorCore) | undefined {
		// Expose ID Compressor only if it's On from the start.
		// If container uses delayed mode, then we can only expose generateDocumentUniqueId() and nothing else.
		// That's because any other usage will require immidiate loading of ID Compressor in next sessions in order
		// to reason over such things as session ID space.
		if (this.sessionSchema.idCompressorMode === "on") {
			assert(this._idCompressor !== undefined, 0x8ea /* compressor should have been loaded */);
			return this._idCompressor;
		}
	}

	/**
	 * {@inheritDoc @fluidframework/runtime-definitions#IContainerRuntimeBase.generateDocumentUniqueId}
	 */
	public generateDocumentUniqueId(): string | number {
		return this._idCompressor?.generateDocumentUniqueId() ?? uuid();
	}

	public get IFluidHandleContext(): IFluidHandleContext {
		return this.handleContext;
	}
	private readonly handleContext: ContainerFluidHandleContext;

	/**
	 * This is a proxy to the delta manager provided by the container context (innerDeltaManager). It restricts certain
	 * accesses such as sets "read-only" mode for the summarizer client. This is the default delta manager that should
	 * be used unless the innerDeltaManager is required.
	 */
	public get deltaManager(): IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
		return this._deltaManager;
	}

	private readonly _deltaManager: BaseDeltaManagerProxy;

	/**
	 * The delta manager provided by the container context. By default, using the default delta manager (proxy)
	 * should be sufficient. This should be used only if necessary. For example, for validating and propagating connected
	 * events which requires access to the actual real only info, this is needed.
	 */
	private readonly innerDeltaManager: IDeltaManagerFull;

	// internal logger for ContainerRuntime. Use this.logger for stores, summaries, etc.
	private readonly mc: MonitoringContext;

	private summarizerClientElection?: SummarizerClientElection;
	/**
	 * summaryManager will only be created if this client is permitted to spawn a summarizing client
	 * It is created only by interactive client, i.e. summarizer client, as well as non-interactive bots
	 * do not create it (see SummarizerClientElection.clientDetailsPermitElection() for details)
	 */
	private summaryManager?: SummaryManager;

	private readonly summarizerNode: IRootSummarizerNodeWithGC;

	private readonly maxConsecutiveReconnects: number;

	private readonly batchRunner = new BatchRunCounter();
	private readonly _flushMode: FlushMode;
	private readonly offlineEnabled: boolean;
	private flushScheduled = false;

	private canSendOps: boolean;

	private consecutiveReconnects = 0;

	private readonly dataModelChangeRunner = new RunCounter();

	/**
	 * Invokes the given callback and expects that no ops are submitted
	 * until execution finishes. If an op is submitted, it will be marked as reentrant.
	 *
	 * @param callback - the callback to be invoked
	 */
	public ensureNoDataModelChanges<T>(callback: () => T): T {
		return this.dataModelChangeRunner.run(callback);
	}

	/**
	 * Indicates whether the container is in a state where it is able to send
	 * ops (connected to op stream and not in readonly mode).
	 */
	public get connected(): boolean {
		return this.canSendOps;
	}

	/**
	 * clientId of parent (non-summarizing) container that owns summarizer container
	 */
	public get summarizerClientId(): string | undefined {
		return this.summarizerClientElection?.electedClientId;
	}

	private _disposed = false;
	public get disposed(): boolean {
		return this._disposed;
	}

	private lastEmittedDirty: boolean;
	private emitDirtyDocumentEvent = true;
	private readonly useDeltaManagerOpsProxy: boolean;
	private readonly closeSummarizerDelayMs: number;

	private readonly signalTelemetryManager = new SignalTelemetryManager();

	/**
	 * Summarizer is responsible for coordinating when to send generate and send summaries.
	 * It is the main entry point for summary work.
	 * It is created only by summarizing container (i.e. one with clientType === "summarizer")
	 */

	private _summarizer?: Summarizer;
	private readonly deltaScheduler: DeltaScheduler;
	private readonly inboundBatchAggregator: InboundBatchAggregator;
	private readonly blobManager: BlobManager;
	private readonly pendingStateManager: PendingStateManager;
	private readonly duplicateBatchDetector: DuplicateBatchDetector | undefined;
	private readonly outbox: Outbox;
	private readonly garbageCollector: IGarbageCollector;

	private readonly channelCollection: ChannelCollection;
	private readonly remoteMessageProcessor: RemoteMessageProcessor;

	/**
	 * The last message processed at the time of the last summary.
	 */

	private messageAtLastSummary: ISummaryMetadataMessage | undefined;

	private readonly summariesDisabled: boolean;

	private readonly createContainerMetadata: ICreateContainerMetadata;
	/**
	 * The summary number of the next summary that will be generated for this container. This is incremented every time
	 * a summary is generated.
	 */
	private nextSummaryNumber: number;

	/**
	 * If false, loading or using a Tombstoned object should merely log, not fail.
	 * @deprecated NOT SUPPORTED - hardcoded to return false since it's deprecated.
	 */
	// eslint-disable-next-line @typescript-eslint/class-literal-property-style
	public get gcTombstoneEnforcementAllowed(): boolean {
		return false;
	}

	/**
	 * If true, throw an error when a tombstone data store is used.
	 * @deprecated NOT SUPPORTED - hardcoded to return false since it's deprecated.
	 */
	// eslint-disable-next-line @typescript-eslint/class-literal-property-style
	public get gcThrowOnTombstoneUsage(): boolean {
		return false;
	}

	/**
	 * GUID to identify a document in telemetry
	 * ! Note: should not be used for anything other than telemetry and is not considered a stable GUID
	 */
	private readonly telemetryDocumentId: string;

	/**
	 * The id of the version used to initially load this runtime, or undefined if it's newly created.
	 */
	private readonly loadedFromVersionId: string | undefined;

	private readonly isSnapshotInstanceOfISnapshot: boolean | undefined;

	/**
	 * The summary context of the last acked summary. The properties from this as used when uploading a summary.
	 */
	private lastAckedSummaryContext: ISummaryContext | undefined;

	/**
	 * It a cache for holding mapping for loading groupIds with its snapshot from the service. Add expiry policy of 1 minute.
	 * Starting with 1 min and based on recorded usage we can tweak it later on.
	 */
	private readonly snapshotCacheForLoadingGroupIds = new PromiseCache<string, ISnapshot>({
		expiry: { policy: "absolute", durationMs: 60000 },
	});

	/**
	 * The compatibility details of the Runtime layer that is exposed to the Loader layer
	 * for validating Loader-Runtime compatibility.
	 */
	public get ILayerCompatDetails(): ILayerCompatDetails {
		return runtimeCompatDetailsForLoader;
	}

	/**
	 * If true, will skip Outbox flushing before processing an incoming message (and on DeltaManager "op" event for loader back-compat),
	 * and instead the Outbox will check for a split batch on every submit.
	 * This is a kill-bit switch for this simplification of logic, in case it causes unexpected issues.
	 */
	private readonly skipSafetyFlushDuringProcessStack: boolean;

	private readonly extensions = new Map<ContainerExtensionId, ExtensionEntry>();

	/***/
	protected constructor(
		context: IContainerContext,
		private readonly registry: IFluidDataStoreRegistry,

		private readonly metadata: IContainerRuntimeMetadata | undefined,

		private readonly electedSummarizerData: ISerializedElection | undefined,
		chunks: [string, string[]][],
		dataStoreAliasMap: [string, string][],
		private readonly runtimeOptions: Readonly<ContainerRuntimeOptionsInternal>,
		private readonly containerScope: FluidObject,
		// Create a custom ITelemetryBaseLogger to output telemetry events.
		public readonly baseLogger: ITelemetryBaseLogger,
		existing: boolean,

		blobManagerLoadInfo: IBlobManagerLoadInfo,
		private readonly _storage: IContainerStorageService,
		private readonly createIdCompressorFn: () => IIdCompressor & IIdCompressorCore,

		private readonly documentsSchemaController: DocumentsSchemaController,
		featureGatesForTelemetry: Record<string, boolean | number | undefined>,
		provideEntryPoint: (containerRuntime: IContainerRuntime) => Promise<FluidObject>,
		private readonly minVersionForCollab: SemanticVersion,
		private readonly requestHandler?: (
			request: IRequest,
			runtime: IContainerRuntime,
		) => Promise<IResponse>,
		// // eslint-disable-next-line unicorn/no-object-as-default-parameter
		private readonly summaryConfiguration: ISummaryConfiguration = {
			// the defaults
			...DefaultSummaryConfiguration,
			// the runtime configuration overrides
			...runtimeOptions.summaryOptions?.summaryConfigOverrides,
		},
		recentBatchInfo?: [number, string][],
	) {
		super();

		const {
			options,
			clientDetails,
			connected,
			baseSnapshot,
			submitFn,
			submitBatchFn,
			submitSummaryFn,
			submitSignalFn,
			disposeFn,
			closeFn,
			deltaManager,
			quorum,
			audience,
			pendingLocalState,
			supportedFeatures,
			snapshotWithContents,
		} = context;

		// In old loaders without dispose functionality, closeFn is equivalent but will also switch container to readonly mode
		this.disposeFn = disposeFn ?? closeFn;

		// Validate that the Loader is compatible with this Runtime.
		const maybeLoaderCompatDetailsForRuntime = context as FluidObject<ILayerCompatDetails>;
		validateLoaderCompatibility(
			maybeLoaderCompatDetailsForRuntime.ILayerCompatDetails,
			this.disposeFn,
		);

		this.mc = createChildMonitoringContext({
			logger: this.baseLogger,
			namespace: "ContainerRuntime",
			properties: {
				all: {
					inStagingMode: this.inStagingMode,
				},
			},
		});

		// If we support multiple algorithms in the future, then we would need to manage it here carefully.
		// We can use runtimeOptions.compressionOptions.compressionAlgorithm, but only if it's in the schema list!
		// If it's not in the list, then we will need to either use no compression, or fallback to some other (supported by format)
		// compression.
		const compressionOptions: ICompressionRuntimeOptions = {
			minimumBatchSizeInBytes: this.sessionSchema.compressionLz4
				? runtimeOptions.compressionOptions.minimumBatchSizeInBytes
				: Number.POSITIVE_INFINITY,
			compressionAlgorithm: CompressionAlgorithms.lz4,
		};

		assert(isIDeltaManagerFull(deltaManager), 0xa80 /* Invalid delta manager */);
		this.innerDeltaManager = deltaManager;

		// Here we could wrap/intercept on these functions to block/modify outgoing messages if needed.
		// This makes ContainerRuntime the final gatekeeper for outgoing messages.
		// back-compat: ADO #1385: Make this call unconditional in the future
		this.submitSummaryFn =
			submitSummaryFn ??
			((summaryOp, refseq) => submitFn(MessageType.Summarize, summaryOp, false));

		const sequenceAndSubmitSignal = (
			envelope: UnsequencedSignalEnvelope,
			targetClientId?: string,
		): void => {
			if (targetClientId === undefined) {
				this.signalTelemetryManager.applyTrackingToBroadcastSignalEnvelope(envelope);
			}
			submitSignalFn(envelope, targetClientId);
		};
		this.submitSignalFn = (envelope: UnsequencedSignalEnvelope, targetClientId?: string) => {
			if (envelope.address?.startsWith("/")) {
				throw new Error("General path based addressing is not implemented");
			}
			sequenceAndSubmitSignal(envelope, targetClientId);
		};
		this.submitExtensionSignal = <TMessage extends TypedMessage>(
			id: string,
			addressChain: string[],
			message: OutboundExtensionMessage<TMessage>,
		): void => {
			this.verifyNotClosed();
			const envelope = createNewSignalEnvelope(
				`/ext/${id}/${addressChain.join("/")}`,
				message.type,
				message.content,
			);
			sequenceAndSubmitSignal(envelope, message.targetClientId);
		};

		// TODO: After IContainerContext.options is removed, we'll just create a new blank object {} here.
		// Values are generally expected to be set from the runtime side.
		this.options = options ?? {};
		this.clientDetails = clientDetails;
		this.isSummarizerClient = this.clientDetails.type === summarizerClientType;
		this.loadedFromVersionId = context.getLoadedFromVersion()?.id;
		// eslint-disable-next-line unicorn/consistent-destructuring
		this._getClientId = () => context.clientId;
		// eslint-disable-next-line unicorn/consistent-destructuring
		this._getAttachState = () => context.attachState;
		this.getAbsoluteUrl = async (relativeUrl: string) => {
			// eslint-disable-next-line unicorn/consistent-destructuring
			if (context.getAbsoluteUrl === undefined) {
				throw new Error("Driver does not implement getAbsoluteUrl");
			}
			if (this.attachState !== AttachState.Attached) {
				return undefined;
			}
			return context.getAbsoluteUrl(relativeUrl);
		};
		// TODO: Consider that the Container could just listen to these events itself, or even more appropriately maybe the
		// customer should observe dirty state on the runtime (the owner of dirty state) directly, rather than on the IContainer.
		this.on("dirty", () => context.updateDirtyContainerState(true));
		this.on("saved", () => context.updateDirtyContainerState(false));

		// Telemetry for when the container is attached and subsequently saved for the first time.
		// These events are useful for investigating the validity of container "saved" eventing upon attach.
		// See this.setAttachState() and this.updateDocumentDirtyState() for more details on "attached" and "saved" events.
		this.once("attached", () => {
			this.mc.logger.sendTelemetryEvent({
				eventName: "Attached",
				details: {
					lastEmittedDirty: this.lastEmittedDirty,
					currentDirtyState: this.computeCurrentDirtyState(),
				},
			});
		});
		this.once("saved", () =>
			this.mc.logger.sendTelemetryEvent({
				eventName: "Saved",
				details: { attachState: this.attachState },
			}),
		);

		// In cases of summarizer, we want to dispose instead since consumer doesn't interact with this container
		this.closeFn = this.isSummarizerClient ? this.disposeFn : closeFn;

		let loadSummaryNumber: number;
		// Get the container creation metadata. For new container, we initialize these. For existing containers,
		// get the values from the metadata blob.
		if (existing) {
			this.createContainerMetadata = {
				createContainerRuntimeVersion: metadata?.createContainerRuntimeVersion,
				createContainerTimestamp: metadata?.createContainerTimestamp,
			};
			// summaryNumber was renamed from summaryCount. For older docs that haven't been opened for a long time,
			// the count is reset to 0.
			loadSummaryNumber = metadata?.summaryNumber ?? 0;
		} else {
			this.createContainerMetadata = {
				createContainerRuntimeVersion: pkgVersion,
				createContainerTimestamp: Date.now(),
			};
			loadSummaryNumber = 0;
		}
		this.nextSummaryNumber = loadSummaryNumber + 1;

		this.messageAtLastSummary = lastMessageFromMetadata(metadata);

		// Note that we only need to pull the *initial* connected state from the context.
		// Later updates come through calls to setConnectionState.
		this.canSendOps = connected;

		this.mc.logger.sendTelemetryEvent({
			eventName: "GCFeatureMatrix",
			metadataValue: JSON.stringify(metadata?.gcFeatureMatrix),
			inputs: JSON.stringify({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				gcOptions_gcGeneration: runtimeOptions.gcOptions[gcGenerationOptionName],
			}),
		});

		this.telemetryDocumentId = metadata?.telemetryDocumentId ?? uuid();

		const opGroupingManager = new OpGroupingManager(
			{
				groupedBatchingEnabled: this.groupedBatchingEnabled,
			},
			this.mc.logger,
		);

		const opSplitter = new OpSplitter(
			chunks,
			submitBatchFn,
			runtimeOptions.chunkSizeInBytes,
			runtimeOptions.maxBatchSizeInBytes,
			this.mc.logger,
		);

		this.remoteMessageProcessor = new RemoteMessageProcessor(
			opSplitter,
			new OpDecompressor(this.mc.logger),
			opGroupingManager,
		);

		const pendingRuntimeState = pendingLocalState as IPendingRuntimeState | undefined;
		this.pendingStateManager = new PendingStateManager(
			{
				applyStashedOp: this.applyStashedOp.bind(this),
				clientId: () => this.clientId,
				connected: () => this.connected,
				reSubmitBatch: this.reSubmitBatch.bind(this),
				isActiveConnection: () => this.innerDeltaManager.active,
				isAttached: () => this.attachState !== AttachState.Detached,
			},
			pendingRuntimeState?.pending,
			this.baseLogger,
		);

		let outerDeltaManager: IDeltaManagerFull = this.innerDeltaManager;
		this.useDeltaManagerOpsProxy =
			this.mc.config.getBoolean("Fluid.ContainerRuntime.DeltaManagerOpsProxy") === true;
		// The summarizerDeltaManager Proxy is used to lie to the summarizer to convince it is in the right state as a summarizer client.
		outerDeltaManager = DeltaManagerSummarizerProxy.wrapIfSummarizer(outerDeltaManager);

		// The DeltaManagerPendingOpsProxy is used to control the minimum sequence number
		// It allows us to lie to the layers below so that they can maintain enough local state for rebasing ops.
		if (this.useDeltaManagerOpsProxy) {
			const pendingOpsDeltaManagerProxy = new DeltaManagerPendingOpsProxy(
				outerDeltaManager,
				this.pendingStateManager,
			);
			outerDeltaManager = pendingOpsDeltaManagerProxy;
		}

		// always wrap the exposed delta manager in at least on layer of proxying
		this._deltaManager =
			outerDeltaManager instanceof BaseDeltaManagerProxy
				? outerDeltaManager
				: new BaseDeltaManagerProxy(outerDeltaManager);

		this.handleContext = new ContainerFluidHandleContext("", this);

		if (this.summaryConfiguration.state === "enabled") {
			validateSummaryHeuristicConfiguration(this.summaryConfiguration);
		}

		this.summariesDisabled = isSummariesDisabled(this.summaryConfiguration);

		this.maxConsecutiveReconnects =
			this.mc.config.getNumber(maxConsecutiveReconnectsKey) ?? defaultMaxConsecutiveReconnects;

		// If the context has ILayerCompatDetails, it supports referenceSequenceNumbers since that features
		// predates ILayerCompatDetails.
		const referenceSequenceNumbersSupported =
			maybeLoaderCompatDetailsForRuntime.ILayerCompatDetails === undefined
				? supportedFeatures?.get("referenceSequenceNumbers") === true
				: true;
		if (
			runtimeOptions.flushMode === (FlushModeExperimental.Async as unknown as FlushMode) &&
			!referenceSequenceNumbersSupported
		) {
			// The loader does not support reference sequence numbers, falling back on FlushMode.TurnBased
			this.mc.logger.sendErrorEvent({ eventName: "FlushModeFallback" });
			this._flushMode = FlushMode.TurnBased;
		} else {
			this._flushMode = runtimeOptions.flushMode;
		}
		this.offlineEnabled =
			this.mc.config.getBoolean("Fluid.Container.enableOfflineLoad") ?? false;

		if (this.offlineEnabled && this._flushMode !== FlushMode.TurnBased) {
			const error = new UsageError("Offline mode is only supported in turn-based mode");
			this.closeFn(error);
			throw error;
		}

		// DuplicateBatchDetection is only enabled if Offline Load is enabled
		// It maintains a cache of all batchIds/sequenceNumbers within the collab window.
		// Don't waste resources doing so if not needed.
		if (this.offlineEnabled) {
			this.duplicateBatchDetector = new DuplicateBatchDetector(recentBatchInfo);
		}

		// eslint-disable-next-line unicorn/consistent-destructuring
		if (context.attachState === AttachState.Attached) {
			const maxSnapshotCacheDurationMs = this._storage?.policies?.maximumCacheDurationMs;
			if (
				maxSnapshotCacheDurationMs !== undefined &&
				maxSnapshotCacheDurationMs > 5 * 24 * 60 * 60 * 1000
			) {
				// This is a runtime enforcement of what's already explicit in the policy's type itself,
				// which dictates the value is either undefined or exactly 5 days in ms.
				// As long as the actual value is less than 5 days, the assumptions GC makes here are valid.
				throw new UsageError("Driver's maximumCacheDurationMs policy cannot exceed 5 days");
			}
		}

		this.garbageCollector = GarbageCollector.create({
			runtime: this,
			gcOptions: runtimeOptions.gcOptions,
			baseSnapshot,
			baseLogger: this.mc.logger,
			existing,
			metadata,
			createContainerMetadata: this.createContainerMetadata,
			isSummarizerClient: this.isSummarizerClient,
			getNodePackagePath: async (nodePath: string) => this.getGCNodePackagePath(nodePath),
			getLastSummaryTimestampMs: () => this.messageAtLastSummary?.timestamp,
			readAndParseBlob: async <T>(id: string) => readAndParse<T>(this.storage, id),
			submitMessage: (message: ContainerRuntimeGCMessage) => this.submit(message),
			sessionExpiryTimerStarted: pendingRuntimeState?.sessionExpiryTimerStarted,
		});

		const loadedFromSequenceNumber = this.deltaManager.initialSequenceNumber;
		// If the base snapshot was generated when isolated channels were disabled, set the summary reference
		// sequence to undefined so that this snapshot will not be used for incremental summaries. This is for
		// back-compat and will rarely happen so its okay to re-summarize everything in the first summary.
		const summaryReferenceSequenceNumber =
			baseSnapshot === undefined || metadata?.disableIsolatedChannels === true
				? undefined
				: loadedFromSequenceNumber;
		this.summarizerNode = createRootSummarizerNodeWithGC(
			createChildLogger({ logger: this.baseLogger, namespace: "SummarizerNode" }),
			// Summarize function to call when summarize is called. Summarizer node always tracks summary state.
			async (fullTree: boolean, trackState: boolean, telemetryContext?: ITelemetryContext) =>
				this.summarizeInternal(fullTree, trackState, telemetryContext),
			// Latest change sequence number, no changes since summary applied yet
			loadedFromSequenceNumber,
			summaryReferenceSequenceNumber,
			{
				// Must set to false to prevent sending summary handle which would be pointing to
				// a summary with an older protocol state.
				canReuseHandle: false,
				// If GC should not run, let the summarizer node know so that it does not track GC state.
				gcDisabled: !this.garbageCollector.shouldRunGC,
			},
			// Function to get GC data if needed. This will always be called by the root summarizer node to get GC data.
			async (fullGC?: boolean) => this.getGCDataInternal(fullGC),
			// Function to get the GC details from the base snapshot we loaded from.
			async () => this.garbageCollector.getBaseGCDetails(),
		);

		const parentContext = wrapContext(this);

		if (snapshotWithContents !== undefined) {
			this.isSnapshotInstanceOfISnapshot = true;
		}

		// Due to a mismatch between different layers in terms of
		// what is the interface of passing signals, we need the
		// downstream stores to wrap the signal.
		parentContext.submitSignal = (type: string, content: unknown, targetClientId?: string) => {
			// Future: Can the `content` argument type be IEnvelope?
			// verifyNotClosed is called in FluidDataStoreContext, which is *the* expected caller.
			const envelope1 = content as IEnvelope;
			const envelope2 = createNewSignalEnvelope(envelope1.address, type, envelope1.contents);
			this.submitSignalFn(envelope2, targetClientId);
		};

		let snapshot: ISnapshot | ISnapshotTree | undefined = getSummaryForDatastores(
			baseSnapshot,
			metadata,
		);
		if (snapshot !== undefined && snapshotWithContents !== undefined) {
			snapshot = {
				...snapshotWithContents,
				snapshotTree: snapshot,
			};
		}

		this.channelCollection = new ChannelCollection(
			snapshot,
			parentContext,
			this.mc.logger,
			(props) =>
				this.garbageCollector.nodeUpdated({
					...props,
					timestampMs: props.timestampMs ?? this.getCurrentReferenceTimestampMs(),
				}),
			(path: string) => this.garbageCollector.isNodeDeleted(path),
			new Map<string, string>(dataStoreAliasMap),
			async (runtime: ChannelCollection) => provideEntryPoint,
		);
		this._deltaManager.on("readonly", this.notifyReadOnlyState);

		this.blobManager = new BlobManager({
			routeContext: this.handleContext,
			blobManagerLoadInfo,
			storage: this.storage,
			sendBlobAttachOp: (localId: string, blobId: string) => {
				if (!this.disposed) {
					this.submit(
						{ type: ContainerMessageType.BlobAttach, contents: undefined },
						undefined,
						{
							localId,
							blobId,
						},
					);
				}
			},
			blobRequested: (blobPath: string) =>
				this.garbageCollector.nodeUpdated({
					node: { type: "Blob", path: blobPath },
					reason: "Loaded",
					timestampMs: this.getCurrentReferenceTimestampMs(),
				}),
			isBlobDeleted: (blobPath: string) => this.garbageCollector.isNodeDeleted(blobPath),
			runtime: this,
			stashedBlobs: pendingRuntimeState?.pendingAttachmentBlobs,
			createBlobPayloadPending: this.sessionSchema.createBlobPayloadPending === true,
		});

		this.deltaScheduler = new DeltaScheduler(
			this.innerDeltaManager,
			this,
			createChildLogger({ logger: this.baseLogger, namespace: "DeltaScheduler" }),
		);

		this.inboundBatchAggregator = new InboundBatchAggregator(
			this.innerDeltaManager,
			() => this.clientId,
			createChildLogger({ logger: this.baseLogger, namespace: "InboundBatchAggregator" }),
		);

		const legacySendBatchFn = makeLegacySendBatchFn(submitFn, this.innerDeltaManager);

		this.skipSafetyFlushDuringProcessStack =
			// Keep the old flag name even though we renamed the class member (it shipped in 2.31.0)
			this.mc.config.getBoolean("Fluid.ContainerRuntime.DisableFlushBeforeProcess") === true;

		this.outbox = new Outbox({
			shouldSend: () => this.shouldSendOps(),
			pendingStateManager: this.pendingStateManager,
			submitBatchFn,
			legacySendBatchFn,
			compressor: new OpCompressor(this.mc.logger),
			splitter: opSplitter,
			config: {
				compressionOptions,
				maxBatchSizeInBytes: runtimeOptions.maxBatchSizeInBytes,
				// If we disable flush before process, we must be ready to flush partial batches
				flushPartialBatches: this.skipSafetyFlushDuringProcessStack,
			},
			logger: this.mc.logger,
			groupingManager: opGroupingManager,
			getCurrentSequenceNumbers: () => ({
				// Note: These sequence numbers only change when DeltaManager processes an incoming op
				referenceSequenceNumber: this.deltaManager.lastSequenceNumber,
				clientSequenceNumber: this._processedClientSequenceNumber,
			}),
			reSubmit: this.reSubmit.bind(this),
			opReentrancy: () => this.dataModelChangeRunner.running,
		});

		this._quorum = quorum;
		this._quorum.on("removeMember", (clientId: string) => {
			this.remoteMessageProcessor.clearPartialMessagesFor(clientId);
		});

		this._audience = audience;
		if (audience.getSelf === undefined) {
			// back-compat, added in 2.0 RC3.
			// Purpose: deal with cases when we run against old loader that does not have newly added capabilities
			audience.getSelf = () => {
				const clientId = this._getClientId();
				return clientId === undefined
					? undefined
					: ({
							clientId,
							client: audience.getMember(clientId),
						} satisfies ISelf);
			};

			let oldClientId = this.clientId;
			this.on("connected", () => {
				const clientId = this.clientId;
				assert(clientId !== undefined, 0x975 /* can't be undefined */);
				(audience as unknown as TypedEventEmitter<IAudienceEvents>).emit(
					"selfChanged",
					{ clientId: oldClientId },
					{ clientId, client: audience.getMember(clientId) },
				);
				oldClientId = clientId;
			});
		}

		const closeSummarizerDelayOverride = this.mc.config.getNumber(
			"Fluid.ContainerRuntime.Test.CloseSummarizerDelayOverrideMs",
		);
		this.closeSummarizerDelayMs =
			closeSummarizerDelayOverride ?? defaultCloseSummarizerDelayMs;

		// We haven't emitted dirty/saved yet, but this is the baseline so we know to emit when it changes
		this.lastEmittedDirty = this.computeCurrentDirtyState();
		context.updateDirtyContainerState(this.lastEmittedDirty);

		if (!this.skipSafetyFlushDuringProcessStack) {
			// Reference Sequence Number may have just changed, and it must be consistent across a batch,
			// so we should flush now to clear the way for the next ops.
			// NOTE: This will be redundant whenever CR.process was called for the op (since we flush there too) -
			// But we need this coverage for old loaders that don't call ContainerRuntime.process for non-runtime messages.
			// (We have to call flush _before_ processing a runtime op, but after is ok for non-runtime op)
			this.deltaManager.on("op", () => this.flush());
		}

		// logging hardware telemetry
		this.baseLogger.send({
			category: "generic",
			eventName: "DeviceSpec",
			...getDeviceSpec(),
		});

		this.mc.logger.sendTelemetryEvent({
			eventName: "ContainerLoadStats",
			...this.createContainerMetadata,
			...this.channelCollection.containerLoadStats,
			summaryNumber: loadSummaryNumber,
			summaryFormatVersion: metadata?.summaryFormatVersion,
			disableIsolatedChannels: metadata?.disableIsolatedChannels,
			gcVersion: metadata?.gcFeature,
			options: JSON.stringify(runtimeOptions),
			idCompressorModeMetadata: metadata?.documentSchema?.runtime?.idCompressorMode,
			idCompressorMode: this.sessionSchema.idCompressorMode,
			sessionRuntimeSchema: JSON.stringify(this.sessionSchema),
			featureGates: JSON.stringify({
				...featureGatesForTelemetry,
				closeSummarizerDelayOverride,
				disableFlushBeforeProcess: this.skipSafetyFlushDuringProcessStack,
			}),
			telemetryDocumentId: this.telemetryDocumentId,
			groupedBatchingEnabled: this.groupedBatchingEnabled,
			initialSequenceNumber: this.deltaManager.initialSequenceNumber,
			minVersionForCollab: this.minVersionForCollab,
		});

		ReportOpPerfTelemetry(this.clientId, this._deltaManager, this, this.baseLogger);
		BindBatchTracker(this, this.baseLogger);

		this.entryPoint = new LazyPromise(async () => {
			if (this._summarizer !== undefined) {
				return this._summarizer;
			}
			return provideEntryPoint(this);
		});

		// If we loaded from pending state, then we need to skip any ops that are already accounted in such
		// saved state, i.e. all the ops marked by Loader layer sa savedOp === true.
		this.skipSavedCompressorOps = pendingRuntimeState?.pendingIdCompressorState !== undefined;
	}

	public onSchemaChange(schema: IDocumentSchemaCurrent): void {
		this.mc.logger.sendTelemetryEvent({
			eventName: "SchemaChangeAccept",
			sessionRuntimeSchema: JSON.stringify(schema),
		});

		// Most of the settings will be picked up only by new sessions (i.e. after reload).
		// We can make it better in the future (i.e. start to use op compression right away), but for simplicity
		// this is not done.
		// But ID compressor is special. It's possible, that in future, we will remove "stickiness" of ID compressor setting
		// and will allow to start using it. If that were to happen, we want to ensure that we do not break eventual consistency
		// promises. To do so, we need to initialize id compressor right away.
		// As it's implemented right now (with async initialization), this will only work for "off" -> "delayed" transitions.
		// Anything else is too risky, and requires ability to initialize ID compressor synchronously!
		if (schema.runtime.idCompressorMode !== undefined) {
			this.loadIdCompressor();
		}
	}

	public getCreateChildSummarizerNodeFn(
		id: string,
		createParam: CreateChildSummarizerNodeParam,
	) {
		return (
			summarizeInternal: SummarizeInternalFn,
			getGCDataFn: (fullGC?: boolean) => Promise<IGarbageCollectionData>,
		): ISummarizerNodeWithGC =>
			this.summarizerNode.createChild(
				summarizeInternal,
				id,
				createParam,
				undefined,
				getGCDataFn,
			);
	}

	public deleteChildSummarizerNode(id: string): void {
		return this.summarizerNode.deleteChild(id);
	}

	// #region `IFluidParentContext` APIs that should not be called on Root

	public makeLocallyVisible(): void {
		assert(false, 0x8eb /* should not be called */);
	}

	public setChannelDirty(address: string): void {
		assert(false, 0x909 /* should not be called */);
	}

	// #endregion

	/**
	 * Initializes the state from the base snapshot this container runtime loaded from.
	 */
	private async initializeBaseState(loader: ILoader): Promise<void> {
		if (
			this.sessionSchema.idCompressorMode === "on" ||
			(this.sessionSchema.idCompressorMode === "delayed" && this.connected)
		) {
			PerformanceEvent.timedExec(
				this.mc.logger,
				{ eventName: "CreateIdCompressorOnBoot" },
				(event) => {
					this._idCompressor = this.createIdCompressorFn();
					event.end({
						details: {
							idCompressorMode: this.sessionSchema.idCompressorMode,
						},
					});
				},
			);
			// This is called from loadRuntime(), long before we process any ops, so there should be no ops accumulated yet.
			assert(this.pendingIdCompressorOps.length === 0, 0x8ec /* no pending ops */);
		}

		await this.initializeSummarizer(loader);
		await this.garbageCollector.initializeBaseState();
	}

	private async initializeSummarizer(loader: ILoader): Promise<void> {
		if (this.summariesDisabled) {
			this.mc.logger.sendTelemetryEvent({ eventName: "SummariesDisabled" });
			return;
		}

		const { maxOpsSinceLastSummary = 0, initialSummarizerDelayMs = 0 } = isSummariesDisabled(
			this.summaryConfiguration,
		)
			? {}
			: {
					...this.summaryConfiguration,
					initialSummarizerDelayMs:
						// back-compat: initialSummarizerDelayMs was moved from ISummaryRuntimeOptions
						//   to ISummaryConfiguration in 0.60.
						this.runtimeOptions.summaryOptions.initialSummarizerDelayMs ??
						this.summaryConfiguration.initialSummarizerDelayMs,
				};

		const summaryCollection: SummaryCollection = new SummaryCollection(
			this.deltaManager,
			this.baseLogger,
		);
		const orderedClientLogger = createChildLogger({
			logger: this.baseLogger,
			namespace: "OrderedClientElection",
		});
		const orderedClientCollection = new OrderedClientCollection(
			orderedClientLogger,
			this.innerDeltaManager,
			this._quorum,
		);
		const orderedClientElectionForSummarizer = new OrderedClientElection(
			orderedClientLogger,
			orderedClientCollection,
			this.electedSummarizerData ?? this.innerDeltaManager.lastSequenceNumber,
			SummarizerClientElection.isClientEligible,
			this.mc.config.getBoolean(
				"Fluid.ContainerRuntime.OrderedClientElection.EnablePerformanceEvents",
			),
		);

		this.summarizerClientElection = new SummarizerClientElection(
			orderedClientLogger,
			summaryCollection,
			orderedClientElectionForSummarizer,
			maxOpsSinceLastSummary,
		);

		if (this.isSummarizerClient) {
			// We want to dynamically import any thing inside summaryDelayLoadedModule module only when we are the summarizer client,
			// so that all non summarizer clients don't have to load the code inside this module.
			const module = await import(
				/* webpackChunkName: "summarizerDelayLoadedModule" */ "./summary/index.js"
			);
			this._summarizer = new module.Summarizer(
				this /* ISummarizerRuntime */,
				() => this.summaryConfiguration,
				this /* ISummarizerInternalsProvider */,
				this.handleContext,
				summaryCollection,

				async (runtime: IConnectableRuntime) =>
					module.RunWhileConnectedCoordinator.create(
						runtime,
						// Summarization runs in summarizer client and needs access to the real (non-proxy) active
						// information. The proxy delta manager would always return false for summarizer client.
						() => this.innerDeltaManager.active,
					),
			);
		} else if (SummarizerClientElection.clientDetailsPermitElection(this.clientDetails)) {
			// Only create a SummaryManager and SummarizerClientElection
			// if summaries are enabled and we are not the summarizer client.
			const defaultAction = (): void => {
				if (summaryCollection.opsSinceLastAck > maxOpsSinceLastSummary) {
					this.mc.logger.sendTelemetryEvent({ eventName: "SummaryStatus:Behind" });
					// unregister default to no log on every op after falling behind
					// and register summary ack handler to re-register this handler
					// after successful summary
					summaryCollection.once(MessageType.SummaryAck, () => {
						this.mc.logger.sendTelemetryEvent({
							eventName: "SummaryStatus:CaughtUp",
						});
						// we've caught up, so re-register the default action to monitor for
						// falling behind, and unregister ourself
						summaryCollection.on("default", defaultAction);
					});
					summaryCollection.off("default", defaultAction);
				}
			};

			summaryCollection.on("default", defaultAction);

			// Create the SummaryManager and mark the initial state
			this.summaryManager = new SummaryManager(
				this.summarizerClientElection,
				this, // IConnectedState
				summaryCollection,
				this.baseLogger,
				formCreateSummarizerFn(loader),
				new Throttler(
					60 * 1000, // 60 sec delay window
					30 * 1000, // 30 sec max delay
					// throttling function increases exponentially (0ms, 40ms, 80ms, 160ms, etc)
					formExponentialFn({ coefficient: 20, initialDelay: 0 }),
				),
				{
					initialDelayMs: initialSummarizerDelayMs,
				},
			);
			// Forward events from SummaryManager
			for (const eventName of [
				"summarize",
				"summarizeAllAttemptsFailed",
				"summarizerStop",
				"summarizerStart",
				"summarizerStartupFailed",
			]) {
				this.summaryManager?.on(eventName, (...args: unknown[]) => {
					this.emit(eventName, ...args);
				});
			}

			this.summaryManager.start();
		}
	}

	public dispose(error?: Error): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;

		this.mc.logger.sendTelemetryEvent(
			{
				eventName: "ContainerRuntimeDisposed",
				isDirty: this.isDirty,
				lastSequenceNumber: this.deltaManager.lastSequenceNumber,
				attachState: this.attachState,
			},
			error,
		);

		if (this.summaryManager !== undefined) {
			this.summaryManager.dispose();
		}
		this.garbageCollector.dispose();
		this._summarizer?.dispose();
		this.channelCollection.dispose();
		this.pendingStateManager.dispose();
		this.inboundBatchAggregator.dispose();
		this.deltaScheduler.dispose();
		this._deltaManager.dispose();
		this.emit("dispose");
		this.removeAllListeners();
	}

	/**
	 * Api to fetch the snapshot from the service for a loadingGroupIds.
	 * @param loadingGroupIds - LoadingGroupId for which the snapshot is asked for.
	 * @param pathParts - Parts of the path, which we want to extract from the snapshot tree.
	 * @returns - snapshotTree and the sequence number of the snapshot.
	 */
	public async getSnapshotForLoadingGroupId(
		loadingGroupIds: string[],
		pathParts: string[],
	): Promise<{ snapshotTree: ISnapshotTree; sequenceNumber: number }> {
		const sortedLoadingGroupIds = loadingGroupIds.sort();
		assert(
			this.storage.getSnapshot !== undefined,
			0x8ed /* getSnapshot api should be defined if used */,
		);
		let loadedFromCache = true;
		// Lookup up in the cache, if not present then make the network call as multiple datastores could
		// be in same loading group. So, once we have fetched the snapshot for that loading group on
		// any request, then cache that as same group could be requested in future too.
		const snapshot = await this.snapshotCacheForLoadingGroupIds.addOrGet(
			sortedLoadingGroupIds.join(","),
			async () => {
				assert(
					this.storage.getSnapshot !== undefined,
					0x8ee /* getSnapshot api should be defined if used */,
				);
				loadedFromCache = false;
				return this.storage.getSnapshot({
					cacheSnapshot: false,
					scenarioName: "snapshotForLoadingGroupId",
					loadingGroupIds: sortedLoadingGroupIds,
				});
			},
		);

		this.mc.logger.sendTelemetryEvent({
			eventName: "GroupIdSnapshotFetched",
			details: JSON.stringify({
				fromCache: loadedFromCache,
				loadingGroupIds: loadingGroupIds.join(","),
			}),
		});
		// Find the snapshotTree inside the returned snapshot based on the path as given in the request.
		const hasIsolatedChannels = rootHasIsolatedChannels(this.metadata);
		const snapshotTreeForPath = this.getSnapshotTreeForPath(
			snapshot.snapshotTree,
			pathParts,
			hasIsolatedChannels,
		);
		assert(snapshotTreeForPath !== undefined, 0x8ef /* no snapshotTree for the path */);
		const snapshotSeqNumber = snapshot.sequenceNumber;
		assert(snapshotSeqNumber !== undefined, 0x8f0 /* snapshotSeqNumber should be present */);

		// This assert fires if we get a snapshot older than the snapshot we loaded from. This is a service issue.
		// Snapshots should only move forward. If we observe an older snapshot than the one we loaded from, then likely
		// the file has been overwritten or service lost data.
		if (snapshotSeqNumber < this.deltaManager.initialSequenceNumber) {
			throw DataProcessingError.create(
				"Downloaded snapshot older than snapshot we loaded from",
				"getSnapshotForLoadingGroupId",
				undefined,
				{
					loadingGroupIds: sortedLoadingGroupIds.join(","),
					snapshotSeqNumber,
					initialSequenceNumber: this.deltaManager.initialSequenceNumber,
				},
			);
		}

		// If the snapshot is ahead of the last seq number of the delta manager, then catch up before
		// returning the snapshot.
		if (snapshotSeqNumber > this.deltaManager.lastSequenceNumber) {
			// If this is a summarizer client, which is trying to load a group and it finds that there is
			// another snapshot from which the summarizer loaded and it is behind, then just give up as
			// the summarizer state is not up to date.
			// This should be a recoverable scenario and shouldn't happen as we should process the ack first.
			if (this._summarizer !== undefined) {
				throw new Error("Summarizer client behind, loaded newer snapshot with loadingGroupId");
			}

			// We want to catchup from sequenceNumber to targetSequenceNumber
			const props: ITelemetryGenericEventExt = {
				eventName: "GroupIdSnapshotCatchup",
				loadingGroupIds: sortedLoadingGroupIds.join(","),
				targetSequenceNumber: snapshotSeqNumber, // This is so we reuse some columns in telemetry
				sequenceNumber: this.deltaManager.lastSequenceNumber, // This is so we reuse some columns in telemetry
			};

			const event = PerformanceEvent.start(this.mc.logger, {
				...props,
			});
			// If the inbound deltas queue is paused or disconnected, we expect a reconnect and unpause
			// as long as it's not a summarizer client.
			if (this._deltaManager.inbound.paused) {
				props.inboundPaused = this._deltaManager.inbound.paused; // reusing telemetry
			}
			const defP = new Deferred<boolean>();
			this.deltaManager.on("op", (message: ISequencedDocumentMessage) => {
				if (message.sequenceNumber >= snapshotSeqNumber) {
					defP.resolve(true);
				}
			});
			await defP.promise;
			event.end(props);
		}
		return { snapshotTree: snapshotTreeForPath, sequenceNumber: snapshotSeqNumber };
	}

	/**
	 * Api to find a snapshot tree inside a bigger snapshot tree based on the path in the pathParts array.
	 * @param snapshotTree - snapshot tree to look into.
	 * @param pathParts - Part of the path, which we want to extract from the snapshot tree.
	 * @param hasIsolatedChannels - whether the channels are present inside ".channels" subtree. Older
	 * snapshots will not have trees inside ".channels", so check that.
	 * @returns - requested snapshot tree based on the path parts.
	 */
	private getSnapshotTreeForPath(
		snapshotTree: ISnapshotTree,
		pathParts: string[],
		hasIsolatedChannels: boolean,
	): ISnapshotTree | undefined {
		let childTree = snapshotTree;
		for (const part of pathParts) {
			if (hasIsolatedChannels) {
				childTree = childTree?.trees[channelsTreeName];
			}
			childTree = childTree?.trees[part];
		}
		return childTree;
	}

	/**
	 * Notifies this object about the request made to the container.
	 * @param request - Request made to the handler.
	 * @deprecated Will be removed in future major release. This method needs to stay private until LTS version of Loader moves to "2.0.0-internal.7.0.0".
	 */
	// @ts-expect-error expected to be used by LTS Loaders and Containers
	private async request(request: IRequest): Promise<IResponse> {
		try {
			const parser = RequestParser.create(request);
			const id = parser.pathParts[0];

			if (id === summarizerRequestUrl && parser.pathParts.length === 1) {
				if (this._summarizer !== undefined) {
					return {
						status: 200,
						mimeType: "fluid/object",
						value: this._summarizer,
					};
				}
				return create404Response(request);
			}
			if (this.requestHandler !== undefined) {
				// eslint-disable-next-line @typescript-eslint/return-await -- Adding an await here causes test failures
				return this.requestHandler(parser, this);
			}

			return create404Response(request);
		} catch (error) {
			return exceptionToResponse(error);
		}
	}

	/**
	 * Resolves URI representing handle
	 * @param request - Request made to the handler.
	 */
	public async resolveHandle(request: IRequest): Promise<IResponse> {
		try {
			const requestParser = RequestParser.create(request);
			const id = requestParser.pathParts[0];

			if (id === "_channels") {
				// eslint-disable-next-line @typescript-eslint/return-await -- Adding an await here causes test failures
				return this.resolveHandle(requestParser.createSubRequest(1));
			}

			if (id === blobManagerBasePath && requestParser.isLeaf(2)) {
				const localId = requestParser.pathParts[1];
				const payloadPending = requestParser.headers?.[RuntimeHeaders.payloadPending] === true;
				if (
					!this.blobManager.hasBlob(localId) &&
					requestParser.headers?.[RuntimeHeaders.wait] === false
				) {
					return create404Response(request);
				}

				const blob = await this.blobManager.getBlob(localId, payloadPending);
				return {
					status: 200,
					mimeType: "fluid/object",
					value: blob,
				};
			} else if (requestParser.pathParts.length > 0) {
				return await this.channelCollection.request(request);
			}

			return create404Response(request);
		} catch (error) {
			return exceptionToResponse(error);
		}
	}

	/**
	 * {@inheritDoc @fluidframework/container-definitions#IRuntime.getEntryPoint}
	 */
	public async getEntryPoint(): Promise<FluidObject> {
		return this.entryPoint;
	}
	private readonly entryPoint: LazyPromise<FluidObject>;

	private internalId(maybeAlias: string): string {
		return this.channelCollection.internalId(maybeAlias);
	}

	/**
	 * Adds the container's metadata to the given summary tree.
	 */
	private addMetadataToSummary(summaryTree: ISummaryTreeWithStats): void {
		// The last message processed at the time of summary. If there are no new messages, use the message from the
		// last summary.
		const message =
			extractSummaryMetadataMessage(this.deltaManager.lastMessage) ??
			this.messageAtLastSummary;

		const documentSchema = this.documentsSchemaController.summarizeDocumentSchema(
			this.deltaManager.lastSequenceNumber,
		);

		// Is document schema explicit control on?
		const explicitSchemaControl = documentSchema?.runtime.explicitSchemaControl;

		const metadata: IContainerRuntimeMetadata = {
			...this.createContainerMetadata,
			// Increment the summary number for the next summary that will be generated.
			summaryNumber: this.nextSummaryNumber++,
			summaryFormatVersion: 1,
			...this.garbageCollector.getMetadata(),
			telemetryDocumentId: this.telemetryDocumentId,
			// If explicit document schema control is not on, use legacy way to supply last message (using 'message' property).
			// Otherwise use new 'lastMessage' property, but also put content into the 'message' property that cases old
			// runtimes (that preceed document schema control capabilities) to close container on load due to mismatch in
			// last message's sequence number.
			// See also lastMessageFromMetadata()
			message: explicitSchemaControl
				? ({ sequenceNumber: -1 } as unknown as ISummaryMetadataMessage)
				: message,
			lastMessage: explicitSchemaControl ? message : undefined,
			documentSchema,
		};

		addBlobToSummary(summaryTree, metadataBlobName, JSON.stringify(metadata));
	}

	protected addContainerStateToSummary(
		summaryTree: ISummaryTreeWithStats,
		fullTree: boolean,
		trackState: boolean,
		telemetryContext?: ITelemetryContext,
	): void {
		this.addMetadataToSummary(summaryTree);

		if (this._idCompressor) {
			const idCompressorState = JSON.stringify(this._idCompressor.serialize(false));
			addBlobToSummary(summaryTree, idCompressorBlobName, idCompressorState);
		}

		if (this.remoteMessageProcessor.partialMessages.size > 0) {
			const content = JSON.stringify([...this.remoteMessageProcessor.partialMessages]);
			addBlobToSummary(summaryTree, chunksBlobName, content);
		}

		const recentBatchInfo =
			this.duplicateBatchDetector?.getRecentBatchInfoForSummary(telemetryContext);
		if (recentBatchInfo !== undefined) {
			addBlobToSummary(summaryTree, recentBatchInfoBlobName, JSON.stringify(recentBatchInfo));
		}

		const dataStoreAliases = this.channelCollection.aliases;
		if (dataStoreAliases.size > 0) {
			addBlobToSummary(summaryTree, aliasBlobName, JSON.stringify([...dataStoreAliases]));
		}

		if (this.summarizerClientElection) {
			const electedSummarizerContent = JSON.stringify(
				this.summarizerClientElection?.serialize(),
			);
			addBlobToSummary(summaryTree, electedSummarizerBlobName, electedSummarizerContent);
		}

		const blobManagerSummary = this.blobManager.summarize();
		// Some storage (like git) doesn't allow empty tree, so we can omit it.
		// and the blob manager can handle the tree not existing when loading
		if (Object.keys(blobManagerSummary.summary.tree).length > 0) {
			addSummarizeResultToSummary(summaryTree, blobsTreeName, blobManagerSummary);
		}

		const gcSummary = this.garbageCollector.summarize(fullTree, trackState, telemetryContext);
		if (gcSummary !== undefined) {
			addSummarizeResultToSummary(summaryTree, gcTreeKey, gcSummary);
		}
	}

	// Track how many times the container tries to reconnect with pending messages.
	// This happens when the connection state is changed and we reset the counter
	// when we are able to process a local op or when there are no pending messages.
	// If this counter reaches a max, it's a good indicator that the container
	// is not making progress and it is stuck in a retry loop.
	private shouldContinueReconnecting(): boolean {
		if (this.maxConsecutiveReconnects <= 0) {
			// Feature disabled, we never stop reconnecting
			return true;
		}

		if (!this.hasPendingMessages()) {
			// If there are no pending messages, we can always reconnect
			this.resetReconnectCount();
			return true;
		}

		if (this.consecutiveReconnects === Math.floor(this.maxConsecutiveReconnects / 2)) {
			// If we're halfway through the max reconnects, send an event in order
			// to better identify false positives, if any. If the rate of this event
			// matches Container Close count below, we can safely cut down
			// maxConsecutiveReconnects to half.
			this.mc.logger.sendTelemetryEvent({
				eventName: "ReconnectsWithNoProgress",
				attempts: this.consecutiveReconnects,
				pendingMessages: this.pendingMessagesCount,
			});
		}

		return this.consecutiveReconnects < this.maxConsecutiveReconnects;
	}

	private resetReconnectCount(): void {
		this.consecutiveReconnects = 0;
	}

	private replayPendingStates(): void {
		// We need to be able to send ops to replay states
		if (!this.shouldSendOps()) {
			return;
		}

		// Replaying is an internal operation and we don't want to generate noise while doing it.
		// So temporarily disable dirty state change events, and save the old state.
		// When we're done, we'll emit the event if the state changed.
		const oldState = this.lastEmittedDirty;
		assert(this.emitDirtyDocumentEvent, 0x127 /* "dirty document event not set on replay" */);
		this.emitDirtyDocumentEvent = false;

		try {
			// Any ID Allocation ops that failed to submit after the pending state was queued need to have
			// the corresponding ranges resubmitted (note this call replaces the typical resubmit flow).
			// Since we don't submit ID Allocation ops when staged, any outstanding ranges would be from
			// before staging mode so we can simply say staged: false.
			this.submitIdAllocationOpIfNeeded({ resubmitOutstandingRanges: true, staged: false });
			this.scheduleFlush();

			// replay the ops
			this.pendingStateManager.replayPendingStates();
		} finally {
			// Restore the old state, re-enable event emit
			this.lastEmittedDirty = oldState;
			this.emitDirtyDocumentEvent = true;
		}

		// This will emit an event if the state changed relative to before replay
		this.updateDocumentDirtyState();
	}

	/**
	 * Parse an op's type and actual content from given serialized content
	 * ! Note: this format needs to be in-line with what is set in the "ContainerRuntime.submit(...)" method
	 */
	private parseLocalOpContent(serializedContents?: string): LocalContainerRuntimeMessage {
		assert(serializedContents !== undefined, 0x6d5 /* content must be defined */);
		const message = JSON.parse(serializedContents) as LocalContainerRuntimeMessage;
		assert(message.type !== undefined, 0x6d6 /* incorrect op content format */);
		return message;
	}

	private async applyStashedOp(serializedOpContent: string): Promise<unknown> {
		// Pending State contains serialized contents, so parse it here.
		const opContents = this.parseLocalOpContent(serializedOpContent);
		switch (opContents.type) {
			case ContainerMessageType.FluidDataStoreOp:
			case ContainerMessageType.Attach:
			case ContainerMessageType.Alias: {
				return this.channelCollection.applyStashedOp(opContents);
			}
			case ContainerMessageType.IdAllocation: {
				// IDs allocation ops in stashed state are ignored because the tip state of the compressor
				// is serialized into the pending state. This is done because generation of new IDs during
				// stashed op application (or, later, resubmit) must generate new IDs and if the compressor
				// was loaded from a state serialized at the same time as the summary tree in the stashed state
				// then it would generate IDs that collide with any in later stashed ops.
				// In the future, IdCompressor could be extended to have an "applyStashedOp" or similar method
				// and the runtime could filter out all ID allocation ops from the stashed state and apply them
				// before applying the rest of the stashed ops. This would accomplish the same thing but with
				// better performance in future incremental stashed state creation.
				assert(
					this.sessionSchema.idCompressorMode !== undefined,
					0x8f1 /* ID compressor should be in use */,
				);
				return;
			}
			case ContainerMessageType.DocumentSchemaChange: {
				return;
			}
			case ContainerMessageType.BlobAttach: {
				return;
			}
			case ContainerMessageType.Rejoin: {
				throw new Error("rejoin not expected here");
			}
			case ContainerMessageType.GC: {
				// GC op is only sent in summarizer which should never have stashed ops.
				throw new LoggingError("GC op not expected to be stashed in summarizer");
			}
			default: {
				const error = getUnknownMessageTypeError(
					opContents.type,
					"applyStashedOp" /* codePath */,
				);
				this.closeFn(error);
				throw error;
			}
		}
	}

	private loadIdCompressor(): void {
		if (
			this._idCompressor === undefined &&
			this.sessionSchema.idCompressorMode !== undefined
		) {
			PerformanceEvent.timedExec(
				this.mc.logger,
				{ eventName: "CreateIdCompressorOnDelayedLoad" },
				(event) => {
					this._idCompressor = this.createIdCompressorFn();
					// Finalize any ranges we received while the compressor was turned off.
					const ops = this.pendingIdCompressorOps;
					this.pendingIdCompressorOps = [];
					const trace = Trace.start();
					for (const range of ops) {
						this._idCompressor.finalizeCreationRange(range);
					}
					event.end({
						details: {
							finalizeCreationRangeDuration: trace.trace().duration,
							idCompressorMode: this.sessionSchema.idCompressorMode,
							pendingIdCompressorOps: ops.length,
						},
					});
				},
			);
			assert(this.pendingIdCompressorOps.length === 0, 0x976 /* No new ops added */);
		}
	}

	private readonly notifyReadOnlyState = (readonly: boolean): void =>
		this.channelCollection.notifyReadOnlyState(readonly);

	public setConnectionState(canSendOps: boolean, clientId?: string): void {
		// Validate we have consistent state
		const currentClientId = this._audience.getSelf()?.clientId;
		assert(clientId === currentClientId, 0x977 /* input clientId does not match Audience */);
		assert(
			this.clientId === currentClientId,
			0x978 /* this.clientId does not match Audience */,
		);

		if (canSendOps && this.sessionSchema.idCompressorMode === "delayed") {
			this.loadIdCompressor();
		}

		this.setConnectionStateCore(canSendOps, clientId);
	}

	/**
	 * Raises and propagates connected events.
	 * @param canSendOps - Indicates whether the container can send ops or not (connected and not readonly).
	 * @remarks The connection state from container context used here when raising connected events.
	 */
	private setConnectionStateCore(canSendOps: boolean, clientId?: string): void {
		this.verifyNotClosed();

		// There might be no change of state due to Container calling this API after loading runtime.
		const canSendOpsChanged = this.canSendOps !== canSendOps;
		const reconnection = canSendOpsChanged && !canSendOps;

		// We need to flush the ops currently collected by Outbox to preserve original order.
		// This flush NEEDS to happen before we set the ContainerRuntime to "connected".
		// We want these ops to get to the PendingStateManager without sending to service and have them return to the Outbox upon calling "replayPendingStates".
		if (canSendOpsChanged && canSendOps) {
			this.flush();
		}

		this.canSendOps = canSendOps;

		if (canSendOps) {
			assert(
				this.attachState === AttachState.Attached,
				0x3cd /* Connection is possible only if container exists in storage */,
			);
			if (canSendOpsChanged) {
				this.signalTelemetryManager.resetTracking();
			}
		}

		// Fail while disconnected
		if (reconnection) {
			this.consecutiveReconnects++;

			if (!this.shouldContinueReconnecting()) {
				this.closeFn(
					DataProcessingError.create(
						"Runtime detected too many reconnects with no progress syncing local ops.",
						"setConnectionState",
						undefined,
						{
							dataLoss: 1,
							attempts: this.consecutiveReconnects,
							pendingMessages: this.pendingMessagesCount,
						},
					),
				);
				return;
			}
		}

		if (canSendOpsChanged) {
			this.replayPendingStates();
		}

		this.channelCollection.setConnectionState(canSendOps, clientId);
		this.garbageCollector.setConnectionState(canSendOps, clientId);

		raiseConnectedEvent(this.mc.logger, this, this.connected /* canSendOps */, clientId);
	}

	public async notifyOpReplay(message: ISequencedDocumentMessage): Promise<void> {
		await this.pendingStateManager.applyStashedOpsAt(message.sequenceNumber);
	}

	/**
	 * Processes the op.
	 * @param messageCopy - Sequenced message for a distributed document.
	 * @param local - true if the message was originally generated by the client receiving it.
	 */
	public process({ ...messageCopy }: ISequencedDocumentMessage, local: boolean): void {
		// spread operator above ensure we make a shallow copy of message, as the processing flow will modify it.
		// There might be multiple container instances receiving the same message.

		this.verifyNotClosed();

		if (!this.skipSafetyFlushDuringProcessStack) {
			// Reference Sequence Number may be about to change, and it must be consistent across a batch, so flush now
			this.flush();
		}

		this.ensureNoDataModelChanges(() => {
			this.processInboundMessageOrBatch(messageCopy, local);
		});
	}

	/**
	 * Implementation of core logic for {@link ContainerRuntime.process}, once preconditions are established
	 *
	 * @param messageCopy - Shallow copy of the sequenced message. If it's a virtualized batch, we'll process
	 * all messages in the batch here.
	 */
	private processInboundMessageOrBatch(
		messageCopy: ISequencedDocumentMessage,
		local: boolean,
	): void {
		// Whether or not the message appears to be a runtime message from an up-to-date client.
		// It may be a legacy runtime message (ie already unpacked and ContainerMessageType)
		// or something different, like a system message.
		const hasModernRuntimeMessageEnvelope = messageCopy.type === MessageType.Operation;
		const savedOp = (messageCopy.metadata as ISavedOpMetadata)?.savedOp;
		const logLegacyCase = getSingleUseLegacyLogCallback(this.mc.logger, messageCopy.type);

		let runtimeBatch: boolean =
			hasModernRuntimeMessageEnvelope || isUnpackedRuntimeMessage(messageCopy);
		if (runtimeBatch) {
			// We expect runtime messages to have JSON contents - deserialize it in place.
			ensureContentsDeserialized(messageCopy);
		}

		if (hasModernRuntimeMessageEnvelope) {
			// If the message has the modern message envelope, then process it here.
			// Here we unpack the message (decompress, unchunk, and/or ungroup) into a batch of messages with ContainerMessageType
			const inboundResult = this.remoteMessageProcessor.process(messageCopy, logLegacyCase);
			if (inboundResult === undefined) {
				// This means the incoming message is an incomplete part of a message or batch
				// and we need to process more messages before the rest of the system can understand it.
				return;
			}

			if ("batchStart" in inboundResult) {
				const batchStart: BatchStartInfo = inboundResult.batchStart;
				const result = this.duplicateBatchDetector?.processInboundBatch(batchStart);
				if (result?.duplicate) {
					const error = new DataCorruptionError(
						"Duplicate batch - The same batch was sequenced twice",
						{ batchId: batchStart.batchId },
					);

					this.mc.logger.sendTelemetryEvent(
						{
							eventName: "DuplicateBatch",
							details: {
								batchId: batchStart.batchId,
								clientId: batchStart.clientId,
								batchStartCsn: batchStart.batchStartCsn,
								size: inboundResult.length,
								duplicateBatchSequenceNumber: result.otherSequenceNumber,
								...extractSafePropertiesFromMessage(batchStart.keyMessage),
							},
						},
						error,
					);
					throw error;
				}
			}

			// Reach out to PendingStateManager, either to zip localOpMetadata into the *local* message list,
			// or to check to ensure the *remote* messages don't match the batchId of a pending local batch.
			// This latter case would indicate that the container has forked - two copies are trying to persist the same local changes.
			let messagesWithPendingState: {
				message: ISequencedDocumentMessage;
				localOpMetadata?: unknown;
			}[] = this.pendingStateManager.processInboundMessages(inboundResult, local);

			if (inboundResult.type !== "fullBatch") {
				assert(
					messagesWithPendingState.length === 1,
					0xa3d /* Partial batch should have exactly one message */,
				);
			}

			if (messagesWithPendingState.length === 0) {
				assert(
					inboundResult.type === "fullBatch",
					0xa3e /* Empty batch is always considered a full batch */,
				);
				/**
				 * We need to process an empty batch, which will execute expected actions while processing even if there
				 * are no inner runtime messages.
				 *
				 * Empty batches are produced by the outbox on resubmit when the resubmit flow resulted in no runtime
				 * messages.
				 * This can happen if changes from a remote client "cancel out" the pending changes being resubmitted by
				 * this client.  We submit an empty batch if "offline load" (aka rehydrating from stashed state) is
				 * enabled, to ensure we account for this batch when comparing batchIds, checking for a forked container.
				 * Otherwise, we would not realize this container has forked in the case where it did fork, and a batch
				 * became empty but wasn't submitted as such.
				 */
				messagesWithPendingState = [
					{
						message: inboundResult.batchStart.keyMessage,
						localOpMetadata: undefined,
					},
				];
				// Empty batch message is a non-runtime message as it was generated by the op grouping manager.
				runtimeBatch = false;
			}

			const locationInBatch: { batchStart: boolean; batchEnd: boolean } =
				inboundResult.type === "fullBatch"
					? { batchStart: true, batchEnd: true }
					: inboundResult.type === "batchStartingMessage"
						? { batchStart: true, batchEnd: false }
						: { batchStart: false, batchEnd: inboundResult.batchEnd === true };

			this.processInboundMessages(
				messagesWithPendingState,
				locationInBatch,
				local,
				savedOp,
				runtimeBatch,
				inboundResult.type === "fullBatch"
					? inboundResult.groupedBatch
					: false /* groupedBatch */,
			);
		} else {
			this.processInboundMessages(
				[{ message: messageCopy, localOpMetadata: undefined }],
				{ batchStart: true, batchEnd: true }, // Single message
				local,
				savedOp,
				runtimeBatch,
				false /* groupedBatch */,
			);
		}

		if (local) {
			// If we have processed a local op, this means that the container is
			// making progress and we can reset the counter for how many times
			// we have consecutively replayed the pending states
			this.resetReconnectCount();
		}
	}

	private _processedClientSequenceNumber: number | undefined;

	/**
	 * Processes inbound message(s). It calls delta scheduler according to the messages' location in the batch.
	 * @param messagesWithMetadata - messages to process along with their metadata.
	 * @param locationInBatch - Are we processing the start and/or end of a batch?
	 * @param local - true if the messages were originally generated by the client receiving it.
	 * @param savedOp - true if the message is a replayed saved op.
	 * @param runtimeBatch - true if these are runtime messages.
	 * @param groupedBatch - true if these messages are part of a grouped op batch.
	 */
	private processInboundMessages(
		messagesWithMetadata: {
			message: ISequencedDocumentMessage;
			localOpMetadata?: unknown;
		}[],
		locationInBatch: { batchStart: boolean; batchEnd: boolean },
		local: boolean,
		savedOp: boolean | undefined,
		runtimeBatch: boolean,
		groupedBatch: boolean,
	): void {
		// This message could have been the last pending local (dirtyable) message, in which case we need to update dirty state to "saved"
		this.updateDocumentDirtyState();

		if (locationInBatch.batchStart) {
			const firstMessage = messagesWithMetadata[0]?.message;
			assert(firstMessage !== undefined, 0xa31 /* Batch must have at least one message */);
			this.emit("batchBegin", firstMessage);
		}

		let error: unknown;
		try {
			if (!runtimeBatch) {
				for (const { message } of messagesWithMetadata) {
					this.observeNonRuntimeMessage(message);
				}
				return;
			}

			// Updates a message's minimum sequence number to the minimum sequence number that container
			// runtime is tracking and sets _processedClientSequenceNumber. It returns the updated message.
			const updateSequenceNumbers = (
				message: ISequencedDocumentMessage,
			): InboundSequencedContainerRuntimeMessage => {
				// Set the minimum sequence number to the containerRuntime's understanding of minimum sequence number.
				message.minimumSequenceNumber =
					this.useDeltaManagerOpsProxy &&
					this.deltaManager.minimumSequenceNumber < message.minimumSequenceNumber
						? this.deltaManager.minimumSequenceNumber
						: message.minimumSequenceNumber;
				this._processedClientSequenceNumber = message.clientSequenceNumber;
				return message as InboundSequencedContainerRuntimeMessage;
			};

			// Non-grouped batch messages are processed one at a time.
			if (!groupedBatch) {
				for (const { message, localOpMetadata } of messagesWithMetadata) {
					updateSequenceNumbers(message);
					this.validateAndProcessRuntimeMessages(
						message as InboundSequencedContainerRuntimeMessage,
						[
							{
								contents: message.contents,
								localOpMetadata,
								clientSequenceNumber: message.clientSequenceNumber,
							},
						],
						local,
						savedOp,
					);
					this.emit("op", message, true /* runtimeMessage */);
				}
				return;
			}

			let bunchedMessagesContent: IRuntimeMessagesContent[] = [];
			let previousMessage: InboundSequencedContainerRuntimeMessage | undefined;

			// Process the previous bunch of messages.
			const processBunchedMessages = (): void => {
				assert(previousMessage !== undefined, 0xa67 /* previous message must exist */);
				this.validateAndProcessRuntimeMessages(
					previousMessage,
					bunchedMessagesContent,
					local,
					savedOp,
				);
				bunchedMessagesContent = [];
			};

			/**
			 * For grouped batch messages, bunch contiguous messages of the same type and process them together.
			 * This is an optimization mainly for DDSes, where it can process a bunch of ops together. DDSes
			 * like merge tree or shared tree can process ops more efficiently when they are bunched together.
			 */
			for (const { message, localOpMetadata } of messagesWithMetadata) {
				const currentMessage = updateSequenceNumbers(message);
				if (previousMessage && previousMessage.type !== currentMessage.type) {
					processBunchedMessages();
				}
				previousMessage = currentMessage;
				bunchedMessagesContent.push({
					contents: message.contents,
					localOpMetadata,
					clientSequenceNumber: message.clientSequenceNumber,
				});
			}

			// Process the last bunch of messages.
			processBunchedMessages();

			// Send the "op" events for the messages now that the ops have been processed.
			for (const { message } of messagesWithMetadata) {
				this.emit("op", message, true /* runtimeMessage */);
			}
		} catch (error_) {
			error = error_;
			throw error;
		} finally {
			if (locationInBatch.batchEnd) {
				const lastMessage = messagesWithMetadata[messagesWithMetadata.length - 1]?.message;
				assert(lastMessage !== undefined, 0xa32 /* Batch must have at least one message */);
				this.emit("batchEnd", error, lastMessage);
			}
		}
	}

	/**
	 * Observes messages that are not intended for the runtime layer, updating/notifying Runtime systems as needed.
	 * @param message - non-runtime message to process.
	 */
	private observeNonRuntimeMessage(message: ISequencedDocumentMessage): void {
		// Set the minimum sequence number to the containerRuntime's understanding of minimum sequence number.
		if (this.deltaManager.minimumSequenceNumber < message.minimumSequenceNumber) {
			message.minimumSequenceNumber = this.deltaManager.minimumSequenceNumber;
		}

		this._processedClientSequenceNumber = message.clientSequenceNumber;

		// The DeltaManager used to do this, but doesn't anymore as of Loader v2.4
		// Anyone listening to our "op" event would expect the contents to be parsed per this same logic
		if (
			typeof message.contents === "string" &&
			message.contents !== "" &&
			message.type !== MessageType.ClientLeave
		) {
			message.contents = JSON.parse(message.contents);
		}

		this.emit("op", message, false /* runtimeMessage */);
	}

	/**
	 * Process runtime messages. The messages here are contiguous messages in a batch.
	 * Assuming the messages in the given bunch are also a TypedContainerRuntimeMessage, checks its type and dispatch
	 * the messages to the appropriate handler in the runtime.
	 * Throws a DataProcessingError if the message looks like but doesn't conform to a known TypedContainerRuntimeMessage type.
	 * @param message - The core message with common properties for all the messages.
	 * @param messageContents - The contents, local metadata and clientSequenceNumbers of the messages.
	 * @param local - true if the messages were originally generated by the client receiving it.
	 * @param savedOp - true if the message is a replayed saved op.
	 *
	 */
	private validateAndProcessRuntimeMessages(
		message: Omit<InboundSequencedContainerRuntimeMessage, "contents">,
		messagesContent: IRuntimeMessagesContent[],
		local: boolean,
		savedOp?: boolean,
	): void {
		// Get the contents without the localOpMetadata because not all message types know about localOpMetadata.
		const contents = messagesContent.map((c) => c.contents);

		switch (message.type) {
			case ContainerMessageType.FluidDataStoreOp:
			case ContainerMessageType.Attach:
			case ContainerMessageType.Alias: {
				// Remove the metadata from the message before sending it to the channel collection. The metadata
				// is added by the container runtime and is not part of the message that the channel collection and
				// layers below it expect.
				this.channelCollection.processMessages({ envelope: message, messagesContent, local });
				break;
			}
			case ContainerMessageType.BlobAttach: {
				this.blobManager.processBlobAttachMessage(message, local);
				break;
			}
			case ContainerMessageType.IdAllocation: {
				this.processIdCompressorMessages(contents as IdCreationRange[], savedOp);
				break;
			}
			case ContainerMessageType.GC: {
				this.garbageCollector.processMessages(
					contents as GarbageCollectionMessage[],
					message.timestamp,
					local,
				);
				break;
			}
			case ContainerMessageType.ChunkedOp: {
				// From observability POV, we should not expose the rest of the system (including "op" events on object) to these messages.
				// Also resetReconnectCount() would be wrong - see comment that was there before this change was made.
				assert(false, 0x93d /* should not even get here */);
			}
			case ContainerMessageType.Rejoin: {
				break;
			}
			case ContainerMessageType.DocumentSchemaChange: {
				this.documentsSchemaController.processDocumentSchemaMessages(
					contents as IDocumentSchemaChangeMessageIncoming[],
					local,
					message.sequenceNumber,
				);
				break;
			}
			default: {
				const error = getUnknownMessageTypeError(
					message.type,
					"validateAndProcessRuntimeMessage" /* codePath */,
					message as ISequencedDocumentMessage,
				);
				this.closeFn(error);
				throw error;
			}
		}
	}

	private processIdCompressorMessages(
		messageContents: IdCreationRange[],
		savedOp?: boolean,
	): void {
		for (const range of messageContents) {
			// Don't re-finalize the range if we're processing a "savedOp" in
			// stashed ops flow. The compressor is stashed with these ops already processed.
			// That said, in idCompressorMode === "delayed", we might not serialize ID compressor, and
			// thus we need to process all the ops.
			if (!(this.skipSavedCompressorOps && savedOp === true)) {
				// Some other client turned on the id compressor. If we have not turned it on,
				// put it in a pending queue and delay finalization.
				if (this._idCompressor === undefined) {
					assert(
						this.sessionSchema.idCompressorMode !== undefined,
						0x93c /* id compressor should be enabled */,
					);
					this.pendingIdCompressorOps.push(range);
				} else {
					assert(
						this.pendingIdCompressorOps.length === 0,
						0x979 /* there should be no pending ops! */,
					);
					this._idCompressor.finalizeCreationRange(range);
				}
			}
		}
	}

	public processSignal(
		message: ISignalMessage<{
			type: string;
			content: ISignalEnvelope<{ type: string; content: OpaqueJsonDeserialized<unknown> }>;
		}>,
		local: boolean,
	): void {
		const envelope = message.content;
		const transformed = markUnverified({
			clientId: message.clientId,
			content: envelope.contents.content,
			type: envelope.contents.type,
			targetClientId: message.targetClientId,
		});

		// Only collect signal telemetry for broadcast messages sent by the current client.
		if (message.clientId === this.clientId) {
			this.signalTelemetryManager.trackReceivedSignal(
				envelope,
				this.mc.logger,
				this.consecutiveReconnects,
			);
		}

		const fullAddress = envelope.address;
		if (fullAddress === undefined) {
			// No address indicates a container signal message.
			this.emit("signal", transformed, local);
			return;
		}

		this.routeNonContainerSignal(fullAddress, transformed, local);
	}

	private routeNonContainerSignal(
		address: string,
		signalMessage: IInboundSignalMessage<UnknownIncomingTypedMessage> &
			UnverifiedBrand<UnknownIncomingTypedMessage>,
		local: boolean,
	): void {
		// channelCollection signals are identified by no starting `/` in address.
		if (!address.startsWith("/")) {
			// Due to a mismatch between different layers in terms of
			// what is the interface of passing signals, we need to adjust
			// the signal envelope before sending it to the datastores to be processed
			const channelSignalMessage = {
				...signalMessage,
				content: {
					address,
					contents: signalMessage.content,
				},
			};

			this.channelCollection.processSignal(channelSignalMessage, local);
			return;
		}

		const addresses = address.split("/");
		if (addresses.length > 2 && addresses[1] === "ext") {
			const id = addresses[2] as ContainerExtensionId;
			const entry = this.extensions.get(id);
			if (entry !== undefined) {
				entry.extension.processSignal?.(addresses.slice(3), signalMessage, local);
				return;
			}
		}

		assert(!local, 0xba0 /* No recipient found for local signal */);
		this.mc.logger.sendTelemetryEvent({
			eventName: "SignalAddressNotFound",
			...tagCodeArtifacts({
				address,
			}),
		});
	}

	/**
	 * Flush the current batch of ops to the ordering service for sequencing
	 * This method is not expected to be called in the middle of a batch.
	 * @remarks - If it throws (e.g. if the batch is too large to send), the container will be closed.
	 *
	 * @param resubmitInfo - If defined, indicates this is a resubmission of a batch with the given Batch info needed for resubmit.
	 */
	private flush(resubmitInfo?: BatchResubmitInfo): void {
		this.flushScheduled = false;

		try {
			assert(
				!this.batchRunner.running,
				0x24c /* "Cannot call `flush()` while manually accumulating a batch (e.g. under orderSequentially) */,
			);

			this.outbox.flush(resubmitInfo);
			assert(this.outbox.isEmpty, 0x3cf /* reentrancy */);
		} catch (error) {
			const error2 = normalizeError(error, {
				props: {
					orderSequentiallyCalls: this.batchRunner.runs,
				},
			});
			this.closeFn(error2);
			throw error2;
		}
	}

	/**
	 * {@inheritDoc @fluidframework/runtime-definitions#IContainerRuntimeBase.orderSequentially}
	 */
	public orderSequentially<T>(callback: () => T): T {
		let checkpoint: IBatchCheckpoint | undefined;
		// eslint-disable-next-line import/no-deprecated
		let stageControls: StageControlsExperimental | undefined;
		if (this.mc.config.getBoolean("Fluid.ContainerRuntime.EnableRollback")) {
			if (!this.batchRunner.running && !this.inStagingMode) {
				stageControls = this.enterStagingMode();
			}
			// Note: we are not touching any batches other than mainBatch here, for two reasons:
			// 1. It would not help, as other batches are flushed independently from main batch.
			// 2. There is no way to undo process of data store creation, blob creation, ID compressor ops, or other things tracked by other batches.
			checkpoint = this.outbox.getBatchCheckpoints().mainBatch;
		}
		const result = this.batchRunner.run(() => {
			try {
				return callback();
			} catch (error) {
				if (checkpoint) {
					// This will throw and close the container if rollback fails
					try {
						checkpoint.rollback((message: LocalBatchMessage) =>
							// These changes are staged since we entered staging mode above
							this.rollbackStagedChange(message.runtimeOp, message.localOpMetadata),
						);
						this.updateDocumentDirtyState();
						stageControls?.discardChanges();
						stageControls = undefined;
					} catch (error_) {
						const error2 = wrapError(error_, (message) => {
							return DataProcessingError.create(
								`RollbackError: ${message}`,
								"checkpointRollback",
								undefined,
							) as DataProcessingError;
						});
						this.closeFn(error2);
						throw error2;
					}
				} else {
					this.closeFn(
						wrapError(
							error,
							(errorMessage) =>
								new GenericError(
									`orderSequentially callback exception: ${errorMessage}`,
									error,
									{
										orderSequentiallyCalls: this.batchRunner.runs,
									},
								),
						),
					);
				}

				throw error; // throw the original error for the consumer of the runtime
			}
		});

		stageControls?.commitChanges({ squash: false });

		// We don't flush on TurnBased since we expect all messages in the same JS turn to be part of the same batch
		if (this.flushMode !== FlushMode.TurnBased && !this.batchRunner.running) {
			this.flush();
		}
		return result;
	}

	// eslint-disable-next-line import/no-deprecated
	private stageControls: StageControlsExperimental | undefined;

	/**
	 * If true, the ContainerRuntime is not submitting any new ops to the ordering service.
	 * Ops submitted to the ContainerRuntime while in Staging Mode will be queued in the PendingStateManager,
	 * either to be discarded or committed later (via the Stage Controls returned from enterStagingMode).
	 */
	public get inStagingMode(): boolean {
		return this.stageControls !== undefined;
	}

	/**
	 * Enter Staging Mode, such that ops submitted to the ContainerRuntime will not be sent to the ordering service.
	 * To exit Staging Mode, call either discardChanges or commitChanges on the Stage Controls returned from this method.
	 *
	 * @returns StageControlsExperimental - Controls for exiting Staging Mode.
	 */
	// eslint-disable-next-line import/no-deprecated
	public enterStagingMode = (): StageControlsExperimental => {
		if (this.stageControls !== undefined) {
			throw new UsageError("Already in staging mode");
		}
		if (this.attachState === AttachState.Detached) {
			throw new UsageError("Cannot enter staging mode while Detached");
		}

		// Make sure Outbox is empty before entering staging mode,
		// since we mark whole batches as "staged" or not to indicate whether to submit them.
		this.flush();

		const exitStagingMode = (discardOrCommit: () => void): void => {
			try {
				// Final flush of any last staged changes
				// NOTE: We can't use this.flush() here, because orderSequentially uses StagingMode and in the rollback case we'll hit assert 0x24c
				this.outbox.flush();

				this.stageControls = undefined;

				// During Staging Mode, we avoid submitting any ID Allocation ops (apart from resubmitting pre-staging ops).
				// Now that we've exited, we need to submit an ID Allocation op for any IDs that were generated while in Staging Mode.
				this.submitIdAllocationOpIfNeeded({ staged: false });
				discardOrCommit();

				this.channelCollection.notifyStagingMode(false);
			} catch (error) {
				const normalizedError = normalizeError(error);
				this.closeFn(normalizedError);
				throw normalizedError;
			}
		};

		// eslint-disable-next-line import/no-deprecated
		const stageControls: StageControlsExperimental = {
			discardChanges: () =>
				exitStagingMode(() => {
					// Pop all staged batches from the PSM and roll them back in LIFO order
					this.pendingStateManager.popStagedBatches(({ runtimeOp, localOpMetadata }) => {
						this.rollbackStagedChange(runtimeOp, localOpMetadata);
					});
					this.updateDocumentDirtyState();
				}),
			commitChanges: (options) => {
				const { squash } = { ...defaultStagingCommitOptions, ...options };
				exitStagingMode(() => {
					// Replay all staged batches in typical FIFO order.
					// We'll be out of staging mode so they'll be sent to the service finally.
					this.pendingStateManager.replayPendingStates({
						committingStagedBatches: true,
						squash,
					});
				});
			},
		};

		this.stageControls = stageControls;
		this.channelCollection.notifyStagingMode(true);

		return this.stageControls;
	};

	/**
	 * Returns the aliased data store's entryPoint, given the alias.
	 * @param alias - The alias for the data store.
	 * @returns The data store's entry point ({@link @fluidframework/core-interfaces#IFluidHandle}) if it exists and is aliased.
	 * Returns undefined if no data store has been assigned the given alias.
	 */
	public async getAliasedDataStoreEntryPoint(
		alias: string,
	): Promise<IFluidHandle<FluidObject> | undefined> {
		// Back-comapatibility:
		// There are old files that were created without using data store aliasing feature, but
		// used createRoot*DataStore*() (already removed) API. Such data stores will have isRoot = true,
		// and internalID provided by user. The expectation is that such files behave as new files, where
		// same data store instances created using aliasing feature.
		// Please also see note on name collisions in DataStores.createDataStoreId()
		await this.channelCollection.waitIfPendingAlias(alias);
		const internalId = this.internalId(alias);
		const context = await this.channelCollection.getDataStoreIfAvailable(internalId, {
			wait: false,
		});
		// If the data store is not available or not an alias, return undefined.
		if (context === undefined || !(await context.isRoot())) {
			return undefined;
		}

		const channel = await context.realize();
		if (channel.entryPoint === undefined) {
			throw new UsageError(
				"entryPoint must be defined on data store runtime for using getAliasedDataStoreEntryPoint",
			);
		}
		this.garbageCollector.nodeUpdated({
			node: { type: "DataStore", path: `/${internalId}` },
			reason: "Loaded",
			packagePath: context.packagePath,
			timestampMs: this.getCurrentReferenceTimestampMs(),
		});
		return channel.entryPoint;
	}

	public createDetachedDataStore(
		pkg: Readonly<string[]>,
		loadingGroupId?: string,
	): IFluidDataStoreContextDetached {
		return this.channelCollection.createDetachedDataStore(pkg, loadingGroupId);
	}

	public async createDataStore(
		pkg: Readonly<string | string[]>,
		loadingGroupId?: string,
	): Promise<IDataStore> {
		const context = this.channelCollection.createDataStoreContext(
			Array.isArray(pkg) ? pkg : [pkg],
			loadingGroupId,
		);
		return channelToDataStore(
			await context.realize(),
			context.id,
			this.channelCollection,
			this.mc.logger,
		);
	}

	private shouldSendOps(): boolean {
		// Note that the real (non-proxy) delta manager is needed here to get the readonly info. This is because
		// container runtime's ability to send ops depend on the actual readonly state of the delta manager.
		return this.connected && !this.innerDeltaManager.readOnlyInfo.readonly;
	}

	private readonly _quorum: IQuorumClients;
	public getQuorum(): IQuorumClients {
		return this._quorum;
	}

	private readonly _audience: IAudience;
	public getAudience(): IAudience {
		return this._audience;
	}

	/**
	 * Returns true of container is dirty, i.e. there are some pending local changes that
	 * either were not sent out to delta stream or were not yet acknowledged.
	 */
	public get isDirty(): boolean {
		// Rather than recomputing the dirty state in this moment,
		// just regurgitate the last emitted dirty state.
		return this.lastEmittedDirty;
	}

	/**
	 * Returns true if the container is dirty: not attached, or no pending user messages (could be some "non-dirtyable" ones though)
	 */
	private computeCurrentDirtyState(): boolean {
		return (
			this.attachState !== AttachState.Attached ||
			this.pendingStateManager.hasPendingUserChanges() ||
			this.outbox.containsUserChanges()
		);
	}

	/**
	 * Submits the signal to be sent to other clients.
	 * @param type - Type of the signal.
	 * @param content - Content of the signal. Should be a JSON serializable object or primitive.
	 * @param targetClientId - When specified, the signal is only sent to the provided client id.
	 *
	 * @remarks
	 *
	 * The `targetClientId` parameter here is currently intended for internal testing purposes only.
	 * Support for this option at container runtime is planned to be deprecated in the future.
	 *
	 */
	public submitSignal(type: string, content: unknown, targetClientId?: string): void {
		this.verifyNotClosed();
		const envelope = createNewSignalEnvelope(undefined /* address */, type, content);
		this.submitSignalFn(envelope, targetClientId);
	}

	public setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void {
		if (attachState === AttachState.Attaching) {
			assert(
				this.attachState === AttachState.Attaching,
				0x12d /* "Container Context should already be in attaching state" */,
			);
		} else {
			assert(
				this.attachState === AttachState.Attached,
				0x12e /* "Container Context should already be in attached state" */,
			);
			this.emit("attached");
		}

		this.updateDocumentDirtyState();
		this.channelCollection.setAttachState(attachState);
	}

	/**
	 * Create a summary. Used when attaching or serializing a detached container.
	 *
	 * @param blobRedirectTable - A table passed during the attach process. While detached, blob upload is supported
	 * using IDs generated locally. After attach, these IDs cannot be used, so this table maps the old local IDs to the
	 * new storage IDs so requests can be redirected.
	 * @param telemetryContext - summary data passed through the layers for telemetry purposes
	 */
	public createSummary(
		blobRedirectTable?: Map<string, string>,
		telemetryContext?: ITelemetryContext,
	): ISummaryTree {
		if (blobRedirectTable) {
			this.blobManager.setRedirectTable(blobRedirectTable);
		}

		// We can finalize any allocated IDs since we're the only client
		const idRange = this._idCompressor?.takeNextCreationRange();
		if (idRange !== undefined) {
			assert(
				idRange.ids === undefined || idRange.ids.firstGenCount === 1,
				0x93e /* No other ranges should be taken while container is detached. */,
			);
			this._idCompressor?.finalizeCreationRange(idRange);
		}

		const summarizeResult = this.channelCollection.getAttachSummary(telemetryContext);
		// Wrap data store summaries in .channels subtree.
		wrapSummaryInChannelsTree(summarizeResult);

		this.addContainerStateToSummary(
			summarizeResult,
			true /* fullTree */,
			false /* trackState */,
			telemetryContext,
		);
		return summarizeResult.summary;
	}

	public readonly getAbsoluteUrl: (relativeUrl: string) => Promise<string | undefined>;

	/**
	 * Builds the Summary tree including all the channels and the container state.
	 *
	 * @remarks - Unfortunately, this function is accessed in a non-typesafe way by a legacy first-party partner,
	 * so until we can provide a proper API for their scenario, we need to ensure this function doesn't change.
	 */
	private async summarizeInternal(
		fullTree: boolean,
		trackState: boolean,
		telemetryContext?: ITelemetryContext,
	): Promise<ISummarizeInternalResult> {
		const summarizeResult = await this.channelCollection.summarize(
			fullTree,
			trackState,
			telemetryContext,
		);

		// Wrap data store summaries in .channels subtree.
		wrapSummaryInChannelsTree(summarizeResult);
		const pathPartsForChildren = [channelsTreeName];

		this.loadIdCompressor();

		this.addContainerStateToSummary(summarizeResult, fullTree, trackState, telemetryContext);
		return {
			...summarizeResult,
			id: "",
			pathPartsForChildren,
		};
	}

	/**
	 * Returns a summary of the runtime at the current sequence number.
	 */
	public async summarize(options: {
		/**
		 * True to generate the full tree with no handle reuse optimizations; defaults to false
		 */
		fullTree?: boolean;
		/**
		 * True to track the state for this summary in the SummarizerNodes; defaults to true
		 */
		trackState?: boolean;
		/**
		 * Logger to use for correlated summary events
		 */
		summaryLogger?: ITelemetryLoggerExt;
		/**
		 * True to run garbage collection before summarizing; defaults to true
		 */
		runGC?: boolean;
		/**
		 * True to generate full GC data
		 */
		fullGC?: boolean;
		/**
		 * True to run GC sweep phase after the mark phase
		 */
		runSweep?: boolean;
	}): Promise<ISummaryTreeWithStats> {
		this.verifyNotClosed();

		const {
			fullTree = false,
			trackState = true,
			summaryLogger = this.mc.logger,
			runGC = this.garbageCollector.shouldRunGC,
			runSweep,
			fullGC,
		} = options;

		const telemetryContext = new TelemetryContext();
		// Add the options that are used to generate this summary to the telemetry context.
		telemetryContext.setMultiple("fluid_Summarize", "Options", {
			fullTree,
			trackState,
			runGC,
			fullGC,
			runSweep,
		});

		try {
			if (runGC) {
				await this.collectGarbage(
					{ logger: summaryLogger, runSweep, fullGC },
					telemetryContext,
				);
			}

			const { stats, summary } = await this.summarizerNode.summarize(
				fullTree,
				trackState,
				telemetryContext,
			);

			assert(
				summary.type === SummaryType.Tree,
				0x12f /* "Container Runtime's summarize should always return a tree" */,
			);

			return { stats, summary };
		} finally {
			summaryLogger.sendTelemetryEvent({
				eventName: "SummarizeTelemetry",
				details: telemetryContext.serialize(),
			});
		}
	}

	private async getGCDataInternal(fullGC?: boolean): Promise<IGarbageCollectionData> {
		return this.channelCollection.getGCData(fullGC);
	}

	/**
	 * Generates and returns the GC data for this container.
	 * @param fullGC - true to bypass optimizations and force full generation of GC data.
	 * @see IGarbageCollectionRuntime.getGCData
	 */
	public async getGCData(fullGC?: boolean): Promise<IGarbageCollectionData> {
		const builder = new GCDataBuilder();
		const dsGCData = await this.summarizerNode.getGCData(fullGC);
		builder.addNodes(dsGCData.gcNodes);

		const blobsGCData = this.blobManager.getGCData(fullGC);
		builder.addNodes(blobsGCData.gcNodes);
		return builder.getGCData();
	}

	/**
	 * After GC has run, called to notify this container's nodes of routes that are used in it.
	 * @param usedRoutes - The routes that are used in all nodes in this Container.
	 * @see IGarbageCollectionRuntime.updateUsedRoutes
	 */
	public updateUsedRoutes(usedRoutes: readonly string[]): void {
		// Update our summarizer node's used routes. Updating used routes in summarizer node before
		// summarizing is required and asserted by the the summarizer node. We are the root and are
		// always referenced, so the used routes is only self-route (empty string).
		this.summarizerNode.updateUsedRoutes([""]);

		const { dataStoreRoutes } = this.getDataStoreAndBlobManagerRoutes(usedRoutes);
		this.channelCollection.updateUsedRoutes(dataStoreRoutes);
	}

	/**
	 * After GC has run and identified nodes that are sweep ready, this is called to delete the sweep ready nodes.
	 * @param sweepReadyRoutes - The routes of nodes that are sweep ready and should be deleted.
	 * @returns The routes of nodes that were deleted.
	 */
	public deleteSweepReadyNodes(sweepReadyRoutes: readonly string[]): readonly string[] {
		const { dataStoreRoutes, blobManagerRoutes } =
			this.getDataStoreAndBlobManagerRoutes(sweepReadyRoutes);

		return [
			...this.channelCollection.deleteSweepReadyNodes(dataStoreRoutes),
			...this.blobManager.deleteSweepReadyNodes(blobManagerRoutes),
		];
	}

	/**
	 * This is called to update objects that are tombstones.
	 *
	 * A Tombstoned object has been unreferenced long enough that GC knows it won't be referenced again.
	 * Tombstoned objects are eventually deleted by GC.
	 *
	 * @param tombstonedRoutes - Data store and attachment blob routes that are tombstones in this Container.
	 */
	public updateTombstonedRoutes(tombstonedRoutes: readonly string[]): void {
		const { dataStoreRoutes } = this.getDataStoreAndBlobManagerRoutes(tombstonedRoutes);
		this.channelCollection.updateTombstonedRoutes(dataStoreRoutes);
	}

	/**
	 * Returns a server generated referenced timestamp to be used to track unreferenced nodes by GC.
	 */
	public getCurrentReferenceTimestampMs(): number | undefined {
		// Use the timestamp of the last message seen by this client as that is server generated. If no messages have
		// been processed, use the timestamp of the message from the last summary.
		return this.deltaManager.lastMessage?.timestamp ?? this.messageAtLastSummary?.timestamp;
	}

	/**
	 * Returns the type of the GC node. Currently, there are nodes that belong to the root ("/"), data stores or
	 * blob manager.
	 */

	public getNodeType(nodePath: string): GCNodeType {
		if (isBlobPath(nodePath)) {
			return GCNodeType.Blob;
		}

		return this.channelCollection.getGCNodeType(nodePath) ?? GCNodeType.Other;
	}

	/**
	 * Called by GC to retrieve the package path of the node with the given path. The node should belong to a
	 * data store or an attachment blob.
	 */
	public async getGCNodePackagePath(nodePath: string): Promise<readonly string[] | undefined> {
		// GC uses "/" when adding "root" references, e.g. for Aliasing or as part of Tombstone Auto-Recovery.
		// These have no package path so return a special value.
		if (nodePath === "/") {
			return ["_gcRoot"];
		}

		switch (this.getNodeType(nodePath)) {
			case GCNodeType.Blob: {
				return [blobManagerBasePath];
			}

			case GCNodeType.DataStore:

			case GCNodeType.SubDataStore: {
				return this.channelCollection.getDataStorePackagePath(nodePath);
			}
			default: {
				assert(false, 0x2de /* "Package path requested for unsupported node type." */);
			}
		}
	}

	/**
	 * From a given list of routes, separate and return routes that belong to blob manager and data stores.
	 * @param routes - A list of routes that can belong to data stores or blob manager.
	 * @returns Two route lists - One that contains routes for blob manager and another one that contains routes
	 * for data stores.
	 */
	private getDataStoreAndBlobManagerRoutes(routes: readonly string[]): {
		blobManagerRoutes: string[];
		dataStoreRoutes: string[];
	} {
		const blobManagerRoutes: string[] = [];
		const dataStoreRoutes: string[] = [];
		for (const route of routes) {
			if (isBlobPath(route)) {
				blobManagerRoutes.push(route);
			} else {
				dataStoreRoutes.push(route);
			}
		}
		return { blobManagerRoutes, dataStoreRoutes };
	}

	/**
	 * Runs garbage collection and updates the reference / used state of the nodes in the container.
	 * @returns the statistics of the garbage collection run; undefined if GC did not run.
	 */
	public async collectGarbage(
		options: {
			/**
			 * Logger to use for logging GC events
			 */
			logger?: ITelemetryLoggerExt;
			/**
			 * True to run GC sweep phase after the mark phase
			 */
			runSweep?: boolean;
			/**
			 * True to generate full GC data
			 */
			fullGC?: boolean;
		},
		telemetryContext?: ITelemetryContext,
	): Promise<IGCStats | undefined> {
		return this.garbageCollector.collectGarbage(options, telemetryContext);
	}

	/**
	 * Called when a new outbound route is added to another node. This is used by garbage collection to identify
	 * all references added in the system.
	 * @param fromPath - The absolute path of the node that added the reference.
	 * @param toPath - The absolute path of the outbound node that is referenced.
	 * @param messageTimestampMs - The timestamp of the message that added the reference.
	 */
	public addedGCOutboundRoute(
		fromPath: string,
		toPath: string,
		messageTimestampMs?: number,
	): void {
		// This is always called when processing an op so messageTimestampMs should exist. Due to back-compat
		// across the data store runtime / container runtime boundary, this may be undefined and if so, get
		// the timestamp from the last processed message which should exist.
		// If a timestamp doesn't exist, log so we can learn about these cases and return.
		const timestampMs = messageTimestampMs ?? this.getCurrentReferenceTimestampMs();
		if (timestampMs === undefined) {
			this.mc.logger.sendTelemetryEvent({
				eventName: "NoTimestampInGCOutboundRoute",
				...tagCodeArtifacts({
					id: toPath,
					fromId: fromPath,
				}),
			});
			return;
		}
		this.garbageCollector.addedOutboundReference(fromPath, toPath, timestampMs);
	}

	/**
	 * Generates the summary tree, uploads it to storage, and then submits the summarize op.
	 * This is intended to be called by the summarizer, since it is the implementation of
	 * ISummarizerInternalsProvider.submitSummary.
	 * It takes care of state management at the container level, including pausing inbound
	 * op processing, updating SummarizerNode state tracking, and garbage collection.
	 * @param options - options controlling how the summary is generated or submitted
	 */

	public async submitSummary(options: ISubmitSummaryOptions): Promise<SubmitSummaryResult> {
		const {
			cancellationToken,
			fullTree = false,
			finalAttempt = false,
			summaryLogger,
			latestSummaryRefSeqNum,
		} = options;
		// The summary number for this summary. This will be updated during the summary process, so get it now and
		// use it for all events logged during this summary.
		const summaryNumber = this.nextSummaryNumber;
		let summaryRefSeqNum: number | undefined;
		const summaryNumberLogger = createChildLogger({
			logger: summaryLogger,
			properties: {
				all: {
					summaryNumber,
					referenceSequenceNumber: () => summaryRefSeqNum,
				},
			},
		});

		// legacy: assert 0x3d1
		if (!this.outbox.isEmpty) {
			throw DataProcessingError.create(
				"Can't trigger summary in the middle of a batch",
				"submitSummary",
				undefined,
				{
					summaryNumber,
					pendingMessages: this.pendingMessagesCount,
					outboxLength: this.outbox.messageCount,
					mainBatchLength: this.outbox.mainBatchMessageCount,
					blobAttachBatchLength: this.outbox.blobAttachBatchMessageCount,
					idAllocationBatchLength: this.outbox.idAllocationBatchMessageCount,
				},
			);
		}

		// If the container is dirty, i.e., there are pending unacked ops, the summary will not be eventual consistent
		// and it may even be incorrect. So, wait for the container to be saved with a timeout. If the container is not
		// saved within the timeout, check if it should be failed or can continue.
		if (this.isDirty) {
			const countBefore = this.pendingMessagesCount;
			// The timeout for waiting for pending ops can be overridden via configurations.
			const pendingOpsTimeout =
				this.mc.config.getNumber("Fluid.Summarizer.waitForPendingOpsTimeoutMs") ??
				defaultPendingOpsWaitTimeoutMs;
			await new Promise<void>((resolve, reject) => {
				const timeoutId = setTimeout(() => resolve(), pendingOpsTimeout);
				this.once("saved", () => {
					clearTimeout(timeoutId);
					resolve();
				});
				this.once("dispose", () => {
					clearTimeout(timeoutId);
					reject(new Error("Runtime is disposed while summarizing"));
				});
			});

			// Log that there are pending ops while summarizing. This will help us gather data on how often this
			// happens, whether we attempted to wait for these ops to be acked and what was the result.
			summaryNumberLogger.sendTelemetryEvent({
				eventName: "PendingOpsWhileSummarizing",
				saved: !this.isDirty,
				timeout: pendingOpsTimeout,
				countBefore,
				countAfter: this.pendingMessagesCount,
			});

			// There could still be pending ops. Check if summary should fail or continue.
			const pendingMessagesFailResult = await this.shouldFailSummaryOnPendingOps(
				summaryNumberLogger,
				this.deltaManager.lastSequenceNumber,
				this.deltaManager.minimumSequenceNumber,
				finalAttempt,
				true /* beforeSummaryGeneration */,
			);
			if (pendingMessagesFailResult !== undefined) {
				return pendingMessagesFailResult;
			}
		}

		const shouldPauseInboundSignal =
			this.mc.config.getBoolean(
				"Fluid.ContainerRuntime.SubmitSummary.disableInboundSignalPause",
			) !== true;
		const shouldValidatePreSummaryState =
			this.mc.config.getBoolean(
				"Fluid.ContainerRuntime.SubmitSummary.shouldValidatePreSummaryState",
			) === true;

		try {
			await this._deltaManager.inbound.pause();
			if (shouldPauseInboundSignal) {
				await this.deltaManager.inboundSignal.pause();
			}

			summaryRefSeqNum = this.deltaManager.lastSequenceNumber;
			const minimumSequenceNumber = this.deltaManager.minimumSequenceNumber;
			const message = `Summary @${summaryRefSeqNum}:${this.deltaManager.minimumSequenceNumber}`;
			const lastAckedContext = this.lastAckedSummaryContext;

			const startSummaryResult = this.summarizerNode.startSummary(
				summaryRefSeqNum,
				summaryNumberLogger,
				latestSummaryRefSeqNum,
			);

			/**
			 * This was added to validate that the summarizer node tree has the same reference sequence number from the
			 * top running summarizer down to the lowest summarizer node.
			 *
			 * The order of mismatch numbers goes (validate sequence number)-(node sequence number).
			 * Generally the validate sequence number comes from the running summarizer and the node sequence number comes from the
			 * summarizer nodes.
			 */
			if (startSummaryResult.invalidNodes > 0 || startSummaryResult.mismatchNumbers.size > 0) {
				summaryLogger.sendTelemetryEvent({
					eventName: "LatestSummaryRefSeqNumMismatch",
					details: {
						...startSummaryResult,
						mismatchNumbers: [...startSummaryResult.mismatchNumbers],
					},
				});

				if (shouldValidatePreSummaryState && !finalAttempt) {
					return {
						stage: "base",
						referenceSequenceNumber: summaryRefSeqNum,
						minimumSequenceNumber,
						error: new RetriableSummaryError(
							`Summarizer node state inconsistent with summarizer state.`,
						),
					};
				}
			}

			// Helper function to check whether we should still continue between each async step.
			const checkContinue = (): { continue: true } | { continue: false; error: string } => {
				// Do not check for loss of connectivity directly! Instead leave it up to
				// RunWhileConnectedCoordinator to control policy in a single place.
				// This will allow easier change of design if we chose to. For example, we may chose to allow
				// summarizer to reconnect in the future.
				// Also checking for cancellation is a must as summary process may be abandoned for other reasons,
				// like loss of connectivity for main (interactive) client.
				if (cancellationToken.cancelled) {
					return { continue: false, error: "disconnected" };
				}
				// That said, we rely on submitSystemMessage() that today only works in connected state.
				// So if we fail here, it either means that RunWhileConnectedCoordinator does not work correctly,
				// OR that design changed and we need to remove this check and fix submitSystemMessage.
				assert(this.connected, 0x258 /* "connected" */);

				// Ensure that lastSequenceNumber has not changed after pausing.
				// We need the summary op's reference sequence number to match our summary sequence number,
				// otherwise we'll get the wrong sequence number stamped on the summary's .protocol attributes.
				if (this.deltaManager.lastSequenceNumber !== summaryRefSeqNum) {
					return {
						continue: false,
						error: `lastSequenceNumber changed before uploading to storage. ${this.deltaManager.lastSequenceNumber} !== ${summaryRefSeqNum}`,
					};
				}
				assert(
					summaryRefSeqNum === this.deltaManager.lastMessage?.sequenceNumber,
					0x395 /* it's one and the same thing */,
				);

				if (lastAckedContext !== this.lastAckedSummaryContext) {
					return {
						continue: false,
						error: `Last summary changed while summarizing. ${this.lastAckedSummaryContext} !== ${lastAckedContext}`,
					};
				}
				return { continue: true };
			};

			let continueResult = checkContinue();
			if (!continueResult.continue) {
				return {
					stage: "base",
					referenceSequenceNumber: summaryRefSeqNum,
					minimumSequenceNumber,
					error: new RetriableSummaryError(continueResult.error),
				};
			}

			const trace = Trace.start();
			let summarizeResult: ISummaryTreeWithStats;
			try {
				summarizeResult = await this.summarize({
					fullTree,
					trackState: true,
					summaryLogger: summaryNumberLogger,
					runGC: this.garbageCollector.shouldRunGC,
				});
			} catch (error) {
				return {
					stage: "base",
					referenceSequenceNumber: summaryRefSeqNum,
					minimumSequenceNumber,
					error: wrapError(error, (msg) => new RetriableSummaryError(msg)),
				};
			}

			// Validate that the summary generated by summarizer nodes is correct before uploading.
			const validateResult = this.summarizerNode.validateSummary();
			if (!validateResult.success) {
				const { success, ...loggingProps } = validateResult;
				const error = new RetriableSummaryError(
					validateResult.reason,
					validateResult.retryAfterSeconds,
					{ ...loggingProps },
				);
				return {
					stage: "base",
					referenceSequenceNumber: summaryRefSeqNum,
					minimumSequenceNumber,
					error,
				};
			}

			// If there are pending unacked ops, this summary attempt may fail as the uploaded
			// summary would be eventually inconsistent.
			const pendingMessagesFailResult = await this.shouldFailSummaryOnPendingOps(
				summaryNumberLogger,
				summaryRefSeqNum,
				minimumSequenceNumber,
				finalAttempt,
				false /* beforeSummaryGeneration */,
			);
			if (pendingMessagesFailResult !== undefined) {
				return pendingMessagesFailResult;
			}

			const { summary: summaryTree, stats: partialStats } = summarizeResult;

			// Now that we have generated the summary, update the message at last summary to the last message processed.
			this.messageAtLastSummary = this.deltaManager.lastMessage;

			// Counting dataStores and handles
			// Because handles are unchanged dataStores in the current logic,
			// summarized dataStore count is total dataStore count minus handle count
			const dataStoreTree = summaryTree.tree[channelsTreeName];

			assert(dataStoreTree.type === SummaryType.Tree, 0x1fc /* "summary is not a tree" */);
			const handleCount = Object.values(dataStoreTree.tree).filter(
				(value) => value.type === SummaryType.Handle,
			).length;
			const gcSummaryTreeStats = summaryTree.tree[gcTreeKey]
				? calculateStats(summaryTree.tree[gcTreeKey])
				: undefined;

			const summaryStats: IGeneratedSummaryStats = {
				dataStoreCount: this.channelCollection.size,
				summarizedDataStoreCount: this.channelCollection.size - handleCount,
				gcStateUpdatedDataStoreCount: this.garbageCollector.updatedDSCountSinceLastSummary,
				gcBlobNodeCount: gcSummaryTreeStats?.blobNodeCount,
				gcTotalBlobsSize: gcSummaryTreeStats?.totalBlobSize,
				summaryNumber,
				...partialStats,
			};
			const generateSummaryData: Omit<IGenerateSummaryTreeResult, "stage" | "error"> = {
				referenceSequenceNumber: summaryRefSeqNum,
				minimumSequenceNumber,
				summaryTree,
				summaryStats,
				generateDuration: trace.trace().duration,
			} as const;

			continueResult = checkContinue();
			if (!continueResult.continue) {
				return {
					stage: "generate",
					...generateSummaryData,
					error: new RetriableSummaryError(continueResult.error),
				};
			}

			const summaryContext: ISummaryContext = {
				proposalHandle: this.lastAckedSummaryContext?.proposalHandle ?? undefined,
				ackHandle: this.lastAckedSummaryContext?.ackHandle ?? this.loadedFromVersionId,
				referenceSequenceNumber: summaryRefSeqNum,
			};

			let handle: string;
			try {
				handle = await this.storage.uploadSummaryWithContext(summaryTree, summaryContext);
			} catch (error) {
				return {
					stage: "generate",
					...generateSummaryData,
					error: wrapError(error, (msg) => new RetriableSummaryError(msg)),
				};
			}

			const parent = summaryContext.ackHandle;
			const summaryMessage: ISummaryContent = {
				handle,
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				head: parent!,
				message,
				parents: parent ? [parent] : [],
			};
			const uploadData = {
				...generateSummaryData,
				handle,
				uploadDuration: trace.trace().duration,
			} as const;

			continueResult = checkContinue();
			if (!continueResult.continue) {
				return {
					stage: "upload",
					...uploadData,
					error: new RetriableSummaryError(continueResult.error),
				};
			}

			let clientSequenceNumber: number;
			try {
				clientSequenceNumber = this.submitSummaryMessage(summaryMessage, summaryRefSeqNum);
			} catch (error) {
				return {
					stage: "upload",
					...uploadData,
					error: wrapError(error, (msg) => new RetriableSummaryError(msg)),
				};
			}

			const submitData = {
				stage: "submit",
				...uploadData,
				clientSequenceNumber,
				submitOpDuration: trace.trace().duration,
			} as const;

			try {
				this.summarizerNode.completeSummary(handle);
			} catch (error) {
				return {
					stage: "upload",
					...uploadData,
					error: wrapError(error, (msg) => new RetriableSummaryError(msg)),
				};
			}
			return submitData;
		} finally {
			// Cleanup wip summary in case of failure
			this.summarizerNode.clearSummary();

			// ! This needs to happen before we resume inbound queues to ensure heuristics are tracked correctly
			this._summarizer?.recordSummaryAttempt?.(summaryRefSeqNum);

			// Restart the delta manager
			this._deltaManager.inbound.resume();
			if (shouldPauseInboundSignal) {
				this.deltaManager.inboundSignal.resume();
			}
		}
	}

	/**
	 * This helper is called during summarization. If the container is dirty, it will return a failed summarize result
	 * (IBaseSummarizeResult) unless this is the final summarize attempt and SkipFailingIncorrectSummary option is set.
	 * @param logger - The logger to be used for sending telemetry.
	 * @param referenceSequenceNumber - The reference sequence number of the summary attempt.
	 * @param minimumSequenceNumber - The minimum sequence number of the summary attempt.
	 * @param finalAttempt - Whether this is the final summary attempt.
	 * @param beforeSummaryGeneration - Whether this is called before summary generation or after.
	 * @returns failed summarize result (IBaseSummarizeResult) if summary should be failed, undefined otherwise.
	 */
	private async shouldFailSummaryOnPendingOps(
		logger: ITelemetryLoggerExt,
		referenceSequenceNumber: number,
		minimumSequenceNumber: number,
		finalAttempt: boolean,
		beforeSummaryGeneration: boolean,
	): Promise<IBaseSummarizeResult | undefined> {
		if (!this.isDirty) {
			return;
		}

		// If "SkipFailingIncorrectSummary" option is true, don't fail the summary in the last attempt.
		// This is a fallback to make progress in documents where there are consistently pending ops in
		// the summarizer.
		if (
			finalAttempt &&
			this.mc.config.getBoolean("Fluid.Summarizer.SkipFailingIncorrectSummary")
		) {
			const error = DataProcessingError.create(
				"Pending ops during summarization",
				"submitSummary",
				undefined,
				{ pendingMessages: this.pendingMessagesCount },
			);
			logger.sendErrorEvent(
				{
					eventName: "SkipFailingIncorrectSummary",
					referenceSequenceNumber,
					minimumSequenceNumber,
					beforeGenerate: beforeSummaryGeneration,
				},
				error,
			);
		} else {
			// The retry delay when there are pending ops can be overridden via config so that we can adjust it
			// based on telemetry while we decide on a stable number.
			const retryDelayMs =
				this.mc.config.getNumber("Fluid.Summarizer.PendingOpsRetryDelayMs") ??
				defaultPendingOpsRetryDelayMs;
			const error = new RetriableSummaryError(
				"PendingOpsWhileSummarizing",
				retryDelayMs / 1000,
				{
					count: this.pendingMessagesCount,
					beforeGenerate: beforeSummaryGeneration,
				},
			);
			return {
				stage: "base",
				referenceSequenceNumber,
				minimumSequenceNumber,
				error,
			};
		}
	}

	private get pendingMessagesCount(): number {
		return this.pendingStateManager.pendingMessagesCount + this.outbox.messageCount;
	}

	private hasPendingMessages(): boolean {
		return this.pendingMessagesCount !== 0;
	}

	/**
	 * Emit "dirty" or "saved" event based on the current dirty state of the document.
	 * This must be called every time the states underlying the dirty state change.
	 *
	 * @privateRemarks - It's helpful to think of this as an event handler registered
	 * for hypothetical "changed" events for PendingStateManager, Outbox, and Container Attach machinery.
	 * But those events don't exist so we manually call this wherever we know those changes happen.
	 */
	private updateDocumentDirtyState(): void {
		const dirty: boolean = this.computeCurrentDirtyState();

		if (this.lastEmittedDirty === dirty) {
			return;
		}

		this.lastEmittedDirty = dirty;
		if (this.emitDirtyDocumentEvent) {
			this.emit(dirty ? "dirty" : "saved");
		}
	}

	public submitMessage(
		type:
			| ContainerMessageType.FluidDataStoreOp
			| ContainerMessageType.Alias
			| ContainerMessageType.Attach,
		// TODO: better typing
		// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
		contents: any,
		localOpMetadata: unknown = undefined,
	): void {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.submit({ type, contents }, localOpMetadata);
	}

	public async uploadBlob(
		blob: ArrayBufferLike,
		signal?: AbortSignal,
	): Promise<IFluidHandleInternal<ArrayBufferLike>> {
		this.verifyNotClosed();
		return this.blobManager.createBlob(blob, signal);
	}

	private submitIdAllocationOpIfNeeded({
		resubmitOutstandingRanges = false,
		staged,
	}: {
		resubmitOutstandingRanges?: boolean;
		staged: boolean;
	}): void {
		if (this._idCompressor) {
			const idRange = resubmitOutstandingRanges
				? this._idCompressor.takeUnfinalizedCreationRange()
				: this._idCompressor.takeNextCreationRange();
			// Don't include the idRange if there weren't any Ids allocated
			if (idRange.ids !== undefined) {
				const idAllocationMessage: ContainerRuntimeIdAllocationMessage = {
					type: ContainerMessageType.IdAllocation,
					contents: idRange,
				};
				const idAllocationBatchMessage: LocalBatchMessage = {
					runtimeOp: idAllocationMessage,
					referenceSequenceNumber: this.deltaManager.lastSequenceNumber,
					staged,
				};
				this.outbox.submitIdAllocation(idAllocationBatchMessage);
			}
		}
	}

	private submit(
		containerRuntimeMessage: LocalContainerRuntimeMessage,
		localOpMetadata: unknown = undefined,
		metadata?: { localId: string; blobId?: string },
	): void {
		this.verifyNotClosed();

		// There should be no ops in detached container state!
		assert(
			this.attachState !== AttachState.Detached,
			0x132 /* "sending ops in detached container" */,
		);

		assert(
			metadata === undefined ||
				containerRuntimeMessage.type === ContainerMessageType.BlobAttach,
			0x93f /* metadata */,
		);

		// Note that the real (non-proxy) delta manager is used here to get the readonly info. This is because
		// container runtime's ability to submit ops depend on the actual readonly state of the delta manager.
		if (this.innerDeltaManager.readOnlyInfo.readonly) {
			this.mc.logger.sendTelemetryEvent({
				eventName: "SubmitOpInReadonly",
				connected: this.connected,
			});
		}

		const type = containerRuntimeMessage.type;
		assert(
			type !== ContainerMessageType.IdAllocation,
			0x9a5 /* IdAllocation should be submitted directly to outbox. */,
		);

		try {
			// If we're resubmitting a batch, keep the same "staged" value as before.  Otherwise, use the current "global" state.
			const staged = this.batchRunner.resubmitInfo?.staged ?? this.inStagingMode;

			assert(
				!staged || canStageMessageOfType(type),
				0xbba /* Unexpected message type submitted in Staging Mode */,
			);

			// Before submitting any non-staged change, submit the ID Allocation op to cover any compressed IDs included in the op.
			if (!staged) {
				this.submitIdAllocationOpIfNeeded({ staged: false });
			}

			// Allow document schema controller to send a message if it needs to propose change in document schema.
			// If it needs to send a message, it will call provided callback with payload of such message and rely
			// on this callback to do actual sending.
			const schemaChangeMessage = this.documentsSchemaController.maybeGenerateSchemaMessage();
			if (schemaChangeMessage) {
				this.mc.logger.sendTelemetryEvent({
					eventName: "SchemaChangeProposal",
					refSeq: schemaChangeMessage.refSeq,
					version: schemaChangeMessage.version,
					newRuntimeSchema: JSON.stringify(schemaChangeMessage.runtime),
					sessionRuntimeSchema: JSON.stringify(this.sessionSchema),
					oldRuntimeSchema: JSON.stringify(this.metadata?.documentSchema?.runtime),
					minVersionForCollab: schemaChangeMessage.info?.minVersionForCollab,
				});
				const msg: OutboundContainerRuntimeDocumentSchemaMessage = {
					type: ContainerMessageType.DocumentSchemaChange,
					contents: schemaChangeMessage,
				};
				this.outbox.submit({
					runtimeOp: msg,
					referenceSequenceNumber: this.deltaManager.lastSequenceNumber,
					staged,
				});
			}

			const message: LocalBatchMessage = {
				// This will encode any handles present in this op before serializing to string
				// Note: handles may already have been encoded by the DDS layer, but encoding handles is idempotent so there's no problem.
				runtimeOp: containerRuntimeMessage,
				metadata,
				localOpMetadata,
				referenceSequenceNumber: this.deltaManager.lastSequenceNumber,
				staged,
			};
			if (type === ContainerMessageType.BlobAttach) {
				// BlobAttach ops must have their metadata visible and cannot be grouped (see opGroupingManager.ts)
				this.outbox.submitBlobAttach(message);
			} else {
				this.outbox.submit(message);
			}

			this.scheduleFlush();
		} catch (error) {
			const dpe = DataProcessingError.wrapIfUnrecognized(error, "ContainerRuntime.submit", {
				referenceSequenceNumber: this.deltaManager.lastSequenceNumber,
			});
			this.closeFn(dpe);
			throw dpe;
		}

		this.updateDocumentDirtyState();
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) {
			return;
		}
		this.flushScheduled = true;

		switch (this.flushMode) {
			case FlushMode.Immediate: {
				// When in Immediate flush mode, flush immediately unless we are intentionally batching multiple ops (e.g. via orderSequentially)
				if (!this.batchRunner.running) {
					this.flush();
				}
				break;
			}
			case FlushMode.TurnBased: {
				// When in TurnBased flush mode the runtime will buffer operations in the current turn and send them as a single
				// batch at the end of the turn
				// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Container will close if flush throws
				Promise.resolve().then(() => this.flush());
				break;
			}

			// FlushModeExperimental is experimental and not exposed directly in the runtime APIs
			case FlushModeExperimental.Async as unknown as FlushMode: {
				// When in Async flush mode, the runtime will accumulate all operations across JS turns and send them as a single
				// batch when all micro-tasks are complete.
				// Compared to TurnBased, this flush mode will capture more ops into the same batch.
				setTimeout(() => this.flush(), 0);
				break;
			}

			default: {
				fail(0x587 /* Unreachable unless manually accumulating a batch */);
			}
		}
	}

	private submitSummaryMessage(
		contents: ISummaryContent,
		referenceSequenceNumber: number,
	): number {
		this.verifyNotClosed();
		assert(
			this.connected,
			0x133 /* "Container disconnected when trying to submit system message" */,
		);

		// System message should not be sent in the middle of the batch.
		assert(this.outbox.isEmpty, 0x3d4 /* System op in the middle of a batch */);

		return this.submitSummaryFn(contents, referenceSequenceNumber);
	}

	/**
	 * Throw an error if the runtime is closed.  Methods that are expected to potentially
	 * be called after dispose due to asynchrony should not call this.
	 */
	private verifyNotClosed(): void {
		if (this._disposed) {
			throw new Error("Runtime is closed");
		}
	}

	/**
	 * Resubmits each message in the batch, and then flushes the outbox.
	 * This typically happens when we reconnect and there are pending messages.
	 *
	 * @remarks
	 * Attempting to resubmit a batch that has been successfully sequenced will not happen due to
	 * checks in the ConnectionStateHandler (Loader layer)
	 *
	 * The only exception to this would be if the Container "forks" due to misuse of the "Offline Load" feature.
	 * If the "Offline Load" feature is enabled, the batchId is included in the resubmitted messages,
	 * for correlation to detect container forking.
	 */
	private reSubmitBatch(
		batch: PendingMessageResubmitData[],
		{ batchId, staged, squash }: PendingBatchResubmitMetadata,
	): void {
		assert(
			this._summarizer === undefined,
			0x8f2 /* Summarizer never reconnects so should never resubmit */,
		);

		const resubmitInfo = {
			// Only include Batch ID if "Offline Load" feature is enabled
			// It's only needed to identify batches across container forks arising from misuse of offline load.
			batchId: this.offlineEnabled ? batchId : undefined,
			staged,
		};

		const resubmitFn = squash
			? this.reSubmitWithSquashing.bind(this)
			: this.reSubmit.bind(this);

		this.batchRunner.run(() => {
			for (const message of batch) {
				resubmitFn(message);
			}
		}, resubmitInfo);

		this.flush(resubmitInfo);
	}

	/**
	 * Resubmit the given message as part of a squash rebase upon exiting Staging Mode.
	 * How exactly to resubmit the message is up to the subsystem that submitted the op to begin with.
	 */
	private reSubmitWithSquashing(resubmitData: PendingMessageResubmitData): void {
		const message = resubmitData.runtimeOp;
		assert(
			canStageMessageOfType(message.type),
			0xbbb /* Expected message type to be compatible with staging */,
		);
		switch (message.type) {
			case ContainerMessageType.FluidDataStoreOp: {
				this.channelCollection.reSubmit(
					message.type,
					message.contents,
					resubmitData.localOpMetadata,
					/* squash: */ true,
				);
				break;
			}
			// NOTE: Squash doesn't apply to GC or DocumentSchemaChange ops, fallback to typical resubmit logic.
			case ContainerMessageType.GC:
			case ContainerMessageType.DocumentSchemaChange: {
				this.reSubmit(resubmitData);
				break;
			}
			default: {
				unreachableCase(message.type);
			}
		}
	}

	/**
	 * Resubmit the given message which was previously submitted to the ContainerRuntime but not successfully
	 * transmitted to the ordering service (e.g. due to a disconnect, or being in Staging Mode)
	 * How to resubmit is up to the subsystem that submitted the op to begin with
	 */
	private reSubmit({
		runtimeOp: message,
		localOpMetadata,
		opMetadata,
	}: PendingMessageResubmitData): void {
		switch (message.type) {
			case ContainerMessageType.FluidDataStoreOp:
			case ContainerMessageType.Attach:
			case ContainerMessageType.Alias: {
				// For Operations, call resubmitDataStoreOp which will find the right store
				// and trigger resubmission on it.
				this.channelCollection.reSubmit(
					message.type,
					message.contents,
					localOpMetadata,
					/* squash: */ false,
				);
				break;
			}
			case ContainerMessageType.IdAllocation: {
				// Allocation ops are never resubmitted/rebased. This is because they require special handling to
				// avoid being submitted out of order. For example, if the pending state manager contained
				// [idOp1, dataOp1, idOp2, dataOp2] and the resubmission of dataOp1 generated idOp3, that would be
				// placed into the outbox in the same batch as idOp1, but before idOp2 is resubmitted.
				// To avoid this, allocation ops are simply never resubmitted. Prior to invoking the pending state
				// manager to replay pending ops, the runtime will always submit a new allocation range that includes
				// all pending IDs. The resubmitted allocation ops are then ignored here.
				break;
			}
			case ContainerMessageType.BlobAttach: {
				this.blobManager.reSubmit(opMetadata);
				break;
			}
			case ContainerMessageType.Rejoin: {
				this.submit(message);
				break;
			}
			case ContainerMessageType.GC: {
				this.submit(message);
				break;
			}
			case ContainerMessageType.DocumentSchemaChange: {
				// We shouldn't directly resubmit due to Compare-And-Swap semantics.
				// If needed it will be generated from scratch before other ops are submitted.
				this.documentsSchemaController.pendingOpNotAcked();
				break;
			}
			default: {
				const error = getUnknownMessageTypeError(message.type, "reSubmitCore" /* codePath */);
				this.closeFn(error);
				throw error;
			}
		}
	}

	/**
	 * Rollback the given op which was only staged but not yet submitted.
	 */
	private rollbackStagedChange(
		{ type, contents }: LocalContainerRuntimeMessage,
		localOpMetadata: unknown,
	): void {
		assert(canStageMessageOfType(type), 0xbbc /* Unexpected message type to be rolled back */);

		switch (type) {
			case ContainerMessageType.FluidDataStoreOp: {
				// For operations, call rollbackDataStoreOp which will find the right store
				// and trigger rollback on it.
				this.channelCollection.rollback(type, contents, localOpMetadata);
				break;
			}
			case ContainerMessageType.GC: {
				// Just drop it, but log an error, this is not expected and not ideal, but not critical failure either.
				// Currently the only expected type here is TombstoneLoaded, which will have been preceded by one of these events as well:
				// GC_Tombstone_DataStore_Requested, GC_Tombstone_SubDataStore_Requested, GC_Tombstone_Blob_Requested
				this.mc.logger.sendErrorEvent({
					eventName: "GC_OpDiscarded",
					details: { subType: contents.type },
				});
				break;
			}
			case ContainerMessageType.DocumentSchemaChange: {
				// Notify the document schema controller that the pending op was not acked.
				// This will allow it to propose the schema change again if needed.
				this.documentsSchemaController.pendingOpNotAcked();
				break;
			}
			default: {
				unreachableCase(type);
			}
		}
	}

	/**
	 * Implementation of ISummarizerInternalsProvider.refreshLatestSummaryAck
	 */
	public async refreshLatestSummaryAck(options: IRefreshSummaryAckOptions): Promise<void> {
		const { proposalHandle, ackHandle, summaryRefSeq, summaryLogger } = options;
		// proposalHandle is always passed from RunningSummarizer.
		assert(proposalHandle !== undefined, 0x766 /* proposalHandle should be available */);
		const result = await this.summarizerNode.refreshLatestSummary(
			proposalHandle,
			summaryRefSeq,
		);

		/* eslint-disable jsdoc/check-indentation */
		/**
		 * If the snapshot corresponding to the ack is not tracked by this client, it was submitted by another client.
		 * Take action as per the following scenarios:
		 * 1. If that snapshot is older than the one tracked by this client, ignore the ack because only the latest
		 *    snapshot is tracked.
		 * 2. If that snapshot is newer, attempt to fetch the latest snapshot and do one of the following:
		 *    2.1. If the fetched snapshot is same or newer than the one for which ack was received, close this client.
		 *         The next summarizer client will likely start from this snapshot and get out of this state. Fetching
		 *         the snapshot updates the cache for this client so if it's re-elected as summarizer, this will prevent
		 *         any thrashing.
		 *    2.2. If the fetched snapshot is older than the one for which ack was received, ignore the ack. This can
		 *         happen in scenarios where the snapshot for the ack was lost in storage (in scenarios like DB rollback,
		 *         etc.) but the summary ack is still there because it's tracked a different service. In such cases,
		 *         ignoring the ack is the correct thing to do because the latest snapshot in storage is not the one for
		 *         the ack but is still the one tracked by this client. If we were to close the summarizer like in the
		 *         previous scenario, it will result in this document stuck in this state in a loop.
		 */
		/* eslint-enable jsdoc/check-indentation */
		if (!result.isSummaryTracked) {
			if (result.isSummaryNewer) {
				await this.fetchLatestSnapshotAndMaybeClose(summaryRefSeq, ackHandle, summaryLogger);
			}
			return;
		}

		// Notify the garbage collector so it can update its latest summary state.
		await this.garbageCollector.refreshLatestSummary(result);

		// If we here, the ack was tracked by this client. Update the summary context of the last ack.
		this.lastAckedSummaryContext = {
			proposalHandle,
			ackHandle,
			referenceSequenceNumber: summaryRefSeq,
		};
	}

	private readonly readAndParseBlob = async <T>(id: string): Promise<T> =>
		readAndParse<T>(this.storage, id);

	/**
	 * Fetches the latest snapshot from storage. If the fetched snapshot is same or newer than the one for which ack
	 * was received, close this client. Fetching the snapshot will update the cache for this client so if it's
	 * re-elected as summarizer, this will prevent any thrashing.
	 * If the fetched snapshot is older than the one for which ack was received, ignore the ack and return. This can
	 * happen in scenarios where the snapshot for the ack was lost in storage in scenarios like DB rollback, etc.
	 */
	private async fetchLatestSnapshotAndMaybeClose(
		targetRefSeq: number,
		targetAckHandle: string,
		logger: ITelemetryLoggerExt,
	): Promise<void> {
		const fetchedSnapshotRefSeq = await PerformanceEvent.timedExecAsync(
			logger,
			{ eventName: "RefreshLatestSummaryAckFetch" },
			async (perfEvent: {
				end: (arg0: {
					details: {
						getVersionDuration?: number | undefined;
						getSnapshotDuration?: number | undefined;
						snapshotRefSeq?: number | undefined;
						snapshotVersion?: string | undefined;
						newerSnapshotPresent?: boolean | undefined;
						targetRefSeq?: number | undefined;
						targetAckHandle?: string | undefined;
					};
				}) => void;
			}) => {
				const props: {
					getVersionDuration?: number;
					getSnapshotDuration?: number;
					snapshotRefSeq?: number;
					snapshotVersion?: string;
					newerSnapshotPresent?: boolean | undefined;
					targetRefSeq?: number | undefined;
					targetAckHandle?: string | undefined;
				} = { targetRefSeq, targetAckHandle };
				const trace = Trace.start();

				let snapshotTree: ISnapshotTree | null;
				const scenarioName = "RefreshLatestSummaryAckFetch";
				// If loader supplied us the ISnapshot when loading, the new getSnapshotApi is supported and feature gate is ON, then use the
				// new API, otherwise it will reduce the service performance because the service will need to recalculate the full snapshot
				// in case previously getSnapshotApi was used and now we use the getVersions API.
				if (
					this.isSnapshotInstanceOfISnapshot &&
					this.storage.getSnapshot !== undefined &&
					this.mc.config.getBoolean("Fluid.Container.UseLoadingGroupIdForSnapshotFetch2") ===
						true
				) {
					const snapshot = await this.storage.getSnapshot({
						scenarioName,
						fetchSource: FetchSource.noCache,
					});
					const id = snapshot.snapshotTree.id;
					assert(id !== undefined, 0x9d0 /* id of the fetched snapshot should be defined */);
					props.snapshotVersion = id;
					snapshotTree = snapshot.snapshotTree;
				} else {
					const versions = await this.storage.getVersions(
						// eslint-disable-next-line unicorn/no-null
						null,
						1,
						scenarioName,
						FetchSource.noCache,
					);
					assert(
						!!versions && !!versions[0],
						0x137 /* "Failed to get version from storage" */,
					);
					snapshotTree = await this.storage.getSnapshotTree(versions[0]);
					assert(!!snapshotTree, 0x138 /* "Failed to get snapshot from storage" */);
					props.snapshotVersion = versions[0].id;
				}

				props.getSnapshotDuration = trace.trace().duration;

				const snapshotRefSeq = await seqFromTree(snapshotTree, this.readAndParseBlob);
				props.snapshotRefSeq = snapshotRefSeq;
				props.newerSnapshotPresent = snapshotRefSeq >= targetRefSeq;

				perfEvent.end({ details: props });
				return snapshotRefSeq;
			},
		);

		// If the snapshot that was fetched is older than the target snapshot, return. The summarizer will not be closed
		// because the snapshot is likely deleted from storage and it so, closing the summarizer will result in the
		// document being stuck in this state.
		if (fetchedSnapshotRefSeq < targetRefSeq) {
			return;
		}

		await delay(this.closeSummarizerDelayMs);
		this._summarizer?.stop("latestSummaryStateStale");
		this.disposeFn();
	}

	public getPendingLocalState(props?: IGetPendingLocalStateProps): unknown {
		this.verifyNotClosed();
		if (props?.notifyImminentClosure) {
			throw new UsageError("notifyImminentClosure is no longer supported in ContainerRuntime");
		}

		if (this.batchRunner.running) {
			throw new UsageError("can't get state while manually accumulating a batch");
		}

		// Flush pending batch.
		// getPendingLocalState() is only exposed through Container.getPendingLocalState(), so it's safe
		// to close current batch.
		this.flush();

		return PerformanceEvent.timedExec<IPendingRuntimeState | undefined>(
			this.mc.logger,
			{
				eventName: "getPendingLocalState",
			},
			(event) => {
				const pending = this.pendingStateManager.getLocalState(props?.snapshotSequenceNumber);
				const sessionExpiryTimerStarted =
					props?.sessionExpiryTimerStarted ?? this.garbageCollector.sessionExpiryTimerStarted;

				const pendingIdCompressorState = this._idCompressor?.serialize(true);
				const pendingAttachmentBlobs = this.blobManager.getPendingBlobs();

				const pendingRuntimeState: IPendingRuntimeState = {
					pending,
					pendingIdCompressorState,
					pendingAttachmentBlobs,
					sessionExpiryTimerStarted,
				};
				event.end({
					attachmentBlobsSize: Object.keys(pendingAttachmentBlobs ?? {}).length,
					pendingOpsSize: pendingRuntimeState?.pending?.pendingStates.length,
				});
				return pendingRuntimeState;
			},
		);
	}

	public summarizeOnDemand(options: IOnDemandSummarizeOptions): ISummarizeResults {
		if (this._summarizer !== undefined) {
			return this._summarizer.summarizeOnDemand(options);
		} else if (this.summaryManager === undefined) {
			// If we're not the summarizer, and we don't have a summaryManager, we expect that
			// disableSummaries is turned on. We are throwing instead of returning a failure here,
			// because it is a misuse of the API rather than an expected failure.
			throw new UsageError(`Can't summarize, disableSummaries: ${this.summariesDisabled}`);
		} else {
			return this.summaryManager.summarizeOnDemand(options);
		}
	}

	public enqueueSummarize(options: IEnqueueSummarizeOptions): EnqueueSummarizeResult {
		if (this._summarizer !== undefined) {
			return this._summarizer.enqueueSummarize(options);
		} else if (this.summaryManager === undefined) {
			// If we're not the summarizer, and we don't have a summaryManager, we expect that
			// generateSummaries is turned off. We are throwing instead of returning a failure here,
			// because it is a misuse of the API rather than an expected failure.
			throw new UsageError(`Can't summarize, disableSummaries: ${this.summariesDisabled}`);
		} else {
			return this.summaryManager.enqueueSummarize(options);
		}
	}

	// While internal, ContainerRuntime has not been converted to use the new events support.
	// Recreate the required events (new pattern) with injected, wrapper new emitter.
	// It is lazily create to avoid listeners (old events) that ultimately go nowhere.
	private readonly lazyEventsForExtensions = new Lazy<Listenable<ExtensionHostEvents>>(() => {
		const eventEmitter = createEmitter<ExtensionHostEvents>();
		this.on("connected", (clientId) => eventEmitter.emit("connected", clientId));
		this.on("disconnected", () => eventEmitter.emit("disconnected"));
		return eventEmitter;
	});

	private readonly submitExtensionSignal: <TMessage extends TypedMessage>(
		id: string,
		addressChain: string[],
		message: OutboundExtensionMessage<TMessage>,
	) => void;

	public acquireExtension<
		T,
		TRuntimeProperties extends ExtensionRuntimeProperties,
		TUseContext extends unknown[],
	>(
		id: ContainerExtensionId,
		factory: ContainerExtensionFactory<T, TRuntimeProperties, TUseContext>,
		...useContext: TUseContext
	): T {
		let entry = this.extensions.get(id);
		if (entry === undefined) {
			const runtime = {
				isConnected: () => this.connected,
				getClientId: () => this.clientId,
				events: this.lazyEventsForExtensions.value,
				logger: this.baseLogger,
				submitAddressedSignal: (
					addressChain: string[],
					message: OutboundExtensionMessage<TRuntimeProperties["SignalMessages"]>,
				) => {
					this.submitExtensionSignal(id, addressChain, message);
				},
				getQuorum: this.getQuorum.bind(this),
				getAudience: this.getAudience.bind(this),
				supportedFeatures: this.ILayerCompatDetails.supportedFeatures,
			} satisfies ExtensionHost<TRuntimeProperties>;
			entry = new factory(runtime, ...useContext);
			this.extensions.set(id, entry);
		} else {
			assert(
				entry instanceof factory,
				0xba1 /* Extension entry is not of the expected type */,
			);
			entry.extension.onNewUse(...useContext);
		}
		return entry.interface as T;
	}

	private get groupedBatchingEnabled(): boolean {
		return this.sessionSchema.opGroupingEnabled === true;
	}
}

export function createNewSignalEnvelope(
	address: string | undefined,
	type: string,
	content: unknown,
): UnsequencedSignalEnvelope {
	const newEnvelope: UnsequencedSignalEnvelope = {
		address,
		contents: { type, content },
	};

	return newEnvelope;
}

export function isContainerMessageDirtyable({
	type,
	contents,
}: LocalContainerRuntimeMessage): boolean {
	// Certain container runtime messages should not mark the container dirty such as the old built-in
	// AgentScheduler and Garbage collector messages.
	switch (type) {
		case ContainerMessageType.Attach: {
			const attachMessage = contents as InboundAttachMessage;
			if (attachMessage.id === agentSchedulerId) {
				return false;
			}
			break;
		}
		case ContainerMessageType.FluidDataStoreOp: {
			const envelope = contents;
			if (envelope.address === agentSchedulerId) {
				return false;
			}
			break;
		}
		case ContainerMessageType.IdAllocation:
		case ContainerMessageType.DocumentSchemaChange:
		case ContainerMessageType.GC: {
			return false;
		}
		default: {
			break;
		}
	}
	return true;
}
