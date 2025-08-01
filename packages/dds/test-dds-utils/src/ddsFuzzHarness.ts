/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";

import { TypedEventEmitter } from "@fluid-internal/client-utils";
import type {
	AsyncGenerator,
	AsyncReducer,
	BaseFuzzTestState,
	BaseOperation,
	IRandom,
	MinimizationTransform,
	Reducer,
	SaveDestination,
	SaveInfo,
} from "@fluid-private/stochastic-test-utils";
import {
	ExitBehavior,
	FuzzTestMinimizer,
	asyncGeneratorFromArray,
	chainAsync,
	createFuzzDescribe,
	createWeightedAsyncGenerator,
	defaultOptions,
	done,
	generateTestSeeds,
	getSaveDirectory,
	getSaveInfo,
	interleaveAsync,
	isOperationType,
	makeRandom,
	performFuzzActionsAsync,
	saveOpsToFile,
	takeAsync,
} from "@fluid-private/stochastic-test-utils";
import { AttachState } from "@fluidframework/container-definitions";
import type { IFluidHandle } from "@fluidframework/core-interfaces";
import { unreachableCase } from "@fluidframework/core-utils/internal";
import type {
	IChannel,
	IChannelFactory,
	IChannelServices,
} from "@fluidframework/datastore-definitions/internal";
import type { IIdCompressor } from "@fluidframework/id-compressor";
import type { IIdCompressorCore } from "@fluidframework/id-compressor/internal";
import {
	isISharedObjectHandle,
	type IFluidSerializer,
} from "@fluidframework/shared-object-base/internal";
import {
	MockContainerRuntimeFactoryForReconnection,
	MockFluidDataStoreRuntime,
	MockStorage,
} from "@fluidframework/test-runtime-utils/internal";
import type { IMockContainerRuntimeOptions } from "@fluidframework/test-runtime-utils/internal";

import {
	type Client,
	type ClientLoadData,
	type ClientWithStashData,
	type FuzzSerializedIdCompressor,
	createLoadData,
	createLoadDataFromStashData,
	hasStashData,
} from "./clientLoading.js";
import { DDSFuzzHandle } from "./ddsFuzzHandle.js";
import { DDSFuzzSerializer } from "./fuzzSerializer.js";
import { makeUnreachableCodePathProxy, reconnectAndSquash } from "./utils.js";

/**
 * @internal
 */
export interface DDSRandom extends IRandom {
	handle(): IFluidHandle;
}

/**
 * @internal
 */
export interface DDSFuzzTestState<TChannelFactory extends IChannelFactory>
	extends BaseFuzzTestState {
	containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection;

	random: DDSRandom;

	/**
	 * Client which is responsible for summarizing. This client remains connected and read-only
	 * throughout the test.
	 *
	 * This client is also used for consistency validation, as eventual consistency bugs are
	 * typically easier to reason about when one client was readonly.
	 */
	summarizerClient: Client<TChannelFactory>;
	clients: Client<TChannelFactory>[];
	// Client which was selected to perform an operation on
	client: Client<TChannelFactory>;
	isDetached: boolean;
}

/**
 * @internal
 */
export interface ClientSpec {
	clientId: string;
}

/**
 * @internal
 */
export interface ChangeConnectionState {
	type: "changeConnectionState";
	connected: boolean;
	squash?: boolean;
}

/**
 * @internal
 */
export interface StashClient {
	type: "stashClient";
	existingClientId: string;
	newClientId: string;
}

/**
 * @internal
 */
export interface Attach {
	type: "attach";
}

/**
 * @internal
 */
export interface Attaching {
	type: "attaching";
	beforeRehydrate?: true;
}

/**
 * @internal
 */
export interface Rehydrate {
	type: "rehydrate";
}

/**
 * @internal
 */
export interface TriggerRebase {
	type: "rebase";
}

/**
 * @internal
 */
export interface Rollback {
	type: "applyThenRollback";
	ddsOp: BaseOperation;
}

/**
 * @internal
 */
export interface AddClient {
	type: "addClient";
	addedClientId: string;
	canBeStashed: boolean;
}

/**
 * @internal
 */
export interface Synchronize {
	type: "synchronize";
	clients?: string[];
}

export type HarnessOperation =
	| AddClient
	| Attach
	| Attaching
	| Rehydrate
	| ChangeConnectionState
	| TriggerRebase
	| Synchronize
	| StashClient
	| Rollback;

/**
 * Represents a generic fuzz model for testing eventual consistency of a DDS.
 *
 * @remarks
 *
 * Typical DDSes will parameterize this with their SharedObject factory and a serializable set
 * of operations corresponding to valid edits in the DDS's public API.
 *
 * @example
 * A simplified SharedString data structure exposing the APIs `insertAt(index, contentString)` and `removeRange(start, end)`
 * might represent their API with the following operations:
 * ```typescript
 * type InsertOperation = { type: "insert"; index: number; content: string }
 * type RemoveOperation = { type: "remove"; start: number; end: number }
 * type Operation = InsertOperation | RemoveOperation;
 * ```
 *
 * It would then typically use utilities from \@fluid-private/stochastic-test-utils to write a generator
 * for inserting/removing content, and a reducer for interpreting the serializable operations in terms of
 * SimpleSharedString's public API.
 *
 * See \@fluid-private/stochastic-test-utils's README for more details on this step.
 *
 * Then, it could define a model like so:
 * ```typescript
 * const model: DDSFuzzModel<SimpleSharedStringFactory, Operation> = {
 *     workloadName: "insert and delete",
 *     factory: SimpleSharedStringFactory,
 *     generatorFactory: myGeneratorFactory,
 *     reducer: myReducer,
 *     // A non-toy implementation would typically give a more informative assertion error (e.g. including
 *     // the IDs for `a` and `b`).
 *     validateConsistency: (a, b) => { assert.equal(a.channel.getText(), b.channel.getText()); }
 * }
 * ```
 * This model can be used directly to create a suite of fuzz tests with {@link (createDDSFuzzSuite:function)}
 *
 * @internal
 */
export interface DDSFuzzModel<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory> = DDSFuzzTestState<TChannelFactory>,
> {
	/**
	 * Name for this model. This is used for test case naming, and should generally reflect properties
	 * about the kinds of operations that are generated.
	 * For example, SharedString might fuzz test several different workloads--some involving intervals,
	 * some without, some that never delete text, etc.
	 * This name should also be relatively friendly for file system; if the "save to disk" option of
	 * {@link (createDDSFuzzSuite:function)} is enabled, it will be kebab cased for failure files.
	 */
	workloadName: string;

	/**
	 * ChannelFactory to instantiate the DDS.
	 */
	factory: TChannelFactory;

	/**
	 * Factory which creates a generator for this model.
	 * @remarks DDS model generators can decide to use the "channel" or "client" field to decide which
	 * client to perform the operation on.
	 */
	generatorFactory: () => AsyncGenerator<TOperation, TState>;

	/**
	 * Reducer capable of updating the test state according to the operations generated.
	 */
	reducer: Reducer<TOperation, TState>;

	/**
	 * Equivalence validation function, which should verify that the provided channels contain the same data.
	 * This is run at each synchronization point for all connected clients (as disconnected clients won't
	 * necessarily have the same set of ops applied).
	 * @throws - An informative error if the channels don't have equivalent data.
	 */
	validateConsistency: (
		channelA: Client<TChannelFactory>,
		channelB: Client<TChannelFactory>,
	) => void | Promise<void>;

	/**
	 * An array of transforms used during fuzz test minimization to reduce test
	 * cases. See {@link @fluid-private/stochastic-test-utils#MinimizationTransform} for additional context.
	 *
	 * If no transforms are supplied, minimization will still occur, but the
	 * contents of the operations will remain unchanged.
	 */
	minimizationTransforms?: MinimizationTransform<TOperation>[];
}

