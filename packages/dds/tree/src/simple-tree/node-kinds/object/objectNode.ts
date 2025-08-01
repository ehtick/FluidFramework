/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert, Lazy, fail, debugAssert } from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";
import { isFluidHandle } from "@fluidframework/runtime-utils/internal";

import type { FieldKey } from "../../../core/index.js";
import {
	FieldKinds,
	isTreeValue,
	type FlexTreeField,
	type FlexTreeNode,
	type FlexTreeOptionalField,
	type FlexTreeRequiredField,
} from "../../../feature-libraries/index.js";
import type {
	RestrictiveStringRecord,
	FlattenKeys,
	JsonCompatibleReadOnlyObject,
} from "../../../util/index.js";
import { brand } from "../../../util/index.js";

import {
	CompatibilityLevel,
	type TreeNodeSchema,
	NodeKind,
	type WithType,
	// eslint-disable-next-line import/no-deprecated
	typeNameSymbol,
	typeSchemaSymbol,
	type InternalTreeNode,
	type TreeNode,
	type UnhydratedFlexTreeNode,
	getOrCreateInnerNode,
	type NodeSchemaMetadata,
	type ImplicitAllowedTypes,
	type ImplicitAnnotatedAllowedTypes,
	unannotateImplicitAllowedTypes,
	TreeNodeValid,
	type MostDerivedData,
	type TreeNodeSchemaInitializedData,
	privateDataSymbol,
	createTreeNodeSchemaPrivateData,
	type FlexContent,
	type UnhydratedFlexTreeField,
	createField,
	type TreeNodeSchemaCorePrivate,
	type TreeNodeSchemaPrivateData,
} from "../../core/index.js";
import {
	getTreeNodeSchemaInitializedData,
	getUnhydratedContext,
} from "../../createContext.js";
import { tryGetTreeNodeForField } from "../../getTreeNodeForField.js";
import type {
	ObjectNodeSchema,
	ObjectNodeSchemaInternalData,
	ObjectNodeSchemaPrivate,
	UnannotateSchemaRecord,
} from "./objectNodeTypes.js";
import { prepareForInsertion } from "../../prepareForInsertion.js";
import {
	type ImplicitFieldSchema,
	getStoredKey,
	getExplicitStoredKey,
	type TreeFieldFromImplicitField,
	type InsertableTreeFieldFromImplicitField,
	FieldSchema,
	FieldSchemaAlpha,
	normalizeFieldSchema,
	FieldKind,
	type ImplicitAnnotatedFieldSchema,
	type FieldProps,
	type ContextualFieldProvider,
	extractFieldProvider,
	isConstant,
} from "../../fieldSchema.js";
import type { SimpleObjectFieldSchema } from "../../simpleSchema.js";
import {
	unhydratedFlexTreeFromInsertable,
	unhydratedFlexTreeFromInsertableNode,
	type FactoryContent,
	type FactoryContentObject,
	type InsertableContent,
} from "../../unhydratedFlexTreeFromInsertable.js";
import { convertFieldKind } from "../../toStoredSchema.js";

/**
 * Generates the properties for an ObjectNode from its field schema object.
 * @remarks
 * Due to {@link https://github.com/microsoft/TypeScript/issues/43826}, we can't enable implicit construction of {@link TreeNode|TreeNodes} for setters.
 * Therefore code assigning to these fields must explicitly construct nodes using the schema's constructor or create method,
 * or using some other method like {@link (TreeAlpha:interface).create}.
 * @system @public
 */
export type ObjectFromSchemaRecord<T extends RestrictiveStringRecord<ImplicitFieldSchema>> =
	RestrictiveStringRecord<ImplicitFieldSchema> extends T
		? // eslint-disable-next-line @typescript-eslint/ban-types
			{}
		: {
				-readonly [Property in keyof T]: Property extends string
					? TreeFieldFromImplicitField<T[Property]>
					: unknown;
			};

