/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	TypedEventEmitter,
	type ILayerCompatDetails,
	type IProvideLayerCompatDetails,
} from "@fluid-internal/client-utils";
import { AttachState, IAudience } from "@fluidframework/container-definitions";
import {
	IDeltaManager,
	isIDeltaManagerFull,
	type IDeltaManagerFull,
	type ReadOnlyInfo,
} from "@fluidframework/container-definitions/internal";
import {
	FluidObject,
	IDisposable,
	ITelemetryBaseProperties,
	type IEvent,
} from "@fluidframework/core-interfaces";
import {
	type IFluidHandleContext,
	type IFluidHandleInternal,
	type ITelemetryBaseLogger,
} from "@fluidframework/core-interfaces/internal";
import { assert, LazyPromise, unreachableCase } from "@fluidframework/core-utils/internal";
import { IClientDetails, IQuorumClients } from "@fluidframework/driver-definitions";
import {
	type ISnapshot,
	IDocumentMessage,
	ISnapshotTree,
	ITreeEntry,
	ISequencedDocumentMessage,
} from "@fluidframework/driver-definitions/internal";
import {
	BlobTreeEntry,
	isInstanceOfISnapshot,
	readAndParse,
} from "@fluidframework/driver-utils/internal";
import type { IIdCompressor } from "@fluidframework/id-compressor";
import {
	ISummaryTreeWithStats,
	ITelemetryContext,
	IGarbageCollectionData,
	CreateChildSummarizerNodeFn,
	CreateChildSummarizerNodeParam,
	FluidDataStoreRegistryEntry,
	IContainerRuntimeBase,
	IDataStore,
	IFluidDataStoreChannel,
	IFluidDataStoreContext,
	IFluidDataStoreContextDetached,
	IFluidDataStoreRegistry,
	IGarbageCollectionDetailsBase,
	IProvideFluidDataStoreFactory,
	ISummarizeInternalResult,
	ISummarizeResult,
	ISummarizerNodeWithGC,
	SummarizeInternalFn,
	channelsTreeName,
	IInboundSignalMessage,
	type IPendingMessagesState,
	type IRuntimeMessageCollection,
	type IFluidDataStoreFactory,
	type PackagePath,
	type IRuntimeStorageService,
} from "@fluidframework/runtime-definitions/internal";
import {
	addBlobToSummary,
	isSnapshotFetchRequiredForLoadingGroupId,
} from "@fluidframework/runtime-utils/internal";
import {
	DataProcessingError,
	LoggingError,
	MonitoringContext,
	ThresholdCounter,
	UsageError,
	createChildMonitoringContext,
	extractSafePropertiesFromMessage,
	generateStack,
	tagCodeArtifacts,
} from "@fluidframework/telemetry-utils/internal";

import type { IFluidParentContextPrivate } from "./channelCollection.js";
import { BaseDeltaManagerProxy } from "./deltaManagerProxies.js";
import {
	runtimeCompatDetailsForDataStore,
	validateDatastoreCompatibility,
} from "./runtimeLayerCompatState.js";
import {
	// eslint-disable-next-line import/no-deprecated
	ReadFluidDataStoreAttributes,
	WriteFluidDataStoreAttributes,
	dataStoreAttributesBlobName,
	getAttributesFormatVersion,
	getFluidDataStoreAttributes,
	hasIsolatedChannels,
	wrapSummaryInChannelsTree,
} from "./summary/index.js";

function createAttributes(
	pkg: readonly string[],
	isRootDataStore: boolean,
): WriteFluidDataStoreAttributes {
	const stringifiedPkg = JSON.stringify(pkg);
	return {
		pkg: stringifiedPkg,
		summaryFormatVersion: 2,
		isRootDataStore,
	};
}
export function createAttributesBlob(
	pkg: readonly string[],
	isRootDataStore: boolean,
): ITreeEntry {
	const attributes = createAttributes(pkg, isRootDataStore);
	return new BlobTreeEntry(dataStoreAttributesBlobName, JSON.stringify(attributes));
}

export interface ISnapshotDetails {
	pkg: readonly string[];
	isRootDataStore: boolean;
	snapshot?: ISnapshotTree;
	sequenceNumber?: number;
}

/**
 * This is interface that every context should implement.
 * This interface is used for context's parent - ChannelCollection.
 * It should not be exposed to any other users of context.
 */
export interface IFluidDataStoreContextInternal extends IFluidDataStoreContext {
	getAttachSummary(telemetryContext?: ITelemetryContext): ISummaryTreeWithStats;

	getAttachGCData(telemetryContext?: ITelemetryContext): IGarbageCollectionData;

	getInitialSnapshotDetails(): Promise<ISnapshotDetails>;

	realize(): Promise<IFluidDataStoreChannel>;

	isRoot(): Promise<boolean>;
}

/**
 * Properties necessary for creating a FluidDataStoreContext
 */
export interface IFluidDataStoreContextProps {
	readonly id: string;
	readonly parentContext: IFluidParentContextPrivate;
	readonly storage: IRuntimeStorageService;
	readonly scope: FluidObject;
	readonly createSummarizerNodeFn: CreateChildSummarizerNodeFn;
	/**
	 * See {@link FluidDataStoreContext.pkg}.
	 */
	readonly pkg?: PackagePath;
	/**
	 * See {@link FluidDataStoreContext.loadingGroupId}.
	 */
	readonly loadingGroupId?: string;
}

/**
 * Properties necessary for creating a local FluidDataStoreContext
 */
export interface ILocalFluidDataStoreContextProps extends IFluidDataStoreContextProps {
	readonly pkg: Readonly<string[]> | undefined;
	readonly snapshotTree: ISnapshotTree | undefined;
	readonly makeLocallyVisibleFn: () => void;
}

/**
 * Properties necessary for creating a local FluidDataStoreContext
 */
export interface ILocalDetachedFluidDataStoreContextProps
	extends ILocalFluidDataStoreContextProps {
	readonly channelToDataStoreFn: (channel: IFluidDataStoreChannel) => IDataStore;
}

/**
 * Properties necessary for creating a remote FluidDataStoreContext
 */
export interface IRemoteFluidDataStoreContextProps extends IFluidDataStoreContextProps {
	readonly snapshot: ISnapshotTree | ISnapshot | undefined;
}

// back-compat: To be removed in the future.
// Added in "2.0.0-rc.2.0.0" timeframe (to support older builds).
export interface IFluidDataStoreContextEvents extends IEvent {
	(event: "attaching" | "attached", listener: () => void);
}

/**
 * Eventually we should remove the delta manger from being exposed to Datastore runtimes via the context. However to remove that exposure we need to add new
 * features, and those features themselves need forward and back compat. This proxy is here to enable that back compat. Each feature this proxy is used to
 * support should be listed below, and as layer compat support goes away for those feature, we should also remove them from this proxy, with the eventual goal
 * of completely removing this proxy.
 *
 * - Everything regarding readonly is to support older datastore runtimes which do not have the setReadonly function, so they must get their readonly state via the delta manager.
 *
 */