/**
 * This model is used within the harness to wrap the provided {@link DDSFuzzModel}.
 *
 * This model's reducer differs from the {@link DDSFuzzModel} in that it can be an asynchronous
 * reducer. This is necessary for the harness to support asynchronous operations
 * like loading new clients, and doing synchronization.
 *
 * @internal
 */
export interface DDSFuzzHarnessModel<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory> = DDSFuzzTestState<TChannelFactory>,
> extends Omit<DDSFuzzModel<TChannelFactory, TOperation, TState>, "reducer"> {
	/**
	 * Reducer capable of updating the test state according to the operations generated.
	 */
	reducer: AsyncReducer<TOperation, TState> | Reducer<TOperation, TState>;
}

/**
 * @internal
 */
export interface DDSFuzzHarnessEvents {
	/**
	 * Raised for each non-summarizer client created during fuzz test execution.
	 */
	(event: "clientCreate", listener: (client: Client<IChannelFactory>) => void);

	/**
	 * Raised after creating the initialState but prior to performing the fuzzActions..
	 */
	(event: "testStart", listener: (initialState: DDSFuzzTestState<IChannelFactory>) => void);

	/**
	 * Raised after all fuzzActions have been completed.
	 */
	(event: "testEnd", listener: (finalState: DDSFuzzTestState<IChannelFactory>) => void);

	/**
	 * Raised before each generated operation is run by its reducer.
	 */
	(event: "operationStart", listener: (operation: BaseOperation) => void);
}

/**
 * @internal
 */
export interface DDSFuzzSuiteOptions {
	/**
	 * Number of tests to generate for correctness modes (which are run in the PR gate).
	 */
	defaultTestCount: number;

	/**
	 * Number of clients to perform operations on following the attach phase.
	 * This does not include the read-only client created for consistency validation
	 * and summarization--see {@link DDSFuzzTestState.summarizerClient}.
	 *
	 * See {@link DDSFuzzSuiteOptions.detachedStartOptions} for more details on the detached start phase.
	 * See {@link DDSFuzzSuiteOptions.clientJoinOptions} for more details on clients joining after those in the initial attach.
	 */
	numberOfClients: number;

	/**
	 * Options dictating if and when to simulate new clients joining the collaboration session.
	 * If not specified, no new clients will be added after the test starts.
	 *
	 * This option is useful for testing eventual consistency bugs related to summarization.
	 *
	 * @remarks Even without enabling this option, DDS fuzz models can generate {@link AddClient}
	 * operations with whatever strategy is appropriate.
	 * This is useful for nudging test cases towards a particular pattern of clients joining.
	 */
	clientJoinOptions?: {
		/**
		 * The maximum number of clients that will ever be added to the test.
		 * @remarks Due to current mock limitations, clients will only ever be added to the collaboration session,
		 * not removed.
		 * Adding an excessive number of clients may cause performance issues.
		 */
		maxNumberOfClients: number;

		/**
		 * The probability that a client will be added at any given operation.
		 * If the current number of clients has reached the maximum, this probability is ignored.
		 */
		clientAddProbability: number;
		/**
		 * The probability for an added client to also be stashable which simulates
		 * getting the pending state, closing the container, and re-opening with the state.
		 */
		stashableClientProbability?: number;
	};

	/**
	 * Dictates simulation of edits made to a DDS while that DDS is detached.
	 *
	 * When enabled, the fuzz test starts with a single client generating edits. After a certain number of ops (dictated by `numOpsBeforeAttach`),
	 * an attach op will be generated, at which point:
	 * - getAttachSummary will be invoked on this client
	 * - The remaining clients (as dictated by {@link DDSFuzzSuiteOptions.numberOfClients}) will load from this summary and join the session
	 *
	 * This setup simulates application code initializing state in a data store before attaching it, e.g. running code to edit a DDS from
	 * `DataObject.initializingFirstTime`.
	 * Default: tests are run with this setting enabled, with 5 ops being generated before an attach op. A new client is also rehydrated from
	 * summary. To disable the generation of rehydrate ops, set `rehydrateDisabled` to `true`.
	 */
	detachedStartOptions: {
		numOpsBeforeAttach: number;
		rehydrateDisabled?: true;
		/**
		 * If true, disable rehydrating DDSes while they are in the "attaching" state.
		 *
		 * BEWARE: The harness has known correctness issues with rehydration when there are outstanding id compressor ops. DDSes that use id-compressor
		 * should set this to `true` if they test rehydration. AB#43127 has more context.
		 */
		attachingBeforeRehydrateDisable?: true;
	};

	/**
	 * Defines whether or not ops can be submitted with handles.
	 */
	handleGenerationDisabled: boolean;

	/**
	 * Event emitter which allows hooking into interesting points of DDS harness execution.
	 * Test authors that want to subscribe to any of these events should create a `TypedEventEmitter`,
	 * do so, and pass it in when creating the suite.
	 *
	 * @example
	 *
	 * ```typescript
	 * const emitter = new TypedEventEmitter<DDSFuzzHarnessEvents>();
	 * emitter.on("clientCreate", (client) => {
	 *     // Casting is necessary as the event typing isn't parameterized with each DDS type.
	 *     const myDDS = client.channel as MyDDSType;
	 *     // Do what you want with `myDDS`, e.g. subscribe to change events, add logging, etc.
	 * });
	 * const options = {
	 *     ...defaultDDSFuzzSuiteOptions,
	 *     emitter,
	 * };
	 * createDDSFuzzSuite(model, options);
	 * ```
	 */
	emitter: TypedEventEmitter<DDSFuzzHarnessEvents>;

	/**
	 * Strategy for validating eventual consistency of DDSes.
	 * In random mode, each generated operation has the specified probability to instead be a synchronization point
	 * (all connected clients process all ops) followed by validation that all clients agree on their shared state.
	 * In fixed interval mode, this synchronization happens on a predictable cadence: every `interval` operations
	 * generated.
	 */
	validationStrategy:
		| { type: "random"; probability: number }
		| { type: "fixedInterval"; interval: number }
		// WIP: This validation strategy still currently synchronizes all clients.
		| { type: "partialSynchronization"; probability: number; clientProbability: number };
	parseOperations: (serialized: string) => BaseOperation[];

	/**
	 * Each non-synchronization option has this probability of instead generating a disconnect/reconnect.
	 * The reconnect operation currently *replaces* the operation generated by the model's generator.
	 *
	 * TODO: Expose options for how to inject reconnection in a more flexible way.
	 */
	reconnectProbability: number;

	/**
	 * Each non-synchronization option has this probability of rebasing the current batch before sending it.
	 */
	rebaseProbability: number;

	/**
	 * Each generated DDS operation has this probability of being rolled back immediately after application.
	 */
	rollbackProbability: number;

	/**
	 * Seed which should be replayed from disk.
	 *
	 * This option is intended for quick, by-hand minimization of failure JSON. As such, it adds a `.only`
	 * to the corresponding replay test.
	 *
	 * TODO: Improving workflows around fuzz test minimization, regression test generation for a particular seed,
	 * or more flexibility around replay of test files would be a nice value add to this harness.
	 */
	replay?: number | Iterable<number>;

	/**
	 * Runs only the provided seeds.
	 *
	 * @example
	 *
	 * ```typescript
	 * // Runs only seed 42 for the given model.
	 * createDDSFuzzSuite(model, { only: [42] });
	 * ```
	 *
	 * @remarks
	 * If you prefer, a variant of the standard `.only` syntax works. See {@link (createDDSFuzzSuite:namespace).only}.
	 */
	only: Iterable<number> | number;

