/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { ErasedType, IFluidLoadable } from "@fluidframework/core-interfaces/internal";
import { assert, fail } from "@fluidframework/core-utils/internal";
import type { IChannelStorageService } from "@fluidframework/datastore-definitions/internal";
import type { IIdCompressor } from "@fluidframework/id-compressor";
import type {
	IChannelView,
	IFluidSerializer,
	SharedKernel,
} from "@fluidframework/shared-object-base/internal";
import {
	UsageError,
	type ITelemetryLoggerExt,
} from "@fluidframework/telemetry-utils/internal";

import {
	type CodecWriteOptions,
	FluidClientVersion,
	type ICodecOptions,
	noopValidator,
} from "../codec/index.js";
import {
	type FieldKey,
	type GraphCommit,
	type IEditableForest,
	type JsonableTree,
	LeafNodeStoredSchema,
	MapNodeStoredSchema,
	ObjectNodeStoredSchema,
	RevisionTagCodec,
	SchemaVersion,
	type TaggedChange,
	type TreeFieldStoredSchema,
	type TreeNodeStoredSchema,
	type TreeStoredSchema,
	TreeStoredSchemaRepository,
	type TreeStoredSchemaSubscription,
	makeDetachedFieldIndex,
	moveToDetachedField,
} from "../core/index.js";
import {
	DetachedFieldIndexSummarizer,
	FieldKinds,
	ForestSummarizer,
	SchemaSummarizer,
	TreeCompressionStrategy,
	buildChunkedForest,
	buildForest,
	defaultSchemaPolicy,
	jsonableTreeFromFieldCursor,
	makeFieldBatchCodec,
	makeMitigatedChangeFamily,
	makeSchemaCodec,
	makeTreeChunker,
} from "../feature-libraries/index.js";
// eslint-disable-next-line import/no-internal-modules
import type { FormatV1 } from "../feature-libraries/schema-index/index.js";
import {
	type ClonableSchemaAndPolicy,
	DefaultResubmitMachine,
	type ExplicitCoreCodecVersions,
	SharedTreeCore,
} from "../shared-tree-core/index.js";
import {
	type ITree,
	type ImplicitFieldSchema,
	NodeKind,
	type ReadSchema,
	type SimpleFieldSchema,
	type SimpleTreeSchema,
	type TreeView,
	type TreeViewAlpha,
	type TreeViewConfiguration,
	type UnsafeUnknownSchema,
	type VerboseTree,
	tryStoredSchemaAsArray,
	type SimpleNodeSchema,
	FieldKind,
	type ITreeAlpha,
	type SimpleObjectFieldSchema,
} from "../simple-tree/index.js";

import { SchematizingSimpleTreeView } from "./schematizingTreeView.js";
import { SharedTreeReadonlyChangeEnricher } from "./sharedTreeChangeEnricher.js";
import { SharedTreeChangeFamily } from "./sharedTreeChangeFamily.js";
import type { SharedTreeChange } from "./sharedTreeChangeTypes.js";
import type { SharedTreeEditBuilder } from "./sharedTreeEditBuilder.js";
import { type TreeCheckout, type BranchableTree, createTreeCheckout } from "./treeCheckout.js";
import {
	type Breakable,
	breakingClass,
	type JsonCompatible,
	throwIfBroken,
} from "../util/index.js";

/**
 * Copy of data from an {@link ITreePrivate} at some point in time.
 * @remarks
 * This is unrelated to Fluids concept of "snapshots".
 */
export interface SharedTreeContentSnapshot {
	/**
	 * The schema stored in the document.
	 *
	 * @remarks
	 * Edits to the schema can mutate the schema stored of the tree which took this snapshot (but this snapshot will remain the same)
	 * This is mainly useful for debugging cases where schematize reports an incompatible view schema.
	 */
	readonly schema: TreeStoredSchema;
	/**
	 * All {@link TreeStatus.InDocument} content.
	 */
	readonly tree: JsonableTree[];
	/**
	 * All {@link TreeStatus.Removed} content.
	 */
	readonly removed: [string | number | undefined, number, JsonableTree][];
}