/**
 * A {@link TreeNode} which models a JavaScript object.
 * @remarks
 * Object nodes consist of a type which specifies which {@link TreeNodeSchema} they use (see {@link TreeNodeApi.schema} and {@link SchemaFactory.object}),
 * and a collections of fields, each with a distinct `key` and its own {@link FieldSchema} defining what can be placed under that key.
 *
 * All fields on an object node are exposed as own properties with string keys.
 * Non-empty fields are enumerable and empty optional fields are non-enumerable own properties with the value `undefined`.
 * No other own `own` or `enumerable` properties are included on object nodes unless the user of the node manually adds custom session only state.
 * This allows a majority of general purpose JavaScript object processing operations (like `for...in`, `Reflect.ownKeys()` and `Object.entries()`) to enumerate all the children.
 *
 * The API for fields is defined by {@link ObjectFromSchemaRecord}.
 * @public
 */
export type TreeObjectNode<
	T extends RestrictiveStringRecord<ImplicitFieldSchema>,
	TypeName extends string = string,
> = TreeNode & ObjectFromSchemaRecord<T> & WithType<TypeName, NodeKind.Object, T>;

/**
 * Type utility for determining if an implicit field schema is known to have a default value.
 *
 * @remarks Yields `false` when unknown.
 *
 * @privateRemarks
 * TODO: Account for field schemas with default value providers.
 * For now, this only captures field kinds that we know always have defaults - optional fields and identifier fields.
 *
 * @system @public
 */
export type FieldHasDefault<T extends ImplicitFieldSchema> = [T] extends [
	FieldSchema<FieldKind.Optional | FieldKind.Identifier>,
]
	? true
	: false;

/**
 * Helper used to produce types for:
 *
 * 1. Insertable content which can be used to construct an object node.
 * In this case, only own properties are considered.
 * This reduces the risk of incorrectly interpreting data at the cost of occasionally requiring users to convert data into a compatible format.
 *
 * 2. Insertable content which is an unhydrated object node.
 *
 * 3. Union of 1 and 2.
 *
 * @see {@link Input}
 *
 * @privateRemarks
 * TODO: consider separating these cases into different types.
 *
 * Empty objects don't get "no excess property" checks in literals.
 * To prevent extraneous properties in literals for the fields of an empty object from compiling, the empty case is special cased to produce `Record<string, never>`.
 * More details at {@link https://mercury.com/blog/creating-an-emptyobject-type-in-typescript}.
 *
 * Additionally when T is exactly `RestrictiveStringRecord<ImplicitFieldSchema>` produce just `never` so that it is assignable to the insertable for any given object type.
 *
 * Separating `{}` from `RestrictiveStringRecord<ImplicitFieldSchema>` is a bit messy since both extend each-other despite them being very different types.
 * A third dummy type `{ arbitraryKey: "arbitraryValue" }` is used to resolve this.
 *
 * @system @public
 */
export type InsertableObjectFromSchemaRecord<
	T extends RestrictiveStringRecord<ImplicitFieldSchema>,
> = RestrictiveStringRecord<ImplicitFieldSchema> extends T
	? { arbitraryKey: "arbitraryValue" } extends T
		? // {} case
			Record<string, never>
		: // RestrictiveStringRecord<ImplicitFieldSchema> case
			never
	: FlattenKeys<
			{
				readonly [Property in keyof T]?: InsertableTreeFieldFromImplicitField<
					T[Property & string]
				>;
			} & {
				// Field does not have a known default, make it required:
				readonly [Property in keyof T as FieldHasDefault<T[Property & string]> extends false
					? Property
					: never]: InsertableTreeFieldFromImplicitField<T[Property & string]>;
			}
		>;

/**
 * Helper used to remove annotations from a schema record and produce insertable objects,
 *
 * @privateRemarks
 * This calls {@link InsertableObjectFromSchemaRecord} in order to produce the insertable objects.
 *
 * @system @alpha
 */
export type InsertableObjectFromAnnotatedSchemaRecord<
	T extends RestrictiveStringRecord<ImplicitAnnotatedFieldSchema>,
> = InsertableObjectFromSchemaRecord<UnannotateSchemaRecord<T>>;

/**
 * Maps from simple field keys ("property" keys) to information about the field.
 *
 * @remarks
 * A missing entry for a given property key indicates that no such field exists.
 * Keys with symbols are currently never used, but allowed to make lookups on non-field things
 * (returning undefined) easier.
 */