	/**
	 * Skips the provided seeds.
	 *
	 * @example
	 *
	 * ```typescript
	 * // Skips seed 42 for the given model.
	 * createDDSFuzzSuite(model, { skip: [42] });
	 * ```
	 *
	 * @remarks
	 * If you prefer, a variant of the standard `.skip` syntax works. See {@link (createDDSFuzzSuite:namespace).skip}.
	 */
	skip: Iterable<number> | number;

	/**
	 * Whether failure files should be saved to disk, and if so, the directory in which they should be saved.
	 * Each seed will be saved in a subfolder of this directory obtained by kebab-casing the model name.
	 *
	 * Turning on this feature is encouraged for quick minimization.
	 */
	saveFailures: false | { directory: string };

	/**
	 * Whether successful runs should be saved to disk and where.
	 * Minimization will be skipped for these files.
	 *
	 * This feature is useful to audit the scenarios generated by a given fuzz configuration.
	 */
	saveSuccesses: false | { directory: string };

	/**
	 * Options to be provided to the underlying container runtimes {@link @fluidframework/test-runtime-utils#IMockContainerRuntimeOptions}.
	 * By default nothing will be provided, which means that the runtimes will:
	 * - use FlushMode.Immediate, which means that all ops will be sent as soon as they are produced,
	 * therefore all batches have a single op.
	 * - not use grouped batching.
	 */
	containerRuntimeOptions?: IMockContainerRuntimeOptions;

	/**
	 * Whether or not to skip minimization of fuzz failing test cases. This is useful
	 * when one only cares about the counts or types of errors, and not the
	 * exact contents of the test cases.
	 *
	 * Minimization only works when the failure occurs as part of a reducer, and is mostly
	 * useful if the model being tested defines {@link DDSFuzzModel.minimizationTransforms}.
	 *
	 * It can also add a couple seconds of overhead per failing
	 * test case. See {@link @fluid-private/stochastic-test-utils#MinimizationTransform} for additional context.
	 */
	skipMinimization?: boolean;

	/**
	 * An optional IdCompressor that will be passed to the constructed MockDataStoreRuntime instance.
	 */
	idCompressorFactory?: (
		summary?: FuzzSerializedIdCompressor,
	) => IIdCompressor & IIdCompressorCore;

	/**
	 * This preserves the old seed behavior where the whole fuzz tests gets a single seed.
	 * This creates issues as small changes, like adding a new random usage,
	 * can result in a cascade of changes to the test, which can invalidate current skips.
	 *
	 * The new behavior generates a seed per operation, which leads to more stable results, as
	 * random calls within a generator or reducer do not cascade to other generators or reducers.
	 *
	 * @deprecated This is option is for back-compat only. Once all usages are removed, it should also be removed.
	 */
	forceGlobalSeed?: true;

	/**
	 * If enabled, connection state change operations will sometimes use squashed resubmits.
	 */
	testSquashResubmit?: true;
}

/**
 * @internal
 */
export const defaultDDSFuzzSuiteOptions: DDSFuzzSuiteOptions = {
	defaultTestCount: defaultOptions.defaultTestCount,
	detachedStartOptions: {
		numOpsBeforeAttach: 5,
	},
	handleGenerationDisabled: true,
	emitter: new TypedEventEmitter(),
	numberOfClients: 3,
	only: [],
	skip: [],
	parseOperations: (serialized: string) => JSON.parse(serialized) as BaseOperation[],
	reconnectProbability: 0,
	rebaseProbability: 0,
	saveFailures: false,
	saveSuccesses: false,
	validationStrategy: { type: "random", probability: 0.05 },
	rollbackProbability: 0.01,
};

/**
 * Mixes in functionality to add new clients to a DDS fuzz model.
 * @privateRemarks This is currently file-exported for testing purposes, but it could be reasonable to
 * expose at the package level if we want to expose some of the harness's building blocks.
 */
export function mixinNewClient<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	options: DDSFuzzSuiteOptions,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | AddClient, TState> {
	const isClientAddOp = (op: TOperation | AddClient): op is AddClient =>
		op.type === "addClient";

	const generatorFactory: () => AsyncGenerator<TOperation | AddClient, TState> = () => {
		const baseGenerator = model.generatorFactory();
		return async (state: TState): Promise<TOperation | AddClient | typeof done> => {
			const { clients, random, isDetached } = state;
			if (
				options.clientJoinOptions !== undefined &&
				clients.length < options.clientJoinOptions.maxNumberOfClients &&
				!isDetached &&
				random.bool(options.clientJoinOptions.clientAddProbability)
			) {
				return {
					type: "addClient",
					addedClientId: makeFriendlyClientId(random, clients.length),
					canBeStashed: options.clientJoinOptions?.stashableClientProbability
						? random.bool(options.clientJoinOptions.stashableClientProbability)
						: false,
				};
			}
			return baseGenerator(state);
		};
	};

	const minimizationTransforms: MinimizationTransform<TOperation | AddClient>[] =
		(model.minimizationTransforms as
			| MinimizationTransform<TOperation | AddClient>[]
			| undefined) ?? [];

	minimizationTransforms.push((op: TOperation | AddClient): void => {
		if (isClientAddOp(op)) {
			op.canBeStashed = false;
		}
	});

	const reducer: AsyncReducer<TOperation | AddClient, TState> = async (state, op) => {
		if (isClientAddOp(op)) {
			const newClient = await loadClient(
				state.containerRuntimeFactory,
				state.summarizerClient,
				model.factory,
				op.addedClientId,
				options,
				op.canBeStashed,
			);
			state.clients.push(newClient);
			return state;
		}
		return model.reducer(state, op);
	};

	return {
		...model,
		minimizationTransforms,
		generatorFactory,
		reducer,
	};
}

/**
 * Mixes in functionality to disconnect and reconnect clients in a DDS fuzz model.
 * @privateRemarks This is currently file-exported for testing purposes, but it could be reasonable to
 * expose at the package level if we want to expose some of the harness's building blocks.
 */
export function mixinReconnect<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	options: DDSFuzzSuiteOptions,
	isReconnectAllowed = (state: TState): boolean => !state.isDetached,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | ChangeConnectionState, TState> {
	const generatorFactory: () => AsyncGenerator<TOperation | ChangeConnectionState, TState> =
		() => {
			const baseGenerator = model.generatorFactory();
			return async (state): Promise<TOperation | ChangeConnectionState | typeof done> => {
				const baseOp = baseGenerator(state);
				if (isReconnectAllowed(state) && state.random.bool(options.reconnectProbability)) {
					const op: ChangeConnectionState = {
						type: "changeConnectionState",
						connected: !state.client.containerRuntime.connected,
					};
					if (options.testSquashResubmit === true && op.connected && state.random.bool(0.5)) {
						op.squash = true;
					}
					return op;
				}

				return baseOp;
			};
		};

	const minimizationTransforms = model.minimizationTransforms as
		| MinimizationTransform<TOperation | ChangeConnectionState>[]
		| undefined;

	const reducer: AsyncReducer<TOperation | ChangeConnectionState, TState> = async (
		state,
		operation,
	) => {
		if (isOperationType<ChangeConnectionState>("changeConnectionState", operation)) {
			if (operation.squash === true) {
				reconnectAndSquash(state.client.containerRuntime, state.client.dataStoreRuntime);
			} else {
				state.client.containerRuntime.connected = operation.connected;
			}
			return state;
		} else {
			return model.reducer(state, operation);
		}
	};
	return {
		...model,
		minimizationTransforms,
		generatorFactory,
		reducer,
	};
}

/**
 * Mixes in functionality to generate an 'attach' op, which
 * @privateRemarks This is currently file-exported for testing purposes, but it could be reasonable to
 * expose at the package level if we want to expose some of the harness's building blocks.
 */
