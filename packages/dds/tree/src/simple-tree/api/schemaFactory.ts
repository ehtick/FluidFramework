/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IFluidHandle } from "@fluidframework/core-interfaces";
import { assert, unreachableCase } from "@fluidframework/core-utils/internal";
import { isFluidHandle } from "@fluidframework/runtime-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import type { TreeValue } from "../../core/index.js";
// This import is required for intellisense in @link doc comments on mouseover in VSCode.
// eslint-disable-next-line unused-imports/no-unused-imports, @typescript-eslint/no-unused-vars
import type { TreeAlpha } from "../../shared-tree/index.js";
import {
	type JsonCompatibleReadOnlyObject,
	type RestrictiveStringRecord,
	compareSets,
	getOrCreate,
	isReadonlyArray,
} from "../../util/index.js";
import { normalizeAllowedTypes, markSchemaMostDerived, isLazy } from "../core/index.js";
import type {
	NodeKind,
	WithType,
	TreeNodeSchema,
	TreeNodeSchemaClass,
	TreeNodeSchemaNonClass,
	TreeNodeSchemaBoth,
	UnhydratedFlexTreeNode,
	NodeSchemaMetadata,
	ImplicitAnnotatedAllowedTypes,
	UnannotateImplicitAllowedTypes,
	ImplicitAllowedTypes,
	InsertableTreeNodeFromImplicitAllowedTypes,
} from "../core/index.js";
import {
	booleanSchema,
	handleSchema,
	nullSchema,
	numberSchema,
	stringSchema,
	type LeafSchema,
} from "../leafNodeSchema.js";
import {
	arraySchema,
	type MapNodeInsertableData,
	mapSchema,
	objectSchema,
	type TreeArrayNode,
	type InsertableObjectFromSchemaRecord,
	type TreeMapNode,
	type TreeObjectNode,
	type UnannotateSchemaRecord,
} from "../node-kinds/index.js";
import {
	FieldKind,
	type FieldSchema,
	type ImplicitFieldSchema,
	type FieldProps,
	createFieldSchema,
	type DefaultProvider,
	getDefaultProvider,
	type FieldSchemaAlpha,
	type FieldPropsAlpha,
} from "../fieldSchema.js";

import { createFieldSchemaUnsafe } from "./schemaFactoryRecursive.js";
import type { System_Unsafe, FieldSchemaAlphaUnsafe } from "./typesUnsafe.js";
import type { IIdCompressor } from "@fluidframework/id-compressor";
import { createIdCompressor } from "@fluidframework/id-compressor/internal";
import type { FlexTreeHydratedContextMinimal } from "../../feature-libraries/index.js";
import { unhydratedFlexTreeFromInsertable } from "../unhydratedFlexTreeFromInsertable.js";

/**
 * Gets the leaf domain schema compatible with a given {@link TreeValue}.
 */
export function schemaFromValue(value: TreeValue): TreeNodeSchema {
	switch (typeof value) {
		case "boolean":
			return booleanSchema;
		case "number":
			return numberSchema;
		case "string":
			return stringSchema;
		case "object": {
			if (value === null) {
				return nullSchema;
			}
			assert(isFluidHandle(value), 0x87e /* invalid TreeValue */);
			return handleSchema;
		}
		default:
			unreachableCase(value);
	}
}

/**
 * Options when declaring an {@link SchemaFactory.object|object node}'s schema
 *
 * @alpha
 */
export interface SchemaFactoryObjectOptions<TCustomMetadata = unknown>
	extends NodeSchemaOptionsAlpha<TCustomMetadata> {
	/**
	 * Allow nodes typed with this object node schema to contain optional fields that are not present in the schema declaration.
	 * Such nodes can come into existence either via import APIs (see remarks) or by way of collaboration with another client
	 * that has upgraded the document's schema to include those optional fields.
	 *
	 * @defaultValue `false`
	 * @remarks
	 * The advantage of enabling this option is that it allows an application ecosystem with staged rollout to more quickly
	 * upgrade documents to include schema for new optional features.
	 *
	 * However, it does come with trade-offs that applications should weigh carefully when it comes to interactions between
	 * code and documents.
	 * When opening such documents, the API presented is still determined by the view schema.
	 * This can have implications on the behavior of edits or code which uses portions of the view schema,
	 * since this may inadvertently drop data which is present in those optional fields in the document schema.
	 *
	 * Consider the following example:
	 *
	 * ```typescript
	 * const sf = new SchemaFactory("com.example");
	 * class PersonView extends sf.object("Person", { name: sf.string }, { allowUnknownOptionalFields: true }) {}
	 * class PersonStored extends sf.object("Person", { name: sf.string, nickname: sf.optional(sf.string) }) {}
	 *
	 * // Say we have a document which uses `PersonStored` in its schema, and application code constructs
	 * // a tree view using `PersonView`. If the application for some reason had implemented a function like this:
	 * function clonePerson(a: PersonView): PersonView {
	 * 	return new PersonView({ name: a.name });
	 * }
	 * // ...or even like this:
	 * function clonePerson(a: PersonView): PersonView {
	 *  return new PersonView({ ...a})
	 * }
	 * // Then the alleged clone wouldn't actually clone the entire person in either case, it would drop the nickname.
	 * ```
	 *
	 * The existing import and export APIs have similar problems.
	 * For example currently the {@link (TreeAlpha:interface).exportVerbose|exportVerbose} API with stored keys preserves unknown optional fields,
	 * but {@link Unhydrated} nodes produced by {@link TreeNode} constructors, insertable content, and {@link (TreeAlpha:interface).importVerbose|importVerbose} do not.
	 * {@link (TreeBeta:interface).clone} however can be used to clone a node preserving unknown optional fields.
	 *
	 * Note that public API methods which operate on entire nodes (such as `moveTo`, `moveToEnd`, etc. on arrays) do not encounter
	 * this problem as SharedTree's implementation stores the entire node in its lower layers.
	 * It's only when application code reaches into a node
	 * (either by accessing its fields, spreading it, or some other means) that this problem arises.
	 */
	allowUnknownOptionalFields?: boolean;
}

/**
 * Default options for Object node schema creation.
 * @remarks Omits parameters that are not relevant for common use cases.
 */
export const defaultSchemaFactoryObjectOptions: Required<
	Omit<SchemaFactoryObjectOptions, "metadata" | "persistedMetadata">
> = {
	allowUnknownOptionalFields: false,
};

/**
 * The name of a schema produced by {@link SchemaFactory}, including its optional scope prefix.
 *
 * @system @public
 */
export type ScopedSchemaName<
	TScope extends string | undefined,
	TName extends number | string,
> = TScope extends undefined ? `${TName}` : `${TScope}.${TName}`;
// > = `${TScope extends undefined ? "" : `${TScope}.`}${TName}`;

