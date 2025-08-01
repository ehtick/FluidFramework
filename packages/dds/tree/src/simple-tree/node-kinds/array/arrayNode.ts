/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { Lazy, oob, fail } from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import { EmptyKey } from "../../../core/index.js";
import type {
	FlexibleFieldContent,
	FlexTreeNode,
	FlexTreeSequenceField,
} from "../../../feature-libraries/index.js";
import { FieldKinds, isTreeValue } from "../../../feature-libraries/index.js";
import {
	CompatibilityLevel,
	type WithType,
	// eslint-disable-next-line import/no-deprecated
	typeNameSymbol,
	NodeKind,
	type TreeNode,
	type InternalTreeNode,
	type TreeNodeSchema,
	typeSchemaSymbol,
	getOrCreateNodeFromInnerNode,
	getSimpleNodeSchemaFromInnerNode,
	getOrCreateInnerNode,
	type TreeNodeSchemaClass,
	getKernel,
	type UnhydratedFlexTreeNode,
	UnhydratedSequenceField,
	getOrCreateNodeFromInnerUnboxedNode,
	normalizeAllowedTypes,
	unannotateImplicitAllowedTypes,
	type ImplicitAllowedTypes,
	type ImplicitAnnotatedAllowedTypes,
	type InsertableTreeNodeFromImplicitAllowedTypes,
	type NodeSchemaMetadata,
	type TreeLeafValue,
	type TreeNodeFromImplicitAllowedTypes,
	type UnannotateImplicitAllowedTypes,
	TreeNodeValid,
	type MostDerivedData,
	type TreeNodeSchemaInitializedData,
	type TreeNodeSchemaCorePrivate,
	privateDataSymbol,
	createTreeNodeSchemaPrivateData,
	type FlexContent,
	type TreeNodeSchemaPrivateData,
} from "../../core/index.js";
import {
	type FactoryContent,
	type InsertableContent,
	unhydratedFlexTreeFromInsertable,
	unhydratedFlexTreeFromInsertableNode,
} from "../../unhydratedFlexTreeFromInsertable.js";
import { prepareArrayContentForInsertion } from "../../prepareForInsertion.js";
import {
	getTreeNodeSchemaInitializedData,
	getUnhydratedContext,
} from "../../createContext.js";
import type { System_Unsafe } from "../../api/index.js";
import type {
	ArrayNodeCustomizableSchema,
	ArrayNodePojoEmulationSchema,
	ArrayNodeSchema,
} from "./arrayNodeTypes.js";
import { brand, type JsonCompatibleReadOnlyObject } from "../../../util/index.js";
import { nullSchema } from "../../leafNodeSchema.js";

/**
 * A covariant base type for {@link (TreeArrayNode:interface)}.
 *
 * This provides the readonly subset of TreeArrayNode functionality, and is used as the source interface for moves since that needs to be covariant.
 * @privateRemarks
 * Ideally this would just include `TreeNode, WithType<string, NodeKind.Array>` in the extends list but https://github.com/microsoft/TypeScript/issues/16936 prevents that from compiling.
 * As a workaround around for this TypeScript limitation, the conflicting type intersection is wrapped in `Awaited` (which has no effect on the type in this case) which allows it to compile.
 * @system @sealed @public
 */
export interface ReadonlyArrayNode<out T = TreeNode | TreeLeafValue>
	extends ReadonlyArray<T>,
		Awaited<TreeNode & WithType<string, NodeKind.Array>> {}

/**
 * A {@link TreeNode} which implements 'readonly T[]' and the array mutation APIs.
 *
 * @typeParam TAllowedTypes - Schema for types which are allowed as members of this array.
 * @typeParam T - Use Default: Do not specify. Type of values to read from the array.
 * @typeParam TNew - Use Default: Do not specify. Type of values to write into the array.
 * @typeParam TMoveFrom - Use Default: Do not specify. Type of node from which children can be moved into this array.
 *
 * @sealed @public
 */
export interface TreeArrayNode<
	TAllowedTypes extends System_Unsafe.ImplicitAllowedTypesUnsafe = ImplicitAllowedTypes,
	out T = [TAllowedTypes] extends [ImplicitAllowedTypes]
		? TreeNodeFromImplicitAllowedTypes<TAllowedTypes>
		: TreeNodeFromImplicitAllowedTypes<ImplicitAllowedTypes>,
	in TNew = [TAllowedTypes] extends [ImplicitAllowedTypes]
		? InsertableTreeNodeFromImplicitAllowedTypes<TAllowedTypes>
		: InsertableTreeNodeFromImplicitAllowedTypes<ImplicitAllowedTypes>,
	in TMoveFrom = ReadonlyArrayNode,