export function mixinAttach<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	options: DDSFuzzSuiteOptions,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | Attach | Attaching | Rehydrate, TState> {
	const { numOpsBeforeAttach, rehydrateDisabled, attachingBeforeRehydrateDisable } =
		options.detachedStartOptions;
	if (numOpsBeforeAttach === 0) {
		// not wrapping the reducer/generator in this case makes stepping through the harness slightly less painful.
		return model as DDSFuzzHarnessModel<
			TChannelFactory,
			TOperation | Attach | Attaching | Rehydrate,
			TState
		>;
	}
	const attachOp = async (): Promise<TOperation | Attach | Attaching | Rehydrate> => {
		return { type: "attach" };
	};
	const rehydrateOp = async (): Promise<TOperation | Attach | Attaching | Rehydrate> => {
		return { type: "rehydrate" };
	};
	const generatorFactory: () => AsyncGenerator<
		TOperation | Attach | Attaching | Rehydrate,
		TState
	> = () => {
		const baseGenerator = model.generatorFactory();
		const rehydrates = rehydrateDisabled
			? []
			: [
					// sometimes mix a single attaching op
					// in before rehydrate so we test
					// applying stashed ops while detached
					createWeightedAsyncGenerator<TOperation | Attach | Attaching | Rehydrate, TState>([
						[takeAsync(numOpsBeforeAttach, baseGenerator), numOpsBeforeAttach],
						[
							takeAsync(
								1,
								async (): Promise<Attaching> => ({
									type: "attaching",
									beforeRehydrate: true,
								}),
							),
							attachingBeforeRehydrateDisable === true ? 0 : 1,
						],
					]),
					takeAsync(1, rehydrateOp),
				];
		return chainAsync(
			...rehydrates,
			takeAsync(numOpsBeforeAttach, baseGenerator),
			takeAsync(1, attachOp),
			baseGenerator,
		);
	};

	const minimizationTransforms = model.minimizationTransforms as
		| MinimizationTransform<TOperation | Attach | Attaching | Rehydrate>[]
		| undefined;

	const reducer: AsyncReducer<TOperation | Attach | Attaching | Rehydrate, TState> = async (
		state,
		operation,
	) => {
		if (isOperationType<Attach>("attach", operation)) {
			state.isDetached = false;
			assert.equal(state.clients.length, 1);
			const clientA: ClientWithStashData<TChannelFactory> = state.clients[0];
			if (clientA.dataStoreRuntime.attachState === AttachState.Detached) {
				finalizeAllocatedIds(clientA);
			}
			clientA.dataStoreRuntime.setAttachState(AttachState.Attached);
			const services: IChannelServices = {
				deltaConnection: clientA.dataStoreRuntime.createDeltaConnection(),
				objectStorage: new MockStorage(),
			};
			clientA.channel.connect(services);
			const clients: Client<TChannelFactory>[] = await Promise.all(
				Array.from({ length: options.numberOfClients }, async (_, index) =>
					loadClient(
						state.containerRuntimeFactory,
						clientA,
						model.factory,
						index === 0 ? "summarizer" : makeFriendlyClientId(state.random, index),
						options,
						index !== 0 && options.clientJoinOptions?.stashableClientProbability
							? state.random.bool(options.clientJoinOptions.stashableClientProbability)
							: false,
					),
				),
			);
			// eslint-disable-next-line require-atomic-updates
			clientA.stashData = undefined;

			// While detached, the initial state was set up so that the 'summarizer client' was the same as the detached client.
			// This is actually a pretty reasonable representation of what really happens.
			// However, now that we're transitioning to an attached state, the summarizer client should never have any edits.
			// Thus we use one of the clients we just loaded as the summarizer client, and keep the client around that we generated the
			// attach summary from.
			const summarizerClient: Client<TChannelFactory> = clients[0];
			clients[0] = state.clients[0];

			return {
				...state,
				isDetached: false,
				clients,
				summarizerClient,
			};
		} else if (isOperationType<Rehydrate>("rehydrate", operation)) {
			const clientA = state.clients[0];
			assert.equal(state.clients.length, 1);

			state.containerRuntimeFactory.removeContainerRuntime(clientA.containerRuntime);

			// TODO: AB#43127: Using a detached load here is not right with respect to id compressor ops in all cases.
			// The general strategy that the mocks use for resubmit does not align with the production implementation,
			// and that should probably be rectified here. The immediate problem with using `loadDetached` here is that
			// it finalizes IDs, which is only OK if this rehydrate is happening while the container is detached (not attaching).
			// See comment on `attachingBeforeRehydrateDisable` for more context.
			const summarizerClient = await loadDetached(
				state.containerRuntimeFactory,
				clientA,
				model.factory,
				makeFriendlyClientId(state.random, 0),
				options,
			);

			await model.validateConsistency(clientA, summarizerClient);

			return {
				...state,
				isDetached: true,
				clients: [summarizerClient],
				summarizerClient,
			};
		} else if (isOperationType<Attaching>("attaching", operation)) {
			assert.equal(state.clients.length, 1);
			const clientA: ClientWithStashData<IChannelFactory> = state.clients[0];
			finalizeAllocatedIds(clientA);

			if (operation.beforeRehydrate === true) {
				clientA.stashData = createLoadData(clientA, true);
			}
			clientA.dataStoreRuntime.setAttachState(AttachState.Attaching);
			const services: IChannelServices = {
				deltaConnection: clientA.dataStoreRuntime.createDeltaConnection(),
				objectStorage: new MockStorage(),
			};
			clientA.channel.connect(services);

			return state;
		}
		return model.reducer(state, operation);
	};
	return {
		...model,
		minimizationTransforms,
		generatorFactory,
		reducer,
	};
}

/**
 * Mixes in functionality to rebase in-flight batches in a DDS fuzz model. A batch is rebased by
 * resending it to the datastores before being sent over the wire.
 *
 * @privateRemarks This is currently file-exported for testing purposes, but it could be reasonable to
 * expose at the package level if we want to expose some of the harness's building blocks.
 */
export function mixinRebase<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	options: DDSFuzzSuiteOptions,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | TriggerRebase, TState> {
	const generatorFactory: () => AsyncGenerator<TOperation | TriggerRebase, TState> = () => {
		const baseGenerator = model.generatorFactory();
		return async (state): Promise<TOperation | TriggerRebase | typeof done> => {
			const baseOp = baseGenerator(state);
			if (state.random.bool(options.rebaseProbability)) {
				const client = state.clients.find((c) => c.channel.id === state.client.channel.id);
				assert(client !== undefined);
				return {
					type: "rebase",
				};
			}

			return baseOp;
		};
	};

	const minimizationTransforms = model.minimizationTransforms as
		| MinimizationTransform<TOperation | TriggerRebase>[]
		| undefined;

	const reducer: AsyncReducer<TOperation | TriggerRebase, TState> = async (
		state,
		operation,
	) => {
		if (isOperationType<TriggerRebase>("rebase", operation)) {
			assert(
				state.client.containerRuntime.rebase !== undefined,
				"Unsupported mock runtime version",
			);
			state.client.containerRuntime.rebase();
			return state;
		} else {
			return model.reducer(state, operation);
		}
	};
	return {
		...model,
		minimizationTransforms,
		generatorFactory,
		reducer,
	};
}

/**
 * Mixes in functionality to generate ops which synchronize all clients and assert the resulting state is consistent.
 * @privateRemarks This is currently file-exported for testing purposes, but it could be reasonable to
 * expose at the package level if we want to expose some of the harness's building blocks.
 */