class ContextDeltaManagerProxy extends BaseDeltaManagerProxy {
	constructor(
		base: IDeltaManagerFull,
		private readonly isReadOnly: () => boolean,
	) {
		super(base, {
			onReadonly: (): void => {
				/* readonly is controlled from the context which calls setReadonly */
			},
		});
	}

	public get readOnlyInfo(): ReadOnlyInfo {
		const readonly = this.isReadOnly();
		if (readonly === this.deltaManager.readOnlyInfo.readonly) {
			return this.deltaManager.readOnlyInfo;
		} else {
			return readonly === true
				? {
						readonly,
						forced: false,
						permissions: undefined,
						storageOnly: false,
					}
				: { readonly };
		}
	}

	/**
	 * Called by the owning datastore context to emit the readonly
	 * event on the delta manger that is projected down to the datastore
	 * runtime. This state may not align with that of the true delta
	 * manager if the context wishes to control the read only state
	 * differently than the delta manager itself.
	 */
	public emitReadonly(): void {
		this.emit("readonly", this.isReadOnly());
	}
}

/**
 * {@link IFluidDataStoreContext} for the implementations of {@link IFluidDataStoreChannel} which powers the {@link IDataStore}s.
 */
export abstract class FluidDataStoreContext
	extends TypedEventEmitter<IFluidDataStoreContextEvents>
	implements
		IFluidDataStoreContextInternal,
		IFluidDataStoreContext,
		IDisposable,
		IProvideLayerCompatDetails
{
	public get packagePath(): PackagePath {
		assert(this.pkg !== undefined, 0x139 /* "Undefined package path" */);
		return this.pkg;
	}

	public get options(): Record<string | number, unknown> {
		return this.parentContext.options;
	}

	public get clientId(): string | undefined {
		return this.parentContext.clientId;
	}

	public get clientDetails(): IClientDetails {
		return this.parentContext.clientDetails;
	}

	public get baseLogger(): ITelemetryBaseLogger {
		return this.parentContext.baseLogger;
	}

	private readonly _contextDeltaManagerProxy: ContextDeltaManagerProxy;
	public get deltaManager(): IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
		return this._contextDeltaManagerProxy;
	}

	private isStagingMode: boolean = false;
	public isReadOnly = (): boolean =>
		(this.isStagingMode && this.channel?.policies?.readonlyInStagingMode !== false) ||
		this.parentContext.isReadOnly();

	public get connected(): boolean {
		return this.parentContext.connected;
	}

	public get IFluidHandleContext(): IFluidHandleContext {
		return this.parentContext.IFluidHandleContext;
	}

	public get containerRuntime(): IContainerRuntimeBase {
		return this._containerRuntime;
	}
	public get isLoaded(): boolean {
		return this.loaded;
	}

	public get baseSnapshot(): ISnapshotTree | undefined {
		return this._baseSnapshot;
	}

	public get idCompressor(): IIdCompressor | undefined {
		return this.parentContext.idCompressor;
	}

	private _disposed = false;
	public get disposed(): boolean {
		return this._disposed;
	}

	/**
	 * A Tombstoned object has been unreferenced long enough that GC knows it won't be referenced again.
	 * Tombstoned objects are eventually deleted by GC.
	 */
	private _tombstoned = false;
	public get tombstoned(): boolean {
		return this._tombstoned;
	}
	/**
	 * If true, throw an error when a tombstone data store is used.
	 * @deprecated NOT SUPPORTED - hardcoded to return false since it's deprecated.
	 */
	public readonly gcThrowOnTombstoneUsage: boolean = false;
	/**
	 * @deprecated NOT SUPPORTED - hardcoded to return false since it's deprecated.
	 */
	public readonly gcTombstoneEnforcementAllowed: boolean = false;

	/**
	 * If true, this means that this data store context and its children have been removed from the runtime
	 */
	protected deleted: boolean = false;

	public get attachState(): AttachState {
		return this._attachState;
	}

	public get IFluidDataStoreRegistry(): IFluidDataStoreRegistry | undefined {
		return this.registry;
	}

	/**
	 * The compatibility details of the Runtime layer that is exposed to the DataStore layer
	 * for validating DataStore-Runtime compatibility.
	 */
	public get ILayerCompatDetails(): ILayerCompatDetails {
		return runtimeCompatDetailsForDataStore;
	}

	private baseSnapshotSequenceNumber: number | undefined;

	/**
	 * A datastore is considered as root if it
	 * 1. is root in memory - see isInMemoryRoot
	 * 2. is root as part of the base snapshot that the datastore loaded from
	 * @returns whether a datastore is root
	 */
	public async isRoot(aliasedDataStores?: Set<string>): Promise<boolean> {
		if (this.isInMemoryRoot()) {
			return true;
		}

		// This if is a performance optimization.
		// We know that if the base snapshot is omitted, then the isRootDataStore flag is not set.
		// That means we can skip the expensive call to getInitialSnapshotDetails for virtualized datastores,
		// and get the information from the alias map directly.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
		if (aliasedDataStores !== undefined && (this.baseSnapshot as any)?.omitted === true) {
			return aliasedDataStores.has(this.id);
		}

		const snapshotDetails = await this.getInitialSnapshotDetails();
		return snapshotDetails.isRootDataStore;
	}

	/**
	 * There are 3 states where isInMemoryRoot needs to be true
	 * 1. when a datastore becomes aliased. This can happen for both remote and local datastores
	 * 2. when a datastore is created locally as root
	 * 3. when a datastore is created locally as root and is rehydrated
	 * @returns whether a datastore is root in memory
	 */
	protected isInMemoryRoot(): boolean {
		return this._isInMemoryRoot;
	}

	/**
	 * Returns the count of pending messages that are stored until the data store is realized.
	 */
	public get pendingCount(): number {
		return this.pendingMessagesState?.pendingCount ?? 0;
	}

	protected registry: IFluidDataStoreRegistry | undefined;

	protected detachedRuntimeCreation = false;
	protected channel: IFluidDataStoreChannel | undefined;
	private loaded = false;
	/**
	 * Tracks the messages for this data store that are sent while it's not loaded
	 */
	private pendingMessagesState: IPendingMessagesState | undefined = {
		messageCollections: [],
		pendingCount: 0,
	};
	protected channelP: Promise<IFluidDataStoreChannel> | undefined;
	protected _baseSnapshot: ISnapshotTree | undefined;
	protected _attachState: AttachState;
	private _isInMemoryRoot: boolean = false;
	protected readonly summarizerNode: ISummarizerNodeWithGC;
	protected readonly mc: MonitoringContext;
	private readonly thresholdOpsCounter: ThresholdCounter;
	private static readonly pendingOpsCountThreshold = 1000;

	/**
	 * If the summarizer makes local changes, a telemetry event is logged. This has the potential to be very noisy.
	 * So, adding a count of how many telemetry events are logged per data store context. This can be
	 * controlled via feature flags.
	 */
	private localChangesTelemetryCount: number;

	public readonly id: string;
	private readonly _containerRuntime: IContainerRuntimeBase;
	/**
	 * Information for this data store from its parent.
	 *
	 * @remarks
	 * The parent which provided this information currently can be the container runtime or a datastore (if the datastore this context is for is nested under another one).
	 */
	private readonly parentContext: IFluidParentContextPrivate;
	public readonly storage: IRuntimeStorageService;
	public readonly scope: FluidObject;
	/**
	 * The loading group to which the data store belongs to.
	 */
	public readonly loadingGroupId: string | undefined;
	/**
	 * {@link PackagePath} of this data store.
	 *
	 * This can be undefined when a data store is delay loaded, i.e., the attributes of this data store in the snapshot are not fetched until this data store is actually used.
	 * At that time, the attributes blob is fetched and the pkg is updated from it.
	 *
	 * @see {@link PackagePath}.
	 * @see {@link IFluidDataStoreContext.packagePath}.
	 * @see {@link factoryFromPackagePath}.
	 */
	protected pkg?: PackagePath;

	public constructor(
		props: IFluidDataStoreContextProps,
		private readonly existing: boolean,
		public readonly isLocalDataStore: boolean,
		private readonly makeLocallyVisibleFn: () => void,
	) {
		super();

		this._containerRuntime = props.parentContext.containerRuntime;
		this.parentContext = props.parentContext;
		this.id = props.id;
		this.storage = props.storage;
		this.scope = props.scope;
		this.pkg = props.pkg;
		this.loadingGroupId = props.loadingGroupId;

		// URIs use slashes as delimiters. Handles use URIs.
		// Thus having slashes in types almost guarantees trouble down the road!
		assert(!this.id.includes("/"), 0x13a /* Data store ID contains slash */);

		this._attachState =
			this.parentContext.attachState !== AttachState.Detached && this.existing
				? this.parentContext.attachState
				: AttachState.Detached;

		this.summarizerNode = props.createSummarizerNodeFn(
			async (fullTree, trackState, telemetryContext) =>
				this.summarizeInternal(fullTree, trackState, telemetryContext),
			async (fullGC?: boolean) => this.getGCDataInternal(fullGC),
		);

		this.mc = createChildMonitoringContext({
			logger: this.baseLogger,
			namespace: "FluidDataStoreContext",
			properties: {
				all: tagCodeArtifacts({
					fluidDataStoreId: this.id,
					// The package name is a getter because `this.pkg` may not be initialized during construction.
					// For data stores loaded from summary, it is initialized during data store realization.
					fullPackageName: () => this.pkg?.join("/"),
				}),
			},
		});
		this.thresholdOpsCounter = new ThresholdCounter(
			FluidDataStoreContext.pendingOpsCountThreshold,
			this.mc.logger,
		);

		// By default, a data store can log maximum 10 local changes telemetry in summarizer.
		this.localChangesTelemetryCount =
			this.mc.config.getNumber("Fluid.Telemetry.LocalChangesTelemetryCount") ?? 10;

		assert(
			isIDeltaManagerFull(this.parentContext.deltaManager),
			0xb83 /* Invalid delta manager */,
		);

		this._contextDeltaManagerProxy = new ContextDeltaManagerProxy(
			this.parentContext.deltaManager,
			() => this.isReadOnly(),
		);
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;

		// Dispose any pending runtime after it gets fulfilled
		// Errors are logged where this.channelP is consumed/generated (realizeCore(), bindRuntime())
		if (this.channelP) {
			this.channelP
				.then((runtime) => {
					runtime.dispose();
				})
				.catch((error) => {});
		}
		this._contextDeltaManagerProxy.dispose();
	}

	/**
	 * When delete is called, that means that the data store is permanently removed from the runtime, and will not show up in future summaries
	 * This function is called to prevent ops from being generated from this data store once it has been deleted. Furthermore, this data store
	 * should not receive any ops/signals.
	 */
	public delete(): void {
		this.deleted = true;
	}

	public setTombstone(tombstone: boolean): void {
		if (this.tombstoned === tombstone) {
			return;
		}

		this._tombstoned = tombstone;
	}

	public abstract setAttachState(
		attachState: AttachState.Attaching | AttachState.Attached,
	): void;

	/**
	 * Throw a {@link LoggingError} indicating that {@link factoryFromPackagePath} failed.
	 */
	private factoryFromPackagePathError(
		reason: string,
		failedPkgPath?: string,
		fullPackageName?: PackagePath,
	): never {
		throw new LoggingError(
			reason,
			tagCodeArtifacts({
				failedPkgPath,
				packagePath: fullPackageName?.join("/"),
			}),
		);
	}

	public async realize(): Promise<IFluidDataStoreChannel> {
		assert(
			!this.detachedRuntimeCreation,
			0x13d /* "Detached runtime creation on realize()" */,
		);
		if (!this.channelP) {
			this.channelP = this.realizeCore(this.existing).catch((error) => {
				const errorWrapped = DataProcessingError.wrapIfUnrecognized(
					error,
					"realizeFluidDataStoreContext",
				);
				errorWrapped.addTelemetryProperties(
					tagCodeArtifacts({
						fullPackageName: this.pkg?.join("/"),
						fluidDataStoreId: this.id,
					}),
				);
				this.mc.logger.sendErrorEvent({ eventName: "RealizeError" }, errorWrapped);
				throw errorWrapped;
			});
		}
		return this.channelP;
	}

	/**
	 * Gets the factory that would be used to instantiate this data store by calling `instantiateDataStore` based on {@link pkg}.
	 * @remarks
	 * Also populates {@link registry}.
	 *
	 * Must be called after {@link pkg} is set, and only called once.
	 *
	 * @see {@link @fluidframework/container-runtime-definitions#IContainerRuntimeBase.createDataStore}.
	 * @see {@link FluidDataStoreContext.pkg}.
	 */
	protected async factoryFromPackagePath(): Promise<IFluidDataStoreFactory> {
		const path = this.pkg;
		if (path === undefined) {
			this.factoryFromPackagePathError("packages is undefined");
		}

		let entry: FluidDataStoreRegistryEntry | undefined;
		let registry: IFluidDataStoreRegistry | undefined =
			this.parentContext.IFluidDataStoreRegistry;
		let lastIdentifier: string | undefined;
		// Follow the path, looking up each identifier in the registry along the way:
		for (const identifier of path) {
			if (!registry) {
				this.factoryFromPackagePathError("No registry for package", lastIdentifier, path);
			}
			lastIdentifier = identifier;
			entry = registry.getSync?.(identifier) ?? (await registry.get(identifier));
			if (!entry) {
				this.factoryFromPackagePathError(
					"Registry does not contain entry for the package",
					identifier,
					path,
				);
			}
			registry = entry.IFluidDataStoreRegistry;
		}
		const factory = entry?.IFluidDataStoreFactory;
		if (factory === undefined) {
			this.factoryFromPackagePathError("Can't find factory for package", lastIdentifier, path);
		}

		assert(this.registry === undefined, 0x157 /* "datastore registry already attached" */);
		this.registry = registry;

		return factory;
	}

	public createChildDataStore<T extends IFluidDataStoreFactory>(
		childFactory: T,
	): ReturnType<Exclude<T["createDataStore"], undefined>> {
		const maybe = this.registry?.getSync?.(childFactory.type);

		const isUndefined = maybe === undefined;
		const diffInstance = maybe?.IFluidDataStoreFactory !== childFactory;

		if (isUndefined || diffInstance) {
			throw new UsageError(
				"The provided factory instance must be synchronously available as a child of this datastore",
				{ isUndefined, diffInstance },
			);
		}
		if (childFactory?.createDataStore === undefined) {
			throw new UsageError("createDataStore must exist on the provided factory", {
				noCreateDataStore: true,
			});
		}

		const context = this._containerRuntime.createDetachedDataStore([
			...this.packagePath,
			childFactory.type,
		]);
		assert(
			context instanceof LocalDetachedFluidDataStoreContext,
			0xa89 /* must be a LocalDetachedFluidDataStoreContext */,
		);

		const created = childFactory.createDataStore(context) as ReturnType<
			Exclude<T["createDataStore"], undefined>
		>;
		context.unsafe_AttachRuntimeSync(created.runtime);
		return created;
	}

	private async realizeCore(existing: boolean): Promise<IFluidDataStoreChannel> {
		const details = await this.getInitialSnapshotDetails();
		// Base snapshot is the baseline where pending ops are applied to.
		// It is important that this be in sync with the pending ops, and also
		// that it is set here, before bindRuntime is called.
		this._baseSnapshot = details.snapshot;
		this.baseSnapshotSequenceNumber = details.sequenceNumber;
		assert(this.pkg === details.pkg, 0x13e /* "Unexpected package path" */);

		const factory = await this.factoryFromPackagePath();

		const channel = await factory.instantiateDataStore(this, existing);
		assert(channel !== undefined, 0x140 /* "undefined channel on datastore context" */);

		await this.bindRuntime(channel, existing);
		// This data store may have been disposed before the channel is created during realization. If so,
		// dispose the channel now.
		if (this.disposed) {
			channel.dispose();
		}

		return channel;
	}

	/**
	 * Notifies this object about changes in the connection state.
	 * @param value - New connection state.
	 * @param clientId - ID of the client. Its old ID when in disconnected state and
	 * its new client ID when we are connecting or connected.
	 */
	public setConnectionState(connected: boolean, clientId?: string): void {
		// ConnectionState should not fail in tombstone mode as this is internally run
		this.verifyNotClosed("setConnectionState", false /* checkTombstone */);

		// Connection events are ignored if the store is not yet loaded
		if (!this.loaded) {
			return;
		}

		assert(this.connected === connected, 0x141 /* "Unexpected connected state" */);

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		this.channel!.setConnectionState(connected, clientId);
	}

	public notifyReadOnlyState(): void {
		this.verifyNotClosed("notifyReadOnlyState", false /* checkTombstone */);

		// These two calls achieve the same purpose, and are both needed for a time for back compat
		this.channel?.notifyReadOnlyState?.(this.isReadOnly());
		this._contextDeltaManagerProxy.emitReadonly();
	}

	/**
	 * Updates the readonly state of the data store based on the staging mode.
	 *
	 * @param staging - A boolean indicating whether the container is in staging mode.
	 * If true, the data store is set to readonly unless explicitly allowed by its policies.
	 */
	public notifyStagingMode(staging: boolean): void {
		// If the `readonlyInStagingMode` policy is not explicitly set to `false`,
		// the data store is treated as readonly in staging mode.
		const oldReadOnlyState = this.isReadOnly();
		this.isStagingMode = staging;
		if (this.isReadOnly() !== oldReadOnlyState) {
			this.notifyReadOnlyState();
		}
	}

	/**
	 * Process messages for this data store. The messages here are contiguous messages for this data store in a batch.
	 * @param messageCollection - The collection of messages to process.
	 */
	public processMessages(messageCollection: IRuntimeMessageCollection): void {
		const { envelope, messagesContent, local } = messageCollection;
		const safeTelemetryProps = extractSafePropertiesFromMessage(envelope);
		// Tombstone error is logged in garbage collector. So, set "checkTombstone" to false when calling
		// "verifyNotClosed" which logs tombstone errors.
		this.verifyNotClosed("process", false /* checkTombstone */, safeTelemetryProps);

		this.summarizerNode.recordChange(envelope as ISequencedDocumentMessage);

		if (this.loaded) {
			assert(this.channel !== undefined, 0xa68 /* Channel is not loaded */);
			this.channel.processMessages(messageCollection);
		} else {
			assert(!local, 0x142 /* "local store channel is not loaded" */);
			assert(
				this.pendingMessagesState !== undefined,
				0xa69 /* pending messages queue is undefined */,
			);
			this.pendingMessagesState.messageCollections.push({
				...messageCollection,
				messagesContent: [...messagesContent],
			});
			this.pendingMessagesState.pendingCount += messagesContent.length;
			this.thresholdOpsCounter.sendIfMultiple(
				"StorePendingOps",
				this.pendingMessagesState.pendingCount,
			);
		}
	}

	public processSignal(message: IInboundSignalMessage, local: boolean): void {
		this.verifyNotClosed("processSignal");

		// Signals are ignored if the store is not yet loaded
		if (!this.loaded) {
			return;
		}

		this.channel?.processSignal(message, local);
	}

	public getQuorum(): IQuorumClients {
		return this.parentContext.getQuorum();
	}

	public getAudience(): IAudience {
		return this.parentContext.getAudience();
	}

	/**
	 * Returns a summary at the current sequence number.
	 * @param fullTree - true to bypass optimizations and force a full summary tree
	 * @param trackState - This tells whether we should track state from this summary.
	 * @param telemetryContext - summary data passed through the layers for telemetry purposes
	 */
	public async summarize(
		fullTree: boolean = false,
		trackState: boolean = true,
		telemetryContext?: ITelemetryContext,
	): Promise<ISummarizeResult> {
		return this.summarizerNode.summarize(fullTree, trackState, telemetryContext);
	}

	private async summarizeInternal(
		fullTree: boolean,
		trackState: boolean,
		telemetryContext?: ITelemetryContext,
	): Promise<ISummarizeInternalResult> {
		await this.realize();

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const summarizeResult = await this.channel!.summarize(
			fullTree,
			trackState,
			telemetryContext,
		);

		// Wrap dds summaries in .channels subtree.
		wrapSummaryInChannelsTree(summarizeResult);
		const pathPartsForChildren = [channelsTreeName];

		// Add data store's attributes to the summary.
		const { pkg } = await this.getInitialSnapshotDetails();
		const isRoot = await this.isRoot();
		const attributes = createAttributes(pkg, isRoot);
		addBlobToSummary(summarizeResult, dataStoreAttributesBlobName, JSON.stringify(attributes));

		// If we are not referenced, mark the summary tree as unreferenced. Also, update unreferenced blob
		// size in the summary stats with the blobs size of this data store.
		if (!this.summarizerNode.isReferenced()) {
			summarizeResult.summary.unreferenced = true;
			summarizeResult.stats.unreferencedBlobSize = summarizeResult.stats.totalBlobSize;
		}

		// Add loadingGroupId to the summary
		if (this.loadingGroupId !== undefined) {
			summarizeResult.summary.groupId = this.loadingGroupId;
		}

		return {
			...summarizeResult,
			id: this.id,
			pathPartsForChildren,
		};
	}

	/**
	 * Returns the data used for garbage collection. This includes a list of GC nodes that represent this data store
	 * including any of its child channel contexts. Each node has a set of outbound routes to other GC nodes in the
	 * document.
	 * If there is no new data in this data store since the last summary, previous GC data is used.
	 * If there is new data, the GC data is generated again (by calling getGCDataInternal).
	 * @param fullGC - true to bypass optimizations and force full generation of GC data.
	 */
	public async getGCData(fullGC: boolean = false): Promise<IGarbageCollectionData> {
		return this.summarizerNode.getGCData(fullGC);
	}

	/**
	 * Generates data used for garbage collection. This is called when there is new data since last summary. It
	 * realizes the data store and calls into each channel context to get its GC data.
	 * @param fullGC - true to bypass optimizations and force full generation of GC data.
	 */
	private async getGCDataInternal(fullGC: boolean = false): Promise<IGarbageCollectionData> {
		await this.realize();
		assert(
			this.channel !== undefined,
			0x143 /* "Channel should not be undefined when running GC" */,
		);

		return this.channel.getGCData(fullGC);
	}

	/**
	 * After GC has run, called to notify the data store of routes used in it. These are used for the following:
	 * 1. To identify if this data store is being referenced in the document or not.
	 * 2. To determine if it needs to re-summarize in case used routes changed since last summary.
	 * 3. To notify child contexts of their used routes. This is done immediately if the data store is loaded.
	 * Else, it is done by the data stores's summarizer node when child summarizer nodes are created.
	 *
	 * @param usedRoutes - The routes that are used in this data store.
	 */
	public updateUsedRoutes(usedRoutes: string[]): void {
		// Update the used routes in this data store's summarizer node.
		this.summarizerNode.updateUsedRoutes(usedRoutes);

		// If the channel doesn't exist yet (data store is not realized), the summarizer node will update it
		// when it creates child nodes.
		if (!this.channel) {
			return;
		}

		// Remove the route to this data store, if it exists.
		const usedChannelRoutes = usedRoutes.filter((id: string) => {
			return id !== "/" && id !== "";
		});
		this.channel.updateUsedRoutes(usedChannelRoutes);
	}

	/**
	 * Called when a new outbound reference is added to another node. This is used by garbage collection to identify
	 * all references added in the system.
	 *
	 * @param fromPath - The absolute path of the node that added the reference.
	 * @param toPath - The absolute path of the outbound node that is referenced.
	 * @param messageTimestampMs - The timestamp of the message that added the reference.
	 */
	public addedGCOutboundRoute(
		fromPath: string,
		toPath: string,
		messageTimestampMs?: number,
	): void {
		this.parentContext.addedGCOutboundRoute(fromPath, toPath, messageTimestampMs);
	}

	public submitMessage(type: string, content: unknown, localOpMetadata: unknown): void {
		this.verifyNotClosed("submitMessage");
		assert(!!this.channel, 0x146 /* "Channel must exist when submitting message" */);
		// Readonly clients should not submit messages.
		this.identifyLocalChangeIfReadonly("DataStoreMessageWhileReadonly", type);

		this.parentContext.submitMessage(type, content, localOpMetadata);
	}

	/**
	 * This is called from a SharedSummaryBlock that does not generate ops but only wants to be part of the summary.
	 * It indicates that there is data in the object that needs to be summarized.
	 * We will update the latestSequenceNumber of the summary tracker of this
	 * store and of the object's channel.
	 *
	 * @param address - The address of the channel that is dirty.
	 *
	 */
	public setChannelDirty(address: string): void {
		this.verifyNotClosed("setChannelDirty");

		// Get the latest sequence number.
		const latestSequenceNumber = this.deltaManager.lastSequenceNumber;

		this.summarizerNode.invalidate(latestSequenceNumber);

		const channelSummarizerNode = this.summarizerNode.getChild(address);

		if (channelSummarizerNode) {
			channelSummarizerNode.invalidate(latestSequenceNumber); // TODO: lazy load problem?
		}
	}

	public submitSignal(type: string, content: unknown, targetClientId?: string): void {
		this.verifyNotClosed("submitSignal");

		assert(!!this.channel, 0x147 /* "Channel must exist on submitting signal" */);
		return this.parentContext.submitSignal(type, content, targetClientId);
	}

	/**
	 * This is called by the data store channel when it becomes locally visible indicating that it is ready to become
	 * globally visible now.
	 */
	public makeLocallyVisible(): void {
		assert(this.channel !== undefined, 0x2cf /* "undefined channel on datastore context" */);
		this.makeLocallyVisibleFn();
	}

	protected processPendingOps(channel: IFluidDataStoreChannel): void {
		const baseSequenceNumber = this.baseSnapshotSequenceNumber ?? -1;

		assert(
			this.pendingMessagesState !== undefined,
			0xa6a /* pending messages queue is undefined */,
		);
		for (const messageCollection of this.pendingMessagesState.messageCollections) {
			// Only process ops whose seq number is greater than snapshot sequence number from which it loaded.
			if (messageCollection.envelope.sequenceNumber > baseSequenceNumber) {
				channel.processMessages(messageCollection);
			}
		}

		this.thresholdOpsCounter.send("ProcessPendingOps", this.pendingMessagesState.pendingCount);
		this.pendingMessagesState = undefined;
	}

	protected completeBindingRuntime(channel: IFluidDataStoreChannel): void {
		// Validate that the DataStore is compatible with this Runtime.
		const maybeDataStoreCompatDetails = channel as FluidObject<ILayerCompatDetails>;
		validateDatastoreCompatibility(
			maybeDataStoreCompatDetails.ILayerCompatDetails,
			this.dispose.bind(this),
		);

		// And now mark the runtime active
		this.loaded = true;
		this.channel = channel;

		// Channel does not know when it's "live" (as in - starts to receive events in the system)
		// It may read current state of the system when channel was created, but it was not getting any updates
		// through creation process and could have missed events. So update it on current state.
		// Once this.loaded is set (above), it will stat receiving events.
		channel.setConnectionState(this.connected, this.clientId);

		// Freeze the package path to ensure that someone doesn't modify it when it is
		// returned in packagePath().
		Object.freeze(this.pkg);
	}

	protected async bindRuntime(
		channel: IFluidDataStoreChannel,
		existing: boolean,
	): Promise<void> {
		if (this.channel) {
			throw new Error("Runtime already bound");
		}

		assert(
			!this.detachedRuntimeCreation,
			0x148 /* "Detached runtime creation on runtime bind" */,
		);
		assert(this.pkg !== undefined, 0x14a /* "Undefined package path" */);

		if (!existing) {
			// Execute data store's entry point to make sure that for a local (aka detached from container) data store, the
			// entryPoint initialization function is called before the data store gets attached and potentially connected to
			// the delta stream, so it gets a chance to do things while the data store is still "purely local".
			// This preserves the behavior from before we introduced entryPoints, where the instantiateDataStore method
			// of data store factories tends to construct the data object (at least kick off an async method that returns
			// it); that code moved to the entryPoint initialization function, so we want to ensure it still executes
			// before the data store is attached.
			await channel.entryPoint.get();
		}

		this.processPendingOps(channel);
		this.completeBindingRuntime(channel);
	}

	public async getAbsoluteUrl(relativeUrl: string): Promise<string | undefined> {
		if (this.attachState !== AttachState.Attached) {
			return undefined;
		}
		return this.parentContext.getAbsoluteUrl(relativeUrl);
	}

	/**
	 * Get the summary required when attaching this context's DataStore.
	 * Used for both Container Attach and DataStore Attach.
	 */
	public abstract getAttachSummary(
		telemetryContext?: ITelemetryContext,
	): ISummaryTreeWithStats;

	/**
	 * Get the GC Data for the initial state being attached so remote clients can learn of this DataStore's
	 * outbound routes.
	 */
	public abstract getAttachGCData(
		telemetryContext?: ITelemetryContext,
	): IGarbageCollectionData;

	public abstract getInitialSnapshotDetails(): Promise<ISnapshotDetails>;

	// eslint-disable-next-line jsdoc/require-description
	/**
	 * @deprecated Sets the datastore as root, for aliasing purposes: #7948
	 * This method should not be used outside of the aliasing context.
	 * It will be removed, as the source of truth for this flag will be the aliasing blob.
	 */
	public setInMemoryRoot(): void {
		this._isInMemoryRoot = true;
	}

	// eslint-disable-next-line jsdoc/require-description
	/**
	 * @deprecated The functionality to get base GC details has been moved to summarizer node.
	 */
	public async getBaseGCDetails(): Promise<IGarbageCollectionDetailsBase> {
		return {};
	}

	public reSubmit(
		type: string,
		contents: unknown,
		localOpMetadata: unknown,
		squash: boolean,
	): void {
		assert(!!this.channel, 0x14b /* "Channel must exist when resubmitting ops" */);
		this.channel.reSubmit(type, contents, localOpMetadata, squash);
	}

	public rollback(type: string, contents: unknown, localOpMetadata: unknown): void {
		if (!this.channel) {
			throw new Error("Channel must exist when rolling back ops");
		}
		if (!this.channel.rollback) {
			throw new Error("Channel doesn't support rollback");
		}
		this.channel.rollback(type, contents, localOpMetadata);
	}

	public async applyStashedOp(contents: unknown): Promise<unknown> {
		if (!this.channel) {
			await this.realize();
		}
		assert(!!this.channel, 0x14c /* "Channel must exist when rebasing ops" */);
		return this.channel.applyStashedOp(contents);
	}

	private verifyNotClosed(
		callSite: string,
		checkTombstone = true,
		safeTelemetryProps: ITelemetryBaseProperties = {},
	): void {
		if (this.deleted) {
			const messageString = `Context is deleted! Call site [${callSite}]`;
			const error = DataProcessingError.create(
				messageString,
				callSite,
				undefined /* sequencedMessage */,
				safeTelemetryProps,
			);
			this.mc.logger.sendErrorEvent(
				{
					eventName: "GC_Deleted_DataStore_Changed",
					callSite,
				},
				error,
			);

			throw error;
		}

		if (this._disposed) {
			throw new Error(`Context is closed! Call site [${callSite}]`);
		}

		if (checkTombstone && this.tombstoned) {
			const messageString = `Context is tombstoned! Call site [${callSite}]`;
			const error = DataProcessingError.create(
				messageString,
				callSite,
				undefined /* sequencedMessage */,
				safeTelemetryProps,
				30 /* stackTraceLimit */,
			);

			this.mc.logger.sendTelemetryEvent(
				{
					eventName: "GC_Tombstone_DataStore_Changed",
					category: "generic",
					callSite,
				},
				error,
			);
		}
	}

	/**
	 * Readonly client, including summarizer, should not have local changes. These changes can become part of the summary and can break
	 * eventual consistency. For example, the next summary (say at ref seq# 100) may contain these changes whereas
	 * other clients that are up-to-date till seq# 100 may not have them yet.
	 */
	protected identifyLocalChangeIfReadonly(eventName: string, type?: string): void {
		if (!this.isReadOnly() || this.localChangesTelemetryCount <= 0) {
			return;
		}

		// Log a telemetry if there are local changes in readonly. This will give us data on how often
		// this is happening and which data stores do this. The eventual goal is to disallow local changes
		// in the summarizer and the data will help us plan this.
		this.mc.logger.sendTelemetryEvent({
			eventName,
			type,
			isSummaryInProgress: this.summarizerNode.isSummaryInProgress?.(),
			stack: generateStack(30),
			readonly: this.isReadOnly(),
			isStagingMode: this.isStagingMode,
		});
		this.localChangesTelemetryCount--;
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
				undefined /* config */,
				getGCDataFn,
			);
	}

	public deleteChildSummarizerNode(id: string): void {
		this.summarizerNode.deleteChild(id);
	}

	public async uploadBlob(
		blob: ArrayBufferLike,
		signal?: AbortSignal,
	): Promise<IFluidHandleInternal<ArrayBufferLike>> {
		return this.parentContext.uploadBlob(blob, signal);
	}
}