/**
 * Stateless APIs exposed via {@link SchemaFactory} as both instance properties and as statics.
 * @privateRemarks
 * We have no way to make linkable members which exist both as statics and instance properties since API-Extractor does not support this.
 * As a workaround, we have this type as a third place which can be linked.
 * @system @sealed @public
 */
export interface SchemaStatics {
	/**
	 * {@link TreeNodeSchema} for holding a JavaScript `string`.
	 *
	 * @remarks
	 * Strings containing unpaired UTF-16 surrogate pair code units may not be handled correctly.
	 *
	 * These limitations come from the use of UTF-8 encoding of the strings, which requires them to be valid unicode.
	 * JavaScript does not make this requirement for its strings so not all possible JavaScript strings are supported.
	 * @privateRemarks
	 * TODO:
	 * We should be much more clear about what happens if you use problematic values.
	 * We should validate and/or normalize them when inserting content.
	 */
	readonly string: LeafSchema<"string", string>;

	/**
	 * {@link TreeNodeSchema} for holding a JavaScript `number`.
	 *
	 * @remarks
	 * The number is a {@link https://en.wikipedia.org/wiki/Double-precision_floating-point_format | double-precision 64-bit binary format IEEE 754} value, however there are some exceptions:
	 *
	 * - `NaN`, and the infinities are converted to `null` (and may therefore only be used where `null` is allowed by the schema).
	 *
	 * - `-0` may be converted to `0` in some cases.
	 *
	 * These limitations match the limitations of JSON.
	 * @privateRemarks
	 * TODO:
	 * We should be much more clear about what happens if you use problematic values.
	 * We should validate and/or normalize them when inserting content.
	 */
	readonly number: LeafSchema<"number", number>;

	/**
	 * {@link TreeNodeSchema} for holding a boolean.
	 */
	readonly boolean: LeafSchema<"boolean", boolean>;

	/**
	 * {@link TreeNodeSchema} for JavaScript `null`.
	 *
	 * @remarks
	 * There are good {@link https://www.npmjs.com/package/%40rushstack/eslint-plugin#rushstackno-new-null | reasons to avoid using null} in JavaScript, however sometimes it is desired.
	 * This {@link TreeNodeSchema} node provides the option to include nulls in trees when desired.
	 * Unless directly inter-operating with existing data using null, consider other approaches, like wrapping the value in an optional field, or using a more specifically named empty object node.
	 */
	// eslint-disable-next-line @rushstack/no-new-null
	readonly null: LeafSchema<"null", null>;

	/**
	 * {@link TreeNodeSchema} for holding an {@link @fluidframework/core-interfaces#(IFluidHandle:interface)}.
	 */
	readonly handle: LeafSchema<"handle", IFluidHandle>;

	/**
	 * {@link AllowedTypes} for holding any of the leaf types.
	 */
	readonly leaves: readonly [
		SchemaStatics["string"],
		SchemaStatics["number"],
		SchemaStatics["boolean"],
		SchemaStatics["null"],
		SchemaStatics["handle"],
	];

	/**
	 * Make a field optional instead of the default, which is required.
	 *
	 * @param t - The types allowed under the field.
	 * @param props - Optional properties to associate with the field.
	 *
	 * @typeParam TCustomMetadata - Custom metadata properties to associate with the field.
	 * See {@link FieldSchemaMetadata.custom}.
	 */
	readonly optional: <const T extends ImplicitAllowedTypes, const TCustomMetadata = unknown>(
		t: T,
		props?: Omit<FieldProps<TCustomMetadata>, "defaultProvider">,
	) => FieldSchema<FieldKind.Optional, T, TCustomMetadata>;

	/**
	 * Make a field explicitly required.
	 *
	 * @param t - The types allowed under the field.
	 * @param props - Optional properties to associate with the field.
	 *
	 * @remarks
	 * Fields are required by default, but this API can be used to make the required nature explicit in the schema,
	 * and allows associating custom {@link FieldProps | properties} with the field.
	 *
	 * @typeParam TCustomMetadata - Custom metadata properties to associate with the field.
	 * See {@link FieldSchemaMetadata.custom}.
	 */
	readonly required: <const T extends ImplicitAllowedTypes, const TCustomMetadata = unknown>(
		t: T,
		props?: Omit<FieldProps<TCustomMetadata>, "defaultProvider">,
	) => FieldSchema<FieldKind.Required, T, TCustomMetadata>;

	/**
	 * {@link SchemaStatics.optional} except tweaked to work better for recursive types.
	 * Use with {@link ValidateRecursiveSchema} for improved type safety.
	 * @remarks
	 * This version of {@link SchemaStatics.optional} has fewer type constraints to work around TypeScript limitations, see {@link Unenforced}.
	 * See {@link ValidateRecursiveSchema} for additional information about using recursive schema.
	 */
	readonly optionalRecursive: <
		const T extends System_Unsafe.ImplicitAllowedTypesUnsafe,
		const TCustomMetadata = unknown,
	>(
		t: T,
		props?: Omit<FieldProps<TCustomMetadata>, "defaultProvider">,
	) => System_Unsafe.FieldSchemaUnsafe<FieldKind.Optional, T, TCustomMetadata>;

	/**
	 * {@link SchemaStatics.required} except tweaked to work better for recursive types.
	 * Use with {@link ValidateRecursiveSchema} for improved type safety.
	 * @remarks
	 * This version of {@link SchemaStatics.required} has fewer type constraints to work around TypeScript limitations, see {@link Unenforced}.
	 * See {@link ValidateRecursiveSchema} for additional information about using recursive schema.
	 */
	readonly requiredRecursive: <
		const T extends System_Unsafe.ImplicitAllowedTypesUnsafe,
		const TCustomMetadata = unknown,
	>(
		t: T,
		props?: Omit<FieldProps<TCustomMetadata>, "defaultProvider">,
	) => System_Unsafe.FieldSchemaUnsafe<FieldKind.Required, T, TCustomMetadata>;
}

const defaultOptionalProvider: DefaultProvider = getDefaultProvider(() => []);

// The following overloads for optional and required are used to get around the fact that
// the compiler can't infer that UnannotateImplicitAllowedTypes<T> is equal to T when T is known to extend ImplicitAllowedTypes

function optional<const T extends ImplicitAllowedTypes, const TCustomMetadata = unknown>(
	t: T,
	props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
): FieldSchemaAlpha<FieldKind.Optional, T, TCustomMetadata>;

function optional<
	const T extends ImplicitAnnotatedAllowedTypes,
	const TCustomMetadata = unknown,
>(
	t: T,
	props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
): FieldSchemaAlpha<FieldKind.Optional, UnannotateImplicitAllowedTypes<T>, TCustomMetadata>;

function optional<
	const T extends ImplicitAnnotatedAllowedTypes,
	const TCustomMetadata = unknown,