export function mixinSynchronization<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	options: DDSFuzzSuiteOptions,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | Synchronize, TState> {
	const { validationStrategy } = options;
	let generatorFactory: () => AsyncGenerator<TOperation | Synchronize, TState>;

	switch (validationStrategy.type) {
		case "random": {
			// passing 1 here causes infinite loops. passing close to 1 is wasteful
			// as synchronization + eventual consistency validation should be idempotent.
			// 0.5 is arbitrary but there's no reason anyone should want a probability near this.
			assert(validationStrategy.probability < 0.5, "Use a lower synchronization probability.");
			generatorFactory = (): AsyncGenerator<TOperation | Synchronize, TState> => {
				const baseGenerator = model.generatorFactory();
				return async (state: TState): Promise<TOperation | Synchronize | typeof done> =>
					!state.isDetached && state.random.bool(validationStrategy.probability)
						? { type: "synchronize" }
						: baseGenerator(state);
			};
			break;
		}

		case "fixedInterval": {
			generatorFactory = (): AsyncGenerator<TOperation | Synchronize, TState> => {
				const baseGenerator = model.generatorFactory();
				return interleaveAsync<TOperation | Synchronize, TState>(
					baseGenerator,
					async (state) =>
						state.isDetached ? baseGenerator(state) : ({ type: "synchronize" } as const),
					validationStrategy.interval,
					1,
					ExitBehavior.OnEitherExhausted,
				);
			};
			break;
		}

		case "partialSynchronization": {
			// passing 1 here causes infinite loops. passing close to 1 is wasteful
			// as synchronization + eventual consistency validation should be idempotent.
			// 0.5 is arbitrary but there's no reason anyone should want a probability near this.
			assert(validationStrategy.probability < 0.5, "Use a lower synchronization probability.");
			generatorFactory = (): AsyncGenerator<TOperation | Synchronize, TState> => {
				const baseGenerator = model.generatorFactory();
				return async (state: TState): Promise<TOperation | Synchronize | typeof done> => {
					if (!state.isDetached && state.random.bool(validationStrategy.probability)) {
						const selectedClients = new Set(
							state.clients
								.filter((client) => client.containerRuntime.connected)
								.filter(() => state.random.bool(validationStrategy.clientProbability))
								.map((client) => client.channel.id),
						);

						return { type: "synchronize", clients: [...selectedClients] };
					} else {
						return baseGenerator(state);
					}
				};
			};
			break;
		}
		default: {
			unreachableCase(validationStrategy);
		}
	}

	const minimizationTransforms = model.minimizationTransforms as
		| MinimizationTransform<TOperation | Synchronize>[]
		| undefined;

	const isSynchronizeOp = (op: BaseOperation): op is Synchronize => op.type === "synchronize";
	const reducer: AsyncReducer<TOperation | Synchronize, TState> = async (state, operation) => {
		// TODO: Only synchronize listed clients if specified
		if (isSynchronizeOp(operation)) {
			const connectedClients = state.clients.filter(
				(client) => client.containerRuntime.connected,
			);

			for (const client of connectedClients) {
				assert(
					client.containerRuntime.flush !== undefined,
					"Unsupported mock runtime version",
				);
				client.containerRuntime.flush();
			}

			state.containerRuntimeFactory.processAllMessages();
			if (connectedClients.length > 0) {
				const readonlyChannel = state.summarizerClient;
				for (const client of connectedClients) {
					try {
						await model.validateConsistency(client, readonlyChannel);
					} catch (error: unknown) {
						if (error instanceof Error) {
							error.message = `Comparing client ${client.channel.id} vs client ${readonlyChannel.channel.id}\n${error.message}`;
						}
						throw error;
					}
				}
			}

			return state;
		}
		return model.reducer(state, operation);
	};
	return {
		...model,
		minimizationTransforms,
		generatorFactory,
		reducer,
	};
}

const isClientSpec = (op: unknown): op is ClientSpec =>
	(op as ClientSpec).clientId !== undefined;

export function setupClientContext(
	state: DDSFuzzTestState<IChannelFactory>,
	client: Client<IChannelFactory>,
): CleanupFunction {
	const { client: oldClient, random } = state;
	// eslint-disable-next-line @typescript-eslint/unbound-method
	const { handle: oldHandle } = random;

	state.client = client;
	random.handle = () => new DDSFuzzHandle(random.pick(handles), client.dataStoreRuntime);
	return () => {
		state.client = oldClient;
		// eslint-disable-next-line unicorn/consistent-destructuring
		state.random.handle = oldHandle;
	};
}

/**
 * Mixes in the ability to select a client to perform an operation on.
 * Makes this available to existing generators and reducers in the passed-in model via {@link DDSFuzzTestState.client}
 * and {@link  @fluid-private/test-dds-utils#DDSFuzzTestState.channel}.
 *
 * @remarks This exists purely for convenience, as "pick a client to perform an operation on" is a common concern.
 * @privateRemarks This is currently file-exported for testing purposes, but it could be reasonable to
 * expose at the package level if we want to expose some of the harness's building blocks.
 */
export function mixinClientSelection<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	_: DDSFuzzSuiteOptions,
	setupClientState: (
		state: TState,
		client: TState["client"],
	) => CleanupFunction = setupClientContext,
): DDSFuzzHarnessModel<TChannelFactory, TOperation, TState> {
	const generatorFactory: () => AsyncGenerator<TOperation, TState> = () => {
		const baseGenerator = model.generatorFactory();
		return async (state): Promise<TOperation | typeof done> => {
			// Pick a channel, and:
			// 1. Make it available for the DDS model generators (so they don't need to
			// do the boilerplate of selecting a client to perform the operation on)
			// 2. Make it available to the subsequent reducer logic we're going to inject
			// (so that we can recover the channel from serialized data)
			const client = state.random.pick(state.clients);
			const baseOp = await runInStateWithClient(state, client, setupClientState, async () =>
				baseGenerator(state),
			);
			return baseOp === done
				? done
				: {
						...baseOp,
						clientId: client.channel.id,
					};
		};
	};

	const reducer: AsyncReducer<TOperation | Synchronize, TState> = async (state, operation) => {
		assert(isClientSpec(operation), "operation should have been given a client");
		const client = state.clients.find((c) => c.channel.id === operation.clientId);
		assert(client !== undefined);
		await runInStateWithClient(state, client, setupClientState, async () =>
			model.reducer(state, operation as TOperation),
		);
	};
	return {
		...model,
		generatorFactory,
		reducer,
	};
}

/**
 * Mixes in functionality to allow for rollback operations in a DDS fuzz model and applies them during state transitions.
 */
export function mixinRollback<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	options: DDSFuzzSuiteOptions,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | Rollback, TState> {
	const generatorFactory: () => AsyncGenerator<TOperation | Rollback, TState> = () => {
		const baseGenerator = model.generatorFactory();
		return async (state): Promise<TOperation | Rollback | typeof done> => {
			const baseOp = await baseGenerator(state);
			if (baseOp !== done && state.random.bool(options.rollbackProbability)) {
				return {
					type: "applyThenRollback",
					ddsOp: baseOp,
				};
			}

			return baseOp;
		};
	};

	const minimizationTransforms = model.minimizationTransforms as
		| MinimizationTransform<TOperation | Rollback>[]
		| undefined;

	const reducer: AsyncReducer<TOperation | Rollback, TState> = async (state, operation) => {
		if (isOperationType<Rollback>("applyThenRollback", operation)) {
			state.client.containerRuntime.flush();
			await state.client.containerRuntime.runWithManualFlush(async () => {
				await model.reducer(state, operation.ddsOp as TOperation);
			});
			state.client.containerRuntime.rollback?.();
			return state;
		} else {
			return model.reducer(state, operation);
		}
	};
	return {
		...model,
		minimizationTransforms,
		generatorFactory,
		reducer,
	};
}