> extends ReadonlyArrayNode<T> {
	/**
	 * Inserts new item(s) at a specified location.
	 * @param index - The index at which to insert `value`.
	 * @param value - The content to insert.
	 * @throws Throws if `index` is not in the range [0, `array.length`).
	 */
	insertAt(index: number, ...value: readonly (TNew | IterableTreeArrayContent<TNew>)[]): void;

	/**
	 * Inserts new item(s) at the start of the array.
	 * @param value - The content to insert.
	 */
	insertAtStart(...value: readonly (TNew | IterableTreeArrayContent<TNew>)[]): void;

	/**
	 * Inserts new item(s) at the end of the array.
	 * @param value - The content to insert.
	 */
	insertAtEnd(...value: readonly (TNew | IterableTreeArrayContent<TNew>)[]): void;

	/**
	 * Removes the item at the specified location.
	 * @param index - The index at which to remove the item.
	 * @throws Throws if `index` is not in the range [0, `array.length`).
	 */
	removeAt(index: number): void;

	/**
	 * Removes all items between the specified indices.
	 * @param start - The starting index of the range to remove (inclusive). Defaults to the start of the array.
	 * @param end - The ending index of the range to remove (exclusive). Defaults to `array.length`.
	 * @throws Throws if `start` is not in the range [0, `array.length`].
	 * @throws Throws if `end` is less than `start`.
	 * If `end` is not supplied or is greater than the length of the array, all items after `start` are removed.
	 *
	 * @remarks
	 * The default values for start and end are computed when this is called,
	 * and thus the behavior is the same as providing them explicitly, even with respect to merge resolution with concurrent edits.
	 * For example, two concurrent transactions both emptying the array with `node.removeRange()` then inserting an item,
	 * will merge to result in the array having both inserted items.
	 */
	removeRange(start?: number, end?: number): void;

	/**
	 * Moves the specified item to the start of the array.
	 * @param sourceIndex - The index of the item to move.
	 * @throws Throws if `sourceIndex` is not in the range [0, `array.length`).
	 */
	moveToStart(sourceIndex: number): void;

	/**
	 * Moves the specified item to the start of the array.
	 * @param sourceIndex - The index of the item to move.
	 * @param source - The source array to move the item out of.
	 * @throws Throws if `sourceIndex` is not in the range [0, `array.length`).
	 */
	moveToStart(sourceIndex: number, source: TMoveFrom): void;

	/**
	 * Moves the specified item to the end of the array.
	 * @param sourceIndex - The index of the item to move.
	 * @throws Throws if `sourceIndex` is not in the range [0, `array.length`).
	 */
	moveToEnd(sourceIndex: number): void;

	/**
	 * Moves the specified item to the end of the array.
	 * @param sourceIndex - The index of the item to move.
	 * @param source - The source array to move the item out of.
	 * @throws Throws if `sourceIndex` is not in the range [0, `array.length`).
	 */
	moveToEnd(sourceIndex: number, source: TMoveFrom): void;

	/**
	 * Moves the specified item to the desired location in the array.
	 *
	 * WARNING - This API is easily misused.
	 * Please read the documentation for the `destinationGap` parameter carefully.
	 *
	 * @param destinationGap - The location *between* existing items that the moved item should be moved to.
	 *
	 * WARNING - `destinationGap` describes a location between existing items *prior to applying the move operation*.
	 *
	 * For example, if the array contains items `[A, B, C]` before the move, the `destinationGap` must be one of the following:
	 *
	 * - `0` (between the start of the array and `A`'s original position)
	 *
	 * - `1` (between `A`'s original position and `B`'s original position)
	 *
	 * - `2` (between `B`'s original position and `C`'s original position)
	 *
	 * - `3` (between `C`'s original position and the end of the array)
	 *
	 * So moving `A` between `B` and `C` would require `destinationGap` to be `2`.
	 *
	 * This interpretation of `destinationGap` makes it easy to specify the desired destination relative to a sibling item that is not being moved,
	 * or relative to the start or end of the array:
	 *
	 * - Move to the start of the array: `array.moveToIndex(0, ...)` (see also `moveToStart`)
	 *
	 * - Move to before some item X: `array.moveToIndex(indexOfX, ...)`
	 *
	 * - Move to after some item X: `array.moveToIndex(indexOfX + 1`, ...)
	 *
	 * - Move to the end of the array: `array.moveToIndex(array.length, ...)` (see also `moveToEnd`)
	 *
	 * This interpretation of `destinationGap` does however make it less obvious how to move an item relative to its current position:
	 *
	 * - Move item B before its predecessor: `array.moveToIndex(indexOfB - 1, ...)`
	 *
	 * - Move item B after its successor: `array.moveToIndex(indexOfB + 2, ...)`
	 *
	 * Notice the asymmetry between `-1` and `+2` in the above examples.
	 * In such scenarios, it can often be easier to approach such edits by swapping adjacent items:
	 * If items A and B are adjacent, such that A precedes B,
	 * then they can be swapped with `array.moveToIndex(indexOfA, indexOfB)`.
	 *
	 * @param sourceIndex - The index of the item to move.
	 * @throws Throws if any of the input indices are not in the range [0, `array.length`).
	 */
	moveToIndex(destinationGap: number, sourceIndex: number): void;

	/**
	 * Moves the specified item to the desired location in the array.
	 *
	 * WARNING - This API is easily misused.
	 * Please read the documentation for the `destinationGap` parameter carefully.
	 *
	 * @param destinationGap - The location *between* existing items that the moved item should be moved to.
	 *
	 * WARNING - `destinationGap` describes a location between existing items *prior to applying the move operation*.
	 *
	 * For example, if the array contains items `[A, B, C]` before the move, the `destinationGap` must be one of the following:
	 *
	 * - `0` (between the start of the array and `A`'s original position)
	 *
	 * - `1` (between `A`'s original position and `B`'s original position)
	 *
	 * - `2` (between `B`'s original position and `C`'s original position)
	 *
	 * - `3` (between `C`'s original position and the end of the array)
	 *
	 * So moving `A` between `B` and `C` would require `destinationGap` to be `2`.
	 *
	 * This interpretation of `destinationGap` makes it easy to specify the desired destination relative to a sibling item that is not being moved,
	 * or relative to the start or end of the array:
	 *
	 * - Move to the start of the array: `array.moveToIndex(0, ...)` (see also `moveToStart`)
	 *
	 * - Move to before some item X: `array.moveToIndex(indexOfX, ...)`
	 *
	 * - Move to after some item X: `array.moveToIndex(indexOfX + 1`, ...)
	 *
	 * - Move to the end of the array: `array.moveToIndex(array.length, ...)` (see also `moveToEnd`)
	 *
	 * This interpretation of `destinationGap` does however make it less obvious how to move an item relative to its current position:
	 *
	 * - Move item B before its predecessor: `array.moveToIndex(indexOfB - 1, ...)`
	 *
	 * - Move item B after its successor: `array.moveToIndex(indexOfB + 2, ...)`
	 *
	 * Notice the asymmetry between `-1` and `+2` in the above examples.
	 * In such scenarios, it can often be easier to approach such edits by swapping adjacent items:
	 * If items A and B are adjacent, such that A precedes B,
	 * then they can be swapped with `array.moveToIndex(indexOfA, indexOfB)`.
	 *
	 * @param sourceIndex - The index of the item to move.
	 * @param source - The source array to move the item out of.
	 * @throws Throws if any of the source index is not in the range [0, `array.length`),
	 * or if the index is not in the range [0, `array.length`].
	 */
	moveToIndex(destinationGap: number, sourceIndex: number, source: TMoveFrom): void;

	/**
	 * Moves the specified items to the start of the array.
	 * @param sourceStart - The starting index of the range to move (inclusive).
	 * @param sourceEnd - The ending index of the range to move (exclusive)
	 * @throws Throws if either of the input indices are not in the range [0, `array.length`) or if `sourceStart` is greater than `sourceEnd`.
	 * if any of the input indices are not in the range [0, `array.length`], or if `sourceStart` is greater than `sourceEnd`.
	 */
	moveRangeToStart(sourceStart: number, sourceEnd: number): void;

	/**
	 * Moves the specified items to the start of the array.
	 * @param sourceStart - The starting index of the range to move (inclusive).
	 * @param sourceEnd - The ending index of the range to move (exclusive)
	 * @param source - The source array to move items out of.
	 * @throws Throws if the types of any of the items being moved are not allowed in the destination array,
	 * if either of the input indices are not in the range [0, `array.length`) or if `sourceStart` is greater than `sourceEnd`.
	 * if any of the input indices are not in the range [0, `array.length`], or if `sourceStart` is greater than `sourceEnd`.
	 */
	moveRangeToStart(sourceStart: number, sourceEnd: number, source: TMoveFrom): void;

	/**
	 * Moves the specified items to the end of the array.
	 * @param sourceStart - The starting index of the range to move (inclusive).
	 * @param sourceEnd - The ending index of the range to move (exclusive)
	 * @throws Throws if either of the input indices are not in the range [0, `array.length`) or if `sourceStart` is greater than `sourceEnd`.
	 * if any of the input indices are not in the range [0, `array.length`], or if `sourceStart` is greater than `sourceEnd`.
	 */
	moveRangeToEnd(sourceStart: number, sourceEnd: number): void;

	/**
	 * Moves the specified items to the end of the array.
	 * @param sourceStart - The starting index of the range to move (inclusive).
	 * @param sourceEnd - The ending index of the range to move (exclusive)
	 * @param source - The source array to move items out of.
	 * @throws Throws if the types of any of the items being moved are not allowed in the destination array,
	 * if either of the input indices are not in the range [0, `array.length`) or if `sourceStart` is greater than `sourceEnd`.
	 * if any of the input indices are not in the range [0, `array.length`], or if `sourceStart` is greater than `sourceEnd`.
	 */
	moveRangeToEnd(sourceStart: number, sourceEnd: number, source: TMoveFrom): void;

	/**
	 * Moves the specified items to the desired location within the array.
	 *
	 * WARNING - This API is easily misused.
	 * Please read the documentation for the `destinationGap` parameter carefully.
	 *
	 * @param destinationGap - The location *between* existing items that the moved item should be moved to.
	 *
	 * WARNING - `destinationGap` describes a location between existing items *prior to applying the move operation*.
	 *
	 * For example, if the array contains items `[A, B, C]` before the move, the `destinationGap` must be one of the following:
	 *
	 * - `0` (between the start of the array and `A`'s original position)
	 *
	 * - `1` (between `A`'s original position and `B`'s original position)
	 *
	 * - `2` (between `B`'s original position and `C`'s original position)
	 *
	 * - `3` (between `C`'s original position and the end of the array)
	 *
	 * So moving `A` between `B` and `C` would require `destinationGap` to be `2`.
	 *
	 * This interpretation of `destinationGap` makes it easy to specify the desired destination relative to a sibling item that is not being moved,
	 * or relative to the start or end of the array:
	 *
	 * - Move to the start of the array: `array.moveToIndex(0, ...)` (see also `moveToStart`)
	 *
	 * - Move to before some item X: `array.moveToIndex(indexOfX, ...)`
	 *
	 * - Move to after some item X: `array.moveToIndex(indexOfX + 1`, ...)
	 *
	 * - Move to the end of the array: `array.moveToIndex(array.length, ...)` (see also `moveToEnd`)
	 *
	 * This interpretation of `destinationGap` does however make it less obvious how to move an item relative to its current position:
	 *
	 * - Move item B before its predecessor: `array.moveToIndex(indexOfB - 1, ...)`
	 *
	 * - Move item B after its successor: `array.moveToIndex(indexOfB + 2, ...)`
	 *
	 * Notice the asymmetry between `-1` and `+2` in the above examples.
	 * In such scenarios, it can often be easier to approach such edits by swapping adjacent items:
	 * If items A and B are adjacent, such that A precedes B,
	 * then they can be swapped with `array.moveToIndex(indexOfA, indexOfB)`.
	 *
	 * @param sourceStart - The starting index of the range to move (inclusive).
	 * @param sourceEnd - The ending index of the range to move (exclusive)
	 * @throws Throws if any of the input indices are not in the range [0, `array.length`) or if `sourceStart` is greater than `sourceEnd`.
	 * if any of the input indices are not in the range [0, `array.length`], or if `sourceStart` is greater than `sourceEnd`.
	 */
	moveRangeToIndex(destinationGap: number, sourceStart: number, sourceEnd: number): void;

	/**
	 * Moves the specified items to the desired location within the array.
	 *
	 * WARNING - This API is easily misused.
	 * Please read the documentation for the `destinationGap` parameter carefully.
	 *
	 * @param destinationGap - The location *between* existing items that the moved item should be moved to.
	 *
	 * WARNING - `destinationGap` describes a location between existing items *prior to applying the move operation*.
	 *
	 * For example, if the array contains items `[A, B, C]` before the move, the `destinationGap` must be one of the following:
	 *
	 * - `0` (between the start of the array and `A`'s original position)
	 *
	 * - `1` (between `A`'s original position and `B`'s original position)
	 *
	 * - `2` (between `B`'s original position and `C`'s original position)
	 *
	 * - `3` (between `C`'s original position and the end of the array)
	 *
	 * So moving `A` between `B` and `C` would require `destinationGap` to be `2`.
	 *
	 * This interpretation of `destinationGap` makes it easy to specify the desired destination relative to a sibling item that is not being moved,
	 * or relative to the start or end of the array:
	 *
	 * - Move to the start of the array: `array.moveToIndex(0, ...)` (see also `moveToStart`)
	 *
	 * - Move to before some item X: `array.moveToIndex(indexOfX, ...)`
	 *
	 * - Move to after some item X: `array.moveToIndex(indexOfX + 1`, ...)
	 *
	 * - Move to the end of the array: `array.moveToIndex(array.length, ...)` (see also `moveToEnd`)
	 *
	 * This interpretation of `destinationGap` does however make it less obvious how to move an item relative to its current position:
	 *
	 * - Move item B before its predecessor: `array.moveToIndex(indexOfB - 1, ...)`
	 *
	 * - Move item B after its successor: `array.moveToIndex(indexOfB + 2, ...)`
	 *
	 * Notice the asymmetry between `-1` and `+2` in the above examples.
	 * In such scenarios, it can often be easier to approach such edits by swapping adjacent items:
	 * If items A and B are adjacent, such that A precedes B,
	 * then they can be swapped with `array.moveToIndex(indexOfA, indexOfB)`.
	 *
	 * @param sourceStart - The starting index of the range to move (inclusive).
	 * @param sourceEnd - The ending index of the range to move (exclusive)
	 * @param source - The source array to move items out of.
	 * @throws Throws if the types of any of the items being moved are not allowed in the destination array,
	 * if any of the input indices are not in the range [0, `array.length`], or if `sourceStart` is greater than `sourceEnd`.
	 */
	moveRangeToIndex(
		destinationGap: number,
		sourceStart: number,
		sourceEnd: number,
		source: TMoveFrom,
	): void;

	/**
	 * Returns a custom IterableIterator which throws usage errors if concurrent editing and iteration occurs.
	 */
	values(): IterableIterator<T>;
}