/**
 * @internal
 */
export class RemoteFluidDataStoreContext extends FluidDataStoreContext {
	// Tells whether we need to fetch the snapshot before use. This is to support Data Virtualization.
	private snapshotFetchRequired: boolean | undefined;
	private readonly runtime: IContainerRuntimeBase;
	private readonly blobContents: Map<string, ArrayBuffer> | undefined;
	private readonly isSnapshotInISnapshotFormat: boolean | undefined;

	constructor(props: IRemoteFluidDataStoreContextProps) {
		super(props, true /* existing */, false /* isLocalDataStore */, () => {
			throw new Error("Already attached");
		});

		this.runtime = props.parentContext.containerRuntime;
		if (isInstanceOfISnapshot(props.snapshot)) {
			this.blobContents = props.snapshot.blobContents;
			this._baseSnapshot = props.snapshot.snapshotTree;
			this.isSnapshotInISnapshotFormat = true;
		} else {
			this._baseSnapshot = props.snapshot;
			this.isSnapshotInISnapshotFormat = false;
		}
	}

	/**
	 * This API should not be called for RemoteFluidDataStoreContext. But here is one scenario where it's not the case:
	 * The scenario (hit by stashedOps.spec.ts, "resends attach op" UT is the following (as far as I understand):
	 *
	 * 1. data store is being attached in attached container
	 *
	 * 2. container state is serialized (stashed ops feature)
	 *
	 * 3. new container instance is rehydrated (from stashed ops) -
	 * As result, we create RemoteFluidDataStoreContext for this data store that is actually in "attaching" state  * (as of # 2).
	 * But its state is set to attached when loading container from stashed ops.
	 *
	 * 4. attach op for this data store is processed - setAttachState() is called.
	 */
	public setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void {}