export function mixinStashedClient<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
	TState extends DDSFuzzTestState<TChannelFactory>,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation, TState>,
	options: DDSFuzzSuiteOptions,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | StashClient, TState> {
	if (options.clientJoinOptions?.stashableClientProbability === undefined) {
		return model as DDSFuzzHarnessModel<TChannelFactory, TOperation | StashClient, TState>;
	}

	const generatorFactory: () => AsyncGenerator<TOperation | StashClient, TState> = () => {
		const baseGenerator = model.generatorFactory();
		return async (state): Promise<TOperation | StashClient | typeof done> => {
			const stashable = state.clients.filter(
				(c) => hasStashData(c) && c.containerRuntime.isDirty,
			);

			if (!state.isDetached && stashable.length > 0 && state.random.bool(0.5)) {
				const existingClientId = state.random.pick(stashable).channel.id;
				const instanceIndex = existingClientId.lastIndexOf("_");
				const instance =
					instanceIndex < 0
						? 0
						: Number.parseInt(existingClientId.slice(instanceIndex + 1), 10);
				return {
					type: "stashClient",
					existingClientId,
					newClientId: `${existingClientId}_${instance + 1}`,
				};
			}
			return baseGenerator(state);
		};
	};

	const reducer: AsyncReducer<TOperation | StashClient, TState> = async (state, operation) => {
		const { clients, containerRuntimeFactory } = state;
		if (isOperationType<StashClient>("stashClient", operation)) {
			const client = clients.find((c) => c.channel.id === operation.existingClientId);
			if (!hasStashData(client)) {
				throw new ReducerPreconditionError("client not stashable");
			}
			const loadData = createLoadDataFromStashData(client, client.stashData);

			// load a new client from the same state as the original client
			const newClient = await loadClientFromSummaries(
				containerRuntimeFactory,
				loadData,
				model.factory,
				operation.newClientId,
				options,
			);

			await newClient.containerRuntime.initializeWithStashedOps(client.containerRuntime);

			// replace the old client with the new client
			return {
				...state,
				clients: [...clients.filter((c) => c.channel.id !== client.channel.id), newClient],
			};
		}

		return model.reducer(state, operation);
	};

	return {
		...model,
		generatorFactory,
		reducer,
		minimizationTransforms: model.minimizationTransforms as MinimizationTransform<
			TOperation | StashClient
		>[],
	};
}

export const handles = Array.from({ length: 100 }, (_, index) => `handle_${index}`);

/**
 * Callback invoked on "cleanup" of some associated operation.
 *
 * This is the same dispose callback pattern used by our eventing library in common-utils.
 */
export type CleanupFunction = () => void;

/**
 * This modifies the value of "client" while callback is running, then restores it.
 * This is does instead of copying the state since the state object is mutable, and running callback might make changes to state (like add new members) which are lost if state is just copied.
 *
 * Since the callback is async, this modification to the state could be an issue if multiple runs of this function are done concurrently.
 */
async function runInStateWithClient<TState extends DDSFuzzTestState<IChannelFactory>, Result>(
	state: TState,
	client: TState["client"],
	setupClientState: (state: TState, client: TState["client"]) => CleanupFunction,
	callback: (state: TState) => Promise<Result>,
): Promise<Result> {
	const cleanup = setupClientState(state, client);
	try {
		return await callback(state);
	} finally {
		cleanup();
	}
}

function createDetachedClient<TChannelFactory extends IChannelFactory>(
	containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection,
	factory: TChannelFactory,
	clientId: string,
	options: Omit<DDSFuzzSuiteOptions, "only" | "skip">,
): Client<TChannelFactory> {
	const dataStoreRuntime = new MockFluidDataStoreRuntime({
		clientId,
		idCompressor:
			options.idCompressorFactory === undefined ? undefined : options.idCompressorFactory(),
		attachState: AttachState.Detached,
	});
	// Note: we re-use the clientId for the channel id here despite connecting all clients to the same channel:
	// this isn't how it would work in a real scenario, but the mocks don't use the channel id for any message
	// routing behavior and making all of the object ids consistent helps with debugging and writing more informative
	// consistency validation.
	const channel: ReturnType<typeof factory.create> = factory.create(
		dataStoreRuntime,
		clientId,
	);
	setupFuzzSerializer(channel, dataStoreRuntime);

	const containerRuntime = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime, {
		// only track remote ops(which enables initialize from stashed ops), if rehydrate is enabled
		trackRemoteOps: options.detachedStartOptions.rehydrateDisabled !== true,
	});
	// TS resolves the return type of model.factory.create too early and isn't able to retain a more specific type
	// than IChannel here.
	const newClient: Client<TChannelFactory> = {
		containerRuntime,
		dataStoreRuntime,
		channel: channel as ReturnType<TChannelFactory["create"]>,
	};
	options.emitter.emit("clientCreate", newClient);
	return newClient;
}

async function loadClient<TChannelFactory extends IChannelFactory>(
	containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection,
	summarizerClient: ClientWithStashData<TChannelFactory>,
	factory: TChannelFactory,
	clientId: string,
	options: Omit<DDSFuzzSuiteOptions, "only" | "skip">,
	supportStashing: boolean = false,
): Promise<ClientWithStashData<TChannelFactory>> {
	const loadData: ClientLoadData =
		summarizerClient.stashData === undefined
			? createLoadData(summarizerClient, false)
			: createLoadDataFromStashData(summarizerClient, summarizerClient.stashData);
	return loadClientFromSummaries(
		containerRuntimeFactory,
		loadData,
		factory,
		clientId,
		options,
		supportStashing,
	);
}

function setupFuzzSerializer(
	channel: IChannel,
	dataStoreRuntime: MockFluidDataStoreRuntime,
): void {
	// TODO:AB#36300 tracks refactoring code to allow something like this without access violation.
	assert(
		isFluidSerializerLike(
			(channel as unknown as { _serializer: IFluidSerializer })._serializer,
		),
		"expected SharedObject to store its serializer at key '_serializer'.",
	);
	(channel as unknown as { _serializer: IFluidSerializer })._serializer =
		new DDSFuzzSerializer(dataStoreRuntime.channelsRoutingContext, dataStoreRuntime.id);
}

function isFluidSerializerLike(object: unknown): object is IFluidSerializer {
	return (
		typeof object === "object" &&
		object !== null &&
		"encode" in object &&
		"decode" in object &&
		"stringify" in object &&
		"parse" in object
	);
}

async function loadClientFromSummaries<TChannelFactory extends IChannelFactory>(
	containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection,
	loadData: ClientLoadData,
	factory: TChannelFactory,
	clientId: string,
	options: Omit<DDSFuzzSuiteOptions, "only" | "skip">,
	supportStashing: boolean = false,
): Promise<ClientWithStashData<TChannelFactory>> {
	const { summaries, minimumSequenceNumber } = loadData;
	const stashData = supportStashing ? structuredClone(loadData) : undefined;

	const dataStoreRuntime = new MockFluidDataStoreRuntime({
		clientId,
		idCompressor:
			options.idCompressorFactory === undefined || summaries.idCompressorSummary === undefined
				? undefined
				: options.idCompressorFactory(summaries.idCompressorSummary),
	});
	const containerRuntime = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime, {
		minimumSequenceNumber,
		trackRemoteOps: supportStashing,
	});
	const services: IChannelServices = {
		deltaConnection: dataStoreRuntime.createDeltaConnection(),
		objectStorage: MockStorage.createFromSummary(summaries.summary),
	};

	const channel = (await factory.load(
		dataStoreRuntime,
		clientId,
		services,
		factory.attributes,
	)) as ReturnType<TChannelFactory["create"]>;
	setupFuzzSerializer(channel, dataStoreRuntime);
	channel.connect(services);

	const newClient: ClientWithStashData<TChannelFactory> = {
		channel,
		containerRuntime,
		dataStoreRuntime,
		stashData,
	};

	options.emitter.emit("clientCreate", newClient);
	return newClient;
}