/**
 * {@link ITree} extended with some non-public APIs.
 * @internal
 */
export interface ITreeInternal extends IChannelView, ITreeAlpha {}

/**
 * {@link ITreeInternal} extended with some non-exported APIs.
 * @remarks
 * This allows access to the tree content using the internal data model used at the storage and "flex" layers,
 * and should only be needed for testing and debugging this package's internals.
 */
export interface ITreePrivate extends ITreeInternal {
	/**
	 * Provides a copy of the current content of the tree.
	 * This can be useful for inspecting the tree when no suitable view schema is available.
	 * This is only intended for use in testing and exceptional code paths: it is not performant.
	 *
	 * This does not include everything that is included in a tree summary, since information about how to merge future edits is omitted.
	 */
	contentSnapshot(): SharedTreeContentSnapshot;

	/**
	 * Access to internals for testing.
	 */
	readonly kernel: SharedTreeKernel;
}

/**
 * Has an entry for each codec which writes an explicit version into its data.
 *
 * This is used to map the single API entrypoint controlling the format {@link SharedTreeOptions.formatVersion}
 * to a list of write versions that for each codec that should be used for that format.
 *
 * Note that all explicitly versioned codecs should be using the format version from the data to read encoded data.
 *
 * TODO: Plumb these write versions into forest, schema, detached field index codec creation.
 */
interface ExplicitCodecVersions extends ExplicitCoreCodecVersions {
	forest: number;
	schema: SchemaVersion;
	detachedFieldIndex: number;
	fieldBatch: number;
}

const formatVersionToTopLevelCodecVersions = new Map<number, ExplicitCodecVersions>([
	[
		1,
		{ forest: 1, schema: 1, detachedFieldIndex: 1, editManager: 1, message: 1, fieldBatch: 1 },
	],
	[
		2,
		{ forest: 1, schema: 1, detachedFieldIndex: 1, editManager: 2, message: 2, fieldBatch: 1 },
	],
	[
		3,
		{ forest: 1, schema: 1, detachedFieldIndex: 1, editManager: 3, message: 3, fieldBatch: 1 },
	],
	[
		4,
		{ forest: 1, schema: 1, detachedFieldIndex: 1, editManager: 4, message: 4, fieldBatch: 1 },
	],
	[
		5,
		{ forest: 1, schema: 2, detachedFieldIndex: 1, editManager: 4, message: 4, fieldBatch: 1 },
	],
]);

function getCodecVersions(formatVersion: number): ExplicitCodecVersions {
	const versions = formatVersionToTopLevelCodecVersions.get(formatVersion);
	assert(versions !== undefined, 0x90e /* Unknown format version */);
	return versions;
}

/**
 * The type SharedTree's kernel's view must implement so what when its merged with the underling SharedObject's API it fully implements the required tree API surface ({@link ITreePrivate }).
 */
export type SharedTreeKernelView = Omit<ITreePrivate, keyof (IChannelView & IFluidLoadable)>;

/**
 * SharedTreeCore, configured with a good set of indexes and field kinds which will maintain compatibility over time.
 *
 * TODO: detail compatibility requirements.
 */