	// eslint-disable-next-line unicorn/consistent-function-scoping -- Property is defined once; no need to extract inner lambda
	private readonly initialSnapshotDetailsP = new LazyPromise<ISnapshotDetails>(async () => {
		// Sequence number of the snapshot.
		let sequenceNumber: number | undefined;
		// Check whether we need to fetch the snapshot first to load. The snapshot should be in new format to see
		// whether we want to evaluate to fetch snapshot or not for loadingGroupId. Otherwise, the snapshot
		// will contain all the blobs.
		if (
			this.snapshotFetchRequired === undefined &&
			this._baseSnapshot?.groupId !== undefined &&
			this.isSnapshotInISnapshotFormat
		) {
			assert(
				this.blobContents !== undefined,
				0x97a /* Blob contents should be present to evaluate */,
			);
			assert(
				this._baseSnapshot !== undefined,
				0x97b /* snapshotTree should be present to evaluate */,
			);
			this.snapshotFetchRequired = isSnapshotFetchRequiredForLoadingGroupId(
				this._baseSnapshot,
				this.blobContents,
			);
		}
		if (this.snapshotFetchRequired) {
			assert(
				this.loadingGroupId !== undefined,
				0x8f5 /* groupId should be present to fetch snapshot */,
			);
			const snapshot = await this.runtime.getSnapshotForLoadingGroupId(
				[this.loadingGroupId],
				[this.id],
			);
			this._baseSnapshot = snapshot.snapshotTree;
			sequenceNumber = snapshot.sequenceNumber;
			this.snapshotFetchRequired = false;
		}
		let tree = this.baseSnapshot;
		let isRootDataStore = true;

		if (!!tree && tree.blobs[dataStoreAttributesBlobName] !== undefined) {
			// Need to get through snapshot and use that to populate extraBlobs
			// eslint-disable-next-line import/no-deprecated
			const attributes = await readAndParse<ReadFluidDataStoreAttributes>(
				this.storage,
				tree.blobs[dataStoreAttributesBlobName],
			);

			let pkgFromSnapshot: string[];
			// Use the snapshotFormatVersion to determine how the pkg is encoded in the snapshot.
			// For snapshotFormatVersion = "0.1" (1) or above, pkg is jsonified, otherwise it is just a string.
			const formatVersion = getAttributesFormatVersion(attributes);
			if (formatVersion < 1) {
				pkgFromSnapshot =
					attributes.pkg.startsWith('["') && attributes.pkg.endsWith('"]')
						? (JSON.parse(attributes.pkg) as string[])
						: [attributes.pkg];
			} else {
				pkgFromSnapshot = JSON.parse(attributes.pkg) as string[];
			}
			this.pkg = pkgFromSnapshot;

			/**
			 * If there is no isRootDataStore in the attributes blob, set it to true. This will ensure that
			 * data stores in older documents are not garbage collected incorrectly. This may lead to additional
			 * roots in the document but they won't break.
			 */
			isRootDataStore = attributes.isRootDataStore ?? true;

			if (hasIsolatedChannels(attributes)) {
				tree = tree.trees[channelsTreeName];
				assert(
					tree !== undefined,
					0x1fe /* "isolated channels subtree should exist in remote datastore snapshot" */,
				);
			}
		}

		assert(
			this.pkg !== undefined,
			0x8f6 /* The datastore context package should be defined */,
		);
		return {
			pkg: this.pkg,
			isRootDataStore,
			snapshot: tree,
			sequenceNumber,
		};
	});