async function loadDetached<TChannelFactory extends IChannelFactory>(
	containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection,
	summarizerClient: ClientWithStashData<TChannelFactory>,
	factory: TChannelFactory,
	clientId: string,
	options: Omit<DDSFuzzSuiteOptions, "only" | "skip">,
): Promise<Client<TChannelFactory>> {
	// as in production, emulate immediate finalizing of IDs when attaching
	finalizeAllocatedIds(summarizerClient);

	const { summaries } =
		summarizerClient.stashData === undefined
			? createLoadData(summarizerClient, true)
			: createLoadDataFromStashData(summarizerClient, summarizerClient.stashData);

	const idCompressor = options.idCompressorFactory?.(summaries.idCompressorSummary);

	const dataStoreRuntime = new MockFluidDataStoreRuntime({
		clientId,
		idCompressor,
		attachState: AttachState.Detached,
	});
	const containerRuntime = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime);
	const services: IChannelServices = {
		deltaConnection: dataStoreRuntime.createDeltaConnection(),
		objectStorage: MockStorage.createFromSummary(summaries.summary),
	};

	const channel = (await factory.load(
		dataStoreRuntime,
		clientId,
		services,
		factory.attributes,
	)) as ReturnType<TChannelFactory["create"]>;

	if (summarizerClient.stashData) {
		await containerRuntime.initializeWithStashedOps(summarizerClient.containerRuntime);
	}

	const newClient: Client<TChannelFactory> = {
		channel,
		containerRuntime,
		dataStoreRuntime,
	};
	options.emitter.emit("clientCreate", newClient);
	return newClient;
}

function finalizeAllocatedIds(client: {
	dataStoreRuntime: { idCompressor?: IIdCompressorCore };
}): void {
	const compressor = client.dataStoreRuntime.idCompressor;
	if (compressor !== undefined) {
		const range = compressor.takeNextCreationRange();
		if (range.ids !== undefined) {
			compressor.finalizeCreationRange(range);
		}
	}
}

/**
 * Gets a friendly ID for a client based on its index in the client list.
 * This exists purely for easier debugging--reasoning about client "A" is easier than reasoning
 * about client "3e8a621a-7b35-414b-897f-8795962fb415".
 */
function makeFriendlyClientId(random: IRandom, index: number): string {
	return index < 26 ? String.fromCodePoint(index + 65) : random.uuid4();
}

/**
 * Runs the provided DDS fuzz model. All functionality is already assumed to be mixed in.
 * @privateRemarks This is currently file-exported for testing purposes, but it could be reasonable to
 * expose at the package level if we want to expose some of the harness's building blocks.
 */
export async function runTestForSeed<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation>,
	options: Omit<DDSFuzzSuiteOptions, "only" | "skip">,
	seed: number,
	saveInfo?: SaveInfo,
): Promise<DDSFuzzTestState<TChannelFactory>> {
	const random = makeRandom(seed);
	const containerRuntimeFactory = new MockContainerRuntimeFactoryForReconnection(
		options.containerRuntimeOptions,
	);

	const startDetached = options.detachedStartOptions.numOpsBeforeAttach !== 0;
	const initialClient = createDetachedClient(
		containerRuntimeFactory,
		model.factory,
		startDetached ? makeFriendlyClientId(random, 0) : "summarizer",
		options,
	);
	if (!startDetached) {
		finalizeAllocatedIds(initialClient);
		initialClient.dataStoreRuntime.setAttachState(AttachState.Attached);
		const services: IChannelServices = {
			deltaConnection: initialClient.dataStoreRuntime.createDeltaConnection(),
			objectStorage: new MockStorage(),
		};
		initialClient.channel.connect(services);
	}

	const clients = startDetached
		? [initialClient]
		: await Promise.all(
				Array.from({ length: options.numberOfClients }, async (_, i) =>
					loadClient(
						containerRuntimeFactory,
						initialClient,
						model.factory,
						makeFriendlyClientId(random, i),
						options,
						options.clientJoinOptions?.stashableClientProbability
							? random.bool(options.clientJoinOptions.stashableClientProbability)
							: false,
					),
				),
			);
	const summarizerClient = initialClient;
	const initialState: DDSFuzzTestState<TChannelFactory> = {
		clients,
		summarizerClient,
		containerRuntimeFactory,
		random: {
			...random,
			// This is injected by client selection logic, which allows binding the handle
			// to an appropriate client context.
			handle: makeUnreachableCodePathProxy("random.handle"),
		},
		client: makeUnreachableCodePathProxy("client"),
		isDetached: startDetached,
	};

	options.emitter.emit("testStart", initialState);

	const serializer = new DDSFuzzSerializer(
		initialState.summarizerClient.dataStoreRuntime,
		initialState.summarizerClient.dataStoreRuntime.id,
		false,
	);

	// This is unfortunately needed to pass to the Serializer, even though we don't do any handle binding.
	const dummyHandleBindSource = Object.assign(
		new DDSFuzzHandle("", initialState.summarizerClient.dataStoreRuntime),
		{ bind: () => {} },
	);
	assert(
		isISharedObjectHandle(dummyHandleBindSource),
		"PRECONDITION: must satisfy this for serializer",
	);

	let operationCount = 0;
	const generator = model.generatorFactory();
	const finalState = await performFuzzActionsAsync(
		// performFuzzActionsAsync expects generators to return JSON-serializable objects.
		// To make this work with handles that the DDS model may have generated, we use the FluidSerializer above
		// to encode here and decode in the reducer.
		async (state) => {
			const operation = await generator(state);
			return serializer.encode(operation, dummyHandleBindSource) as TOperation;
		},
		async (state, operation) => {
			const decodedHandles = serializer.decode(operation) as TOperation;
			options.emitter.emit("operation", decodedHandles);
			operationCount++;
			return model.reducer(state, decodedHandles);
		},
		initialState,
		saveInfo,
		options.forceGlobalSeed,
	);

	// Sanity-check that the generator produced at least one operation. If it failed to do so,
	// this usually indicates an error on the part of the test author.
	assert(operationCount > 0, "Generator should have produced at least one operation.");
	options.emitter.emit("testEnd", finalState);

	return finalState;
}

function runTest<TChannelFactory extends IChannelFactory, TOperation extends BaseOperation>(
	model: DDSFuzzHarnessModel<TChannelFactory, TOperation>,
	options: InternalOptions,
	seed: number,
	saveInfo: SaveInfo | undefined,
): void {
	const itFn = options.only.has(seed) ? it.only : options.skip.has(seed) ? it.skip : it;
	itFn(`workload: ${model.workloadName} seed: ${seed}`, async function () {
		const inCi = !!process.env.TF_BUILD;
		const shouldMinimize =
			!options.skipMinimization && saveInfo && saveInfo.saveOnFailure !== false && !inCi;

		// 10 seconds per test should be quite a bit more than is necessary, but
		// a timeout during minimization can cause bad UX because it obfuscates
		// the actual error
		//
		// it should be noted that if a timeout occurs during minimization, the
		// intermediate results are not lost and will still be written to the file.
		const noMinimizationTimeout = this.timeout() === 0 ? 0 : Math.max(2000, this.timeout());
		this.timeout(shouldMinimize ? 5 * noMinimizationTimeout : noMinimizationTimeout);

		try {
			// don't write to files in CI
			await runTestForSeed(model, options, seed, inCi ? undefined : saveInfo);
		} catch (error) {
			if (!shouldMinimize) {
				throw error;
			}
			const savePath: string = (saveInfo.saveOnFailure as SaveDestination).path;
			let file: Buffer;
			try {
				file = readFileSync(savePath);
			} catch {
				// File could not be read and likely does not exist.
				// Test may have failed outside of the fuzz test portion (on setup or teardown).
				// Throw original error that made test fail.
				throw error;
			}
			const operations = JSON.parse(file.toString()) as TOperation[];
			const minimizer = new FuzzTestMinimizer(
				model.minimizationTransforms,
				operations,
				saveInfo,
				async (generator) => replayTest(model, seed, generator, saveInfo, options),
				3,
			);

			const minimized = await minimizer.minimize();
			await saveOpsToFile(savePath, minimized);

			throw error;
		}
	});
}