@breakingClass
export class SharedTreeKernel
	extends SharedTreeCore<SharedTreeEditBuilder, SharedTreeChange>
	implements SharedKernel
{
	public readonly checkout: TreeCheckout;
	public get storedSchema(): TreeStoredSchemaRepository {
		return this.checkout.storedSchema;
	}

	/**
	 * The app-facing API for SharedTree implemented by this Kernel.
	 * @remarks
	 * This is the API grafted onto the ISharedObject which apps can access.
	 * It includes both the APIs used for internal testing, and public facing APIs (both stable and unstable).
	 * Different users will have access to different subsets of this API, see {@link ITree}, {@link ITreeAlpha} and {@link ITreeInternal} which this {@link ITreePrivate} extends.
	 */
	public readonly view: SharedTreeKernelView;

	public constructor(
		breaker: Breakable,
		sharedObject: IChannelView & IFluidLoadable,
		serializer: IFluidSerializer,
		submitLocalMessage: (content: unknown, localOpMetadata?: unknown) => void,
		lastSequenceNumber: () => number | undefined,
		logger: ITelemetryLoggerExt | undefined,
		idCompressor: IIdCompressor,
		optionsParam: SharedTreeOptionsInternal,
	) {
		const options = { ...defaultSharedTreeOptions, ...optionsParam };
		const codecVersions = getCodecVersions(options.formatVersion);
		const schema = new TreeStoredSchemaRepository();
		const forest = buildConfiguredForest(breaker, options.forest, schema, idCompressor);
		const revisionTagCodec = new RevisionTagCodec(idCompressor);
		const removedRoots = makeDetachedFieldIndex(
			"repair",
			revisionTagCodec,
			idCompressor,
			options,
		);
		const schemaCodec = makeSchemaCodec(options, codecVersions.schema);
		const schemaSummarizer = new SchemaSummarizer(
			schema,
			{
				getCurrentSeq: lastSequenceNumber,
			},
			schemaCodec,
		);
		const fieldBatchCodec = makeFieldBatchCodec(options, codecVersions.fieldBatch);

		const encoderContext = {
			schema: {
				schema,
				policy: defaultSchemaPolicy,
			},
			encodeType: options.treeEncodeType,
			originatorId: idCompressor.localSessionId,
			idCompressor,
		};
		const forestSummarizer = new ForestSummarizer(
			forest,
			revisionTagCodec,
			fieldBatchCodec,
			encoderContext,
			options,
			idCompressor,
		);
		const removedRootsSummarizer = new DetachedFieldIndexSummarizer(removedRoots);
		const innerChangeFamily = new SharedTreeChangeFamily(
			revisionTagCodec,
			fieldBatchCodec,
			options,
			options.treeEncodeType,
			idCompressor,
		);
		const changeFamily = makeMitigatedChangeFamily(
			innerChangeFamily,
			SharedTreeChangeFamily.emptyChange,
			(error: unknown) => {
				// TODO:6344 Add telemetry for these errors.
				// Rethrowing the error has a different effect depending on the context in which the
				// ChangeFamily was invoked:
				// - If the ChangeFamily was invoked as part of incoming op processing, rethrowing the error
				// will cause the runtime to disconnect the client, log a severe error, and not reconnect.
				// This will not cause the host application to crash because it is not on the stack at that time.
				// TODO: let the host application know that the client is now disconnected.
				// - If the ChangeFamily was invoked as part of dealing with a local change, rethrowing the
				// error will cause the host application to crash. This is not ideal, but is better than
				// letting the application either send an invalid change to the server or allowing the
				// application to continue working when its local branches contain edits that cannot be
				// reflected in its views.
				// The best course of action for a host application in such a state is to restart.
				// TODO: let the host application know about this situation and provide a way to
				// programmatically reload the SharedTree container.
				throw error;
			},
		);
		const changeEnricher = new SharedTreeReadonlyChangeEnricher(forest, schema, removedRoots);
		super(
			breaker,
			sharedObject,
			serializer,
			submitLocalMessage,
			logger,
			[schemaSummarizer, forestSummarizer, removedRootsSummarizer],
			changeFamily,
			options,
			codecVersions,
			idCompressor,
			schema,
			defaultSchemaPolicy,
			new DefaultResubmitMachine(
				(change: TaggedChange<SharedTreeChange>) =>
					changeFamily.rebaser.invert(change, true, this.mintRevisionTag()),
				changeEnricher,
			),
			changeEnricher,
		);
		const localBranch = this.getLocalBranch();
		this.checkout = createTreeCheckout(idCompressor, this.mintRevisionTag, revisionTagCodec, {
			branch: localBranch,
			changeFamily,
			schema,
			forest,
			fieldBatchCodec,
			removedRoots,
			chunkCompressionStrategy: options.treeEncodeType,
			logger,
			breaker: this.breaker,
			disposeForksAfterTransaction: options.disposeForksAfterTransaction,
		});

		this.checkout.transaction.events.on("started", () => {
			if (sharedObject.isAttached()) {
				// It is currently forbidden to attach during a transaction, so transaction state changes can be ignored until after attaching.
				this.commitEnricher.startTransaction();
			}
		});
		this.checkout.transaction.events.on("aborting", () => {
			if (sharedObject.isAttached()) {
				// It is currently forbidden to attach during a transaction, so transaction state changes can be ignored until after attaching.
				this.commitEnricher.abortTransaction();
			}
		});
		this.checkout.transaction.events.on("committing", () => {
			if (sharedObject.isAttached()) {
				// It is currently forbidden to attach during a transaction, so transaction state changes can be ignored until after attaching.
				this.commitEnricher.commitTransaction();
			}
		});
		this.checkout.events.on("beforeBatch", (event) => {
			if (event.type === "append" && sharedObject.isAttached()) {
				if (this.checkout.transaction.isInProgress()) {
					this.commitEnricher.addTransactionCommits(event.newCommits);
				}
			}
		});

		this.view = {
			contentSnapshot: () => this.contentSnapshot(),
			exportSimpleSchema: () => this.exportSimpleSchema(),
			exportVerbose: () => this.exportVerbose(),
			viewWith: this.viewWith.bind(this),
			kernel: this,
		};
	}

	public exportVerbose(): VerboseTree | undefined {
		return this.checkout.exportVerbose();
	}

	public exportSimpleSchema(): SimpleTreeSchema {
		return exportSimpleSchema(this.storedSchema);
	}

	@throwIfBroken
	public contentSnapshot(): SharedTreeContentSnapshot {
		const cursor = this.checkout.forest.allocateCursor("contentSnapshot");
		try {
			moveToDetachedField(this.checkout.forest, cursor);
			return {
				schema: this.storedSchema.clone(),
				tree: jsonableTreeFromFieldCursor(cursor),
				removed: this.checkout.getRemovedRoots(),
			};
		} finally {
			cursor.free();
		}
	}

	// For the new TreeViewAlpha API
	public viewWith<TRoot extends ImplicitFieldSchema | UnsafeUnknownSchema>(
		config: TreeViewConfiguration<ReadSchema<TRoot>>,
	): SchematizingSimpleTreeView<TRoot> & TreeView<ReadSchema<TRoot>>;

	// For the old TreeView API
	public viewWith<TRoot extends ImplicitFieldSchema>(
		config: TreeViewConfiguration<TRoot>,
	): SchematizingSimpleTreeView<TRoot> & TreeView<TRoot>;

	public viewWith<TRoot extends ImplicitFieldSchema | UnsafeUnknownSchema>(
		config: TreeViewConfiguration<ReadSchema<TRoot>>,
	): SchematizingSimpleTreeView<TRoot> & TreeView<ReadSchema<TRoot>> {
		return this.checkout.viewWith(config) as SchematizingSimpleTreeView<TRoot> &
			TreeView<ReadSchema<TRoot>>;
	}

	public override async loadCore(services: IChannelStorageService): Promise<void> {
		await super.loadCore(services);
		this.checkout.load();
	}

	public override didAttach(): void {
		if (this.checkout.transaction.isInProgress()) {
			// Attaching during a transaction is not currently supported.
			// At least part of of the system is known to not handle this case correctly - commit enrichment - and there may be others.
			throw new UsageError(
				"Cannot attach while a transaction is in progress. Commit or abort the transaction before attaching.",
			);
		}
		super.didAttach();
	}

	public override applyStashedOp(
		...args: Parameters<
			SharedTreeCore<SharedTreeEditBuilder, SharedTreeChange>["applyStashedOp"]
		>
	): void {
		assert(
			!this.checkout.transaction.isInProgress(),
			0x674 /* Unexpected transaction is open while applying stashed ops */,
		);
		super.applyStashedOp(...args);
	}

	protected override submitCommit(
		commit: GraphCommit<SharedTreeChange>,
		schemaAndPolicy: ClonableSchemaAndPolicy,
		isResubmit: boolean,
	): void {
		assert(
			!this.checkout.transaction.isInProgress(),
			0xaa6 /* Cannot submit a commit while a transaction is in progress */,
		);
		if (isResubmit) {
			return super.submitCommit(commit, schemaAndPolicy, isResubmit);
		}

		// Refrain from submitting new commits until they are validated by the checkout.
		// This is not a strict requirement for correctness in our system, but in the event that there is a bug when applying commits to the checkout
		// that causes a crash (e.g. in the forest), this will at least prevent this client from sending the problematic commit to any other clients.
		this.checkout.onCommitValid(commit, () =>
			super.submitCommit(commit, schemaAndPolicy, isResubmit),
		);
	}

	public onDisconnect(): void {}
}