>(
	t: T,
	props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
): FieldSchemaAlpha<FieldKind.Optional, UnannotateImplicitAllowedTypes<T>, TCustomMetadata> {
	return createFieldSchema(FieldKind.Optional, t, {
		defaultProvider: defaultOptionalProvider,
		...props,
	});
}

function required<const T extends ImplicitAllowedTypes, const TCustomMetadata = unknown>(
	t: T,
	props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
): FieldSchemaAlpha<FieldKind.Required, T, TCustomMetadata>;

function required<
	const T extends ImplicitAnnotatedAllowedTypes,
	const TCustomMetadata = unknown,
>(
	t: T,
	props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
): FieldSchemaAlpha<FieldKind.Required, UnannotateImplicitAllowedTypes<T>, TCustomMetadata>;

function required<
	const T extends ImplicitAnnotatedAllowedTypes,
	const TCustomMetadata = unknown,
>(
	t: T,
	props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
): FieldSchemaAlpha<FieldKind.Required, UnannotateImplicitAllowedTypes<T>, TCustomMetadata> {
	return createFieldSchema(FieldKind.Required, t, props);
}

/**
 * Implementation of {@link SchemaStatics}.
 * @remarks
 * Entries can use more specific types than {@link SchemaStatics} requires to be more useful for non-public consumers.
 * Additional non-public members are in {@link schemaStatics}.
 */
export const schemaStaticsBase = {
	string: stringSchema,
	number: numberSchema,
	boolean: booleanSchema,
	null: nullSchema,
	handle: handleSchema,
	leaves: [stringSchema, numberSchema, booleanSchema, nullSchema, handleSchema],

	optional,

	required,

	optionalRecursive: <
		const T extends System_Unsafe.ImplicitAllowedTypesUnsafe,
		const TCustomMetadata = unknown,
	>(
		t: T,
		props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
	): FieldSchemaAlphaUnsafe<FieldKind.Optional, T, TCustomMetadata> => {
		return createFieldSchemaUnsafe(FieldKind.Optional, t, {
			defaultProvider: defaultOptionalProvider,
			...props,
		});
	},

	requiredRecursive: <
		const T extends System_Unsafe.ImplicitAllowedTypesUnsafe,
		const TCustomMetadata = unknown,
	>(
		t: T,
		props?: Omit<FieldPropsAlpha<TCustomMetadata>, "defaultProvider">,
	): FieldSchemaAlphaUnsafe<FieldKind.Required, T, TCustomMetadata> => {
		return createFieldSchemaUnsafe(FieldKind.Required, t, props);
	},
} as const satisfies SchemaStatics;

/**
 * Unstable extensions to {@link schemaStaticsBase}.
 */
export const schemaStatics = {
	...schemaStaticsBase,
	identifier: <const TCustomMetadata = unknown>(
		props?: Omit<FieldProps<TCustomMetadata>, "defaultProvider">,
	): FieldSchemaAlpha<FieldKind.Identifier, typeof stringSchema, TCustomMetadata> => {
		return createFieldSchema(FieldKind.Identifier, stringSchema, props);
	},
} as const;

const schemaStaticsPublic: SchemaStatics = schemaStatics;

// TODO:
// SchemaFactory.array references should link to the correct overloads, however the syntax for this does not seems to work currently for methods unless the they are not qualified with the class.
// API-Extractor requires such links to be qualified with the class, so it can't work.
// Since linking the overload set as a whole also doesn't work, these have been made non-links for now.
/**
 * Creates various types of {@link TreeNodeSchema|schema} for {@link TreeNode}s.
 *
 * @typeParam TScope - Scope added as a prefix to the name of every schema produced by this factory.
 * @typeParam TName - Type of names used to identify each schema produced in this factory.
 * Typically this is just `string` but it is also possible to use `string` or `number` based enums if you prefer to identify your types that way.
 *
 * @remarks
 * For details related to inputting data constrained by schema (including via assignment), and how non-exact schema types are handled in general refer to {@link Input}.
 * For information about recursive schema support, see methods postfixed with "recursive" and {@link ValidateRecursiveSchema}.
 * To apply schema defined with this factory to a tree, see {@link ViewableTree.viewWith} and {@link TreeViewConfiguration}.
 *
 * All schema produced by this factory get a {@link TreeNodeSchemaCore.identifier|unique identifier} by combining the {@link SchemaFactory.scope} with the schema's `Name`.
 * The `Name` part may be explicitly provided as a parameter, or inferred as a structural combination of the provided types.
 * The APIs which use this second approach, structural naming, also deduplicate all equivalent calls.
 * Therefor two calls to `array(allowedTypes)` with the same allowedTypes will return the same {@link TreeNodeSchema} instance.
 * On the other hand, two calls to `array(name, allowedTypes)` will always return different {@link TreeNodeSchema} instances
 * and it is an error to use both in the same tree (since their identifiers are not unique).
 *
 * For "customizable" schema (those which can be subclassed to customize them, see details below) some additional rules must be followed:
 *
 * 1. Only a single {@link TreeNodeSchema|schema} can be used from the class hierarchy deriving from the base class produced by this factory.
 * It is legal to subclass the returned class, and even subclass that class,
 * but only a single class from that class hierarchy can ever be instantiated or passed to any API as a {@link TreeNodeSchema|schema}.
 * These base classes can be used with `instanceof`, but not with schema based APIs like `Tree.is`.
 *
 * 2. If overriding the constructor, the constructor must accept the same argument as the base constructor `super` and forward it to `super` unchanged.
 *
 * 3. Properties for fields defined in the schema should not be overridden.
 *
 * 4. Additional static members added to schema should pick relatively unique keys to reduce the risk of colliding with implementation details what are not exposed in the API.
 *
 * 5. If exporting the schema from a package which uses API-Extractor, export the base class and derived class separately to work around [a known limitation](https://github.com/microsoft/rushstack/issues/4429).
 *
 * Note:
 * POJO stands for Plain Old JavaScript Object.
 * This means an object that works like a `{}` style object literal.
 * In this case it means the prototype is `Object.prototype` and acts like a set of key value pairs (data, not methods).
 * The usage below generalizes this to include array and map like objects as well.
 *
 * There are two ways to use these APIs:
 *
 * Customizable Approach:
 *
 * 1. Declaration: `class X extends schemaFactory.object("x", {}) {}`
 *
 * 2. Allows adding "local" (non-persisted) members: Yes. Members (including methods) can be added to the class.
 *
 * 3. Prototype: The user-defined class.
 *
 * 4. Structurally named Schema: Not Supported.
 *
 * 5. Explicitly named Objects: Supported.
 *
 * 6. Explicitly named Maps and Arrays: Supported: Both declaration approaches can be used.
 *
 * 7. Node.js `assert.deepEqual`: Compares like class instances: equal to other nodes of the same type with the same content, including custom local fields.
 *
 * 8. IntelliSense: Shows and links to user-defined class by name: `X`.
 *
 * 9. Recursion: Supported with special declaration patterns.
 *
 * POJO Emulation Approach:
 *
 * 1. Declaration: `const X = schemaFactory.object("x", {}); type X = NodeFromSchema<typeof X>;`
 *
 * 2. Allows adding "local" (non-persisted) members: No. Attempting to set non-field members will result in an error.
 *
 * 3. Prototype: `Object.prototype`, `Map.prototype`, or `Array.prototype` depending on node kind.
 *
 * 4. Structurally named Schema: Supported.
 *
 * 5. Explicitly named Objects: Supported.
 *
 * 6. Explicitly named Maps and Arrays: Not Supported.
 *
 * 7. Node.js `assert.deepEqual`: Compares like plain objects: equal to plain JavaScript objects with the same fields, and other nodes with the same fields, even if the types are different.
 *
 * 8. IntelliSense: Shows internal type generation logic: `object & TreeNode & ObjectFromSchemaRecord<{}> & WithType<"test.x">`.
 *
 * 9. Recursion: Unsupported: [Generated `.d.ts` files replace recursive references with `any`](https://github.com/microsoft/TypeScript/issues/55832),
 * breaking the use of recursive schema across compilation boundaries.
 *
 * Note that while "POJO Emulation" nodes act a lot like POJO objects, they are not true POJO objects:
 *
 * - Adding new arbitrary fields will error, as well some cases of invalid edits.
 *
 * - They are implemented using proxies.
 *
 * - They have state that is not exposed via enumerable own properties, including a {@link TreeNodeSchema}.
 * This makes libraries like node.js `assert.deepEqual` fail to detect differences in type.
 *
 * - Assigning members has side effects (in this case editing the persisted/shared tree).
 *
 * - Not all operations implied by the prototype will work correctly: stick to the APIs explicitly declared in the TypeScript types.
 *
 * @privateRemarks
 * It's perfectly possible to make `POJO Emulation` mode (or even just hiding the prototype) selectable even when using the custom user class declaration syntax.
 * When doing this, it's still possible to make `instanceof` perform correctly.
 * Allowing (or banning) custom/out-of-schema properties on the class is also possible in both modes: it could be orthogonal.
 * Also for consistency, if keeping the current approach to detecting `POJO Emulation` mode it might make sense to make explicitly named Maps and Arrays do the detection the same as how object does it.
 *
 * Note: the comparison between the customizable and POJO modes is not done in a table because TSDoc does not currently have support for embedded markdown.
 *
 * @see {@link SchemaFactoryAlpha}
 *
 * @sealed @public
 */