interface InternalOnlyAndSkip {
	only: Set<number>;
	skip: Set<number>;
}

type InternalOptions = InternalOnlyAndSkip & Omit<DDSFuzzSuiteOptions, "only" | "skip">;

/**
 * Some reducers require preconditions be met which are validated by their generator.
 * The validation can be lost if the generator is not run.
 * The primary case where this happens is during minimization. If a reducer detects this
 * problem, they can throw this error type, and minimization will consider the current
 * test invalid, rather than continuing to test invalid scenarios.
 * @internal
 */
export class ReducerPreconditionError extends Error {}

export const normalizeSeedOption = (
	seeds: number | Iterable<number> | undefined,
): Iterable<number> => (typeof seeds === "number" ? [seeds] : (seeds ?? []));

/**
 * Performs the test again to verify if the DDS still fails with the same error message.
 *
 * @internal
 */
export async function replayTest<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
>(
	_model: DDSFuzzHarnessModel<TChannelFactory, TOperation>,
	seed: number,
	generator: AsyncGenerator<TOperation, unknown>,
	saveInfo?: SaveInfo,
	providedOptions?: Partial<DDSFuzzSuiteOptions>,
): Promise<void> {
	const options = {
		...defaultDDSFuzzSuiteOptions,
		...providedOptions,
		only: new Set(normalizeSeedOption(providedOptions?.only)),
		skip: new Set(normalizeSeedOption(providedOptions?.skip)),
	};

	const model = {
		..._model,
		// We lose some type safety here because the options interface isn't generic
		generatorFactory: (): AsyncGenerator<TOperation, unknown> => generator,
	};

	await runTestForSeed(model, options, seed, saveInfo);
}

export function convertOnlyAndSkip<TOptions extends DDSFuzzSuiteOptions>(
	options: TOptions,
): InternalOnlyAndSkip & Omit<TOptions, "only" | "skip"> {
	const only = new Set(normalizeSeedOption(options.only));
	const skip = new Set(normalizeSeedOption(options.skip));
	Object.assign(options, { only, skip });
	return options as unknown as InternalOnlyAndSkip & Omit<TOptions, "only" | "skip">;
}

export function createSuite<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
>(model: DDSFuzzHarnessModel<TChannelFactory, TOperation>, options: InternalOptions): void {
	const describeFuzz = createFuzzDescribe({ defaultTestCount: options.defaultTestCount });

	if (options.forceGlobalSeed !== undefined && options.skip.size === 0) {
		// if this error is getting in your way while debugging just comment it out, but re-add before you checkin
		throw new Error(
			"Yay. You fixed all the skipped tests. Remove forceGlobalSeed from the options as it is no longer needed, and removing it will lead to more consistent results going forward." +
				"Please also do a search on the repo for forceGlobalSeed, and if they have all been removed, please remove the option, and its related code!",
		);
	}

	describeFuzz(model.workloadName, ({ testCount, stressMode }) => {
		before(() => {
			if (options.saveFailures !== false) {
				mkdirSync(getSaveDirectory(options.saveFailures.directory, model), {
					recursive: true,
				});
			}
			if (options.saveSuccesses !== false) {
				mkdirSync(getSaveDirectory(options.saveSuccesses.directory, model), {
					recursive: true,
				});
			}
		});

		const seeds = generateTestSeeds(testCount, stressMode);
		for (const seed of seeds) {
			runTest(model, options, seed, getSaveInfo(model, options, seed));
		}

		if (options.replay !== undefined) {
			describe.only(`replay from file`, () => {
				for (const seed of normalizeSeedOption(options.replay)) {
					const saveInfo = getSaveInfo(model, options, seed);
					assert(
						saveInfo.saveOnFailure !== false,
						"Cannot replay a file without a directory to save files in!",
					);
					const operations = options.parseOperations(
						readFileSync(saveInfo.saveOnFailure.path).toString(),
					);

					const replayModel = {
						...model,
						// We lose some type safety here because the options interface isn't generic
						generatorFactory: (): AsyncGenerator<TOperation, unknown> =>
							asyncGeneratorFromArray(operations as TOperation[]),
					};
					runTest(replayModel, options, seed, undefined);
				}
			});
		}
	});
}

const getFullModel = <
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
>(
	ddsModel: DDSFuzzModel<TChannelFactory, TOperation>,
	options: DDSFuzzSuiteOptions,
): DDSFuzzHarnessModel<TChannelFactory, TOperation | HarnessOperation> =>
	mixinAttach(
		mixinSynchronization(
			mixinNewClient(
				mixinStashedClient(
					mixinClientSelection(
						mixinReconnect(mixinRebase(mixinRollback(ddsModel, options), options), options),
						options,
					),
					options,
				),
				options,
			),
			options,
		),
		options,
	);

/**
 * Creates a suite of eventual consistency tests for a particular DDS model.
 * @internal
 */
export function createDDSFuzzSuite<
	TChannelFactory extends IChannelFactory,
	TOperation extends BaseOperation,
>(
	ddsModel: DDSFuzzModel<TChannelFactory, TOperation>,
	providedOptions?: Partial<DDSFuzzSuiteOptions>,
): void {
	const options = convertOnlyAndSkip({ ...defaultDDSFuzzSuiteOptions, ...providedOptions });
	const model = getFullModel(ddsModel, options);
	createSuite(model, options);
}

/**
 * {@inheritDoc (createDDSFuzzSuite:function)}
 * @internal
 */
// Explicit usage of namespace needed for api-extractor.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace createDDSFuzzSuite {
	/**
	 * Runs only the provided seeds.
	 *
	 * @example
	 *
	 * ```typescript
	 * // Runs only seed 42 for the given model.
	 * createDDSFuzzSuite.only(42)(model);
	 * ```
	 * @internal
	 */
	export const only =
		(...seeds: number[]) =>
		<TChannelFactory extends IChannelFactory, TOperation extends BaseOperation>(
			ddsModel: DDSFuzzModel<TChannelFactory, TOperation>,
			providedOptions?: Partial<DDSFuzzSuiteOptions>,
		): void =>
			createDDSFuzzSuite(ddsModel, {
				...providedOptions,
				only: [...seeds, ...normalizeSeedOption(providedOptions?.only)],
			});

	/**
	 * Skips the provided seeds.
	 *
	 * @example
	 *
	 * ```typescript
	 * // Skips seed 42 for the given model.
	 * createDDSFuzzSuite.skip(42)(model);
	 * ```
	 * @internal
	 */
	export const skip =
		(...seeds: number[]) =>
		<TChannelFactory extends IChannelFactory, TOperation extends BaseOperation>(
			ddsModel: DDSFuzzModel<TChannelFactory, TOperation>,
			providedOptions?: Partial<DDSFuzzSuiteOptions>,
		): void =>
			createDDSFuzzSuite(ddsModel, {
				...providedOptions,
				skip: [...seeds, ...normalizeSeedOption(providedOptions?.skip)],
			});
}