export function exportSimpleSchema(storedSchema: TreeStoredSchema): SimpleTreeSchema {
	return {
		root: exportSimpleFieldSchemaStored(storedSchema.rootFieldSchema),
		definitions: new Map(
			[...storedSchema.nodeSchema].map(([key, schema]) => {
				return [key, exportSimpleNodeSchemaStored(schema)];
			}),
		),
	};
}

/**
 * A way to parse schema in the persisted format from {@link extractPersistedSchema}.
 * @remarks
 * This behaves identically to {@link ITreeAlpha.exportSimpleSchema},
 * except that it gets the schema from the caller instead of from an existing tree.
 *
 * This can be useful for inspecting the contents of persisted schema,
 * such as those generated by {@link extractPersistedSchema} for use in testing.
 * Since that data format is otherwise unspecified,
 * this provides a way to inspect its contents with documented semantics.
 * @alpha
 */
export function persistedToSimpleSchema(
	persisted: JsonCompatible,
	options: ICodecOptions,
): SimpleTreeSchema {
	const schemaCodec = makeSchemaCodec(options, SchemaVersion.v1);
	const stored = schemaCodec.decode(persisted as FormatV1);
	return exportSimpleSchema(stored);
}

/**
 * Get a {@link BranchableTree} from a {@link ITree}.
 * @remarks The branch can be used for "version control"-style coordination of edits on the tree.
 * @privateRemarks This function will be removed if/when the branching API becomes public,
 * but it (or something like it) is necessary in the meantime to prevent the alpha types from being exposed as public.
 * @alpha
 * @deprecated This API is superseded by {@link TreeBranch}, which should be used instead.
 */