/**
 * A {@link TreeNode} which implements 'readonly T[]' and the array mutation APIs.
 * @public
 */
export const TreeArrayNode = {
	/**
	 * Wrap an iterable of items to inserted as consecutive items in a array.
	 * @remarks
	 * The object returned by this function can be inserted into a {@link (TreeArrayNode:interface)}.
	 * Its contents will be inserted consecutively in the corresponding location in the array.
	 * @example
	 * ```ts
	 * array.insertAtEnd(TreeArrayNode.spread(iterable))
	 * ```
	 */
	spread: <T>(content: Iterable<T>) => create(content),
} as const;

/**
 * Package internal construction API.
 * Use {@link (TreeArrayNode:variable).spread} to create an instance of this type instead.
 */
let create: <T>(content: Iterable<T>) => IterableTreeArrayContent<T>;

/**
 * Used to insert iterable content into a {@link (TreeArrayNode:interface)}.
 * Use {@link (TreeArrayNode:variable).spread} to create an instance of this type.
 * @sealed @public
 */
export class IterableTreeArrayContent<T> implements Iterable<T> {
	static {
		create = <T2>(content: Iterable<T2>) => new IterableTreeArrayContent(content);
	}

	private constructor(private readonly content: Iterable<T>) {}

	/**
	 * Iterates over content for nodes to insert.
	 */
	public [Symbol.iterator](): Iterator<T> {
		return this.content[Symbol.iterator]();
	}
}

