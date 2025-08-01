/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type {
	SchemaAndPolicy,
	IForestSubscription,
	UpPath,
	NodeIndex,
	FieldKey,
	DetachedField,
	TreeFieldStoredSchema,
} from "../core/index.js";
import {
	type FlexTreeContext,
	getSchemaAndPolicy,
	type FlexTreeHydratedContextMinimal,
	FieldKinds,
	type FlexibleFieldContent,
	type FlexibleNodeContent,
	throwOutOfSchema,
} from "../feature-libraries/index.js";
import { normalizeFieldSchema, type ImplicitAnnotatedFieldSchema } from "./fieldSchema.js";
import {
	type InsertableContent,
	unhydratedFlexTreeFromInsertable,
} from "./unhydratedFlexTreeFromInsertable.js";
import { UsageError } from "@fluidframework/telemetry-utils/internal";
import { brand } from "../util/index.js";
import {
	getKernel,
	type ImplicitAnnotatedAllowedTypes,
	type TreeNode,
	type UnhydratedFlexTreeNode,
} from "./core/index.js";
import { debugAssert, oob } from "@fluidframework/core-utils/internal";
import { isFieldInSchema } from "../feature-libraries/index.js";
import { convertField } from "./toStoredSchema.js";

/**
 * For now, schema validation for inserted content is always enabled.
 * @remarks
 * If this ends up being too much of a performance overhead, AND nothing depends on it (like staged allowed types likely will),
 * this could be changed.
 */
const validateSchema = true;

/**
 * Prepare content from a user for insertion into a tree.
 * @remarks
 * This validates and converts the input, and if necessary invokes {@link prepareContentForHydration}.
 *
 * The next edit made to `destinationContext`'s forest must be the creation of a detached field containing this content,
 * (Triggering {@link ForestEvents.afterRootFieldCreated}) otherwise hydration will break.
 */
export function prepareForInsertion<TIn extends InsertableContent | undefined>(
	data: TIn,
	schema: ImplicitAnnotatedFieldSchema,
	destinationContext: FlexTreeContext,
): TIn extends undefined ? undefined : FlexibleNodeContent {
	return prepareForInsertionContextless(
		data,
		schema,
		getSchemaAndPolicy(destinationContext),
		destinationContext.isHydrated() ? destinationContext : undefined,
	);
}

/**
 * {@link prepareForInsertion} but batched for array content.
 * @remarks
 * This is for inserting items into an array, not a inserting a {@link TreeArrayNode} (that would use {@link prepareForInsertion}).
 *
 * The next edits made to `destinationContext`'s forest must be the creation of a detached field.
 * One edit for each item in `data`, in order.
 *
 * @privateRemarks
 * This has to be done as a single operation for all items in data
 * (as opposed to mapping {@link prepareForInsertion} over the array)
 * due to how the eventing in prepareContentForHydration works.
 */
export function prepareArrayContentForInsertion(
	data: readonly InsertableContent[],
	schema: ImplicitAnnotatedAllowedTypes,
	destinationContext: FlexTreeContext,
): FlexibleFieldContent {
	const mapTrees: UnhydratedFlexTreeNode[] = data.map((item) =>
		unhydratedFlexTreeFromInsertable(item, schema),
	);

	const fieldSchema = convertField(normalizeFieldSchema(schema));

	validateAndPrepare(
		getSchemaAndPolicy(destinationContext),
		destinationContext.isHydrated() ? destinationContext : undefined,
		{
			kind: FieldKinds.sequence.identifier,
			types: fieldSchema.types,
			persistedMetadata: undefined,
		},
		mapTrees,
	);

	return mapTrees;
}

/**
 * Split out from {@link prepareForInsertion} as to allow use without a context.
 *
 * @param hydratedData - If specified, the `mapTrees` will be prepared for hydration into this context.
 * `undefined` when `mapTrees` are being inserted into an {@link Unhydrated} tree.
 *
 * @remarks
 * Adding this entry point is a workaround for initialize not currently having a context.
 */
export function prepareForInsertionContextless<TIn extends InsertableContent | undefined>(
	data: TIn,
	schema: ImplicitAnnotatedFieldSchema,
	schemaAndPolicy: SchemaAndPolicy,
	hydratedData: FlexTreeHydratedContextMinimal | undefined,
): TIn extends undefined ? undefined : FlexibleNodeContent {
	const mapTree = unhydratedFlexTreeFromInsertable(data, schema);

	const contentArray = mapTree === undefined ? [] : [mapTree];
	const fieldSchema = convertField(normalizeFieldSchema(schema));
	validateAndPrepare(schemaAndPolicy, hydratedData, fieldSchema, contentArray);

	return mapTree;
}

/**
 * If hydrating, do a final validation against the schema and prepare the content for hydration.
 *
 * @param hydratedData - If specified, the `mapTrees` will be prepared for hydration into this context.
 * `undefined` when `mapTrees` are being inserted into an {@link Unhydrated} tree.
 */
function validateAndPrepare(
	schemaAndPolicy: SchemaAndPolicy,
	hydratedData: FlexTreeHydratedContextMinimal | undefined,
	fieldSchema: TreeFieldStoredSchema,
	mapTrees: readonly UnhydratedFlexTreeNode[],
): void {
	if (hydratedData !== undefined) {
		// Run `prepareContentForHydration` before walking the tree in `isFieldInSchema`.
		// This ensures that when `isFieldInSchema` requests identifiers (or any other contextual defaults),
		// they were already creating used the more specific context we have access to from `hydratedData`.
		prepareContentForHydration(mapTrees, hydratedData.checkout.forest, hydratedData);
		if (validateSchema === true) {
			isFieldInSchema(mapTrees, fieldSchema, schemaAndPolicy, throwOutOfSchema);
		}
	}
}