export function getBranch(tree: ITree): BranchableTree;
/**
 * Get a {@link BranchableTree} from a {@link TreeView}.
 * @remarks The branch can be used for "version control"-style coordination of edits on the tree.
 * Branches are currently an unstable "alpha" API and are subject to change in the future.
 * @privateRemarks This function will be removed if/when the branching API becomes public,
 * but it (or something like it) is necessary in the meantime to prevent the alpha types from being exposed as public.
 * @alpha
 * @deprecated This API is superseded by {@link TreeBranch}, which should be used instead.
 */
export function getBranch<T extends ImplicitFieldSchema | UnsafeUnknownSchema>(
	view: TreeViewAlpha<T>,
): BranchableTree;
export function getBranch<T extends ImplicitFieldSchema | UnsafeUnknownSchema>(
	treeOrView: ITree | TreeViewAlpha<T>,
): BranchableTree {
	if (treeOrView instanceof SchematizingSimpleTreeView) {
		return treeOrView.checkout as unknown as BranchableTree;
	}
	const kernel = (treeOrView as ITree as ITreePrivate).kernel;
	assert(kernel instanceof SharedTreeKernel, 0xb56 /* Invalid ITree */);
	// This cast is safe so long as TreeCheckout supports all the operations on the branch interface.
	return kernel.checkout as unknown as BranchableTree;
}

/**
 * Format versions supported by SharedTree.
 *
 * Each version documents a required minimum version of the \@fluidframework/tree package.
 * @alpha
 */