/**
 * Given a array node proxy, returns its underlying LazySequence field.
 */
function getSequenceField(arrayNode: ReadonlyArrayNode): FlexTreeSequenceField {
	return getOrCreateInnerNode(arrayNode).getBoxed(EmptyKey) as FlexTreeSequenceField;
}

// For compatibility, we are initially implement 'readonly T[]' by applying the Array.prototype methods
// to the array node proxy.  Over time, we should replace these with efficient implementations on LazySequence
// to avoid re-entering the proxy as these methods access 'length' and the indexed properties.
//
// For brevity, the current implementation dynamically builds a property descriptor map from a list of
// Array functions we want to re-expose via the proxy.

const arrayPrototypeKeys = [
	"concat",
	"entries",
	"every",
	"filter",
	"find",
	"findIndex",
	"flat",
	"flatMap",
	"forEach",
	"includes",
	"indexOf",
	"join",
	"keys",
	"lastIndexOf",
	"map",
	"reduce",
	"reduceRight",
	"slice",
	"some",
	"toLocaleString",
	"toString",

	// "copyWithin",
	// "fill",
	// "length",
	// "pop",
	// "push",
	// "reverse",
	// "shift",
	// "sort",
	// "splice",
	// "unshift",
] as const;

/**
 * {@link TreeNodeValid}, but modified to add members from Array.prototype named in {@link arrayPrototypeKeys}.
 * @privateRemarks
 * Since a lot of scratch types and values are involved with creating this,
 * it's generating using an immediately invoked function expression (IIFE).
 * This is a common JavaScript pattern for cases like this to avoid cluttering the scope.
 */
const TreeNodeWithArrayFeatures = (() => {
	/**
	 * {@link TreeNodeValid}, but modified to add members from Array.prototype named in {@link arrayPrototypeKeys}.
	 */
	abstract class TreeNodeWithArrayFeaturesUntyped<
		const T extends ImplicitAllowedTypes,
	> extends TreeNodeValid<Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>> {}

	// Modify TreeNodeWithArrayFeaturesUntyped to add the members from Array.prototype
	arrayPrototypeKeys.forEach((key) => {
		Object.defineProperty(TreeNodeWithArrayFeaturesUntyped.prototype, key, {
			value: Array.prototype[key],
		});
	});

	return TreeNodeWithArrayFeaturesUntyped as unknown as typeof NodeWithArrayFeatures;
})();

/**
 * Type of {@link TreeNodeValid}, but with array members added to the instance type.
 *
 * TypeScript has a rule that `Base constructors must all have the same return type.ts(2510)`.
 * This means that intersecting two types with different constructors to create a type with a more constrained constructor (ex: more specific return type)
 * is not supported.
 *
 * TypeScript also has a limitation that there is no way to replace or remove just the constructor of a type without losing all the private and protected members.
 * See https://github.com/microsoft/TypeScript/issues/35416 for details.
 *
 * TypeScript also does not support explicitly specifying the instance type in a class definition as the constructor return type.
 *
 * Thus to replace the instance type, while preserving the protected static members of TreeNodeValid,
 * the only option seems to be actually declaring a class with all the members explicitly inline.
 *
 * To avoid incurring any bundle size / runtime overhead from this and having to stub out the function bodies,
 * the class uses `declare`.
 * TypeScript does not support `declare` inside scopes, so this is not inside the function scope above.
 *
 * The members of this class were generated using the "implement interface" refactoring.
 * Since that refactoring does not add `public`, the lint to require it is disabled for this section of the file.
 * To update this class delete all members and reapply the "implement interface" refactoring.
 * As these signatures get formatted to be over three times as many lines with prettier (which is not helpful), it is also suppressed.
 */
/* eslint-disable @typescript-eslint/explicit-member-accessibility, @typescript-eslint/no-explicit-any */
// prettier-ignore
declare abstract class NodeWithArrayFeatures<Input, T>
	extends TreeNodeValid<Input>
	implements Pick<readonly T[], (typeof arrayPrototypeKeys)[number]>
{
	concat(...items: ConcatArray<T>[]): T[];
	concat(...items: (T | ConcatArray<T>)[]): T[];
	entries(): IterableIterator<[number, T]>;
	every<S extends T>(
		predicate: (value: T, index: number, array: readonly T[]) => value is S,
		thisArg?: any,
	): this is readonly S[];
	every(
		predicate: (value: T, index: number, array: readonly T[]) => unknown,
		thisArg?: any,
	): boolean;
	filter<S extends T>(
		predicate: (value: T, index: number, array: readonly T[]) => value is S,
		thisArg?: any,
	): S[];
	filter(
		predicate: (value: T, index: number, array: readonly T[]) => unknown,
		thisArg?: any,
	): T[];
	find<S extends T>(
		predicate: (value: T, index: number, obj: readonly T[]) => value is S,
		thisArg?: any,
	): S | undefined;
	find(
		predicate: (value: T, index: number, obj: readonly T[]) => unknown,
		thisArg?: any,
	): T | undefined;
	findIndex(
		predicate: (value: T, index: number, obj: readonly T[]) => unknown,
		thisArg?: any,
	): number;
	flat<A, D extends number = 1>(this: A, depth?: D | undefined): FlatArray<A, D>[];
	flatMap<U, This = undefined>(
		callback: (this: This, value: T, index: number, array: T[]) => U | readonly U[],
		thisArg?: This | undefined,
	): U[];
	forEach(
		callbackfn: (value: T, index: number, array: readonly T[]) => void,
		thisArg?: any,
	): void;
	includes(searchElement: T, fromIndex?: number | undefined): boolean;
	indexOf(searchElement: T, fromIndex?: number | undefined): number;
	join(separator?: string | undefined): string;
	keys(): IterableIterator<number>;
	lastIndexOf(searchElement: T, fromIndex?: number | undefined): number;
	map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U, thisArg?: any): U[];
	reduce(
		callbackfn: (
			previousValue: T,
			currentValue: T,
			currentIndex: number,
			array: readonly T[],
		) => T,
	): T;
	reduce(
		callbackfn: (
			previousValue: T,
			currentValue: T,
			currentIndex: number,
			array: readonly T[],
		) => T,
		initialValue: T,
	): T;
	reduce<U>(
		callbackfn: (
			previousValue: U,
			currentValue: T,
			currentIndex: number,
			array: readonly T[],
		) => U,
		initialValue: U,
	): U;
	reduceRight(
		callbackfn: (
			previousValue: T,
			currentValue: T,
			currentIndex: number,
			array: readonly T[],
		) => T,
	): T;
	reduceRight(
		callbackfn: (
			previousValue: T,
			currentValue: T,
			currentIndex: number,
			array: readonly T[],
		) => T,
		initialValue: T,
	): T;
	reduceRight<U>(
		callbackfn: (
			previousValue: U,
			currentValue: T,
			currentIndex: number,
			array: readonly T[],
		) => U,
		initialValue: U,
	): U;
	slice(start?: number | undefined, end?: number | undefined): T[];
	some(
		predicate: (value: T, index: number, array: readonly T[]) => unknown,
		thisArg?: any,
	): boolean;
	toLocaleString(): string;
	toString(): string;
}
/* eslint-enable @typescript-eslint/explicit-member-accessibility, @typescript-eslint/no-explicit-any */