	public async getInitialSnapshotDetails(): Promise<ISnapshotDetails> {
		return this.initialSnapshotDetailsP;
	}

	/**
	 * {@inheritDoc FluidDataStoreContext.getAttachSummary}
	 */
	public getAttachSummary(): ISummaryTreeWithStats {
		throw new Error("Cannot attach remote store");
	}

	/**
	 * {@inheritDoc FluidDataStoreContext.getAttachGCData}
	 */
	public getAttachGCData(telemetryContext?: ITelemetryContext): IGarbageCollectionData {
		throw new Error("Cannot attach remote store");
	}
}

/**
 * Base class for detached & attached context classes
 * @internal
 */
export class LocalFluidDataStoreContextBase extends FluidDataStoreContext {
	private readonly snapshotTree: ISnapshotTree | undefined;

	constructor(props: ILocalFluidDataStoreContextProps) {
		super(
			props,
			props.snapshotTree !== undefined /* existing */,
			true /* isLocalDataStore */,
			props.makeLocallyVisibleFn,
		);

		// Summarizer client should not create local data stores.
		this.identifyLocalChangeIfReadonly("DataStoreCreatedWhileReadonly");

		this.snapshotTree = props.snapshotTree;
	}

	public setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void {
		switch (attachState) {
			case AttachState.Attaching: {
				assert(
					this.attachState === AttachState.Detached,
					0x14d /* "Should move from detached to attaching" */,
				);
				this._attachState = AttachState.Attaching;
				if (this.channel?.setAttachState) {
					this.channel.setAttachState(attachState);
				} else if (this.channel) {
					// back-compat! To be removed in the future
					// Added in "2.0.0-rc.2.0.0" timeframe.
					this.emit("attaching");
				}
				break;
			}
			case AttachState.Attached: {
				// We can get called into here twice, as result of both container and data store being attached, if
				// those processes overlapped, for example, in a flow like that one:
				// 1. Container attach started
				// 2. data store attachment started
				// 3. container attached
				// 4. data store attached.
				if (this.attachState !== AttachState.Attached) {
					assert(
						this.attachState === AttachState.Attaching,
						0x14e /* "Should move from attaching to attached" */,
					);
					this._attachState = AttachState.Attached;
					this.channel?.setAttachState?.(attachState);
					if (this.channel?.setAttachState) {
						this.channel.setAttachState(attachState);
					} else if (this.channel) {
						// back-compat! To be removed in the future
						// Added in "2.0.0-rc.2.0.0" timeframe.
						this.emit("attached");
					}
				}
				break;
			}
			default: {
				unreachableCase(attachState, "unreached");
			}
		}
	}