export const SharedTreeFormatVersion = {
	/**
	 * Requires \@fluidframework/tree \>= 2.0.0.
	 *
	 * @deprecated - FF does not currently plan on supporting this format long-term.
	 * Do not write production documents using this format, as they may not be loadable in the future.
	 */
	v1: 1,

	/**
	 * Requires \@fluidframework/tree \>= 2.0.0.
	 */
	v2: 2,

	/**
	 * Requires \@fluidframework/tree \>= 2.0.0.
	 */
	v3: 3,

	/**
	 * Requires \@fluidframework/tree \>= 2.0.0.
	 */
	v5: 5,
} as const;

/**
 * Format versions supported by SharedTree.
 *
 * Each version documents a required minimum version of the \@fluidframework/tree package.
 * @alpha
 * @privateRemarks
 * See packages/dds/tree/docs/main/compatibility.md for information on how to add support for a new format.
 *
 * TODO: Before this gets promoted past Alpha,
 * a separate abstraction more suited for use in the public API should be adopted rather than reusing the same types used internally.
 * Such an abstraction should probably be in the form of a Fluid-Framework wide compatibility enum.
 */
export type SharedTreeFormatVersion = typeof SharedTreeFormatVersion;

/**
 * Configuration options for SharedTree.
 * @alpha @input
 */
export type SharedTreeOptions = Partial<CodecWriteOptions> &
	Partial<SharedTreeFormatOptions> &
	ForestOptions;

export interface SharedTreeOptionsInternal extends SharedTreeOptions {
	disposeForksAfterTransaction?: boolean;
}
/**
 * Configuration options for SharedTree's internal tree storage.
 * @alpha
 */
export interface ForestOptions {
	/**
	 * The {@link ForestType} indicating which forest type should be created for the SharedTree.
	 */
	readonly forest?: ForestType;
}

/**
 * Options for configuring the persisted format SharedTree uses.
 * @alpha
 */
export interface SharedTreeFormatOptions {
	/**
	 * See {@link TreeCompressionStrategy}.
	 * default: TreeCompressionStrategy.Compressed
	 */
	treeEncodeType: TreeCompressionStrategy;
	/**
	 * The format version SharedTree should use to persist documents.
	 *
	 * This option has compatibility implications for applications using SharedTree.
	 * Each version documents a required minimum version of \@fluidframework/tree.
	 * If this minimum version fails to be met, the SharedTree may fail to load.
	 * To be safe, application authors should verify that they have saturated this version
	 * of \@fluidframework/tree in their ecosystem before changing the format version.
	 *
	 * This option defaults to SharedTreeFormatVersion.v2.
	 */
	formatVersion: SharedTreeFormatVersion[keyof SharedTreeFormatVersion];
}

/**
 * Used to distinguish between different forest types.
 * @remarks
 * Current options are {@link ForestTypeReference}, {@link ForestTypeOptimized} and {@link ForestTypeExpensiveDebug}.
 * @sealed @alpha
 */
export interface ForestType extends ErasedType<"ForestType"> {}

/**
 * Reference implementation of forest.
 * @remarks
 * A simple implementation with minimal complexity and moderate debuggability, validation and performance.
 * @privateRemarks
 * The "ObjectForest" forest type.
 * @alpha
 */
export const ForestTypeReference = toForestType(
	(breaker: Breakable, schema: TreeStoredSchemaSubscription, idCompressor: IIdCompressor) =>
		buildForest(breaker, schema),
);

/**
 * Optimized implementation of forest.
 * @remarks
 * A complex optimized forest implementation, which has minimal validation and debuggability to optimize for performance.
 * Uses an internal representation optimized for size designed to scale to larger datasets with reduced overhead.
 * @privateRemarks
 * The "ChunkedForest" forest type.
 * @alpha
 */
export const ForestTypeOptimized = toForestType(
	(breaker: Breakable, schema: TreeStoredSchemaSubscription, idCompressor: IIdCompressor) =>
		buildChunkedForest(makeTreeChunker(schema, defaultSchemaPolicy), undefined, idCompressor),
);