/**
 * Attempts to coerce the given property key to an integer index property.
 * @param key - The property key to coerce.
 * @param exclusiveMax - This restricts the range in which the resulting index is allowed to be.
 * The coerced index of `key` must be less than `exclusiveMax` or else this function will return `undefined`.
 * This is useful for reading an array within the bounds of its length, e.g. `asIndex(key, array.length)`.
 */
export function asIndex(key: string | symbol, exclusiveMax: number): number | undefined {
	if (typeof key !== "string") {
		return undefined;
	}

	// TODO: It may be worth a '0' <= ch <= '9' check before calling 'Number' to quickly
	// reject 'length' as an index, or even parsing integers ourselves.
	const asNumber = Number(key);
	if (!Number.isInteger(asNumber)) {
		return undefined;
	}

	// Check that the original string is the same after converting to a number and back again.
	// This prevents keys like "5.0", "0x5", " 5" from coercing to 5, and keys like " " or "" from coercing to 0.
	const asString = String(asNumber);
	if (asString !== key) {
		return undefined;
	}

	// TODO: See 'matrix/range.ts' for fast integer coercing + range check.
	return 0 <= asNumber && asNumber < exclusiveMax ? asNumber : undefined;
}

/**
 * Create a proxy which implements the {@link TreeArrayNode} API.
 * @param allowAdditionalProperties - If true, setting of unexpected properties will be forwarded to the target object.
 * Otherwise setting of unexpected properties will error.
 * @param proxyTarget - Target object of the proxy. Must provide an own `length` value property
 * (which is not used but must exist for getOwnPropertyDescriptor invariants) and the array functionality from {@link arrayNodePrototype}.
 * Controls the prototype exposed by the produced proxy.
 * @param dispatchTarget - provides the functionally of the node, implementing all fields.
 */
function createArrayNodeProxy(
	allowAdditionalProperties: boolean,
	proxyTarget: object,
	dispatchTarget: object,
): TreeArrayNode {
	// To satisfy 'deepEquals' level scrutiny, the target of the proxy must be an array literal in order
	// to pass 'Object.getPrototypeOf'.  It also satisfies 'Array.isArray' and 'Object.prototype.toString'
	// requirements without use of Array[Symbol.species], which is potentially on a path to deprecation.
	const proxy: TreeArrayNode = new Proxy<TreeArrayNode>(proxyTarget as TreeArrayNode, {
		get: (target, key, receiver) => {
			const field = getSequenceField(receiver);
			const maybeIndex = asIndex(key, field.length);

			if (maybeIndex === undefined) {
				if (key === "length") {
					return field.length;
				}

				// In NodeJS 22, assert.strict.deepEqual started special casing well known constructors like Array.
				// That made this necessary, ensuring that in POJO mode, TreeArrayNode are still deepEqual to arrays.
				if (key === "constructor") {
					return proxyTarget.constructor;
				}

				// Pass the proxy as the receiver here, so that any methods on
				// the prototype receive `proxy` as `this`.
				return Reflect.get(dispatchTarget, key, receiver) as unknown;
			}

			const maybeContent = field.at(maybeIndex);
			return maybeContent === undefined
				? undefined
				: getOrCreateNodeFromInnerUnboxedNode(maybeContent);
		},
		set: (target, key, newValue, receiver) => {
			if (key === "length") {
				// To allow "length" to look like "length" on an array, getOwnPropertyDescriptor has to report it as a writable value.
				// This means the proxy target must provide a length value, but since it can't use getters and setters, it can't be correct.
				// Therefor length has to be handled in this proxy.
				// Since it's not actually mutable, return false so setting it will produce a type error.
				return false;
			}

			// 'Symbol.isConcatSpreadable' may be set on an Array instance to modify the behavior of
			// the concat method.  We allow this property to be added to the dispatch object.
			if (key === Symbol.isConcatSpreadable) {
				return Reflect.set(dispatchTarget, key, newValue, receiver);
			}

			// Array nodes treat all non-negative integer indexes as array access.
			// Using Infinity here (rather than length) ensures that indexing past the end doesn't create additional session local properties.
			const maybeIndex = asIndex(key, Number.POSITIVE_INFINITY);
			if (maybeIndex !== undefined) {
				// For MVP, we otherwise disallow setting properties (mutation is only available via the array node mutation APIs).
				// To ensure a clear and actionable error experience, we will throw explicitly here, rather than just returning false.
				throw new UsageError(
					"Cannot set indexed properties on array nodes. Use array node mutation APIs to alter the array.",
				);
			}
			return allowAdditionalProperties ? Reflect.set(target, key, newValue, receiver) : false;
		},
		has: (target, key) => {
			const field = getSequenceField(proxy);
			const maybeIndex = asIndex(key, field.length);
			return maybeIndex !== undefined || Reflect.has(dispatchTarget, key);
		},
		ownKeys: (target) => {
			const field = getSequenceField(proxy);

			// TODO: Would a lazy iterator to produce the indexes work / be more efficient?
			// TODO: Need to surface 'Symbol.isConcatSpreadable' as an own key.
			const keys: (string | symbol)[] = Array.from(
				{ length: field.length },
				(_, index) => `${index}`,
			);

			if (allowAdditionalProperties) {
				keys.push(...Reflect.ownKeys(target));
			} else {
				keys.push("length");
			}
			return keys;
		},
		getOwnPropertyDescriptor: (target, key) => {
			const field = getSequenceField(proxy);
			const maybeIndex = asIndex(key, field.length);
			if (maybeIndex !== undefined) {
				const val = field.at(maybeIndex);
				// To satisfy 'deepEquals' level scrutiny, the property descriptor for indexed properties must
				// be a simple value property (as opposed to using getter) and declared writable/enumerable/configurable.
				return {
					value: val === undefined ? undefined : getOrCreateNodeFromInnerUnboxedNode(val),
					writable: true, // For MVP, setting indexed properties is reported as allowed here (for deep equals compatibility noted above), but not actually supported.
					enumerable: true,
					configurable: true,
				};
			} else if (key === "length") {
				// To satisfy 'deepEquals' level scrutiny, the property descriptor for 'length' must be a simple
				// value property (as opposed to using getter) and be declared writable / non-configurable.
				return {
					value: field.length,
					writable: true,
					enumerable: false,
					configurable: false,
				};
			}
			return Reflect.getOwnPropertyDescriptor(dispatchTarget, key);
		},
		defineProperty(target, key, attributes) {
			const maybeIndex = asIndex(key, Number.POSITIVE_INFINITY);
			if (maybeIndex !== undefined) {
				throw new UsageError("Shadowing of array indices is not permitted.");
			}
			return Reflect.defineProperty(dispatchTarget, key, attributes);
		},
	});
	return proxy;
}