	/**
	 * {@inheritDoc FluidDataStoreContext.getAttachSummary}
	 */
	public getAttachSummary(telemetryContext?: ITelemetryContext): ISummaryTreeWithStats {
		assert(
			this.channel !== undefined,
			0x14f /* "There should be a channel when generating attach message" */,
		);
		assert(
			this.pkg !== undefined,
			0x150 /* "pkg should be available in local data store context" */,
		);

		const attachSummary = this.channel.getAttachSummary(telemetryContext);

		// Wrap dds summaries in .channels subtree.
		wrapSummaryInChannelsTree(attachSummary);

		// Add data store's attributes to the summary.
		const attributes = createAttributes(this.pkg, this.isInMemoryRoot());
		addBlobToSummary(attachSummary, dataStoreAttributesBlobName, JSON.stringify(attributes));

		// Add loadingGroupId to the summary
		if (this.loadingGroupId !== undefined) {
			attachSummary.summary.groupId = this.loadingGroupId;
		}

		return attachSummary;
	}

	/**
	 * {@inheritDoc FluidDataStoreContext.getAttachGCData}
	 */
	public getAttachGCData(telemetryContext?: ITelemetryContext): IGarbageCollectionData {
		assert(
			this.channel !== undefined,
			0x9a6 /* There should be a channel when generating attach GC data */,
		);
		return this.channel.getAttachGCData(telemetryContext);
	}

