/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import type {
	HasListeners,
	IEmitter,
	Listenable,
} from "@fluidframework/core-interfaces/internal";
import {
	createMockLoggerExt,
	type IMockLoggerExt,
	UsageError,
} from "@fluidframework/telemetry-utils/internal";

import { makeRandom } from "@fluid-private/stochastic-test-utils";
import { LocalServerTestDriver } from "@fluid-private/test-drivers";
import type { IContainer } from "@fluidframework/container-definitions/internal";
import { Loader } from "@fluidframework/container-loader/internal";
import type { ISummarizer } from "@fluidframework/container-runtime/internal";
import type { ConfigTypes, IConfigProviderBase } from "@fluidframework/core-interfaces";
import type {
	IChannelAttributes,
	IFluidDataStoreRuntime,
	IChannelServices,
	IChannelFactory,
} from "@fluidframework/datastore-definitions/internal";
import type { IIdCompressor, SessionId } from "@fluidframework/id-compressor";
import { assertIsStableId, createIdCompressor } from "@fluidframework/id-compressor/internal";
import { createAlwaysFinalizedIdCompressor } from "@fluidframework/id-compressor/internal/test-utils";
import { FlushMode } from "@fluidframework/runtime-definitions/internal";
import {
	MockFluidDataStoreRuntime,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";
import {
	type ChannelFactoryRegistry,
	type ITestContainerConfig,
	type ITestObjectProvider,
	type SummaryInfo,
	TestContainerRuntimeFactory,
	TestFluidObjectFactory,
	TestFluidObjectInternal,
	TestObjectProvider,
	createSummarizer,
	summarizeNow,
} from "@fluidframework/test-utils/internal";

import { type ICodecFamily, type IJsonCodec, withSchemaValidation } from "../codec/index.js";
import {
	type ChangeFamily,
	type ChangeFamilyEditor,
	CommitKind,
	type CommitMetadata,
	type DeltaDetachedNodeBuild,
	type DeltaDetachedNodeDestruction,
	type DeltaFieldChanges,
	type DeltaFieldMap,
	type DeltaMark,
	type DeltaRoot,
	type DeltaVisitor,
	type DetachedFieldIndex,
	type FieldUpPath,
	type IEditableForest,
	type IForestSubscription,
	type JsonableTree,
	type RevisionInfo,
	type RevisionMetadataSource,
	type RevisionTag,
	RevisionTagCodec,
	type TaggedChange,
	type TreeStoredSchema,
	TreeStoredSchemaRepository,
	type UpPath,
	applyDelta,
	clonePath,
	compareUpPaths,
	makeDetachedFieldIndex,
	mapCursorField,
	moveToDetachedField,
	revisionMetadataSourceFromInfo,
	type Anchor,
	type AnchorNode,
	type AnchorSetRootEvents,
	type TreeStoredSchemaSubscription,
	type ITreeCursorSynchronous,
	CursorLocationType,
	type RevertibleAlpha,
	type RevertibleAlphaFactory,
	type DeltaDetachedNodeChanges,
	type DeltaDetachedNodeRename,
	type NormalizedFieldUpPath,
	type ExclusiveMapTree,
	type MapTree,
	SchemaVersion,
	type FieldKindIdentifier,
	type TreeNodeSchemaIdentifier,
	type TreeFieldStoredSchema,
} from "../core/index.js";
import { typeboxValidator } from "../external-utilities/index.js";
import {
	Context,
	type NodeIdentifierManager,
	defaultSchemaPolicy,
	jsonableTreeFromFieldCursor,
	jsonableTreeFromForest,
	mapRootChanges,
	mapTreeFromCursor,
	MockNodeIdentifierManager,
	cursorForMapTreeField,
	type IDefaultEditBuilder,
	type TreeChunk,
	mapTreeFieldFromCursor,
	defaultChunkPolicy,
	cursorForJsonableTreeField,
	chunkFieldSingle,
	makeSchemaCodec,
	mapTreeWithField,
	type MinimalMapTreeNodeView,
	jsonableTreeFromCursor,
	cursorForMapTreeNode,
	type FullSchemaPolicy,
} from "../feature-libraries/index.js";
import {
	type CheckoutEvents,
	type ITreePrivate,
	type ITreeCheckout,
	type SharedTreeContentSnapshot,
	type TreeCheckout,
	createTreeCheckout,
	type ISharedTreeEditor,
	type ITreeCheckoutFork,
	independentView,
	type TreeStoredContent,
	SchematizingSimpleTreeView,
	type ForestOptions,
	type SharedTreeOptionsInternal,
} from "../shared-tree/index.js";
import {
	type ImplicitFieldSchema,
	type TreeViewConfiguration,
	SchemaFactory,
	toStoredSchema,
	type TreeView,
	type TreeBranchEvents,
	type ITree,
	type UnsafeUnknownSchema,
	type InsertableField,
	unhydratedFlexTreeFromInsertable,
	type SimpleNodeSchema,
	type TreeNodeSchema,
	getStoredSchema,
} from "../simple-tree/index.js";
import {
	Breakable,
	type JsonCompatible,
	type Mutable,
	nestedMapFromFlatList,
	forEachInNestedMap,
	tryGetFromNestedMap,
	isReadonlyArray,
	brand,
} from "../util/index.js";
import { isFluidHandle, toFluidHandleInternal } from "@fluidframework/runtime-utils/internal";
import type { Client } from "@fluid-private/test-dds-utils";
import { cursorToJsonObject, fieldJsonCursor, singleJsonCursor } from "./json/index.js";
// eslint-disable-next-line import/no-internal-modules
import type { TreeSimpleContent } from "./feature-libraries/flex-tree/utils.js";
import type { Transactor } from "../shared-tree-core/index.js";
// eslint-disable-next-line import/no-internal-modules
import type { FieldChangeDelta } from "../feature-libraries/modular-schema/index.js";
import { configuredSharedTree, type ISharedTree } from "../treeFactory.js";
import { JsonAsTree } from "../jsonDomainSchema.js";
import {
	MockContainerRuntimeFactoryWithOpBunching,
	type MockContainerRuntimeWithOpBunching,
} from "./mocksForOpBunching.js";
import { configureDebugAsserts } from "@fluidframework/core-utils/internal";
import { isInPerformanceTestingMode } from "@fluid-tools/benchmark";
import type {
	ISharedObjectKind,
	SharedObjectKind,
} from "@fluidframework/shared-object-base/internal";
// eslint-disable-next-line import/no-internal-modules
import { ObjectForest } from "../feature-libraries/object-forest/objectForest.js";
import {
	allowsFieldSuperset,
	allowsTreeSuperset,
	// eslint-disable-next-line import/no-internal-modules
} from "../feature-libraries/modular-schema/index.js";

// Testing utilities

/**
 * A SharedObjectKind typed to return `ISharedTree` and configured with a `jsonValidator`.
 */
export const DefaultTestSharedTreeKind = configuredSharedTree({
	jsonValidator: typeboxValidator,
}) as SharedObjectKind<ISharedTree> & ISharedObjectKind<ISharedTree>;

/**
 * A {@link IJsonCodec} implementation which fails on encode and decode.
 *
 * Useful for testing codecs which compose over other codecs (in cases where the "inner" codec should never be called)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const failCodec: IJsonCodec<any, any, any, any> = {
	encode: () => assert.fail("Unexpected encode"),
	decode: () => assert.fail("Unexpected decode"),
};

/**
 * A {@link ICodecFamily} implementation which fails to resolve any codec.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const failCodecFamily: ICodecFamily<any, any> = {
	resolve: () => assert.fail("Unexpected resolve"),
	getSupportedFormats: () => [],
};

/**
 * Manages the creation, connection, and retrieval of SharedTrees and related components for ease of testing.
 * Satisfies the {@link ITestObjectProvider} interface.
 */
export type ITestTreeProvider = TestTreeProvider & ITestObjectProvider;

export enum SummarizeType {
	onDemand = 0,
	automatic = 1,
	disabled = 2,
}

/**
 * A test helper class that manages the creation, connection and retrieval of SharedTrees. Instances of this
 * class are created via {@link TestTreeProvider.create} and satisfy the {@link ITestObjectProvider} interface.
 */
export class TestTreeProvider {
	private static readonly treeId = "TestSharedTree";

	private readonly provider: ITestObjectProvider;
	private readonly _trees: ISharedTree[] = [];
	private readonly _containers: IContainer[] = [];
	private readonly summarizer?: ISummarizer;

	public get trees(): readonly ISharedTree[] {
		return this._trees;
	}

	public get containers(): readonly IContainer[] {
		return this._containers;
	}

	/**
	 * Create a new {@link TestTreeProvider} with a number of trees pre-initialized.
	 * @param trees - the number of trees to initialize this provider with. This is the same as calling
	 * {@link create} followed by {@link createTree} _trees_ times.
	 * @param summarizeType - enum to manually, automatically, or disable summarization
	 * @param factory - The factory to use for creating and loading trees. See {@link SharedTreeTestFactory}.
	 *
	 * @example
	 *
	 * ```typescript
	 * const provider = await TestTreeProvider.create(2);
	 * assert(provider.trees[0].isAttached());
	 * assert(provider.trees[1].isAttached());
	 * await trees.ensureSynchronized();
	 * ```
	 */
	public static async create(
		trees = 0,
		summarizeType: SummarizeType = SummarizeType.disabled,
		factory: IChannelFactory<ITree> = DefaultTestSharedTreeKind.getFactory(),
	): Promise<ITestTreeProvider> {
		// The on-demand summarizer shares a container with the first tree, so at least one tree and container must be created right away.
		assert(
			!(trees === 0 && summarizeType === SummarizeType.onDemand),
			"trees must be >= 1 to allow summarization on demand",
		);

		const registry: ChannelFactoryRegistry = [[TestTreeProvider.treeId, factory]];
		const driver = new LocalServerTestDriver();
		const containerRuntimeFactory = () =>
			new TestContainerRuntimeFactory(
				"@fluid-example/test-dataStore",
				new TestFluidObjectFactory(
					registry,
					"TestFluidObjectFactory",
					TestFluidObjectInternal,
				),
				{
					summaryOptions: {
						summaryConfigOverrides:
							summarizeType === SummarizeType.disabled ? { state: "disabled" } : undefined,
					},
					enableRuntimeIdCompressor: "on",
				},
			);

		const objProvider = new TestObjectProvider(Loader, driver, containerRuntimeFactory);

		if (summarizeType === SummarizeType.onDemand) {
			const container = await objProvider.makeTestContainer();
			const firstTree = await this.getTree(container);
			const { summarizer } = await createSummarizer(objProvider, container);
			const provider = new TestTreeProvider(objProvider, [
				container,
				firstTree,
				summarizer,
			]) as ITestTreeProvider;
			for (let i = 1; i < trees; i++) {
				await provider.createTree();
			}
			return provider;
		} else {
			const provider = new TestTreeProvider(objProvider) as ITestTreeProvider;
			for (let i = 0; i < trees; i++) {
				await provider.createTree();
			}
			return provider;
		}
	}

	private static async getTree(container: IContainer): Promise<ISharedTree> {
		const dataObject = await container.getEntryPoint();
		assert(dataObject instanceof TestFluidObjectInternal);
		const tree = await dataObject.getInitialSharedObjectTyped(
			DefaultTestSharedTreeKind,
			TestTreeProvider.treeId,
		);
		return tree;
	}

	/**
	 * Create and initialize a new {@link ITreePrivate} that is connected to all other trees from this provider.
	 * @returns the tree that was created. For convenience, the tree can also be accessed via `this[i]` where
	 * _i_ is the index of the tree in order of creation.
	 */
	public async createTree(): Promise<ISharedTree> {
		const configProvider = (settings: Record<string, ConfigTypes>): IConfigProviderBase => ({
			getRawConfig: (name: string): ConfigTypes => settings[name],
		});
		const testContainerConfig: ITestContainerConfig = {
			loaderProps: {
				configProvider: configProvider({
					"Fluid.Container.enableOfflineLoad": true,
				}),
			},
		};
		const container =
			this.trees.length === 0
				? await this.provider.makeTestContainer(testContainerConfig)
				: await this.provider.loadTestContainer();

		this._containers.push(container);
		const tree = await TestTreeProvider.getTree(container);
		this._trees[this.trees.length] = tree;
		return tree;
	}

	/**
	 * Give this {@link TestTreeProvider} the ability to summarize on demand during a test by creating a summarizer
	 * client for the container at the given index.  This can only be called when the summarizeOnDemand parameter
	 * was set to true when calling the create() method.
	 * @returns void after a summary has been resolved. May be called multiple times.
	 */
	public async summarize(): Promise<SummaryInfo> {
		assert(
			this.summarizer !== undefined,
			"can't summarize because summarizeOnDemand was not set to true.",
		);
		return summarizeNow(this.summarizer, "TestTreeProvider");
	}

	public [Symbol.iterator](): IterableIterator<ITreePrivate> {
		return this.trees[Symbol.iterator]();
	}

	private constructor(
		provider: ITestObjectProvider,
		firstTreeParams?: [IContainer, ISharedTree, ISummarizer],
	) {
		this.provider = provider;
		if (firstTreeParams !== undefined) {
			const [container, firstTree, summarizer] = firstTreeParams;
			this._containers.push(container);
			this._trees.push(firstTree);
			this.summarizer = summarizer;
		}
		return new Proxy(this, {
			get: (target, prop, receiver) => {
				// Route all properties that are on the `TestTreeProvider` itself
				if ((target as never)[prop] !== undefined) {
					return Reflect.get(target, prop, receiver) as unknown;
				}

				// Route all other properties to the `TestObjectProvider`
				return Reflect.get(this.provider, prop, receiver) as unknown;
			},
		});
	}
}

/**
 * A type with subset of functionalities of mock container runtime that can help tests control
 * the processing of messages and the connection state of the runtime.
 */
export type TreeMockContainerRuntime = Pick<
	MockContainerRuntimeWithOpBunching,
	"connected" | "pauseInboundProcessing" | "resumeInboundProcessing" | "flush"
>;
export type SharedTreeWithContainerRuntime = ISharedTree & {
	readonly containerRuntime: TreeMockContainerRuntime;
};

/**
 * A test helper class that creates one or more SharedTrees connected to mock services.
 */
export class TestTreeProviderLite {
	private readonly runtimeFactory: MockContainerRuntimeFactoryWithOpBunching;
	public readonly trees: readonly SharedTreeWithContainerRuntime[];
	public readonly logger: IMockLoggerExt = createMockLoggerExt();
	private readonly containerRuntimeMap: Map<string, MockContainerRuntimeWithOpBunching> =
		new Map();

	/**
	 * Create a new {@link TestTreeProviderLite} with a number of trees pre-initialized.
	 * @param trees - the number of trees created by this provider.
	 * @param factory - an optional factory to use for creating and loading trees. See {@link SharedTreeTestFactory}.
	 * @param useDeterministicSessionIds - Whether or not to deterministically generate session ids
	 * @param flushMode - The flush mode to use for the container runtime. This is FlushMode.Immediate by default. Tests
	 * that need ops to be processed in a batch or bunch should use FlushMode.TurnBased.
	 * @example
	 *
	 * ```typescript
	 * const provider = new TestTreeProviderLite(2);
	 * assert(provider.trees[0].isAttached());
	 * assert(provider.trees[1].isAttached());
	 * provider.processMessages();
	 * ```
	 */
	public constructor(
		trees = 1,
		private readonly factory: IChannelFactory<ITree> = DefaultTestSharedTreeKind.getFactory(),
		useDeterministicSessionIds = true,
		private readonly flushMode: FlushMode = FlushMode.Immediate,
	) {
		this.runtimeFactory = new MockContainerRuntimeFactoryWithOpBunching({
			flushMode,
		});
		assert(trees >= 1, "Must initialize provider with at least one tree");
		const t: SharedTreeWithContainerRuntime[] = [];
		const random = useDeterministicSessionIds ? makeRandom(0xdeadbeef) : makeRandom();
		for (let i = 0; i < trees; i++) {
			const sessionId = random.uuid4() as SessionId;
			const runtime = new MockFluidDataStoreRuntime({
				clientId: `test-client-${i}`,
				id: "test",
				idCompressor: createIdCompressor(sessionId),
				logger: this.logger,
			});
			const tree = this.factory.create(runtime, `tree-${i}`);
			const containerRuntime = this.runtimeFactory.createContainerRuntime(runtime);
			this.containerRuntimeMap.set(tree.id, containerRuntime);
			tree.connect({
				deltaConnection: runtime.createDeltaConnection(),
				objectStorage: new MockStorage(),
			});
			(tree as Mutable<SharedTreeWithContainerRuntime>).containerRuntime = containerRuntime;
			t.push(tree as SharedTreeWithContainerRuntime);
		}
		this.trees = t;
	}

	/**
	 * Synchronize messages across all trees. This involves optionally flushing any messages sent by the trees so
	 * that they are sequenced. Then, the runtime processes the messages. Flushing is needed in TurnBased mode only
	 * where messages are not automatically flushed. In Immediate mode, each message is flushed immediately.
	 * @param options - The options to use when synchronizing messages.
	 * - count: The number of messages to synchronize. If not provided, all messages are synchronized.
	 * - flush: Whether or not to flush the messages before processing them. Defaults to true. In TurnBased mode,
	 * messages are not automatically flushed so this should either be set to true or the test should manually
	 * flush the messages before calling this method.
	 * @remarks
	 * - Trees that are not connected will not flush outbound messages or process inbound messages. They will be queued
	 * and will be processed when they are reconnected (unless their inbound processing is paused. See below).
	 * - Trees whose inbound processing is paused will not process inbound messages but will queue them. Any queued
	 * messages will be processed when inbound processing is resumed (unless they are not connected. See above).
	 * - Flushing does not preserve the order in which the messages were sent. To do so, tests should flush the messages
	 * from the trees in the order they were sent.
	 */
	public synchronizeMessages(options?: { count?: number; flush?: boolean }): void {
		const flush = options?.flush ?? true;
		if (flush) {
			this.containerRuntimeMap.forEach((containerRuntime) => {
				containerRuntime.flush();
			});
		}

		const count = options?.count;
		if (count !== undefined) {
			this.runtimeFactory.processSomeMessages(count);
		} else {
			this.runtimeFactory.processAllMessages();
		}
	}

	public get minimumSequenceNumber(): number {
		return this.runtimeFactory.getMinSeq();
	}

	public get sequenceNumber(): number {
		return this.runtimeFactory.sequenceNumber;
	}
}

/**
 * Run a custom "spy function" every time the given method is invoked.
 * @param methodClass - the class that has the method
 * @param methodName - the name of the method
 * @param spy - the spy function to run alongside the method
 * @returns a function which will remove the spy function when invoked. Should be called exactly once
 * after the spy is no longer needed.
 */
export function spyOnMethod(
	// eslint-disable-next-line @typescript-eslint/ban-types
	methodClass: Function,
	methodName: string,
	spy: () => void,
): () => void {
	const { prototype } = methodClass;
	const method = prototype[methodName];
	assert(typeof method === "function", `Method does not exist: ${methodName}`);

	const methodSpy = function (this: unknown, ...args: unknown[]): unknown {
		spy();
		return method.call(this, ...args);
	};
	prototype[methodName] = methodSpy;

	return () => {
		prototype[methodName] = method;
	};
}

/**
 * Determines whether or not the given delta has a visible impact on the document tree.
 */
export function isDeltaVisible(fieldChanges: DeltaFieldChanges | undefined): boolean {
	for (const mark of fieldChanges ?? []) {
		if (mark.attach !== undefined || mark.detach !== undefined) {
			return true;
		}
		if (mark.fields !== undefined) {
			for (const field of mark.fields.values()) {
				if (isDeltaVisible(field)) {
					return true;
				}
			}
		}
	}
	return false;
}

/**
 * Assert two MarkList are equal, handling cursors.
 */
export function assertFieldChangesEqual(a: FieldChangeDelta, b: FieldChangeDelta): void {
	assert.deepStrictEqual(a, b);
}

/**
 * Assert two MarkList are equal, handling cursors.
 */
export function assertMarkListEqual(a: readonly DeltaMark[], b: readonly DeltaMark[]): void {
	assert.deepStrictEqual(a, b);
}

/**
 * Assert two Delta are equal, handling cursors.
 */
export function assertDeltaFieldMapEqual(a: DeltaFieldMap, b: DeltaFieldMap): void {
	assert.deepStrictEqual(a, b);
}

/**
 * Assert two Delta are equal, handling cursors.
 */
export function assertDeltaEqual(a: DeltaRoot, b: DeltaRoot): void {
	const aTree = mapRootChanges(a, chunkToMapTreeField);
	const bTree = mapRootChanges(b, chunkToMapTreeField);
	assert.deepStrictEqual(aTree, bTree);
}

/**
 * A test helper that allows custom code to be injected when a tree is created/loaded.
 */
export class SharedTreeTestFactory implements IChannelFactory<ISharedTree> {
	private readonly inner: IChannelFactory<ISharedTree>;

	/**
	 * @param onCreate - Called once for each created tree (not called for trees loaded from summaries).
	 * @param onLoad - Called once for each tree that is loaded from a summary.
	 */
	public constructor(
		protected readonly onCreate: (tree: ISharedTree) => void,
		protected readonly onLoad?: (tree: ISharedTree) => void,
		options: SharedTreeOptionsInternal = {},
	) {
		this.inner = configuredSharedTree({
			...options,
			jsonValidator: typeboxValidator,
		}).getFactory() as IChannelFactory<ISharedTree>;
	}

	public get type(): string {
		return this.inner.type;
	}
	public get attributes(): IChannelAttributes {
		return this.inner.attributes;
	}

	public async load(
		runtime: IFluidDataStoreRuntime,
		id: string,
		services: IChannelServices,
		channelAttributes: Readonly<IChannelAttributes>,
	): Promise<ISharedTree> {
		const tree = await this.inner.load(runtime, id, services, channelAttributes);
		this.onLoad?.(tree);
		return tree;
	}

	public create(runtime: IFluidDataStoreRuntime, id: string): ISharedTree {
		const tree = this.inner.create(runtime, id);
		this.onCreate(tree);
		return tree;
	}
}

export function validateTree(tree: ITreeCheckout, expected: JsonableTree[]): void {
	const actual = toJsonableTree(tree);
	assert.deepEqual(actual, expected);
}

// If you are adding a new schema format, consider changing the encoding format used for this codec, given
// that equality of two schemas in tests is achieved by deep-comparing their persisted representations.
// If the newer format is a superset of the previous format, it can be safely used for comparisons. This is the
// case with schema format v2.
const schemaCodec = makeSchemaCodec({ jsonValidator: typeboxValidator }, SchemaVersion.v2);

export function checkRemovedRootsAreSynchronized(trees: readonly ITreeCheckout[]): void {
	if (trees.length > 1) {
		const baseline = nestedMapFromFlatList(trees[0].getRemovedRoots());
		for (const tree of trees.slice(1)) {
			const actual = nestedMapFromFlatList(tree.getRemovedRoots());
			assert.deepEqual(actual, baseline);
		}
	}
}

/**
 * This does NOT check that the trees have the same edits, same edit manager state or anything like that.
 * This ONLY checks if the content of the forest of the main branch of the trees match.
 */
export function validateTreeConsistency(treeA: ITreePrivate, treeB: ITreePrivate): void {
	// TODO: validate other aspects of these trees are consistent, for example their collaboration window information.
	validateSnapshotConsistency(
		treeA.contentSnapshot(),
		treeB.contentSnapshot(),
		`id: ${treeA.id} vs id: ${treeB.id}`,
	);
}

export function validateFuzzTreeConsistency(
	treeA: Client<IChannelFactory<ISharedTree>>,
	treeB: Client<IChannelFactory<ISharedTree>>,
): void {
	validateSnapshotConsistency(
		treeA.channel.contentSnapshot(),
		treeB.channel.contentSnapshot(),
		`id: ${treeA.channel.id} vs id: ${treeB.channel.id}`,
	);
}

function contentToJsonableTree(content: TreeStoredContent): JsonableTree[] {
	return jsonableTreeFromFieldCursor(normalizeNewFieldContent(content.initialTree));
}

export function validateTreeContent(tree: ITreeCheckout, content: TreeSimpleContent): void {
	const contentReference = jsonableTreeFromFieldCursor(
		fieldCursorFromInsertable<UnsafeUnknownSchema>(content.schema, content.initialTree),
	);
	assert.deepEqual(toJsonableTree(tree), contentReference);
	expectSchemaEqual(tree.storedSchema, toStoredSchema(content.schema));
}
export function validateTreeStoredContent(
	tree: ITreeCheckout,
	content: TreeStoredContent,
): void {
	assert.deepEqual(toJsonableTree(tree), contentToJsonableTree(content));
	expectSchemaEqual(tree.storedSchema, content.schema);
}

export function expectSchemaEqual(
	a: TreeStoredSchema,
	b: TreeStoredSchema,
	idDifferentiator: string | undefined = undefined,
): void {
	assert.deepEqual(
		schemaCodec.encode(a),
		schemaCodec.encode(b),
		`Inconsistent schema: ${idDifferentiator}`,
	);
}

export function validateViewConsistency(
	treeA: ITreeCheckout,
	treeB: ITreeCheckout,
	idDifferentiator: string | undefined = undefined,
): void {
	validateSnapshotConsistency(
		{
			tree: toJsonableTree(treeA),
			schema: treeA.storedSchema,
			removed: treeA.getRemovedRoots(),
		},
		{
			tree: toJsonableTree(treeB),
			schema: treeB.storedSchema,
			removed: treeA.getRemovedRoots(),
		},
		idDifferentiator,
	);
}

export function validateSnapshotConsistency(
	treeA: SharedTreeContentSnapshot,
	treeB: SharedTreeContentSnapshot,
	idDifferentiator: string | undefined = undefined,
): void {
	assert.deepEqual(
		prepareTreeForCompare(treeA.tree),
		prepareTreeForCompare(treeB.tree),
		`Inconsistent document tree json representation: ${idDifferentiator}`,
	);

	// Removed trees are garbage collected so we only enforce that whenever two
	// clients both have data for the same removed tree (as identified by the first two tuple entries), then they
	// should be consistent about the content being stored (the third tuple entry).
	const mapA = nestedMapFromFlatList(
		treeA.removed.map(([key, num, children]) => [
			key,
			num,
			prepareTreeForCompare([children])[0],
		]),
	);
	const mapB = nestedMapFromFlatList(
		treeB.removed.map(([key, num, children]) => [
			key,
			num,
			prepareTreeForCompare([children])[0],
		]),
	);
	forEachInNestedMap(mapA, (content, major, minor) => {
		const mapBContent = tryGetFromNestedMap(mapB, major, minor);
		if (mapBContent !== undefined) {
			assert.deepEqual(
				content,
				mapBContent,
				`Inconsistent removed trees json representation: ${idDifferentiator}`,
			);
		}
	});
	expectSchemaEqual(treeA.schema, treeB.schema, idDifferentiator);
}

/**
 * Make a copy of a {@link JsonableTree} array adjusted for compatibility with `assert.deepEqual`.
 * @remarks
 * This replaces handles replaced with `{ Handle: absolutePath }`, and normalizes optional fields to be omitted.
 */
export function prepareTreeForCompare(tree: JsonableTree[]): object[] {
	return tree.map((node): object => {
		const fields: Record<string, object> = {};
		for (const [key, children] of Object.entries(node.fields ?? {})) {
			fields[key] = prepareTreeForCompare(children);
		}
		const inputValue = node.value;
		const value = isFluidHandle(inputValue)
			? { Handle: toFluidHandleInternal(inputValue).absolutePath }
			: inputValue;

		const output: Record<string, unknown> = { ...node, value, fields };

		// Normalize optional values to be omitted for cleaner diffs:
		if (output.value === undefined) delete output.value;
		if (Reflect.ownKeys(output.fields as object).length === 0) delete output.fields;

		return output as object;
	});
}

export function checkoutWithContent(
	content: TreeStoredContent,
	args?: {
		events?: Listenable<CheckoutEvents> &
			IEmitter<CheckoutEvents> &
			HasListeners<CheckoutEvents>;
		additionalAsserts?: boolean;
	},
): TreeCheckout {
	const { checkout } = createCheckoutWithContent(content, args);
	return checkout;
}

function createCheckoutWithContent(
	content: TreeStoredContent,
	args?: {
		events?: Listenable<CheckoutEvents> &
			IEmitter<CheckoutEvents> &
			HasListeners<CheckoutEvents>;
		additionalAsserts?: boolean;
	},
): { checkout: TreeCheckout; logger: IMockLoggerExt } {
	const fieldCursor = normalizeNewFieldContent(content.initialTree);
	const roots: MapTree = mapTreeWithField(mapTreeFieldFromCursor(fieldCursor));
	const schema = new TreeStoredSchemaRepository(content.schema);
	const forest = buildTestForest({
		additionalAsserts: args?.additionalAsserts ?? true,
		schema,
		roots,
	});

	const logger = createMockLoggerExt();
	const checkout = createTreeCheckout(
		testIdCompressor,
		mintRevisionTag,
		testRevisionTagCodec,
		{
			...args,
			forest,
			schema,
			logger,
		},
	);
	return { checkout, logger };
}

export function flexTreeViewWithContent(
	content: TreeSimpleContent,
	args?: {
		events?: Listenable<CheckoutEvents> &
			IEmitter<CheckoutEvents> &
			HasListeners<CheckoutEvents>;
		nodeKeyManager?: NodeIdentifierManager;
	},
): Context {
	const view = checkoutWithContent(
		{
			initialTree: fieldCursorFromInsertable<UnsafeUnknownSchema>(
				content.schema,
				content.initialTree,
			),
			schema: toStoredSchema(content.schema),
		},
		args,
	);
	return new Context(
		defaultSchemaPolicy,
		view,
		args?.nodeKeyManager ?? new MockNodeIdentifierManager(),
	);
}

/**
 * Builds a reference forest.
 */
export function buildTestForest(options: {
	schema?: TreeStoredSchemaRepository;
	additionalAsserts: boolean;
	roots?: MapTree;
}): IEditableForest {
	return new ObjectForest(
		new Breakable("buildTestForest"),
		options.schema,
		undefined,
		options.additionalAsserts,
		options.roots,
	);
}

export function forestWithContent(content: TreeStoredContent): IEditableForest {
	const fieldCursor = normalizeNewFieldContent(content.initialTree);
	const roots: MapTree = mapTreeWithField(mapTreeFieldFromCursor(fieldCursor));
	const forest = buildTestForest({
		additionalAsserts: true,
		schema: new TreeStoredSchemaRepository(content.schema),
		roots,
	});

	return forest;
}

const sf = new SchemaFactory("com.fluidframework.json");

export const NumberArray = sf.array("array", sf.number);
export const StringArray = sf.array("array", sf.string);

export const IdentifierSchema = sf.object("identifier-object", {
	identifier: sf.identifier,
});

/**
 * Creates a tree using the Json domain.
 *
 * @param json - The JSON-compatible object to initialize the tree with.
 * @param optionalRoot - If `true`, the root field is optional; otherwise, it is required. Defaults to `false`.
 */
export function makeTreeFromJson(json: JsonCompatible, optionalRoot = false): ITreeCheckout {
	return checkoutWithContent({
		schema: toStoredSchema(
			optionalRoot ? SchemaFactory.optional(JsonAsTree.Tree) : JsonAsTree.Tree,
		),
		initialTree: singleJsonCursor(json),
	});
}

export function toJsonableTree(tree: ITreeCheckout): JsonableTree[] {
	return jsonableTreeFromForest(tree.forest);
}

/**
 * Assumes `tree` is in the json domain and returns its content as a json compatible object.
 */
export function jsonTreeFromCheckout(tree: ITreeCheckout): JsonCompatible[] {
	return jsonTreeFromForest(tree.forest);
}

export function jsonTreeFromForest(forest: IForestSubscription): JsonCompatible[] {
	const readCursor = forest.allocateCursor();
	moveToDetachedField(forest, readCursor);
	const copy = mapCursorField(readCursor, cursorToJsonObject);
	readCursor.free();
	return copy;
}

export function expectJsonTree(
	actual: ITreeCheckout | ITreeCheckout[],
	expected: JsonCompatible[],
	expectRemovedRootsAreSynchronized = true,
): void {
	const trees = Array.isArray(actual) ? actual : [actual];
	for (const tree of trees) {
		const roots = jsonTreeFromCheckout(tree);
		assert.deepEqual(roots, expected);
	}
	if (expectRemovedRootsAreSynchronized) {
		checkRemovedRootsAreSynchronized(trees);
	}
}

export function expectEqualMapTreeViews(
	actual: MinimalMapTreeNodeView,
	expected: MinimalMapTreeNodeView,
): void {
	expectEqualCursors(cursorForMapTreeNode(actual), cursorForMapTreeNode(expected));
}

export function expectEqualCursors(
	actual: ITreeCursorSynchronous | undefined,
	expected: ITreeCursorSynchronous,
): void {
	assert(actual !== undefined);
	const actualJson = jsonableTreeFromCursor(actual);
	const expectedJson = jsonableTreeFromCursor(expected);
	assert.deepEqual(actualJson, expectedJson);
}

export function expectNoRemovedRoots(tree: ITreeCheckout): void {
	assert(tree.getRemovedRoots().length === 0);
}

export function expectEqualPaths(
	path: UpPath | undefined,
	expectedPath: UpPath | undefined,
): void {
	if (!compareUpPaths(path, expectedPath)) {
		// This is slower than above compare, so only do it in the error case.
		// Make a nice error message:
		assert.deepEqual(clonePath(path), clonePath(expectedPath));
		assert.fail("unequal paths, but clones compared equal");
	}
}

export function expectEqualFieldPaths(path: FieldUpPath, expectedPath: FieldUpPath): void {
	expectEqualPaths(path.parent, expectedPath.parent);
	assert.equal(path.field, expectedPath.field);
}

export const mockIntoDelta = (delta: DeltaRoot): DeltaRoot => delta;

export interface EncodingTestData<TDecoded, TEncoded, TContext = void> {
	/**
	 * Contains test cases which should round-trip successfully through all persisted formats.
	 */
	successes: TContext extends void
		? [name: string, data: TDecoded][]
		: [name: string, data: TDecoded, context: TContext][];
	/**
	 * Contains malformed encoded data which a particular version's codec should fail to decode.
	 */
	failures?: {
		[version: string]: TContext extends void
			? [name: string, data: TEncoded][]
			: [name: string, data: TEncoded, context: TContext][];
	};
}

const assertDeepEqual = (a: unknown, b: unknown): void => assert.deepEqual(a, b);

/**
 * Constructs a basic suite of round-trip tests for all versions of a codec family.
 * This helper should generally be wrapped in a `describe` block.
 *
 * Encoded data for JSON codecs within `family` will be validated using `typeboxValidator`.
 *
 * @privateRemarks It is generally not valid to compare the decoded formats with assert.deepEqual,
 * but since these round trip tests start with the decoded format (not the encoded format),
 * they require assert.deepEqual to be a valid comparison.
 * This can be problematic for some cases (for example edits containing cursors).
 *
 * TODO:
 * - Consider extending this to allow testing in a way where encoded formats (which can safely use deepEqual) are compared.
 * - Consider adding a custom comparison function for non-encoded data.
 * - Consider adding a way to test that specific values have specific encodings.
 * Maybe generalize test cases to each have an optional encoded and optional decoded form (require at least one), for example via:
 * `{name: string, encoded?: JsonCompatibleReadOnly, decoded?: TDecoded}`.
 */
export function makeEncodingTestSuite<TDecoded, TEncoded, TContext>(
	family: ICodecFamily<TDecoded, TContext>,
	encodingTestData: EncodingTestData<TDecoded, TEncoded, TContext>,
	assertEquivalent: (a: TDecoded, b: TDecoded) => void = assertDeepEqual,
): void {
	for (const version of family.getSupportedFormats()) {
		describe(`version ${version}`, () => {
			const codec = family.resolve(version);
			// A common pattern to avoid validating the same portion of encoded data multiple times
			// is for a codec to either validate its data is in schema itself and not return `encodedSchema`,
			// or for it to not validate its own data but return an `encodedSchema` and let the caller use that.
			// This block makes sure we still validate the encoded data schema for codecs following the latter
			// pattern.
			const jsonCodec =
				codec.json.encodedSchema !== undefined
					? withSchemaValidation(codec.json.encodedSchema, codec.json, typeboxValidator)
					: codec.json;
			describe("can json roundtrip", () => {
				for (const includeStringification of [false, true]) {
					// biome-ignore format: https://github.com/biomejs/biome/issues/4202
					describe(
						includeStringification ? "with stringification" : "without stringification",
						() => {
							for (const [name, data, context] of encodingTestData.successes) {
								it(name, () => {
									// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
									let encoded = jsonCodec.encode(data, context!);
									if (includeStringification) {
										encoded = JSON.parse(JSON.stringify(encoded));
									}
									// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
									const decoded = jsonCodec.decode(encoded, context!);
									assertEquivalent(decoded, data);
								});
							}
						},
					);
				}
			});

			describe("can binary roundtrip", () => {
				for (const [name, data, context] of encodingTestData.successes) {
					it(name, () => {
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						const encoded = codec.binary.encode(data, context!);
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						const decoded = codec.binary.decode(encoded, context!);
						assertEquivalent(decoded, data);
					});
				}
			});

			const failureCases = encodingTestData.failures?.[version ?? "undefined"] ?? [];
			if (failureCases.length > 0) {
				describe("rejects malformed data", () => {
					for (const [name, encodedData, context] of failureCases) {
						it(name, () => {
							assert.throws(() =>
								// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
								jsonCodec.decode(encodedData as JsonCompatible, context!),
							);
						});
					}
				});
			}
		});
	}
}

/**
 * Creates a change receiver function for passing to an `EditBuilder` which records the changes
 * applied via that editor and allows them to be queried via a function.
 * @param _changeFamily - this optional change family allows for type inference of `TChange` for
 * convenience, but is otherwise unused.
 * @returns a change receiver function and a function that will return all changes received
 */
export function testChangeReceiver<TChange>(
	_changeFamily?: ChangeFamily<ChangeFamilyEditor, TChange>,
): [
	changeReceiver: Parameters<ChangeFamily<ChangeFamilyEditor, TChange>["buildEditor"]>[1],
	getChanges: () => readonly TChange[],
] {
	const changes: TChange[] = [];
	const changeReceiver = (taggedChange: TaggedChange<TChange>): number =>
		changes.push(taggedChange.change);
	return [changeReceiver, () => [...changes]];
}

export function defaultRevisionMetadataFromChanges(
	changes: readonly TaggedChange<unknown>[],
): RevisionMetadataSource {
	return revisionMetadataSourceFromInfo(defaultRevInfosFromChanges(changes));
}

export function defaultRevInfosFromChanges(
	changes: readonly TaggedChange<unknown>[],
): RevisionInfo[] {
	const revInfos: RevisionInfo[] = [];
	const revisions = new Set<RevisionTag>();
	const rolledBackRevisions: RevisionTag[] = [];
	for (const change of changes) {
		// TODO: ADO#7366 assert to check if either all the changes have revision,
		// or that all of the changes have undefined revision.
		if (change.revision !== undefined) {
			revInfos.push({
				revision: change.revision,
				rollbackOf: change.rollbackOf,
			});

			revisions.add(change.revision);
			if (change.rollbackOf !== undefined) {
				rolledBackRevisions.push(change.rollbackOf);
			}
		}
	}

	rolledBackRevisions.reverse();
	for (const revision of rolledBackRevisions) {
		if (!revisions.has(revision)) {
			revInfos.push({ revision });
		}
	}

	return revInfos;
}

export interface DeltaParams {
	detachedFieldIndex?: DetachedFieldIndex;
	revision?: RevisionTag;
	global?: readonly DeltaDetachedNodeChanges[];
	rename?: readonly DeltaDetachedNodeRename[];
	build?: readonly DeltaDetachedNodeBuild[];
	destroy?: readonly DeltaDetachedNodeDestruction[];
}

export function applyTestDelta(
	delta: DeltaFieldMap,
	deltaProcessor: { acquireVisitor: () => DeltaVisitor },
	params?: DeltaParams,
): void {
	const { detachedFieldIndex, revision, global, rename, build, destroy } = params ?? {};
	const rootDelta = rootFromDeltaFieldMap(delta, global, rename, build, destroy);
	applyDelta(
		rootDelta,
		revision,
		deltaProcessor,
		detachedFieldIndex ??
			makeDetachedFieldIndex(undefined, testRevisionTagCodec, testIdCompressor),
	);
}

export function rootFromDeltaFieldMap(
	delta: DeltaFieldMap,
	global?: readonly DeltaDetachedNodeChanges[],
	rename?: readonly DeltaDetachedNodeRename[],
	build?: readonly DeltaDetachedNodeBuild[],
	destroy?: readonly DeltaDetachedNodeDestruction[],
): Mutable<DeltaRoot> {
	const rootDelta: Mutable<DeltaRoot> = { fields: delta };
	if (global !== undefined) {
		rootDelta.global = global;
	}
	if (rename !== undefined) {
		rootDelta.rename = rename;
	}
	if (build !== undefined) {
		rootDelta.build = build;
	}
	if (destroy !== undefined) {
		rootDelta.destroy = destroy;
	}
	return rootDelta;
}

export function createTestUndoRedoStacks(
	events: Listenable<TreeBranchEvents | CheckoutEvents>,
): {
	undoStack: RevertibleAlpha[];
	redoStack: RevertibleAlpha[];
	unsubscribe: () => void;
} {
	const undoStack: RevertibleAlpha[] = [];
	const redoStack: RevertibleAlpha[] = [];

	function onDispose(disposed: RevertibleAlpha): void {
		const redoIndex = redoStack.indexOf(disposed);
		if (redoIndex !== -1) {
			redoStack.splice(redoIndex, 1);
		} else {
			const undoIndex = undoStack.indexOf(disposed);
			if (undoIndex !== -1) {
				undoStack.splice(undoIndex, 1);
			}
		}
	}

	function onNewCommit(commit: CommitMetadata, getRevertible?: RevertibleAlphaFactory): void {
		if (getRevertible !== undefined) {
			const revertible = getRevertible(onDispose);
			if (commit.kind === CommitKind.Undo) {
				redoStack.push(revertible);
			} else {
				undoStack.push(revertible);
			}
		}
	}

	const unsubscribeFromChangedEvent = events.on("changed", onNewCommit);
	const unsubscribe = (): void => {
		unsubscribeFromChangedEvent();
		for (const revertible of undoStack) {
			revertible.dispose();
		}
		for (const revertible of redoStack) {
			revertible.dispose();
		}
	};
	return { undoStack, redoStack, unsubscribe };
}

export function assertIsSessionId(sessionId: string): SessionId {
	assertIsStableId(sessionId);
	return sessionId as SessionId;
}

export const testIdCompressor = createAlwaysFinalizedIdCompressor(
	assertIsSessionId("00000000-0000-4000-b000-000000000000"),
);
export function mintRevisionTag(): RevisionTag {
	return testIdCompressor.generateCompressedId();
}

export const testRevisionTagCodec = new RevisionTagCodec(testIdCompressor);

/**
 * Given the TreeViewConfiguration, returns an uninitialized view.
 *
 * This works a much like the actual package public API as possible, while avoiding the actual SharedTree object.
 * This should allow realistic (app like testing) of all the simple-tree APIs.
 *
 * Typically, users will want to initialize the returned view with some content (thereby setting its schema) using `TreeView.initialize`.
 *
 * Like `SchematizingSimpleTreeView` but using internal types and uses {@link createSnapshotCompressor}.
 */
export function getView<const TSchema extends ImplicitFieldSchema>(
	config: TreeViewConfiguration<TSchema>,
	options: ForestOptions & {
		idCompressor?: IIdCompressor | undefined;
	} = {},
): SchematizingSimpleTreeView<TSchema> {
	const view = independentView(config, {
		idCompressor: createSnapshotCompressor(),
		...options,
	});
	assert(view instanceof SchematizingSimpleTreeView);
	return view;
}

/**
 * Session ids used for the created trees' IdCompressors must be deterministic.
 * TestTreeProviderLite does this by default.
 * Test trees which manually create their data store runtime must set up their trees'
 * session ids explicitly.
 */
export const snapshotSessionId = assertIsSessionId("beefbeef-beef-4000-8000-000000000001");

export function createSnapshotCompressor() {
	return createAlwaysFinalizedIdCompressor(snapshotSessionId);
}

/**
 * Views the supplied checkout with the given schema.
 */
export function viewCheckout<const TSchema extends ImplicitFieldSchema>(
	checkout: TreeCheckout,
	config: TreeViewConfiguration<TSchema>,
): SchematizingSimpleTreeView<TSchema> {
	return new SchematizingSimpleTreeView<TSchema>(
		checkout,
		config,
		new MockNodeIdentifierManager(),
	);
}

/**
 * A mock implementation of `ITreeCheckout` that provides read access to the forest, and nothing else.
 */
export class MockTreeCheckout implements ITreeCheckout {
	public readonly breaker: Breakable = new Breakable("MockTreeCheckout");
	public constructor(
		public readonly forest: IForestSubscription,
		private readonly options?: {
			schema?: TreeStoredSchemaSubscription;
			editor?: ISharedTreeEditor;
		},
	) {}

	public viewWith<TRoot extends ImplicitFieldSchema>(
		config: TreeViewConfiguration<TRoot>,
	): TreeView<TRoot> {
		throw new Error("'viewWith' not implemented in MockTreeCheckout.");
	}

	public get storedSchema(): TreeStoredSchemaSubscription {
		if (this.options?.schema === undefined) {
			throw new Error("No schema provided to MockTreeCheckout.");
		}
		return this.options.schema;
	}
	public get editor(): ISharedTreeEditor {
		if (this.options?.editor === undefined) {
			throw new Error("No editor provided to MockTreeCheckout.");
		}
		return this.options.editor;
	}
	public get transaction(): Transactor {
		throw new Error("'transaction' property not implemented in MockTreeCheckout.");
	}
	public get events(): Listenable<CheckoutEvents> {
		throw new Error("'events' property not implemented in MockTreeCheckout.");
	}
	public get rootEvents(): Listenable<AnchorSetRootEvents> {
		throw new Error("'rootEvents' property not implemented in MockTreeCheckout.");
	}

	public branch(): ITreeCheckoutFork {
		throw new Error("Method 'fork' not implemented in MockTreeCheckout.");
	}
	public merge(view: unknown, disposeView?: unknown): void {
		throw new Error("Method 'merge' not implemented in MockTreeCheckout.");
	}
	public rebase(view: ITreeCheckoutFork): void {
		throw new Error("Method 'rebase' not implemented in MockTreeCheckout.");
	}
	public updateSchema(newSchema: TreeStoredSchema): void {
		throw new Error("Method 'updateSchema' not implemented in MockTreeCheckout.");
	}
	public getRemovedRoots(): [string | number | undefined, number, JsonableTree][] {
		throw new Error("Method 'getRemovedRoots' not implemented in MockTreeCheckout.");
	}
	public locate(anchor: Anchor): AnchorNode | undefined {
		throw new Error("Method 'locate' not implemented in MockTreeCheckout.");
	}
}

export function validateUsageError(expectedErrorMsg: string | RegExp): (error: Error) => true {
	return (error: Error) => {
		assert(error instanceof UsageError, `Expected UsageError, got ${error}`);
		if (
			typeof expectedErrorMsg === "string"
				? error.message !== expectedErrorMsg
				: !expectedErrorMsg.test(error.message)
		) {
			throw new Error(
				`Unexpected assertion thrown\nActual: ${error.message}\nExpected: ${expectedErrorMsg}`,
			);
		}
		return true;
	};
}

function normalizeNewFieldContent(
	content: readonly ITreeCursorSynchronous[] | ITreeCursorSynchronous | undefined,
): ITreeCursorSynchronous {
	if (content === undefined) {
		return cursorForMapTreeField([]);
	}

	if (isReadonlyArray(content)) {
		return cursorForMapTreeField(content.map((c) => mapTreeFromCursor(c)));
	}

	if (content.mode === CursorLocationType.Fields) {
		return content;
	}

	return cursorForMapTreeField([mapTreeFromCursor(content)]);
}

/**
 * Convenience helper for performing a "move" edit where the source and destination field are the same.
 */
export function moveWithin(
	editor: IDefaultEditBuilder,
	field: NormalizedFieldUpPath,
	sourceIndex: number,
	count: number,
	destIndex: number,
) {
	editor.move(field, sourceIndex, count, field, destIndex);
}

/**
 * Invoke inside a describe block for benchmarks to add hooks that configure things for maximum performance if isInPerformanceTestingMode,
 * and enable debug asserts otherwise.
 */
export function configureBenchmarkHooks(): void {
	let debugBefore: boolean;
	before(() => {
		debugBefore = configureDebugAsserts(!isInPerformanceTestingMode);
	});
	after(() => {
		assert.equal(configureDebugAsserts(debugBefore), !isInPerformanceTestingMode);
	});
}

export function chunkFromJsonTrees(field: JsonCompatible[]): TreeChunk {
	const cursor = fieldJsonCursor(field);
	return chunkFieldSingle(cursor, {
		idCompressor: testIdCompressor,
		policy: defaultChunkPolicy,
	});
}

export function chunkFromJsonableTrees(field: JsonableTree[]): TreeChunk {
	const cursor = cursorForJsonableTreeField(field);
	return chunkFieldSingle(cursor, {
		idCompressor: testIdCompressor,
		policy: defaultChunkPolicy,
	});
}

export function chunkToMapTreeField(chunk: TreeChunk): ExclusiveMapTree[] {
	return mapTreeFieldFromCursor(chunk.cursor());
}

export function nodeCursorsFromChunk(trees: TreeChunk): ITreeCursorSynchronous[] {
	return mapCursorField(trees.cursor(), (c) => c.fork());
}

/**
 * Construct field cursor from content that is compatible with the field defined by the provided `schema`.
 * @param schema - The schema for what to construct.
 * @param data - The data used to construct the field content.
 * @remarks
 * When providing a {@link TreeNodeSchemaClass},
 * this is the same as invoking its constructor except that an unhydrated node can also be provided and the returned value is a cursor.
 * When `undefined` is provided (for an optional field), `undefined` is returned.
 */
export function fieldCursorFromInsertable<
	TSchema extends ImplicitFieldSchema | UnsafeUnknownSchema,
>(
	schema: UnsafeUnknownSchema extends TSchema
		? ImplicitFieldSchema
		: TSchema & ImplicitFieldSchema,
	data: InsertableField<TSchema>,
): ITreeCursorSynchronous {
	const mapTree = unhydratedFlexTreeFromInsertable(
		data as InsertableField<UnsafeUnknownSchema>,
		schema,
	);
	return cursorForMapTreeField(mapTree === undefined ? [] : [mapTree]);
}

/**
 * Helper for building {@link TreeFieldStoredSchema}.
 */
export function fieldSchema(
	kind: { identifier: FieldKindIdentifier },
	types: Iterable<TreeNodeSchemaIdentifier>,
): TreeFieldStoredSchema {
	return {
		kind: kind.identifier,
		types: new Set(types),
		persistedMetadata: undefined,
	};
}

export class TestSchemaRepository extends TreeStoredSchemaRepository {
	public constructor(
		public readonly policy: FullSchemaPolicy,
		data?: TreeStoredSchema,
	) {
		super(data);
	}

	/**
	 * Updates the specified schema iff all possible in schema data would remain in schema after the change.
	 * @returns true iff update was performed.
	 */
	public tryUpdateRootFieldSchema(schema: TreeFieldStoredSchema): boolean {
		if (allowsFieldSuperset(this.policy, this, this.rootFieldSchema, schema)) {
			this.rootFieldSchemaData = schema;
			this._events.emit("afterSchemaChange", this);
			return true;
		}
		return false;
	}
	/**
	 * Updates the specified schema iff all possible in schema data would remain in schema after the change.
	 * @returns true iff update was performed.
	 */
	public tryUpdateTreeSchema(schema: SimpleNodeSchema & TreeNodeSchema): boolean {
		const storedSchema = getStoredSchema(schema);
		const name: TreeNodeSchemaIdentifier = brand(schema.identifier);
		const original = this.nodeSchema.get(name);
		if (allowsTreeSuperset(this.policy, this, original, storedSchema)) {
			this.nodeSchemaData.set(name, storedSchema);
			this._events.emit("afterSchemaChange", this);
			return true;
		}
		return false;
	}
}