type Insertable<T extends ImplicitAllowedTypes> = readonly (
	| InsertableTreeNodeFromImplicitAllowedTypes<T>
	| IterableTreeArrayContent<InsertableTreeNodeFromImplicitAllowedTypes<T>>
)[];

abstract class CustomArrayNodeBase<const T extends ImplicitAnnotatedAllowedTypes>
	extends TreeNodeWithArrayFeatures<
		Iterable<InsertableTreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>>>,
		TreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>>
	>
	implements TreeArrayNode<UnannotateImplicitAllowedTypes<T>>
{
	// Indexing must be provided by subclass.
	[k: number]: TreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>>;

	public static readonly kind = NodeKind.Array;

	protected abstract get simpleSchema(): T;
	protected abstract get allowedTypes(): ReadonlySet<TreeNodeSchema>;

	public abstract override get [typeSchemaSymbol](): TreeNodeSchemaClass<
		string,
		NodeKind.Array
	>;

	public constructor(
		input?:
			| Iterable<InsertableTreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>>>
			| InternalTreeNode,
	) {
		super(input ?? []);
	}

	#mapTreesFromFieldData(
		value: Insertable<UnannotateImplicitAllowedTypes<T>>,
	): FlexibleFieldContent {
		const sequenceField = getSequenceField(this);
		const content = value as readonly (
			| InsertableContent
			| IterableTreeArrayContent<InsertableContent>
		)[];

		const contentArray = content.flatMap((c): InsertableContent[] =>
			c instanceof IterableTreeArrayContent ? Array.from(c) : [c],
		);
		const mapTrees = prepareArrayContentForInsertion(
			contentArray,
			this.simpleSchema,
			sequenceField.context,
		);

		return mapTrees;
	}

	public toJSON(): unknown {
		// This override causes the class instance to `JSON.stringify` as `[a, b]` rather than `{0: a, 1: b}`.
		return Array.from(this as unknown as TreeArrayNode);
	}

	// Instances of this class are used as the dispatch object for the proxy,
	// and thus its set of keys is used to implement `has` (for the `in` operator) for the non-numeric cases.
	// Therefore it must include `length`,
	// even though this "length" is never invoked (due to being shadowed by the proxy provided own property).
	public get length(): number {
		return fail(0xadb /* Proxy should intercept length */);
	}

	public [Symbol.iterator](): IterableIterator<
		TreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>>
	> {
		return this.values();
	}

	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
	public get [Symbol.unscopables]() {
		// This might not be the exact right set of values, but it only matters for `with` clauses which are deprecated and are banned in strict mode, so it shouldn't matter much.
		// See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/with for details.
		return Array.prototype[Symbol.unscopables];
	}

	public at(
		this: TreeArrayNode<UnannotateImplicitAllowedTypes<T>>,
		index: number,
	): TreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>> | undefined {
		const field = getSequenceField(this);
		const val = field.boxedAt(index);

		if (val === undefined) {
			return val;
		}

		return getOrCreateNodeFromInnerNode(val) as TreeNodeFromImplicitAllowedTypes<
			UnannotateImplicitAllowedTypes<T>
		>;
	}
	public insertAt(
		index: number,
		...value: Insertable<UnannotateImplicitAllowedTypes<T>>
	): void {
		const field = getSequenceField(this);
		validateIndex(index, field, "insertAt", true);
		const content = this.#mapTreesFromFieldData(value);
		field.editor.insert(index, content);
	}
	public insertAtStart(...value: Insertable<UnannotateImplicitAllowedTypes<T>>): void {
		this.insertAt(0, ...value);
	}
	public insertAtEnd(...value: Insertable<UnannotateImplicitAllowedTypes<T>>): void {
		this.insertAt(this.length, ...value);
	}
	public removeAt(index: number): void {
		const field = getSequenceField(this);
		validateIndex(index, field, "removeAt");
		field.editor.remove(index, 1);
	}
	public removeRange(start?: number, end?: number): void {
		const field = getSequenceField(this);
		const { length } = field;
		const removeStart = start ?? 0;
		const removeEnd = Math.min(length, end ?? length);
		validatePositiveIndex(removeStart);
		validatePositiveIndex(removeEnd);
		if (removeEnd < removeStart) {
			// This catches both the case where start is > array.length and when start is > end.
			throw new UsageError('Too large of "start" value passed to TreeArrayNode.removeRange.');
		}
		field.editor.remove(removeStart, removeEnd - removeStart);
	}
	public moveToStart(sourceIndex: number, source?: ReadonlyArrayNode): void {
		const sourceArray = source ?? this;
		const sourceField = getSequenceField(sourceArray);
		validateIndex(sourceIndex, sourceField, "moveToStart");
		this.moveRangeToIndex(0, sourceIndex, sourceIndex + 1, source);
	}
	public moveToEnd(sourceIndex: number, source?: ReadonlyArrayNode): void {
		const sourceArray = source ?? this;
		const sourceField = getSequenceField(sourceArray);
		validateIndex(sourceIndex, sourceField, "moveToEnd");
		this.moveRangeToIndex(this.length, sourceIndex, sourceIndex + 1, source);
	}
	public moveToIndex(
		destinationGap: number,
		sourceIndex: number,
		source?: ReadonlyArrayNode,
	): void {
		const sourceArray = source ?? this;
		const sourceField = getSequenceField(sourceArray);
		const destinationField = getSequenceField(this);
		validateIndex(destinationGap, destinationField, "moveToIndex", true);
		validateIndex(sourceIndex, sourceField, "moveToIndex");
		this.moveRangeToIndex(destinationGap, sourceIndex, sourceIndex + 1, source);
	}
	public moveRangeToStart(
		sourceStart: number,
		sourceEnd: number,
		source?: ReadonlyArrayNode,
	): void {
		validateIndexRange(
			sourceStart,
			sourceEnd,
			source ?? getSequenceField(this),
			"moveRangeToStart",
		);
		this.moveRangeToIndex(0, sourceStart, sourceEnd, source);
	}
	public moveRangeToEnd(
		sourceStart: number,
		sourceEnd: number,
		source?: ReadonlyArrayNode,
	): void {
		validateIndexRange(
			sourceStart,
			sourceEnd,
			source ?? getSequenceField(this),
			"moveRangeToEnd",
		);
		this.moveRangeToIndex(this.length, sourceStart, sourceEnd, source);
	}
	public moveRangeToIndex(
		destinationGap: number,
		sourceStart: number,
		sourceEnd: number,
		source?: ReadonlyArrayNode,
	): void {
		const destinationField = getSequenceField(this);
		const destinationSchema = this.allowedTypes;
		const sourceField = source !== undefined ? getSequenceField(source) : destinationField;

		validateIndex(destinationGap, destinationField, "moveRangeToIndex", true);
		validateIndexRange(sourceStart, sourceEnd, source ?? destinationField, "moveRangeToIndex");

		// TODO: determine support for move across different sequence types
		if (sourceField !== destinationField) {
			for (let i = sourceStart; i < sourceEnd; i++) {
				const sourceNode = sourceField.boxedAt(i) ?? oob();
				const sourceSchema = getSimpleNodeSchemaFromInnerNode(sourceNode);
				if (!destinationSchema.has(sourceSchema)) {
					throw new UsageError("Type in source sequence is not allowed in destination.");
				}
			}
		}

		const movedCount = sourceEnd - sourceStart;
		if (!destinationField.context.isHydrated()) {
			if (!(sourceField instanceof UnhydratedSequenceField)) {
				throw new UsageError(
					"Cannot move elements from a hydrated array to an unhydrated array.",
				);
			}

			if (sourceField.context.isHydrated()) {
				throw new UsageError(
					"Cannot move elements from an unhydrated array to a hydrated array.",
				);
			}

			if (sourceField !== destinationField || destinationGap < sourceStart) {
				destinationField.editor.insert(
					destinationGap,
					sourceField.editor.remove(sourceStart, movedCount),
				);
			} else if (destinationGap > sourceStart + movedCount) {
				destinationField.editor.insert(
					destinationGap - movedCount,
					sourceField.editor.remove(sourceStart, movedCount),
				);
			}
		} else {
			if (!sourceField.context.isHydrated()) {
				throw new UsageError(
					"Cannot move elements from an unhydrated array to a hydrated array.",
				);
			}
			if (sourceField.context !== destinationField.context) {
				throw new UsageError("Cannot move elements between two different TreeViews.");
			}

			destinationField.context.checkout.editor.move(
				sourceField.getFieldPath(),
				sourceStart,
				movedCount,
				destinationField.getFieldPath(),
				destinationGap,
			);
		}
	}

	public values(): IterableIterator<
		TreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>>
	> {
		return this.generateValues(getKernel(this).generationNumber);
	}
	private *generateValues(
		initialLastUpdatedStamp: number,
	): Generator<TreeNodeFromImplicitAllowedTypes<UnannotateImplicitAllowedTypes<T>>> {
		const kernel = getKernel(this);
		if (initialLastUpdatedStamp !== kernel.generationNumber) {
			throw new UsageError(`Concurrent editing and iteration is not allowed.`);
		}
		for (let i = 0; i < this.length; i++) {
			yield this.at(i) ?? fail(0xadc /* Index is out of bounds */);
			if (initialLastUpdatedStamp !== kernel.generationNumber) {
				throw new UsageError(`Concurrent editing and iteration is not allowed.`);
			}
		}
	}
}