export class SchemaFactory<
	out TScope extends string | undefined = string | undefined,
	TName extends number | string = string,
> implements SchemaStatics
{
	/**
	 * TODO:
	 * If users of this generate the same name because two different schema with the same identifier were used,
	 * the second use can get a cache hit, and reference the wrong schema.
	 * Such usage should probably return a distinct type or error but currently does not.
	 * The use of markSchemaMostDerived in structuralName at least ensure an error in the case where the collision is from two types extending the same schema factor class.
	 */
	private readonly structuralTypes: Map<string, TreeNodeSchema> = new Map();

	/**
	 * Construct a SchemaFactory with a given {@link SchemaFactory.scope|scope}.
	 * @remarks
	 * There are no restrictions on mixing schema from different schema factories.
	 * Typically each library will create one or more SchemaFactories and use them to define its schema.
	 */
	public constructor(
		/**
		 * Prefix appended to the identifiers of all {@link TreeNodeSchema} produced by this builder.
		 *
		 * @remarks
		 * Generally each independently developed library
		 * (possibly a package, but could also be part of a package or multiple packages developed together)
		 * should get its own unique `scope`.
		 * Then each schema in the library get a name which is unique within the library.
		 * The scope and name are joined (with a period) to form the {@link TreeNodeSchemaCore.identifier|schema identifier}.
		 * Following this pattern allows a single application to depend on multiple libraries which define their own schema, and use them together in a single tree without risk of collisions.
		 * If a library logically contains sub-libraries with their own schema, they can be given a scope nested inside the parent scope, such as "ParentScope.ChildScope".
		 *
		 * To avoid collisions between the scopes of libraries
		 * it is recommended that the libraries use {@link https://en.wikipedia.org/wiki/Reverse_domain_name_notation | Reverse domain name notation} or a UUIDv4 for their scope.
		 * If this pattern is followed, application can safely use third party libraries without risk of the schema in them colliding.
		 *
		 * You may opt out of using a scope by passing `undefined`, but note that this increases the risk of collisions.
		 *
		 * @example
		 * Fluid Framework follows this pattern, placing the schema for the built in leaf types in the `com.fluidframework.leaf` scope.
		 * If Fluid Framework publishes more schema in the future, they would be under some other `com.fluidframework` scope.
		 * This ensures that any schema defined by any other library will not conflict with Fluid Framework's schema
		 * as long as the library uses the recommended patterns for how to scope its schema..
		 *
		 * @example
		 * A library could generate a random UUIDv4, like `242c4397-49ed-47e6-8dd0-d5c3bc31778b` and use that as the scope.
		 * Note: do not use this UUID: a new one must be randomly generated when needed to ensure collision resistance.
		 * ```typescript
		 * const factory = new SchemaFactory("242c4397-49ed-47e6-8dd0-d5c3bc31778b");
		 * ```
		 */
		public readonly scope: TScope,
	) {}

	private scoped<Name extends TName | string>(name: Name): ScopedSchemaName<TScope, Name> {
		return (
			this.scope === undefined ? `${name}` : `${this.scope}.${name}`
		) as ScopedSchemaName<TScope, Name>;
	}

	/**
	 * {@inheritDoc SchemaStatics.string}
	 */
	public readonly string = schemaStaticsPublic.string;

	/**
	 * {@inheritDoc SchemaStatics.number}
	 */
	public readonly number = schemaStaticsPublic.number;

	/**
	 * {@inheritDoc SchemaStatics.boolean}
	 */
	public readonly boolean = schemaStaticsPublic.boolean;

	/**
	 * {@inheritDoc SchemaStatics.null}
	 */
	public readonly null = schemaStaticsPublic.null;

	/**
	 * {@inheritDoc SchemaStatics.handle}
	 */
	public readonly handle = schemaStaticsPublic.handle;

	/**
	 * {@inheritDoc SchemaStatics.leaves}
	 */
	public readonly leaves = schemaStaticsPublic.leaves;

	/**
	 * {@inheritDoc SchemaStatics.string}
	 */
	public static readonly string = schemaStaticsPublic.string;

	/**
	 * {@inheritDoc SchemaStatics.number}
	 */
	public static readonly number = schemaStaticsPublic.number;

	/**
	 * {@inheritDoc SchemaStatics.boolean}
	 */
	public static readonly boolean = schemaStaticsPublic.boolean;

	/**
	 * {@inheritDoc SchemaStatics.null}
	 */
	public static readonly null = schemaStaticsPublic.null;

	/**
	 * {@inheritDoc SchemaStatics.handle}
	 */
	public static readonly handle = schemaStaticsPublic.handle;

	/**
	 * {@inheritDoc SchemaStatics.leaves}
	 */
	public static readonly leaves = schemaStaticsPublic.leaves;

	/**
	 * Define a {@link TreeNodeSchemaClass} for a {@link TreeObjectNode}.
	 *
	 * @param name - Unique identifier for this schema within this factory's scope.
	 * @param fields - Schema for fields of the object node's schema. Defines what children can be placed under each key.
	 */
	public object<
		const Name extends TName,
		const T extends RestrictiveStringRecord<ImplicitFieldSchema>,
	>(
		name: Name,
		fields: T,
	): TreeNodeSchemaClass<
		ScopedSchemaName<TScope, Name>,
		NodeKind.Object,
		TreeObjectNode<T, ScopedSchemaName<TScope, Name>>,
		object & InsertableObjectFromSchemaRecord<T>,
		true,
		T
	> {
		// The compiler can't infer that UnannotateSchemaRecord<T> is equal to T so we have to do a bunch of typing to make the error go away.
		const object: TreeNodeSchemaClass<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Object,
			TreeObjectNode<UnannotateSchemaRecord<T>, ScopedSchemaName<TScope, Name>>,
			object & InsertableObjectFromSchemaRecord<UnannotateSchemaRecord<T>>,
			true,
			T
		> = objectSchema(
			this.scoped(name),
			fields,
			true,
			defaultSchemaFactoryObjectOptions.allowUnknownOptionalFields,
		);

		return object as TreeNodeSchemaClass<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Object,
			TreeObjectNode<RestrictiveStringRecord<ImplicitFieldSchema>>,
			unknown,
			true,
			T
		> as TreeNodeSchemaClass<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Object,
			TreeObjectNode<T, ScopedSchemaName<TScope, Name>>,
			object & InsertableObjectFromSchemaRecord<T>,
			true,
			T
		>;
	}

	/**
	 * Define a structurally typed {@link TreeNodeSchema} for a {@link TreeMapNode}.
	 *
	 * @param allowedTypes - The types that may appear as values in the map.
	 *
	 * @remarks
	 * The unique identifier for this Map is defined as a function of the provided types.
	 * It is still scoped to this SchemaBuilder, but multiple calls with the same arguments will return the same schema object, providing somewhat structural typing.
	 * This does not support recursive types.
	 *
	 * If using these structurally named maps, other types in this schema builder should avoid names of the form `Map<${string}>`.
	 *
	 * @example
	 * The returned schema should be used as a schema directly:
	 * ```typescript
	 * const MyMap = factory.map(factory.number);
	 * type MyMap = NodeFromSchema<typeof MyMap>;
	 * ```
	 * Or inline:
	 * ```typescript
	 * factory.object("Foo", {myMap: factory.map(factory.number)});
	 * ```
	 * @privateRemarks
	 * See note on array.
	 */
	public map<const T extends TreeNodeSchema | readonly TreeNodeSchema[]>(
		allowedTypes: T,
	): TreeNodeSchemaNonClass<
		ScopedSchemaName<TScope, `Map<${string}>`>,
		NodeKind.Map,
		TreeMapNode<T> & WithType<ScopedSchemaName<TScope, `Map<${string}>`>, NodeKind.Map>,
		MapNodeInsertableData<T>,
		true,
		T,
		undefined
	>;

	/**
	 * Define a {@link TreeNodeSchema} for a {@link TreeMapNode}.
	 *
	 * @param name - Unique identifier for this schema within this factory's scope.
	 * @param allowedTypes - The types that may appear as values in the map.
	 *
	 * @example
	 * ```typescript
	 * class NamedMap extends factory.map("name", factory.number) {}
	 * ```
	 */
	public map<Name extends TName, const T extends ImplicitAllowedTypes>(
		name: Name,
		allowedTypes: T,
	): TreeNodeSchemaClass<
		ScopedSchemaName<TScope, Name>,
		NodeKind.Map,
		TreeMapNode<T> & WithType<ScopedSchemaName<TScope, Name>, NodeKind.Map>,
		MapNodeInsertableData<T>,
		true,
		T,
		undefined
	>;

	/**
	 * {@link SchemaFactory.map} implementation.
	 *
	 * @privateRemarks
	 * This should return `TreeNodeSchemaBoth`, however TypeScript gives an error if one of the overloads implicitly up-casts the return type of the implementation.
	 * This seems like a TypeScript bug getting variance backwards for overload return types since it's erroring when the relation between the overload
	 * and the implementation is type safe, and forcing an unsafe typing instead.
	 */
	public map<const T extends ImplicitAllowedTypes>(
		nameOrAllowedTypes: TName | ((T & TreeNodeSchema) | readonly TreeNodeSchema[]),
		allowedTypes?: T,
	): TreeNodeSchema<string, NodeKind.Map, TreeMapNode<T>, MapNodeInsertableData<T>, true, T> {
		if (allowedTypes === undefined) {
			const types = nameOrAllowedTypes as (T & TreeNodeSchema) | readonly TreeNodeSchema[];
			const fullName = structuralName("Map", types);
			return this.getStructuralType(fullName, types, () =>
				this.namedMap(fullName, nameOrAllowedTypes as T, false, true),
			) as TreeNodeSchemaBoth<
				string,
				NodeKind.Map,
				TreeMapNode<T>,
				MapNodeInsertableData<T>,
				true,
				T,
				undefined
			>;
		}
		// To actually have type safety, assign to the type this method should return before implicitly up-casting when returning.
		const out: TreeNodeSchemaBoth<
			string,
			NodeKind.Map,
			TreeMapNode<T>,
			MapNodeInsertableData<T>,
			true,
			T,
			undefined
		> = this.namedMap(nameOrAllowedTypes as TName, allowedTypes, true, true);
		return out;
	}

	/**
	 * Define a {@link TreeNodeSchema} for a {@link (TreeMapNode:interface)}.
	 *
	 * @param name - Unique identifier for this schema within this factory's scope.
	 */
	private namedMap<
		Name extends TName | string,
		const T extends ImplicitAllowedTypes,
		const ImplicitlyConstructable extends boolean,
	>(
		name: Name,
		allowedTypes: T,
		customizable: boolean,
		implicitlyConstructable: ImplicitlyConstructable,
	): TreeNodeSchemaBoth<
		ScopedSchemaName<TScope, Name>,
		NodeKind.Map,
		TreeMapNode<T> & WithType<ScopedSchemaName<TScope, Name>, NodeKind.Map>,
		MapNodeInsertableData<T>,
		ImplicitlyConstructable,
		T,
		undefined
	> {
		// The compiler can't infer that UnannotateImplicitAllowedTypes<T> is equal to T so we have to do a bunch of typing to make the error go away.
		const map: TreeNodeSchemaBoth<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Map,
			TreeMapNode<UnannotateImplicitAllowedTypes<T>> &
				WithType<ScopedSchemaName<TScope, Name>, NodeKind.Map>,
			MapNodeInsertableData<UnannotateImplicitAllowedTypes<T>>,
			ImplicitlyConstructable,
			T,
			undefined
		> = mapSchema(
			this.scoped(name),
			allowedTypes,
			implicitlyConstructable,
			// The current policy is customizable nodes don't get fake prototypes.
			!customizable,
			undefined,
		);

		return map as TreeNodeSchemaBoth<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Map,
			TreeMapNode<UnannotateImplicitAllowedTypes<T>> &
				WithType<ScopedSchemaName<TScope, Name>, NodeKind.Map>,
			MapNodeInsertableData<ImplicitAllowedTypes>,
			ImplicitlyConstructable,
			T,
			undefined
		> as TreeNodeSchemaBoth<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Map,
			TreeMapNode<T> & WithType<ScopedSchemaName<TScope, Name>, NodeKind.Map>,
			MapNodeInsertableData<T>,
			ImplicitlyConstructable,
			T,
			undefined
		>;
	}

	/**
	 * Define a structurally typed {@link TreeNodeSchema} for a {@link (TreeArrayNode:interface)}.
	 *
	 * @param allowedTypes - The types that may appear in the array.
	 *
	 * @remarks
	 * The identifier for this Array is defined as a function of the provided types.
	 * It is still scoped to this SchemaFactory, but multiple calls with the same arguments will return the same schema object, providing somewhat structural typing.
	 * This does not support recursive types.
	 *
	 * If using these structurally named arrays, other types in this schema builder should avoid names of the form `Array<${string}>`.
	 *
	 * @example
	 * The returned schema should be used as a schema directly:
	 * ```typescript
	 * const MyArray = factory.array(factory.number);
	 * type MyArray = NodeFromSchema<typeof MyArray>;
	 * ```
	 * Or inline:
	 * ```typescript
	 * factory.object("Foo", {myArray: factory.array(factory.number)});
	 * ```
	 * @privateRemarks
	 * The name produced at the type level here is not as specific as it could be, however doing type level sorting and escaping is a real mess.
	 * There are cases where not having this full type provided will be less than ideal, since TypeScript's structural types will allow assignment between runtime incompatible types at compile time.
	 * For example attempts to narrow unions of structural arrays by name won't work.
	 * Planned future changes to move to a class based schema system as well as factor function based node construction should mostly avoid these issues,
	 * though there may still be some problematic cases even after that work is done.
	 *
	 * The return value is a class, but its the type is intentionally not specific enough to indicate it is a class.
	 * This prevents callers of this from sub-classing it, which is unlikely to work well (due to the ease of accidentally giving two different calls o this different subclasses)
	 * when working with structural typing.
	 *
	 * {@label STRUCTURAL}
	 */
	public array<const T extends TreeNodeSchema | readonly TreeNodeSchema[]>(
		allowedTypes: T,
	): TreeNodeSchemaNonClass<
		ScopedSchemaName<TScope, `Array<${string}>`>,
		NodeKind.Array,
		TreeArrayNode<T> & WithType<ScopedSchemaName<TScope, `Array<${string}>`>, NodeKind.Array>,
		Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>,
		true,
		T,
		undefined
	>;

	/**
	 * Define (and add to this library) a {@link TreeNodeSchemaClass} for a {@link (TreeArrayNode:interface)}.
	 *
	 * @param name - Unique identifier for this schema within this factory's scope.
	 * @param allowedTypes - The types that may appear in the array.
	 *
	 * @example
	 * ```typescript
	 * class NamedArray extends factory.array("name", factory.number) {}
	 * ```
	 *
	 * {@label NAMED}
	 */
	public array<const Name extends TName, const T extends ImplicitAllowedTypes>(
		name: Name,
		allowedTypes: T,
	): TreeNodeSchemaClass<
		ScopedSchemaName<TScope, Name>,
		NodeKind.Array,
		TreeArrayNode<T> & WithType<ScopedSchemaName<TScope, Name>, NodeKind.Array>,
		Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>,
		true,
		T,
		undefined
	>;

	/**
	 * {@link SchemaFactory.array} implementation.
	 *
	 * @privateRemarks
	 * This should return TreeNodeSchemaBoth: see note on "map" implementation for details.
	 */
	public array<const T extends ImplicitAllowedTypes>(
		nameOrAllowedTypes: TName | ((T & TreeNodeSchema) | readonly TreeNodeSchema[]),
		allowedTypes?: T,
	): TreeNodeSchema<
		ScopedSchemaName<TScope, string>,
		NodeKind.Array,
		TreeArrayNode<T>,
		Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>,
		true,
		T
	> {
		if (allowedTypes === undefined) {
			const types = nameOrAllowedTypes as (T & TreeNodeSchema) | readonly TreeNodeSchema[];
			const fullName = structuralName("Array", types);
			return this.getStructuralType(fullName, types, () =>
				this.namedArray(fullName, nameOrAllowedTypes as T, false, true),
			) as TreeNodeSchemaClass<
				ScopedSchemaName<TScope, string>,
				NodeKind.Array,
				TreeArrayNode<T>,
				Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>,
				true,
				T,
				undefined
			>;
		}
		const out: TreeNodeSchemaBoth<
			ScopedSchemaName<TScope, string>,
			NodeKind.Array,
			TreeArrayNode<T>,
			Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>,
			true,
			T,
			undefined
		> = this.namedArray(nameOrAllowedTypes as TName, allowedTypes, true, true);
		return out;
	}

	/**
	 * Retrieves or creates a structural {@link TreeNodeSchema} with the specified name and types.
	 *
	 * @param fullName - The name for the structural schema.
	 * @param types - The input schema(s) used to define the structural schema.
	 * @param builder - A function that builds the schema if it does not already exist.
	 * @returns The structural {@link TreeNodeSchema} associated with the given name and types.
	 * @throws `UsageError` if a schema structurally named schema with the same name is cached in `structuralTypes` but had different input types.
	 */
	protected getStructuralType(
		fullName: string,
		types: TreeNodeSchema | readonly TreeNodeSchema[],
		builder: () => TreeNodeSchema,
	): TreeNodeSchema {
		const structural = getOrCreate(this.structuralTypes, fullName, builder);
		const inputTypes = new Set(normalizeAllowedTypes(types));
		const outputTypes = new Set(
			normalizeAllowedTypes(structural.info as TreeNodeSchema | readonly TreeNodeSchema[]),
		);
		// If our cached value had a different set of types then were requested, the user must have caused a collision.
		const same = compareSets({ a: inputTypes, b: outputTypes });
		if (!same) {
			throw new UsageError(
				`Structurally named schema collision: two schema named "${fullName}" were defined with different input schema.`,
			);
		}
		return structural;
	}

	/**
	 * Define a {@link TreeNodeSchema} for a {@link (TreeArrayNode:interface)}.
	 *
	 * @param name - Unique identifier for this schema within this factory's scope.
	 *
	 * @remarks
	 * This is not intended to be used directly, use the overload of `array` which takes a name instead.
	 * This is only public to work around a compiler limitation.
	 */
	private namedArray<
		Name extends TName | string,
		const T extends ImplicitAllowedTypes,
		const ImplicitlyConstructable extends boolean,
	>(
		name: Name,
		allowedTypes: T,
		customizable: boolean,
		implicitlyConstructable: ImplicitlyConstructable,
	): TreeNodeSchemaBoth<
		ScopedSchemaName<TScope, Name>,
		NodeKind.Array,
		TreeArrayNode<T> & WithType<ScopedSchemaName<TScope, string>, NodeKind.Array>,
		Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>,
		ImplicitlyConstructable,
		T,
		undefined
	> {
		const array = arraySchema(
			this.scoped(name),
			allowedTypes,
			implicitlyConstructable,
			customizable,
		);

		return array as TreeNodeSchemaBoth<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Array,
			TreeArrayNode<T> & WithType<ScopedSchemaName<TScope, string>, NodeKind.Array>,
			Iterable<InsertableTreeNodeFromImplicitAllowedTypes<T>>,
			ImplicitlyConstructable,
			T,
			undefined
		>;
	}

	/**
	 * {@inheritDoc SchemaStatics.optional}
	 */
	public readonly optional = schemaStaticsPublic.optional;

	/**
	 * {@inheritDoc SchemaStatics.required}
	 */
	public readonly required = schemaStaticsPublic.required;

	/**
	 * {@inheritDoc SchemaStatics.optionalRecursive}
	 */
	public readonly optionalRecursive = schemaStaticsPublic.optionalRecursive;

	/**
	 * {@inheritDoc SchemaStatics.requiredRecursive}
	 */
	public readonly requiredRecursive = schemaStaticsPublic.requiredRecursive;

	/**
	 * {@inheritDoc SchemaStatics.optional}
	 */
	public static readonly optional = schemaStaticsPublic.optional;

	/**
	 * {@inheritDoc SchemaStatics.required}
	 */
	public static readonly required = schemaStaticsPublic.required;

	/**
	 * {@inheritDoc SchemaStatics.optionalRecursive}
	 */
	public static readonly optionalRecursive = schemaStaticsPublic.optionalRecursive;

	/**
	 * {@inheritDoc SchemaStatics.requiredRecursive}
	 */
	public static readonly requiredRecursive = schemaStaticsPublic.requiredRecursive;

	/**
	 * A special readonly field which holds an identifier string for an object node.
	 * @remarks
	 * The value of this field, a "node identifier", is a string which identifies a node (or nodes) among all nodes in the tree.
	 * Node identifiers are strings, and can therefore be used as lookup keys in maps or written to a database.
	 * When the node is constructed, the identifier field does not need to be specified.
	 * When an identifier is not provided, the SharedTree will generate an identifier for the node automatically.
	 * The identifier generated by the SharedTree has the following properties:
	 *
	 * - It is a UUID which will not collide with other generated UUIDs.
	 *
	 * - It is compressed to a space-efficient representation when stored in the document.
	 * Reading the identifier before inserting the node into a tree prevents the identifier from being stored in its compressed form,
	 * resulting in a larger storage footprint.
	 *
	 * - A compressed form of the identifier can be accessed at runtime via the {@link TreeNodeApi.shortId|Tree.shortId()} API.
	 *
	 * However, a user may alternatively supply their own string as the identifier if desired (for example, if importing identifiers from another system).
	 * In that case, if the user requires it to be unique, it is up to them to ensure uniqueness.
	 * User-supplied identifiers may be read immediately, even before insertion into the tree.
	 *
	 * A node may have more than one identifier field (though note that this precludes the use of the {@link TreeNodeApi.shortId|Tree.shortId()} API).
	 */
	public get identifier(): FieldSchema<FieldKind.Identifier, typeof this.string> {
		const defaultIdentifierProvider: DefaultProvider = getDefaultProvider(
			(
				context: FlexTreeHydratedContextMinimal | "UseGlobalContext",
			): UnhydratedFlexTreeNode[] => {
				const id =
					context === "UseGlobalContext"
						? globalIdentifierAllocator.decompress(
								globalIdentifierAllocator.generateCompressedId(),
							)
						: context.nodeKeyManager.stabilizeNodeIdentifier(
								context.nodeKeyManager.generateLocalNodeIdentifier(),
							);

				return [unhydratedFlexTreeFromInsertable(id, this.string)];
			},
		);
		return createFieldSchema(FieldKind.Identifier, this.string, {
			defaultProvider: defaultIdentifierProvider,
		});
	}

	/**
	 * {@link SchemaFactory.object} except tweaked to work better for recursive types.
	 * Use with {@link ValidateRecursiveSchema} for improved type safety.
	 * @remarks
	 * This version of {@link SchemaFactory.object} has fewer type constraints to work around TypeScript limitations, see {@link Unenforced}.
	 * See {@link ValidateRecursiveSchema} for additional information about using recursive schema.
	 *
	 * Additionally `ImplicitlyConstructable` is disabled (forcing use of constructor) to avoid
	 * `error TS2589: Type instantiation is excessively deep and possibly infinite.`
	 * which otherwise gets reported at sometimes incorrect source locations that vary based on incremental builds.
	 */
	public objectRecursive<
		const Name extends TName,
		const T extends RestrictiveStringRecord<System_Unsafe.ImplicitFieldSchemaUnsafe>,
	>(
		name: Name,
		t: T,
	): TreeNodeSchemaClass<
		ScopedSchemaName<TScope, Name>,
		NodeKind.Object,
		System_Unsafe.TreeObjectNodeUnsafe<T, ScopedSchemaName<TScope, Name>>,
		object & System_Unsafe.InsertableObjectFromSchemaRecordUnsafe<T>,
		false,
		T
	> {
		type TScopedName = ScopedSchemaName<TScope, Name>;
		return this.object(
			name,
			t as T & RestrictiveStringRecord<ImplicitFieldSchema>,
		) as unknown as TreeNodeSchemaClass<
			TScopedName,
			NodeKind.Object,
			System_Unsafe.TreeObjectNodeUnsafe<T, TScopedName>,
			object & System_Unsafe.InsertableObjectFromSchemaRecordUnsafe<T>,
			false,
			T
		>;
	}

	/**
	 * `SchemaFactory.array` except tweaked to work better for recursive types.
	 * Use with {@link ValidateRecursiveSchema} for improved type safety.
	 * @remarks
	 * This version of `SchemaFactory.array` uses the same workarounds as {@link SchemaFactory.objectRecursive}.
	 * See {@link ValidateRecursiveSchema} for additional information about using recursive schema.
	 * See also {@link FixRecursiveArraySchema} for additional information specific to recursive arrays schema exports.
	 */
	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
	public arrayRecursive<
		const Name extends TName,
		const T extends System_Unsafe.ImplicitAllowedTypesUnsafe,
	>(name: Name, allowedTypes: T) {
		const RecursiveArray = this.namedArray(
			name,
			allowedTypes as T & ImplicitAllowedTypes,
			true,
			false,
		);

		return RecursiveArray as TreeNodeSchemaClass<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Array,
			System_Unsafe.TreeArrayNodeUnsafe<T> &
				WithType<ScopedSchemaName<TScope, Name>, NodeKind.Array>,
			{
				/**
				 * Iterator for the iterable of content for this node.
				 * @privateRemarks
				 * Wrapping the constructor parameter for recursive arrays and maps in an inlined object type avoids (for unknown reasons)
				 * the following compile error when declaring the recursive schema:
				 * `Function implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions.`
				 * To benefit from this without impacting the API, the definition of `Iterable` has been inlined as such an object.
				 *
				 * If this workaround is kept, ideally this comment would be deduplicated with the other instance of it.
				 * Unfortunately attempts to do this failed to avoid the compile error this was introduced to solve.
				 */
				[Symbol.iterator](): Iterator<
					System_Unsafe.InsertableTreeNodeFromImplicitAllowedTypesUnsafe<T>
				>;
			},
			false,
			T,
			undefined
		>;
	}

	/**
	 * `SchemaFactory.map` except tweaked to work better for recursive types.
	 * Use with {@link ValidateRecursiveSchema} for improved type safety.
	 * @remarks
	 * This version of `SchemaFactory.map` uses the same workarounds as {@link SchemaFactory.objectRecursive}.
	 * See {@link ValidateRecursiveSchema} for additional information about using recursive schema.
	 */
	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
	public mapRecursive<
		Name extends TName,
		const T extends System_Unsafe.ImplicitAllowedTypesUnsafe,
	>(name: Name, allowedTypes: T) {
		const MapSchema = this.namedMap(
			name,
			allowedTypes as T & ImplicitAllowedTypes,
			true,
			// Setting this (implicitlyConstructable) to true seems to work ok currently, but not for other node kinds.
			// Supporting this could be fragile and might break other future changes, so it's being kept as false for now.
			false,
		);

		return MapSchema as TreeNodeSchemaClass<
			ScopedSchemaName<TScope, Name>,
			NodeKind.Map,
			System_Unsafe.TreeMapNodeUnsafe<T> &
				WithType<ScopedSchemaName<TScope, Name>, NodeKind.Map>,
			| {
					/**
					 * Iterator for the iterable of content for this node.
					 * @privateRemarks
					 * Wrapping the constructor parameter for recursive arrays and maps in an inlined object type avoids (for unknown reasons)
					 * the following compile error when declaring the recursive schema:
					 * `Function implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions.`
					 * To benefit from this without impacting the API, the definition of `Iterable` has been inlined as such an object.
					 *
					 * If this workaround is kept, ideally this comment would be deduplicated with the other instance of it.
					 * Unfortunately attempts to do this failed to avoid the compile error this was introduced to solve.
					 */
					[Symbol.iterator](): Iterator<
						[string, System_Unsafe.InsertableTreeNodeFromImplicitAllowedTypesUnsafe<T>]
					>;
			  }
			// Ideally this would be
			// RestrictiveStringRecord<InsertableTreeNodeFromImplicitAllowedTypesUnsafe<T>>,
			// but doing so breaks recursive types.
			// Instead we do a less nice version:
			| {
					readonly [P in string]: System_Unsafe.InsertableTreeNodeFromImplicitAllowedTypesUnsafe<T>;
			  },
			false,
			T,
			undefined
		>;
	}
}

