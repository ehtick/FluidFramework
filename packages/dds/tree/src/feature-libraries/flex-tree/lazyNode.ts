/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, fail } from "@fluidframework/core-utils/internal";

import {
	type Anchor,
	type AnchorNode,
	CursorLocationType,
	type FieldKey,
	type FieldKindIdentifier,
	type ITreeSubscriptionCursor,
	type TreeNavigationResult,
	type TreeNodeSchemaIdentifier,
	type TreeNodeStoredSchema,
	type Value,
	inCursorField,
	mapCursorFields,
	rootFieldKey,
} from "../../core/index.js";
import { disposeSymbol } from "../../util/index.js";
import { FieldKinds } from "../default-schema/index.js";

import type { Context } from "./context.js";
import {
	FlexTreeEntityKind,
	type FlexTreeField,
	type HydratedFlexTreeNode,
	flexTreeMarker,
	flexTreeSlot,
} from "./flexTreeTypes.js";
import { LazyEntity } from "./lazyEntity.js";
import { makeField } from "./lazyField.js";

/**
 * Get or create a {@link HydratedFlexTreeNode} for the given context at node indicated by the cursor.
 * @remarks
 * This does not take ownership of this cursor: Node will fork it as needed.
 */
export function getOrCreateHydratedFlexTreeNode(
	context: Context,
	cursor: ITreeSubscriptionCursor,
): HydratedFlexTreeNode {
	const anchor = cursor.buildAnchor();
	const anchorNode =
		context.checkout.forest.anchors.locate(anchor) ??
		fail(0xb12 /* cursor should point to a node that is not the root of the AnchorSet */);
	const cached = anchorNode.slots.get(flexTreeSlot);
	if (cached !== undefined) {
		context.checkout.forest.anchors.forget(anchor);
		assert(cached.context === context, 0x782 /* contexts must match */);
		assert(cached instanceof LazyTreeNode, 0x92c /* Expected LazyTreeNode */);
		return cached;
	}
	return new LazyTreeNode(context, cursor.type, cursor, anchorNode, anchor);
}

function cleanupTree(anchor: AnchorNode): void {
	const cached =
		anchor.slots.get(flexTreeSlot) ?? fail(0xb13 /* tree should only be cleaned up once */);
	assert(cached instanceof LazyTreeNode, 0x92d /* Expected LazyTreeNode */);
	cached[disposeSymbol]();
}

/**
 * Lazy implementation of {@link FlexTreeNode}.
 */
export class LazyTreeNode extends LazyEntity<Anchor> implements HydratedFlexTreeNode {
	public get [flexTreeMarker](): FlexTreeEntityKind.Node {
		return FlexTreeEntityKind.Node;
	}

	// Using JS private here prevents it from showing up as a enumerable own property, or conflicting with struct fields.
	readonly #removeDeleteCallback: () => void;

	private readonly storedSchema: TreeNodeStoredSchema;

	public constructor(
		context: Context,
		public readonly type: TreeNodeSchemaIdentifier,
		cursor: ITreeSubscriptionCursor,
		public readonly anchorNode: AnchorNode,
		anchor: Anchor,
	) {
		super(context, cursor, anchor);
		this.storedSchema =
			context.schema.nodeSchema.get(this.type) ?? fail(0xb14 /* missing schema */);
		assert(cursor.mode === CursorLocationType.Nodes, 0x783 /* must be in nodes mode */);
		anchorNode.slots.set(flexTreeSlot, this);
		this.#removeDeleteCallback = anchorNode.events.on("afterDestroy", cleanupTree);
	}

	public isHydrated(): this is HydratedFlexTreeNode {
		return true;
	}

	protected override tryMoveCursorToAnchor(
		cursor: ITreeSubscriptionCursor,
	): TreeNavigationResult {
		return this.context.checkout.forest.tryMoveCursorToNode(this.anchor, cursor);
	}

	protected override forgetAnchor(): void {
		// This type unconditionally has an anchor, so `forgetAnchor` is always called and cleanup can be done here:
		// After this point this node will not be usable,
		// so remove it from the anchor incase a different context (or the same context later) uses this AnchorSet.
		this.anchorNode.slots.delete(flexTreeSlot);
		this.#removeDeleteCallback();
		this.context.checkout.forest.anchors.forget(this.anchor);
	}