	// eslint-disable-next-line unicorn/consistent-function-scoping -- Property is defined once; no need to extract inner lambda
	private readonly initialSnapshotDetailsP = new LazyPromise<ISnapshotDetails>(async () => {
		let snapshot = this.snapshotTree;
		// eslint-disable-next-line import/no-deprecated
		let attributes: ReadFluidDataStoreAttributes;
		let isRootDataStore = false;
		if (snapshot !== undefined) {
			// Get the dataStore attributes.
			// Note: storage can be undefined in special case while detached.
			attributes = await getFluidDataStoreAttributes(this.storage, snapshot);
			if (hasIsolatedChannels(attributes)) {
				snapshot = snapshot.trees[channelsTreeName];
				assert(
					snapshot !== undefined,
					0x1ff /* "isolated channels subtree should exist in local datastore snapshot" */,
				);
			}
			if (this.pkg === undefined) {
				this.pkg = JSON.parse(attributes.pkg) as string[];
				// If there is no isRootDataStore in the attributes blob, set it to true. This ensures that data
				// stores in older documents are not garbage collected incorrectly. This may lead to additional
				// roots in the document but they won't break.
				if (attributes.isRootDataStore ?? true) {
					isRootDataStore = true;
					this.setInMemoryRoot();
				}
			}
		}
		assert(this.pkg !== undefined, 0x152 /* "pkg should be available in local data store" */);

		return {
			pkg: this.pkg,
			isRootDataStore,
			snapshot,
		};
	});