/**
 * Define a {@link TreeNodeSchema} for a {@link (TreeArrayNode:interface)}.
 *
 * @param name - Unique identifier for this schema including the factory's scope.
 * @param persistedMetadata - Optional persisted metadata for the object node schema.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function arraySchema<
	TName extends string,
	const T extends ImplicitAnnotatedAllowedTypes,
	const ImplicitlyConstructable extends boolean,
	const TCustomMetadata = unknown,
>(
	identifier: TName,
	info: T,
	implicitlyConstructable: ImplicitlyConstructable,
	customizable: boolean,
	metadata?: NodeSchemaMetadata<TCustomMetadata>,
	persistedMetadata?: JsonCompatibleReadOnlyObject | undefined,
) {
	type Output = ArrayNodeCustomizableSchema<
		TName,
		T,
		ImplicitlyConstructable,
		TCustomMetadata
	> &
		ArrayNodePojoEmulationSchema<TName, T, ImplicitlyConstructable, TCustomMetadata> &
		TreeNodeSchemaCorePrivate;

	const unannotatedTypes = unannotateImplicitAllowedTypes(info);

	const lazyChildTypes = new Lazy(() => normalizeAllowedTypes(unannotatedTypes));
	const lazyAllowedTypesIdentifiers = new Lazy(
		() => new Set([...lazyChildTypes.value].map((type) => type.identifier)),
	);

	let privateData: TreeNodeSchemaPrivateData | undefined;

	// This class returns a proxy from its constructor to handle numeric indexing.
	// Alternatively it could extend a normal class which gets tons of numeric properties added.
	class Schema extends CustomArrayNodeBase<T> {
		public static override prepareInstance<T2>(
			this: typeof TreeNodeValid<T2>,
			instance: TreeNodeValid<T2>,
			flexNode: FlexTreeNode,
		): TreeNodeValid<T2> {
			const proxyTarget = customizable ? instance : [];

			if (customizable) {
				// Since proxy reports this as a "non-configurable" property, it must exist on the underlying object used as the proxy target, not as an inherited property.
				// This should not get used as the proxy should intercept all use.
				Object.defineProperty(instance, "length", {
					value: Number.NaN,
					writable: true,
					enumerable: false,
					configurable: false,
				});
			}
			return createArrayNodeProxy(customizable, proxyTarget, instance) as unknown as Schema;
		}

		public static override buildRawNode<T2>(
			this: typeof TreeNodeValid<T2>,
			instance: TreeNodeValid<T2>,
			input: T2,
		): UnhydratedFlexTreeNode {
			return unhydratedFlexTreeFromInsertable(input as object, this as typeof Schema);
		}

		public static get allowedTypesIdentifiers(): ReadonlySet<string> {
			return lazyAllowedTypesIdentifiers.value;
		}

		protected static override constructorCached: MostDerivedData | undefined = undefined;

		protected static override oneTimeSetup(): TreeNodeSchemaInitializedData {
			// First run, do extra validation.
			// TODO: provide a way for TreeConfiguration to trigger this same validation to ensure it gets run early.
			// Scan for shadowing inherited members which won't work, but stop scan early to allow shadowing built in (which seems to work ok).
			{
				let prototype: object = this.prototype;
				// There isn't a clear cleaner way to author this loop.
				while (prototype !== Schema.prototype) {
					// Search prototype keys and check for positive integers. Throw if any are found.
					// Shadowing of index properties on array nodes is not supported.
					for (const key of Object.getOwnPropertyNames(prototype)) {
						const maybeIndex = asIndex(key, Number.POSITIVE_INFINITY);
						if (maybeIndex !== undefined) {
							throw new UsageError(
								`Schema ${identifier} defines an inherited index property "${key.toString()}" which shadows a possible array index. Shadowing of array indices is not permitted.`,
							);
						}
					}

					// Since this stops at the array node base schema, it should never see a null prototype, so this case is safe.
					// Additionally, if the prototype chain is ever messed up such that the array base schema is not in it,
					// the null that would show up here does at least ensure this code throws instead of hanging.
					prototype = Reflect.getPrototypeOf(prototype) as object;
				}
			}
			const schema = this as ArrayNodeSchema;

			return getTreeNodeSchemaInitializedData(this, {
				shallowCompatibilityTest: (data: FactoryContent): CompatibilityLevel =>
					shallowCompatibilityTest(data, schema),
				toFlexContent: (
					data: FactoryContent,
					allowedTypes: ReadonlySet<TreeNodeSchema>,
				): FlexContent => arrayToFlexContent(data, schema),
			});
		}

		public static readonly identifier = identifier;
		public static readonly info = info;
		public static readonly implicitlyConstructable: ImplicitlyConstructable =
			implicitlyConstructable;
		public static get childTypes(): ReadonlySet<TreeNodeSchema> {
			return lazyChildTypes.value;
		}
		public static readonly metadata: NodeSchemaMetadata<TCustomMetadata> = metadata ?? {};
		public static readonly persistedMetadata: JsonCompatibleReadOnlyObject | undefined =
			persistedMetadata;

		// eslint-disable-next-line import/no-deprecated
		public get [typeNameSymbol](): TName {
			return identifier;
		}
		public get [typeSchemaSymbol](): Output {
			return Schema.constructorCached?.constructor as unknown as Output;
		}

		protected get simpleSchema(): T {
			return info;
		}
		protected get allowedTypes(): ReadonlySet<TreeNodeSchema> {
			return lazyChildTypes.value;
		}

		public static get [privateDataSymbol](): TreeNodeSchemaPrivateData {
			return (privateData ??= createTreeNodeSchemaPrivateData(this, [info]));
		}
	}

	const output: Output = Schema;
	return output;
}

function validateSafeInteger(index: number): void {
	if (!Number.isSafeInteger(index)) {
		throw new UsageError(`Expected a safe integer, got ${index}.`);
	}
}

function validatePositiveIndex(index: number): void {
	validateSafeInteger(index);
	if (index < 0) {
		throw new UsageError(`Expected non-negative index, got ${index}.`);
	}
}

function validateIndex(
	index: number,
	array: { readonly length: number },
	methodName: string,
	allowOnePastEnd: boolean = false,
): void {
	validatePositiveIndex(index);
	if (allowOnePastEnd) {
		if (index > array.length) {
			throw new UsageError(
				`Index value passed to TreeArrayNode.${methodName} is out of bounds.`,
			);
		}
	} else {
		if (index >= array.length) {
			throw new UsageError(
				`Index value passed to TreeArrayNode.${methodName} is out of bounds.`,
			);
		}
	}
}

function validateIndexRange(
	startIndex: number,
	endIndex: number,
	array: { readonly length: number },
	methodName: string,
): void {
	validateIndex(startIndex, array, methodName, true);
	validateIndex(endIndex, array, methodName, true);
	if (startIndex > endIndex || array.length < endIndex) {
		throw new UsageError(
			`Index value passed to TreeArrayNode.${methodName} is out of bounds.`,
		);
	}
}

/**
 * Transforms data for a child of an array.
 * @param child - The tree data to be transformed.
 * @param allowedTypes - The set of types allowed by the parent context. Used to validate the input tree.
 */