export type SimpleKeyMap = ReadonlyMap<
	string | symbol,
	{ storedKey: FieldKey; schema: FieldSchema }
>;

/**
 * Caches the mappings from property keys to stored keys for the provided object field schemas in {@link simpleKeyToFlexKeyCache}.
 */
function createFlexKeyMapping(
	fields: Record<string, ImplicitAnnotatedFieldSchema>,
): SimpleKeyMap {
	const keyMap: Map<string | symbol, { storedKey: FieldKey; schema: FieldSchema }> = new Map();
	for (const [propertyKey, fieldSchema] of Object.entries(fields)) {
		const schema = normalizeFieldSchema(fieldSchema);
		const storedKey = getStoredKey(propertyKey, schema);
		keyMap.set(propertyKey, { storedKey, schema });
	}

	return keyMap;
}

/**
 * Creates a proxy handler for the given schema.
 *
 * @param allowAdditionalProperties - If true, setting of unexpected properties will be forwarded to the target object.
 * Otherwise setting of unexpected properties will error.
 * TODO: consider implementing this using `Object.preventExtension` instead.
 * @param customTargetObject - Target object of the proxy.
 * If not provided `{}` is used for the target.
 */
function createProxyHandler(
	schema: ObjectNodeSchemaPrivate,
	allowAdditionalProperties: boolean,
): ProxyHandler<TreeNode> {
	// To satisfy 'deepEquals' level scrutiny, the target of the proxy must be an object with the same
	// prototype as an object literal '{}'.  This is because 'deepEquals' uses 'Object.getPrototypeOf'
	// as a way to quickly reject objects with different prototype chains.
	//
	// (Note that the prototype of an object literal appears as '[Object: null prototype] {}', not because
	// the prototype is null, but because the prototype object itself has a null prototype.)

	// TODO: Although the target is an object literal, it's still worthwhile to try experimenting with
	// a dispatch object to see if it improves performance.
	const handler: ProxyHandler<TreeNode> = {
		get(target, propertyKey, proxy): unknown {
			const fieldInfo = schema.flexKeyMap.get(propertyKey);
			if (fieldInfo !== undefined) {
				const flexNode = getOrCreateInnerNode(proxy);
				debugAssert(() => !flexNode.context.isDisposed() || "FlexTreeNode is disposed");
				const field = flexNode.tryGetField(fieldInfo.storedKey);
				if (field !== undefined) {
					return tryGetTreeNodeForField(field);
				}

				return undefined;
			}

			// POJO mode objects don't have TreeNode's built in members on their targets, so special case them:
			if (propertyKey === typeSchemaSymbol) {
				return schema;
			}
			// eslint-disable-next-line import/no-deprecated
			if (propertyKey === typeNameSymbol) {
				return schema.identifier;
			}

			// Pass the proxy as the receiver here, so that any methods on the prototype receive `proxy` as `this`.
			return Reflect.get(target, propertyKey, proxy);
		},
		set(target, propertyKey, value: InsertableContent | undefined, proxy) {
			const fieldInfo = schema.flexKeyMap.get(propertyKey);
			if (fieldInfo === undefined) {
				// Pass the proxy as the receiver here, so that setters on the prototype receive `proxy` as `this`.
				return allowAdditionalProperties
					? Reflect.set(target, propertyKey, value, proxy)
					: false;
			}

			setField(
				getOrCreateInnerNode(proxy).getBoxed(fieldInfo.storedKey),
				fieldInfo.schema,
				value,
			);
			return true;
		},
		deleteProperty(target, propertyKey): boolean {
			// TODO: supporting delete when it makes sense (custom local fields, and optional field) could be added as a feature in the future.
			throw new UsageError(
				`Object nodes do not support the delete operator. Optional fields can be assigned to undefined instead.`,
			);
		},
		has: (target, propertyKey) => {
			return (
				schema.flexKeyMap.has(propertyKey) ||
				(allowAdditionalProperties ? Reflect.has(target, propertyKey) : false)
			);
		},
		ownKeys: (target) => {
			return [
				...schema.flexKeyMap.keys(),
				...(allowAdditionalProperties ? Reflect.ownKeys(target) : []),
			];
		},
		getOwnPropertyDescriptor: (target, propertyKey) => {
			const fieldInfo = schema.flexKeyMap.get(propertyKey);

			if (fieldInfo === undefined) {
				return allowAdditionalProperties
					? Reflect.getOwnPropertyDescriptor(target, propertyKey)
					: undefined;
			}

			// For some reason, the getOwnPropertyDescriptor is not passed in the receiver, so use a weak map.
			// If a refactoring is done to associated flex tree data with the target not the proxy, this extra map could be removed,
			// and the design would be more compatible with proxyless nodes.
			const proxy = targetToProxy.get(target) ?? fail(0xadd /* missing proxy */);
			const field = getOrCreateInnerNode(proxy).tryGetField(fieldInfo.storedKey);

			const p: PropertyDescriptor = {
				value: field === undefined ? undefined : tryGetTreeNodeForField(field),
				writable: true,
				// Report empty fields as own properties so they shadow inherited properties (even when empty) to match TypeScript typing.
				// Make empty fields not enumerable so they get skipped when iterating over an object to better align with
				// JSON and deep equals with JSON compatible object (which can't have undefined fields).
				enumerable: field !== undefined,
				configurable: true, // Must be 'configurable' if property is absent from proxy target.
			};

			return p;
		},
	};
	return handler;
}