/**
 * An {@link UpPath} that is just index zero in a {@link DetachedField} which can be modified at a later time.
 */
interface Root extends UpPath {
	readonly parent: undefined;
	parentField: DetachedField & FieldKey;
	readonly parentIndex: NodeIndex & 0;
}

/**
 * The path from the included node to the root of the content tree it was inserted as part of.
 */
interface RelativeNodePath {
	readonly path: UpPath;
	readonly node: TreeNode;
}

/**
 * {@link RelativeNodePath}s for every {@link TreeNode} in the content tree inserted as an atomic operation.
 */
interface LocatedNodesBatch {
	/**
	 * UpPath shared by all {@link RelativeNodePath}s in this batch corresponding to the root of the inserted content.
	 */
	readonly rootPath: Root;
	readonly paths: RelativeNodePath[];
}

/**
 * A dummy key value used in {@link LocatedNodesBatch.rootPath} which will be replaced with the actual detached field once it is known.
 */
const placeholderKey: DetachedField & FieldKey = brand("placeholder" as const);

/**
 * Records any {@link TreeNode}s in the given `content` tree and does the necessary bookkeeping to ensure they are synchronized with subsequent reads of the tree.
 * Additionally populates any {@link UnhydratedFlexTreeField.pendingDefault}s using the provided `context`.
 *
 * @remarks If the content tree contains has any associated {@link TreeNode}s, this function must be called just prior to inserting the content into the tree.
 * Specifically, no other content may be inserted into the tree between the invocation of this function and the insertion of `content`.
 * The insertion of `content` must occur or else this function will cause memory leaks.
 *
 * Exported for testing purposes: otherwise should not be used outside this module.
 * @param content - the content subsequence to be inserted, of which might deeply contain {@link TreeNode}s which need to be hydrated.
 * @param forest - the forest the content is being inserted into.
 */
export function prepareContentForHydration(
	content: readonly UnhydratedFlexTreeNode[],
	forest: IForestSubscription,
	context: FlexTreeHydratedContextMinimal,
): void {
	const batches: LocatedNodesBatch[] = [];
	for (const item of content) {
		const batch: LocatedNodesBatch = {
			rootPath: {
				parent: undefined,
				parentField: placeholderKey,
				parentIndex: 0,
			},
			paths: [],
		};
		batches.push(batch);
		walkMapTree(
			item,
			batch.rootPath,
			(p, node) => {
				batch.paths.push({ path: p, node });
			},
			context,
		);
	}

	scheduleHydration(batches, forest);
}

function walkMapTree(
	root: UnhydratedFlexTreeNode,
	path: UpPath,
	onVisitTreeNode: (path: UpPath, treeNode: TreeNode) => void,
	context: FlexTreeHydratedContextMinimal,
): void {
	if (root.parentField.parent.parent !== undefined) {
		throw new UsageError(
			"Attempted to insert a node which is already under a parent. If this is desired, remove the node from its parent before inserting it elsewhere.",
		);
	}

	type Next = [path: UpPath, tree: UnhydratedFlexTreeNode];
	const nexts: Next[] = [];
	for (let next: Next | undefined = [path, root]; next !== undefined; next = nexts.pop()) {
		const [p, node] = next;
		if (node !== undefined) {
			const treeNode = node.treeNode;
			if (treeNode !== undefined) {
				onVisitTreeNode(p, treeNode);
			}
		}

		for (const [key, field] of node.allFieldsLazy) {
			field.fillPendingDefaults(context);
			for (const [i, child] of field.children.entries()) {
				nexts.push([
					{
						parent: p,
						parentField: key,
						parentIndex: i,
					},
					child,
				]);
			}
		}
	}
}

/**
 * Register events which will hydrate batches of nodes when they are inserted.
 * The next edits to forest must be their insertions, in order, or data corruption can occur.
 * @param locatedNodes - the nodes to register with the forest.
 * Each index in this array expects its content to be added and produce its own `afterRootFieldCreated` event.
 * If array subsequence insertion is optimized to produce a single event, this will not work correctly as is, and will need to be modified to take in a single {@link LocatedNodesBatch}.
 */
function scheduleHydration(
	locatedNodes: readonly LocatedNodesBatch[],
	forest: IForestSubscription,
): void {
	// Only subscribe to the event if there is at least one TreeNode tree to hydrate - this is not the case when inserting an empty array [].
	if (locatedNodes.length > 0) {
		// Creating a new array emits one event per element in the array, so listen to the event once for each element
		let i = 0;
		const off = forest.events.on("afterRootFieldCreated", (fieldKey) => {
			// Indexing is safe here because of the length check above. This assumes the array has not been modified which should be the case.
			const batch = locatedNodes[i] ?? oob();
			debugAssert(() => batch.rootPath.parentField === placeholderKey);
			batch.rootPath.parentField = brand(fieldKey);
			for (const { path, node } of batch.paths) {
				getKernel(node).hydrate(forest.anchors, path);
			}
			if (++i === locatedNodes.length) {
				off();
			}
		});
	}
}