function arrayChildToFlexTree(
	child: InsertableContent,
	allowedTypes: ReadonlySet<TreeNodeSchema>,
): UnhydratedFlexTreeNode {
	// We do not support undefined sequence entries.
	// If we encounter an undefined entry, use null instead if supported by the schema, otherwise throw.
	let childWithFallback = child;
	if (child === undefined) {
		if (allowedTypes.has(nullSchema)) {
			childWithFallback = null;
		} else {
			throw new TypeError(`Received unsupported array entry value: ${child}.`);
		}
	}
	return unhydratedFlexTreeFromInsertableNode(childWithFallback, allowedTypes);
}

/**
 * {@link TreeNodeSchemaInitializedData.toFlexContent} for Array nodes.
 *
 * @param data - The tree data to be transformed. Must be an iterable.
 * @param schema - The schema to comply with.
 */
function arrayToFlexContent(data: FactoryContent, schema: ArrayNodeSchema): FlexContent {
	if (!(typeof data === "object" && data !== null && Symbol.iterator in data)) {
		throw new UsageError(`Input data is incompatible with Array schema: ${data}`);
	}

	const allowedChildTypes = normalizeAllowedTypes(schema.info as ImplicitAllowedTypes);

	const mappedData = Array.from(data, (child) =>
		arrayChildToFlexTree(child, allowedChildTypes),
	);

	const context = getUnhydratedContext(schema).flexContext;

	// Array nodes have a single `EmptyKey` field:
	const fieldsEntries =
		mappedData.length === 0
			? []
			: ([
					[
						EmptyKey,
						new UnhydratedSequenceField(
							context,
							FieldKinds.sequence.identifier,
							EmptyKey,
							mappedData,
						),
					],
				] as const);

	return [
		{
			type: brand(schema.identifier),
		},
		new Map(fieldsEntries),
	];
}

/**
 * {@link TreeNodeSchemaInitializedData.shallowCompatibilityTest} for Array nodes.
 */
function shallowCompatibilityTest(
	data: FactoryContent,
	schema: ArrayNodeSchema,
): CompatibilityLevel {
	if (isTreeValue(data)) {
		return CompatibilityLevel.None;
	}

	if (data instanceof Map) {
		// Maps are iterable, so type checking does allow constructing an ArrayNode from a map if the ArrayNode's type is an array that includes the key and value types of the map.
		return CompatibilityLevel.Low;
	}

	if (Symbol.iterator in data) {
		return CompatibilityLevel.Normal;
	}

	return CompatibilityLevel.None;
}