export function setField(
	field: FlexTreeField,
	simpleFieldSchema: FieldSchema,
	value: InsertableContent | undefined,
): void {
	const mapTree = prepareForInsertion(value, simpleFieldSchema, field.context);

	switch (field.schema) {
		case FieldKinds.required.identifier: {
			assert(mapTree !== undefined, 0xa04 /* Cannot set a required field to undefined */);
			const typedField = field as FlexTreeRequiredField;
			typedField.editor.set(mapTree);
			break;
		}
		case FieldKinds.optional.identifier: {
			const typedField = field as FlexTreeOptionalField;
			typedField.editor.set(mapTree, typedField.length === 0);
			break;
		}

		default:
			fail(0xade /* invalid FieldKind */);
	}
}

/**
 * {@link FieldSchemaAlpha} including {@link SimpleObjectFieldSchema}.
 */
export class ObjectFieldSchema<
		Kind extends FieldKind,
		Types extends ImplicitAllowedTypes,
		TCustomMetadata = unknown,
	>
	extends FieldSchemaAlpha<Kind, Types, TCustomMetadata>
	implements SimpleObjectFieldSchema
{
	public readonly storedKey: string;

	public constructor(
		kind: Kind,
		allowedTypes: Types,
		annotatedTypes: ImplicitAnnotatedAllowedTypes,
		props: FieldProps<TCustomMetadata> & { readonly key: string },
	) {
		super(kind, allowedTypes, annotatedTypes, props);
		this.storedKey = props.key;
	}
}

abstract class CustomObjectNodeBase<
	const T extends RestrictiveStringRecord<ImplicitFieldSchema>,
> extends TreeNodeValid<InsertableObjectFromSchemaRecord<T>> {
	public static readonly kind = NodeKind.Object;
}

/**
 * Define a {@link TreeNodeSchema} for a {@link TreeObjectNode}.
 *
 * @param name - Unique identifier for this schema within this factory's scope.
 * @param fields - Schema for fields of the object node's schema. Defines what children can be placed under each key.
 * @param persistedMetadata - Optional persisted metadata for the object node schema.
 */
export function objectSchema<
	TName extends string,
	const T extends RestrictiveStringRecord<ImplicitAnnotatedFieldSchema>,
	const ImplicitlyConstructable extends boolean,
	const TCustomMetadata = unknown,