	public async getInitialSnapshotDetails(): Promise<ISnapshotDetails> {
		return this.initialSnapshotDetailsP;
	}

	/**
	 * A context should only be marked as deleted when its a remote context.
	 * Session Expiry at the runtime level should have closed the container creating the local data store context
	 * before delete is even possible. Session Expiry is at 30 days, and sweep is done 36+ days later from the time
	 * it was unreferenced. Thus the sweeping container should have loaded from a snapshot and thus creating a remote
	 * context.
	 */
	public delete(): void {
		// TODO: GC:Validation - potentially prevent this from happening or asserting. Maybe throw here.
		this.mc.logger.sendErrorEvent({
			eventName: "GC_Deleted_DataStore_Unexpected_Delete",
			message: "Unexpected deletion of a local data store context",
		});
		super.delete();
	}
}

/**
 * context implementation for "attached" data store runtime.
 * Various workflows (snapshot creation, requests) result in .realize() being called
 * on context, resulting in instantiation and attachment of runtime.
 * Runtime is created using data store factory that is associated with this context.
 * @internal
 */
export class LocalFluidDataStoreContext extends LocalFluidDataStoreContextBase {
	constructor(props: ILocalFluidDataStoreContextProps) {
		super(props);
	}
}

/**
 * Detached context. Data Store runtime will be attached to it by attachRuntime() call
 * Before attachment happens, this context is not associated with particular type of runtime
 * or factory, i.e. it's package path is undefined.
 * Attachment process provides all missing parts - package path, data store runtime, and data store factory
 */
export class LocalDetachedFluidDataStoreContext
	extends LocalFluidDataStoreContextBase
	implements IFluidDataStoreContextDetached
{
	constructor(props: ILocalDetachedFluidDataStoreContextProps) {
		super(props);
		this.detachedRuntimeCreation = true;
		this.channelToDataStoreFn = props.channelToDataStoreFn;
	}
	private readonly channelToDataStoreFn: (channel: IFluidDataStoreChannel) => IDataStore;

	public async attachRuntime(
		registry: IProvideFluidDataStoreFactory,
		dataStoreChannel: IFluidDataStoreChannel,
	): Promise<IDataStore> {
		assert(this.detachedRuntimeCreation, 0x154 /* "runtime creation is already attached" */);
		this.detachedRuntimeCreation = false;

		assert(this.channelP === undefined, 0x155 /* "channel deferral is already set" */);

		this.channelP = Promise.resolve()
			.then(async () => {
				const factory = registry.IFluidDataStoreFactory;

				const factory2 = await this.factoryFromPackagePath();
				assert(factory2 === factory, 0x156 /* "Unexpected factory for package path" */);

				await super.bindRuntime(dataStoreChannel, false /* existing */);

				assert(
					!(await this.isRoot()),
					0x8f7 /* there are no more createRootDataStore() kind of APIs! */,
				);

				return dataStoreChannel;
			})
			.catch((error) => {
				this.mc.logger.sendErrorEvent({ eventName: "AttachRuntimeError" }, error);
				// The following two lines result in same exception thrown.
				// But we need to ensure that this.channelDeferred.promise is "observed", as otherwise
				// out UT reports unhandled exception
				throw error;
			});

		return this.channelToDataStoreFn(await this.channelP);
	}

	/**
	 * This method provides a synchronous path for binding a runtime to the context.
	 *
	 * Due to its synchronous nature, it is unable to validate that the runtime
	 * represents a datastore which is instantiable by remote clients. This could
	 * happen if the runtime's package path does not return a factory when looked up
	 * in the container runtime's registry, or if the runtime's entrypoint is not
	 * properly initialized. As both of these validation's are asynchronous to preform.
	 *
	 * If used incorrectly, this function can result in permanent data corruption.
	 */
	public unsafe_AttachRuntimeSync(channel: IFluidDataStoreChannel): IDataStore {
		this.channelP = Promise.resolve(channel);
		this.processPendingOps(channel);
		this.completeBindingRuntime(channel);
		return this.channelToDataStoreFn(channel);
	}

	public async getInitialSnapshotDetails(): Promise<ISnapshotDetails> {
		if (this.detachedRuntimeCreation) {
			throw new Error(
				"Detached Fluid Data Store context can't be realized! Please attach runtime first!",
			);
		}
		return super.getInitialSnapshotDetails();
	}
}