	public get value(): Value {
		return this.cursor.value;
	}

	public readonly fields: Pick<Map<FieldKey, FlexTreeField>, typeof Symbol.iterator | "get"> =
		{
			get: (key: FieldKey): FlexTreeField | undefined => this.tryGetField(key),
			[Symbol.iterator]: (): IterableIterator<[FieldKey, FlexTreeField]> =>
				mapCursorFields(this.cursor, (cursor) => {
					const key: FieldKey = cursor.getFieldKey();
					const pair: [FieldKey, FlexTreeField] = [
						key,
						makeField(this.context, this.storedSchema.getFieldSchema(key).kind, cursor),
					];
					return pair;
				}).values(),
		};

	public tryGetField(fieldKey: FieldKey): FlexTreeField | undefined {
		const schema = this.storedSchema.getFieldSchema(fieldKey);
		return inCursorField(this.cursor, fieldKey, (cursor) => {
			if (cursor.getFieldLength() === 0) {
				return undefined;
			}
			return makeField(this.context, schema.kind, cursor);
		});
	}

	public getBoxed(key: FieldKey): FlexTreeField {
		const fieldSchema = this.storedSchema.getFieldSchema(key);
		return inCursorField(this.cursor, key, (cursor) => {
			return makeField(this.context, fieldSchema.kind, cursor);
		});
	}

	public [Symbol.iterator](): IterableIterator<FlexTreeField> {
		return mapCursorFields(this.cursor, (cursor) =>
			makeField(
				this.context,
				this.storedSchema.getFieldSchema(cursor.getFieldKey()).kind,
				cursor,
			),
		).values();
	}

	public get parentField(): { readonly parent: FlexTreeField; readonly index: number } {
		const cursor = this.cursor;
		const index = this.anchorNode.parentIndex;
		assert(cursor.fieldIndex === index, 0x786 /* mismatched indexes */);
		const key = this.anchorNode.parentField;

		cursor.exitNode();
		assert(key === cursor.getFieldKey(), 0x787 /* mismatched keys */);
		let fieldSchema: FieldKindIdentifier;

		// Check if the current node is in a detached sequence.
		if (this.anchorNode.parent === undefined) {
			// Parent field is a detached sequence, and thus needs special handling for its schema.
			// eslint-disable-next-line unicorn/prefer-ternary
			if (key === rootFieldKey) {
				fieldSchema = this.context.schema.rootFieldSchema.kind;
			} else {
				// All fields (in the flex tree API) have a schema.
				// Since currently there is no known schema for detached field other than the special default root:
				// give all other detached fields a schema of sequence of anything.
				// That schema is the only one that is safe since its the only field schema that allows any possible field content.
				//
				// TODO:
				// if any of the following are done this schema will need to be more specific:
				// 1. Editing APIs start exposing user created detached sequences.
				// 2. Remove (and its inverse) start working on subsequences or fields contents (like everything in a sequence or optional field) and not just single nodes.
				// 3. Possibly other unknown cases.
				// Additionally this approach makes it possible for a user to take a FlexTree node, get its parent, check its schema, down cast based on that, then edit that detached field (ex: removing the node in it).
				// This MIGHT work properly with existing merge resolution logic (it must keep client in sync and be unable to violate schema), but this either needs robust testing or to be explicitly banned (error before sending the op).
				// Issues like replacing a node in the a removed sequenced then undoing the remove could easily violate schema if not everything works exactly right!
				fieldSchema = FieldKinds.sequence.identifier;
			}
		} else {
			cursor.exitField();
			const parentType = cursor.type;
			cursor.enterField(key);
			const nodeSchema =
				this.context.schema.nodeSchema.get(parentType) ??
				fail(0xb15 /* requested schema that does not exist */);
			fieldSchema = nodeSchema.getFieldSchema(key).kind;
		}

		const proxifiedField = makeField(this.context, fieldSchema, cursor);
		cursor.enterNode(index);

		return { parent: proxifiedField, index };
	}

	public keys(): IterableIterator<FieldKey> {
		return mapCursorFields(this.cursor, (cursor) => cursor.getFieldKey()).values();
	}
}