>(
	identifier: TName,
	info: T,
	implicitlyConstructable: ImplicitlyConstructable,
	allowUnknownOptionalFields: boolean,
	metadata?: NodeSchemaMetadata<TCustomMetadata>,
	persistedMetadata?: JsonCompatibleReadOnlyObject | undefined,
): ObjectNodeSchema<TName, T, ImplicitlyConstructable, TCustomMetadata> &
	ObjectNodeSchemaInternalData &
	TreeNodeSchemaCorePrivate {
	// Field set can't be modified after this since derived data is stored in maps.
	Object.freeze(info);

	// Ensure no collisions between final set of property keys, and final set of stored keys (including those
	// implicitly derived from property keys)
	assertUniqueKeys(identifier, info);

	// Performance optimization: cache property key => stored key and schema.
	const flexKeyMap: SimpleKeyMap = createFlexKeyMapping(info);

	const identifierFieldKeys: FieldKey[] = [];
	for (const item of flexKeyMap.values()) {
		if (item.schema.kind === FieldKind.Identifier) {
			identifierFieldKeys.push(item.storedKey);
		}
	}

	const lazyChildTypes = new Lazy(
		() => new Set(Array.from(flexKeyMap.values(), (f) => [...f.schema.allowedTypeSet]).flat()),
	);

	let privateData: TreeNodeSchemaPrivateData | undefined;

	let handler: ProxyHandler<object>;
	let customizable: boolean;

	class CustomObjectNode extends CustomObjectNodeBase<UnannotateSchemaRecord<T>> {
		public static readonly fields: ReadonlyMap<
			string,
			FieldSchemaAlpha & SimpleObjectFieldSchema
		> = new Map(
			Array.from(flexKeyMap, ([key, value]) => [
				key as string,
				new ObjectFieldSchema(
					value.schema.kind,
					value.schema.allowedTypes,
					(value.schema as FieldSchemaAlpha).annotatedAllowedTypes,
					{
						...value.schema.props,
						key: getStoredKey(key as string, value.schema),
					},
				),
			]),
		);
		public static readonly flexKeyMap: SimpleKeyMap = flexKeyMap;
		public static readonly storedKeyToPropertyKey: ReadonlyMap<FieldKey, string> = new Map<
			FieldKey,
			string
		>(
			Array.from(flexKeyMap, ([key, value]): [FieldKey, string] => [
				value.storedKey,
				key as string,
			]),
		);
		public static readonly identifierFieldKeys: readonly FieldKey[] = identifierFieldKeys;
		public static readonly allowUnknownOptionalFields: boolean = allowUnknownOptionalFields;

		public static override prepareInstance<T2>(
			this: typeof TreeNodeValid<T2>,
			instance: TreeNodeValid<T2>,
			flexNode: FlexTreeNode,
		): TreeNodeValid<T2> {
			// Differentiate between the following cases:
			//
			// Case 1: Direct construction (POJO emulation)
			//
			//     const Foo = schemaFactory.object("Foo", {bar: schemaFactory.number});
			//
			//     assert.deepEqual(new Foo({ bar: 42 }), { bar: 42 },
			//		   "Prototype chain equivalent to POJO.");
			//
			// Case 2: Subclass construction (Customizable Object)
			//
			// 	   class Foo extends schemaFactory.object("Foo", {bar: schemaFactory.number}) {}
			//
			// 	   assert.notDeepEqual(new Foo({ bar: 42 }), { bar: 42 },
			// 	       "Subclass prototype chain differs from POJO.");
			//
			// In Case 1 (POJO emulation), the prototype chain match '{}' (proxyTarget = undefined)
			// In Case 2 (Customizable Object), the prototype chain include the user's subclass (proxyTarget = this)

			const proxyTarget = customizable ? instance : {};
			const proxy = new Proxy(proxyTarget, handler) as CustomObjectNode;
			targetToProxy.set(proxyTarget, proxy);
			return proxy;
		}

		public static override buildRawNode<T2>(
			this: typeof TreeNodeValid<T2>,
			instance: TreeNodeValid<T2>,
			input: T2,
		): UnhydratedFlexTreeNode {
			return unhydratedFlexTreeFromInsertable(input as object, this as Output);
		}

		protected static override constructorCached: MostDerivedData | undefined = undefined;

		protected static override oneTimeSetup(): TreeNodeSchemaInitializedData {
			// One time initialization that required knowing the most derived type (from this.constructor) and thus has to be lazy.
			customizable = (this as unknown) !== CustomObjectNode;
			const schema = this as unknown as ObjectNodeSchemaPrivate;
			handler = createProxyHandler(schema, customizable);

			// First run, do extra validation.
			// TODO: provide a way for TreeConfiguration to trigger this same validation to ensure it gets run early.
			// Scan for shadowing inherited members which won't work, but stop scan early to allow shadowing built in (which seems to work ok).
			{
				let prototype: object = this.prototype;
				// There isn't a clear cleaner way to author this loop.
				while (prototype !== CustomObjectNode.prototype) {
					for (const [key] of flexKeyMap) {
						if (
							// constructor is a special case, since one is built in on the derived type, and shadowing it works fine since we only use it before fields are applied.
							key !== "constructor" &&
							Reflect.getOwnPropertyDescriptor(prototype, key) !== undefined
						) {
							throw new UsageError(
								`Schema ${identifier} defines an inherited property "${key.toString()}" which shadows a field. Since fields are exposed as own properties, this shadowing will not work, and is an error.`,
							);
						}
					}
					// Since this stops at CustomObjectNode, it should never see a null prototype, so this case is safe.
					// Additionally, if the prototype chain is ever messed up such that CustomObjectNode is not in it,
					// the null that would show up here does at least ensure this code throws instead of hanging.
					prototype = Reflect.getPrototypeOf(prototype) as object;
				}
			}

			return getTreeNodeSchemaInitializedData(schema, {
				shallowCompatibilityTest: (data: FactoryContent): CompatibilityLevel =>
					shallowCompatibilityTest(data, schema),
				toFlexContent: (
					data: FactoryContent,
					allowedTypes: ReadonlySet<TreeNodeSchema>,
				): FlexContent => objectToFlexContent(data, schema),
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
			return CustomObjectNode.constructorCached?.constructor as unknown as Output;
		}

		public static get [privateDataSymbol](): TreeNodeSchemaPrivateData {
			return (privateData ??= createTreeNodeSchemaPrivateData(
				this,
				Array.from(
					flexKeyMap.values(),
					({ schema }) => normalizeFieldSchema(schema).annotatedAllowedTypes,
				),
			));
		}
	}
	type Output = typeof CustomObjectNode &
		(new (
			input: InsertableObjectFromAnnotatedSchemaRecord<T> | InternalTreeNode,
		) => TreeObjectNode<UnannotateSchemaRecord<T>, TName>);
	return CustomObjectNode as Output;
}

/**
 * Removes annotations from a schema record.
 */
export function unannotateSchemaRecord<
	Schema extends RestrictiveStringRecord<ImplicitAnnotatedFieldSchema>,
>(schemaRecord: Schema): UnannotateSchemaRecord<Schema> {
	return Object.fromEntries(
		Object.entries(schemaRecord).map(([key, schema]) => [
			key,
			schema instanceof FieldSchema ? schema : unannotateImplicitAllowedTypes(schema),
		]),
	) as UnannotateSchemaRecord<Schema>;
}

const targetToProxy: WeakMap<object, TreeNode> = new WeakMap();

/**
 * Ensures that the set of property keys in the schema is unique.
 * Also ensure that the final set of stored keys (including those implicitly derived from property keys) is unique.
 * @throws Throws a `UsageError` if either of the key uniqueness invariants is violated.
 */
function assertUniqueKeys<
	const Name extends number | string,
	const Fields extends RestrictiveStringRecord<ImplicitAnnotatedFieldSchema>,
>(schemaName: Name, fields: Fields): void {
	// Verify that there are no duplicates among the explicitly specified stored keys.
	const explicitStoredKeys = new Set<string>();
	for (const schema of Object.values(fields)) {
		const storedKey = getExplicitStoredKey(schema);
		if (storedKey === undefined) {
			continue;
		}
		if (explicitStoredKeys.has(storedKey)) {
			throw new UsageError(
				`Duplicate stored key "${storedKey}" in schema "${schemaName}". Stored keys must be unique within an object schema.`,
			);
		}
		explicitStoredKeys.add(storedKey);
	}

	// Verify that there are no duplicates among the derived
	// (including those implicitly derived from property keys) stored keys.
	const derivedStoredKeys = new Set<string>();
	for (const [propertyKey, schema] of Object.entries(fields)) {
		const storedKey = getStoredKey(propertyKey, schema);
		if (derivedStoredKeys.has(storedKey)) {
			throw new UsageError(
				`Stored key "${storedKey}" in schema "${schemaName}" conflicts with a property key of the same name, which is not overridden by a stored key. The final set of stored keys in an object schema must be unique.`,
			);
		}
		derivedStoredKeys.add(storedKey);
	}
}

/**
 * {@link TreeNodeSchemaInitializedData.toFlexContent} for Map nodes.
 *
 * Transforms data under an Object schema.
 * @param data - The tree data to be transformed. Must be a Record-like object.
 * @param schema - The schema to comply with.
 */
function objectToFlexContent(
	data: FactoryContent,
	schema: TreeNodeSchema & ObjectNodeSchemaInternalData,
): FlexContent {
	if (
		typeof data !== "object" ||
		data === null ||
		Symbol.iterator in data ||
		isFluidHandle(data)
	) {
		throw new UsageError(`Input data is incompatible with Object schema: ${data}`);
	}

	const fields = new Map<FieldKey, UnhydratedFlexTreeField>();
	const context = getUnhydratedContext(schema).flexContext;

	for (const [key, fieldInfo] of schema.flexKeyMap) {
		const value = getFieldProperty(data, key);

		let children: UnhydratedFlexTreeNode[] | ContextualFieldProvider;
		if (value === undefined) {
			const defaultProvider =
				fieldInfo.schema.props?.defaultProvider ??
				fail(0xbb1 /* missing field has no default provider */);
			const fieldProvider = extractFieldProvider(defaultProvider);
			children = isConstant(fieldProvider) ? fieldProvider() : fieldProvider;
		} else {
			children = [
				unhydratedFlexTreeFromInsertableNode(value, fieldInfo.schema.allowedTypeSet),
			];
		}

		const kind =
			convertFieldKind.get(fieldInfo.schema.kind) ?? fail(0xbb2 /* Invalid field kind */);
		fields.set(
			fieldInfo.storedKey,
			createField(context, kind.identifier, fieldInfo.storedKey, children),
		);
	}

	return [{ type: brand(schema.identifier) }, fields];
}

/**
 * {@link TreeNodeSchemaInitializedData.shallowCompatibilityTest} for Object nodes.
 */
function shallowCompatibilityTest(
	data: FactoryContent,
	schema: ObjectNodeSchema & ObjectNodeSchemaInternalData,
): CompatibilityLevel {
	if (isTreeValue(data)) {
		return CompatibilityLevel.None;
	}

	if (Symbol.iterator in data) {
		return CompatibilityLevel.None;
	}

	// TODO: Improve type inference by making this logic more thorough. Handle at least:
	// * Types which are strict subsets of other types in the same polymorphic union
	// * Types which have the same keys but different types for those keys in the polymorphic union
	// * Types which have the same required fields but different optional fields and enough of those optional fields are populated to disambiguate

	// TODO#7441: Consider allowing data to be inserted which has keys that are extraneous/unknown to the schema (those keys are ignored)

	// If the schema has a required key which is not present in the input object, reject it.
	for (const [fieldKey, fieldSchema] of schema.fields) {
		if (fieldSchema.requiresValue) {
			if (getFieldProperty(data, fieldKey) === undefined) {
				return CompatibilityLevel.None;
			}
		}
	}

	return CompatibilityLevel.Normal;
}

/**
 * Check {@link FactoryContentObject} for a property which could be store a field.
 *
 * @returns If the property exists, return its value. Otherwise, returns undefined.
 * @remarks
 * The currently policy is to only consider own properties.
 * See {@link InsertableObjectFromSchemaRecord} for where this policy is documented in the public API.
 *
 * Explicit undefined values are treated the same as missing properties to allow explicit use of undefined with defaulted identifiers.
 *
 * @privateRemarks
 * If we ever want to have an optional field which defaults to something other than undefined, this will need changes.
 * It would need to adjusting the handling of explicit undefined in contexts where undefined is allowed, and a default provider also exists.
 */
function getFieldProperty(
	data: FactoryContentObject,
	key: string | symbol,
): InsertableContent | undefined {
	// This policy only allows own properties.
	if (Object.hasOwnProperty.call(data, key)) {
		return (data as Record<string, InsertableContent>)[key as string];
	}
	return undefined;
}