export function structuralName<const T extends string>(
	collectionName: T,
	allowedTypes: TreeNodeSchema | readonly TreeNodeSchema[],
): `${T}<${string}>` {
	let inner: string;
	if (!isReadonlyArray(allowedTypes)) {
		return structuralName(collectionName, [allowedTypes]);
	} else {
		const names = allowedTypes.map((t): string => {
			// Ensure that lazy types (functions) don't slip through here.
			assert(!isLazy(t), 0x83d /* invalid type provided */);
			markSchemaMostDerived(t);
			return t.identifier;
		});
		// Ensure name is order independent
		names.sort();
		// Ensure name can't have collisions by quoting and escaping any quotes in the names of types.
		// Using JSON is a simple way to accomplish this.
		// The outer `[]` around the result were needed so that a single type name "Any" would not collide with the "any" case which used to exist.
		inner = JSON.stringify(names);
	}
	return `${collectionName}<${inner}>`;
}

/**
 * Used to allocate default identifiers for unhydrated nodes when no context is available.
 * @remarks
 * The identifiers allocated by this will never be compressed to Short Ids.
 * Using this is only better than creating fully random V4 UUIDs because it reduces the entropy making it possible for things like text compression to work slightly better.
 */
const globalIdentifierAllocator: IIdCompressor = createIdCompressor();

/**
 * Additional information to provide to Node Schema creation.
 *
 * @typeParam TCustomMetadata - Custom metadata properties to associate with the Node Schema.
 * See {@link NodeSchemaMetadata.custom}.
 *
 * @sealed
 * @public
 */
export interface NodeSchemaOptions<out TCustomMetadata = unknown> {
	/**
	 * Optional metadata to associate with the Node Schema.
	 *
	 * @remarks
	 * Note: this metadata is not persisted nor made part of the collaborative state; it is strictly client-local.
	 * Different clients in the same collaborative session may see different metadata for the same field.
	 */
	readonly metadata?: NodeSchemaMetadata<TCustomMetadata> | undefined;
}

/**
 * Additional information to provide to Node Schema creation. Includes fields for alpha features.
 *
 * @typeParam TCustomMetadata - Custom metadata properties to associate with the Node Schema.
 * See {@link NodeSchemaMetadata.custom}.
 *
 * @alpha
 */
export interface NodeSchemaOptionsAlpha<out TCustomMetadata = unknown>
	extends NodeSchemaOptions<TCustomMetadata> {
	/**
	 * The persisted metadata for this schema element.
	 */
	readonly persistedMetadata?: JsonCompatibleReadOnlyObject | undefined;
}