/**
 * Slow implementation of forest intended only for debugging.
 * @remarks
 * Includes validation with scales poorly.
 * May be asymptotically slower than {@link ForestTypeReference}, and may perform very badly with larger data sizes.
 * @privateRemarks
 * The "ObjectForest" forest type with expensive asserts for debugging.
 * @alpha
 */
export const ForestTypeExpensiveDebug = toForestType(
	(breaker: Breakable, schema: TreeStoredSchemaSubscription) =>
		buildForest(breaker, schema, undefined, true),
);

type ForestFactory = (
	breaker: Breakable,
	schema: TreeStoredSchemaSubscription,
	idCompressor: IIdCompressor,
) => IEditableForest;

function toForestType(factory: ForestFactory): ForestType {
	return factory as unknown as ForestType;
}

/**
 * Build and return a forest of the requested type.
 */
export function buildConfiguredForest(
	breaker: Breakable,
	factory: ForestType,
	schema: TreeStoredSchemaSubscription,
	idCompressor: IIdCompressor,
): IEditableForest {
	return (factory as unknown as ForestFactory)(breaker, schema, idCompressor);
}

export const defaultSharedTreeOptions: Required<SharedTreeOptionsInternal> = {
	jsonValidator: noopValidator,
	oldestCompatibleClient: FluidClientVersion.v2_0,
	forest: ForestTypeReference,
	treeEncodeType: TreeCompressionStrategy.Compressed,
	formatVersion: SharedTreeFormatVersion.v3,
	disposeForksAfterTransaction: true,
};

function exportSimpleFieldSchemaStored(schema: TreeFieldStoredSchema): SimpleFieldSchema {
	let kind: FieldKind;
	switch (schema.kind) {
		case FieldKinds.identifier.identifier:
			kind = FieldKind.Identifier;
			break;
		case FieldKinds.optional.identifier:
			kind = FieldKind.Optional;
			break;
		case FieldKinds.required.identifier:
			kind = FieldKind.Required;
			break;
		case FieldKinds.forbidden.identifier:
			kind = FieldKind.Optional;
			assert(schema.types.size === 0, 0xa94 /* invalid forbidden field */);
			break;
		default:
			fail(0xaca /* invalid field kind */);
	}
	return {
		kind,
		allowedTypesIdentifiers: schema.types,
		metadata: {},
		persistedMetadata: schema.persistedMetadata,
	};
}

/**
 * Export a {@link SimpleNodeSchema} from a {@link TreeNodeStoredSchema}.
 * @privateRemarks
 * TODO: Persist node metadata once schema FormatV2 is supported.
 */
function exportSimpleNodeSchemaStored(schema: TreeNodeStoredSchema): SimpleNodeSchema {
	const arrayTypes = tryStoredSchemaAsArray(schema);
	if (arrayTypes !== undefined) {
		return {
			kind: NodeKind.Array,
			allowedTypesIdentifiers: arrayTypes,
			metadata: {},
			persistedMetadata: schema.metadata,
		};
	}
	if (schema instanceof ObjectNodeStoredSchema) {
		const fields = new Map<FieldKey, SimpleObjectFieldSchema>();
		for (const [storedKey, field] of schema.objectNodeFields) {
			fields.set(storedKey, { ...exportSimpleFieldSchemaStored(field), storedKey });
		}
		return { kind: NodeKind.Object, fields, metadata: {}, persistedMetadata: schema.metadata };
	}
	if (schema instanceof MapNodeStoredSchema) {
		assert(
			schema.mapFields.kind === FieldKinds.optional.identifier,
			0xa95 /* Invalid map schema */,
		);
		return {
			kind: NodeKind.Map,
			allowedTypesIdentifiers: schema.mapFields.types,
			metadata: {},
			persistedMetadata: schema.metadata,
		};
	}
	if (schema instanceof LeafNodeStoredSchema) {
		return {
			kind: NodeKind.Leaf,
			leafKind: schema.leafValue,
			metadata: {},
			persistedMetadata: schema.metadata,
		};
	}
	fail(0xacb /* invalid schema kind */);
}
