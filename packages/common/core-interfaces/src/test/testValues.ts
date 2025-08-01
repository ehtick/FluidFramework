/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assertIdenticalTypes } from "./testUtils.js";

import type {
	ErasedType,
	IFluidHandle,
	IFluidHandleErased,
} from "@fluidframework/core-interfaces";
import { fluidHandleSymbol } from "@fluidframework/core-interfaces";
import type {
	BrandedType,
	ReadonlyNonNullJsonObjectWith,
} from "@fluidframework/core-interfaces/internal";
import type {
	JsonTypeWith,
	InternalUtilityTypes,
	ReadonlyJsonTypeWith,
	NonNullJsonObjectWith,
	OpaqueJsonSerializable,
	OpaqueJsonDeserialized,
} from "@fluidframework/core-interfaces/internal/exposedUtilityTypes";

/* eslint-disable jsdoc/require-jsdoc */
/* eslint-disable unicorn/no-null */
/* eslint-disable @typescript-eslint/consistent-type-definitions */

export const boolean: boolean = true as boolean; // Use `as` to avoid type conversion to `true`
export const number: number = 0;
export const string: string = "";
export const symbol: symbol = Symbol("symbol");
export const uniqueSymbol: unique symbol = Symbol("unique symbol");
export const bigint: bigint = 0n;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const aFunction = (): any => {};
export const unknownValueOfSimpleRecord = { key: "value" } as unknown;
export const unknownValueWithBigint = { bigint: 1n } as unknown;
export const voidValue = null as unknown as void;
export const never = null as never;

export const stringOrSymbol = Symbol("objectSymbol") as string | symbol;
export const bigintOrString = "not bigint" as string | bigint;
export const bigintOrSymbol = Symbol("objectSymbol") as symbol | bigint;
export const numberOrBigintOrSymbol = 7 as number | bigint | symbol;

export enum NumericEnum {
	zero,
	one,
	two,
}
export enum StringEnum {
	a = "a",
	b = "b",
}
export const enum ConstHeterogenousEnum {
	zero,
	a = "a",
}
export enum ComputedEnum {
	fixed,
	computed = (<T>(v: T): T => v)(5),
}
// Define these enum values with functions to avoid static analysis determining their specific value.
export const numericEnumValue = ((): NumericEnum => NumericEnum.one)();
export const stringEnumValue = ((): StringEnum => StringEnum.a)();
export const constHeterogenousEnumValue = ((): ConstHeterogenousEnum =>
	ConstHeterogenousEnum.a)();
export const computedEnumValue = ((): ComputedEnum => ComputedEnum.computed)();

// Functions are objects and they may have arbitrary properties
export const functionWithProperties = Object.assign(
	(): number => {
		return 2;
	},
	{ property: 5 },
);
// Regular objects may also be functions
// eslint-disable-next-line prefer-object-spread
export const objectAndFunction = Object.assign({ property: 6 }, (): number => {
	return 3;
});

// #region Array types

export const arrayOfNumbers: number[] = [0, 1, 2];
export const arrayOfNumbersSparse: number[] = [0];
arrayOfNumbersSparse[3] = 3;
export const arrayOfNumbersOrUndefined = [0, undefined, 2];
export const arrayOfBigints = [bigint];
export const arrayOfSymbols: symbol[] = [Symbol("symbol")];
export const arrayOfUnknown: unknown[] = [unknownValueOfSimpleRecord];
export const arrayOfFunctions = [aFunction];
export const arrayOfFunctionsWithProperties = [functionWithProperties];
export const arrayOfObjectAndFunctions = [objectAndFunction];
export const arrayOfBigintOrObjects: (bigint | { property: string })[] = [
	{ property: "string" },
	bigint,
];
export const arrayOfSymbolOrObjects: (symbol | { property: string })[] = [Symbol("symbol")];
export const arrayOfBigintOrSymbols = [bigintOrSymbol];
export const arrayOfNumberBigintOrSymbols = [numberOrBigintOrSymbol];

export const readonlyArrayOfNumbers: readonly number[] = arrayOfNumbers;
export const readonlyArrayOfObjects: readonly { property: string }[] = [];

// #endregion

// #region Object (record) types

export const object: object = { key: "value" };
export const emptyObject = {};
export const objectWithBoolean = { boolean: true };
export const objectWithNumber = { number: 0 };
export const objectWithString = { string: "" };
export const objectWithSymbol = { symbol: Symbol("objectSymbol") };
export const objectWithBigint = { bigint: 0n };
export const objectWithFunction = { function: (): void => {} };
export const objectWithFunctionWithProperties = { function: functionWithProperties };
export const objectWithObjectAndFunction = { object: objectAndFunction };
export const objectWithStringOrSymbol = { stringOrSymbol };
export const objectWithBigintOrString = { bigintOrString };
export const objectWithBigintOrSymbol = { bigintOrSymbol };
export const objectWithNumberOrBigintOrSymbol = { numberOrBigintOrSymbol };
export const objectWithFunctionOrSymbol = {
	functionOrSymbol: ((): void => {}) as (() => void) | symbol,
};
export const objectWithOptionalSymbol: { symbol?: symbol } = {
	symbol: Symbol("objectSymbol"),
};
export const objectWithOptionalBigint: { bigint?: bigint } = { bigint: 0n };

export const objectWithNumberKey = { 3: "value" };
export const objectWithSymbolKey = { [symbol]: "value" };
export const objectWithUniqueSymbolKey = { [uniqueSymbol]: "value" };

export const objectWithArrayOfNumbers = { arrayOfNumbers };
export const objectWithArrayOfNumbersSparse = { arrayOfNumbersSparse };
export const objectWithArrayOfNumbersOrUndefined = { arrayOfNumbersOrUndefined };
export const objectWithArrayOfBigints = { arrayOfBigints };
export const objectWithArrayOfSymbols = { arrayOfSymbols };
export const objectWithArrayOfUnknown = { arrayOfUnknown };
export const objectWithArrayOfFunctions = { arrayOfFunctions };
export const objectWithArrayOfFunctionsWithProperties = { arrayOfFunctionsWithProperties };
export const objectWithArrayOfObjectAndFunctions = { arrayOfObjectAndFunctions };
export const objectWithArrayOfBigintOrObjects = { arrayOfBigintOrObjects };
export const objectWithArrayOfSymbolOrObjects = { arrayOfSymbolOrObjects };
export const objectWithReadonlyArrayOfNumbers = { readonlyArrayOfNumbers };

export const objectWithUnknown = { unknown: "value" as unknown };
interface ObjectWithOptionalUnknown {
	optUnknown?: unknown;
}
export const objectWithOptionalUnknown: ObjectWithOptionalUnknown = { optUnknown: "value" };

export const objectWithUndefined = {
	undef: undefined,
};
export const objectWithOptionalUndefined: {
	optUndef?: undefined;
} = { optUndef: undefined };
export interface ObjectWithOptionalNumber {
	optNumber?: number;
}
export const objectWithOptionalNumberNotPresent: ObjectWithOptionalNumber = {};
// This case is present for exactOptionalPropertyTypes=false Typescript configuration.
// When built with exactOptionalPropertyTypes=true, simple cast is an error;
// so, to enable build with either setting cast through unknown.
export const objectWithOptionalNumberUndefined = {
	optNumber: undefined,
} as unknown as ObjectWithOptionalNumber;
export const objectWithOptionalNumberDefined: ObjectWithOptionalNumber = { optNumber: 4 };
export interface ObjectWithNumberOrUndefined {
	numOrUndef: number | undefined;
}
export const objectWithNumberOrUndefinedUndefined: ObjectWithNumberOrUndefined = {
	numOrUndef: undefined,
};
export const objectWithNumberOrUndefinedNumbered: ObjectWithNumberOrUndefined = {
	numOrUndef: 5.2,
};
export const objectWithOptionalUndefinedEnclosingRequiredUndefined: {
	opt?: { requiredUndefined: number | undefined };
} = { opt: { requiredUndefined: undefined } };
export const objectWithNever = {
	never,
};

interface ObjectWithReadonly {
	readonly readonly: number;
}
export const objectWithReadonly: ObjectWithReadonly = { readonly: 5 };
class ClassImplementsObjectWithReadonly implements ObjectWithReadonly {
	public get readonly(): number {
		throw new Error("ClassImplementsObjectWithReadonly reading 'readonly'");
		return 4;
	}
}
export const objectWithReadonlyViaGetter: ObjectWithReadonly =
	new ClassImplementsObjectWithReadonly();

interface ObjectWithGetter {
	get getter(): number;
}
class ClassImplementsObjectWithGetter implements ObjectWithGetter {
	public get getter(): number {
		throw new Error("ClassImplementsObjectWithGetter reading 'getter'");
		return 4.2;
	}
}
export const objectWithGetter: ObjectWithGetter = new ClassImplementsObjectWithGetter();
export const objectWithGetterViaValue: ObjectWithGetter = { getter: 0 };

interface ObjectWithSetter {
	set setter(v: string);
}
class ClassImplementsObjectWithSetter implements ObjectWithSetter {
	public set setter(v: string) {
		throw new Error(`ClassImplementsObjectWithSetter writing 'setter' as ${v}`);
	}
}
export const objectWithSetter: ObjectWithSetter = new ClassImplementsObjectWithSetter();
export const objectWithSetterViaValue: ObjectWithSetter = { setter: "value" };
interface ObjectWithMatchedGetterAndSetterProperty {
	get property(): number;
	set property(v: number);
}
export const objectWithMatchedGetterAndSetterPropertyViaValue: ObjectWithMatchedGetterAndSetterProperty =
	{ property: 0 };
class ClassImplementsObjectWithMatchedGetterAndSetterProperty
	implements ObjectWithMatchedGetterAndSetterProperty
{
	public get property(): number {
		throw new Error(
			"ClassImplementsObjectWithMatchedGetterAndSetterProperty reading 'property'",
		);
		return 2;
	}
	public set property(v: number) {
		throw new Error(
			`ClassImplementsObjectWithMatchedGetterAndSetterProperty writing 'property' as ${v}`,
		);
	}
}
export const objectWithMatchedGetterAndSetterProperty: ObjectWithMatchedGetterAndSetterProperty =
	new ClassImplementsObjectWithMatchedGetterAndSetterProperty();
interface ObjectWithMismatchedGetterAndSetterProperty {
	get property(): number;
	set property(v: string);
}
class ClassImplementsObjectWithMismatchedGetterAndSetterProperty
	implements ObjectWithMismatchedGetterAndSetterProperty
{
	public get property(): number {
		throw new Error(
			"ClassImplementsObjectWithMismatchedGetterAndSetterProperty reading 'property'",
		);
		return 3;
	}
	public set property(v: string) {
		throw new Error(
			`ClassImplementsObjectWithMismatchedGetterAndSetterProperty writing 'property' as ${v}`,
		);
	}
}
export const objectWithMismatchedGetterAndSetterProperty: ObjectWithMismatchedGetterAndSetterProperty =
	new ClassImplementsObjectWithMismatchedGetterAndSetterProperty();
export const objectWithMismatchedGetterAndSetterPropertyViaValue: ObjectWithMismatchedGetterAndSetterProperty =
	{ property: 0 };

// #region Index(`Record`) signature types
// Records and directly declared index types (`{[x: type]: type}`) can have
// different treatment. `Record`s generally fair better but won't allow self
// references; so, later self-references are declared with direct index types.

export const stringRecordOfNumbers: Record<string, number> = { key: 0 };
export const stringRecordOfUndefined: Record<string, undefined> = { key: undefined };
export const stringRecordOfNumberOrUndefined: Record<string, number | undefined> = {
	number,
	undefined,
};
export const stringRecordOfSymbolOrBoolean: Record<string, symbol | boolean> = {
	boolean,
	symbol,
};
export const stringRecordOfUnknown: Record<string, unknown> = { key: 0 };
export const stringOrNumberRecordOfStrings: Record<string | number, string> = { 5: "value" };
export const stringOrNumberRecordOfObjects: Record<string | number, { string: string }> = {
	8: { string: "string value" },
	knownNumber: { string: "4" },
};
// Ideally TypeScript would not allow this assignment. Index signatures are
// inherently optional and modification via `Partial` should not modify the
// type (particularly under exactOptionalPropertyTypes=true).
// See https://github.com/microsoft/TypeScript/issues/46969
export const partialStringRecordOfNumbers: Partial<Record<string, number>> = {
	key1: 0,
	key2: undefined,
};
export const partialStringRecordOfUnknown: Partial<Record<string, unknown>> = { key: 0 };
// @ts-expect-error These types are not intended to be identical; so error is expected...
assertIdenticalTypes(partialStringRecordOfUnknown, {});
// Unfortunately the inverse test fails. An IfSameType check of the two types is unstable.
// Results appear to vary on presence of prior uses, but injecting prior uses did not
// provide desired consistency either.
assertIdenticalTypes({}, partialStringRecordOfUnknown);

export const templatedRecordOfNumbers: Record<`key${number}`, number> = { key1: 0 };
// This assignment should not be allowed. See partialStringRecordOfNumbers comments.
export const partialTemplatedRecordOfNumbers: Partial<Record<`key${number}`, number>> = {
	key1: 0,
	key2: undefined,
};
export const templatedRecordOfUnknown: Record<`${string}Key`, unknown> = {
	aKey: '"unknown" value',
};
export const mixedRecordOfUnknown: Record<
	`aKey` | `bKey_${string | number}` | number,
	unknown
> = {
	aKey: '"unknown" value',
};

// Must use `type` over `interface` to enable intersection with `Record<>`.
type KnownStringAndNumber = { knownString: string; knownNumber: number };
export const stringRecordOfNumbersOrStringsWithKnownProperties: InternalUtilityTypes.FlattenIntersection<
	Record<string, number | string> & KnownStringAndNumber
> = { key: 0, knownString: "string value", knownNumber: 4 };
export const stringRecordOfUnknownWithKnownProperties: InternalUtilityTypes.FlattenIntersection<
	Record<string, unknown> & KnownStringAndNumber
> = { key: 0, knownString: "string value", knownNumber: 4 };
export const partialStringRecordOfUnknownWithKnownProperties: InternalUtilityTypes.FlattenIntersection<
	Partial<Record<string, unknown>> & KnownStringAndNumber
> = stringRecordOfUnknownWithKnownProperties;
export const stringRecordOfUnknownWithOptionalKnownProperties: InternalUtilityTypes.FlattenIntersection<
	Record<string, unknown> & { knownString?: string; knownNumber?: number }
> = { key: undefined, knownString: "string value" };
export const stringRecordOfUnknownWithKnownUnknown: InternalUtilityTypes.FlattenIntersection<
	Record<string, unknown> & { knownUnknown: unknown }
> = { key: 0, knownUnknown: "unknown value" };
export const stringRecordOfUnknownWithOptionalKnownUnknown: InternalUtilityTypes.FlattenIntersection<
	Record<string, unknown> & { knownUnknown?: unknown }
> = stringRecordOfUnknownWithKnownUnknown;
type StringOrNumberRecordOfStringsWithKnownNumber_UnassignableType =
	InternalUtilityTypes.FlattenIntersection<
		Record<string | number, string> & { knownNumber: number }
	>;
export const stringOrNumberRecordOfStringWithKnownNumber = {
	8: "string value",
	knownNumber: 4,
} as unknown as StringOrNumberRecordOfStringsWithKnownNumber_UnassignableType;
type StringOrNumberRecordOfUndefinedWithKnownNumber_UnassignableType =
	InternalUtilityTypes.FlattenIntersection<
		Record<string | number, undefined> & { knownNumber: number }
	>;
export const stringOrNumberRecordOfUndefinedWithKnownNumber = {
	5: undefined,
	knownNumber: 4,
} as unknown as StringOrNumberRecordOfUndefinedWithKnownNumber_UnassignableType;

// #endregion

// #region Recursive types

type ObjectWithPossibleRecursion = {
	[x: string]: ObjectWithPossibleRecursion | string;
};
export const objectWithPossibleRecursion: ObjectWithPossibleRecursion = {
	recursive: { stop: "here" },
};
export type ObjectWithOptionalRecursion = {
	recursive?: ObjectWithOptionalRecursion;
};
export const objectWithOptionalRecursion: ObjectWithOptionalRecursion = {
	recursive: {},
};
export type ReadonlyObjectWithOptionalRecursion = {
	readonly recursive?: ReadonlyObjectWithOptionalRecursion;
};
export const readonlyObjectWithOptionalRecursion: ReadonlyObjectWithOptionalRecursion =
	objectWithOptionalRecursion;

export const objectWithEmbeddedRecursion = {
	outer: objectWithOptionalRecursion,
};
export const readonlyObjectWithEmbeddedRecursion = {
	outer: readonlyObjectWithOptionalRecursion,
} as const;
export const objectWithSelfReference: ObjectWithOptionalRecursion = {};
objectWithSelfReference.recursive = objectWithSelfReference;

type ObjectWithAlternatingRecursionA = {
	recurseA: ObjectWithAlternatingRecursionB | number;
};
type ObjectWithAlternatingRecursionB = {
	recurseB: ObjectWithAlternatingRecursionA | "stop";
};
export const objectWithAlternatingRecursion: ObjectWithAlternatingRecursionA = {
	recurseA: {
		recurseB: {
			recurseA: {
				recurseB: "stop",
			},
		},
	},
};
type ReadonlyObjectWithAlternatingRecursionA = {
	readonly recurseA: ReadonlyObjectWithAlternatingRecursionB | number;
};
type ReadonlyObjectWithAlternatingRecursionB = {
	readonly recurseB: ReadonlyObjectWithAlternatingRecursionA | "stop";
};
export const readonlyObjectWithAlternatingRecursion: ReadonlyObjectWithAlternatingRecursionA =
	objectWithAlternatingRecursion;

export type ObjectWithSymbolOrRecursion = {
	recurse: ObjectWithSymbolOrRecursion | symbol;
};
export const objectWithSymbolOrRecursion: ObjectWithSymbolOrRecursion = {
	recurse: { recurse: Symbol("stop") },
};
type ReadonlyObjectWithSymbolOrRecursion = {
	readonly recurse: ReadonlyObjectWithSymbolOrRecursion | symbol;
};
export const readonlyObjectWithSymbolOrRecursion: ReadonlyObjectWithSymbolOrRecursion =
	objectWithSymbolOrRecursion;

type ObjectWithFluidHandleOrRecursion = {
	recurseToHandle: ObjectWithFluidHandleOrRecursion | IFluidHandle<string>;
};
export const objectWithFluidHandleOrRecursion: ObjectWithFluidHandleOrRecursion = {
	recurseToHandle: { recurseToHandle: "fake-handle" as unknown as IFluidHandle<string> },
};
type ReadonlyObjectWithFluidHandleOrRecursion = {
	readonly recurseToHandle:
		| ReadonlyObjectWithFluidHandleOrRecursion
		| Readonly<IFluidHandle<string>>;
};
export const readonlyObjectWithFluidHandleOrRecursion: ReadonlyObjectWithFluidHandleOrRecursion =
	objectWithFluidHandleOrRecursion;

export const objectWithUnknownAdjacentToOptionalRecursion = {
	unknown: unknownValueOfSimpleRecord,
	outer: objectWithOptionalRecursion,
};
type ObjectWithOptionalUnknownAdjacentToOptionalRecursion = {
	unknown?: unknown;
	outer: ObjectWithOptionalRecursion;
};
export const objectWithOptionalUnknownAdjacentToOptionalRecursion: ObjectWithOptionalUnknownAdjacentToOptionalRecursion =
	objectWithUnknownAdjacentToOptionalRecursion;
type ObjectWithUnknownInOptionalRecursion = {
	unknown: unknown;
	recurse?: ObjectWithUnknownInOptionalRecursion;
};
export const objectWithUnknownInOptionalRecursion: ObjectWithUnknownInOptionalRecursion = {
	unknown: 458,
	recurse: { unknown: "nested-value" },
};

type ObjectWithOptionalUnknownInOptionalRecursion = {
	unknown?: unknown;
	recurse?: ObjectWithOptionalUnknownInOptionalRecursion;
};
export const objectWithOptionalUnknownInOptionalRecursion: ObjectWithOptionalUnknownInOptionalRecursion =
	objectWithUnknownInOptionalRecursion;

type StringRecordWithRecursionOrNumber = {
	[x: string]: StringRecordWithRecursionOrNumber | number;
};
export const stringRecordWithRecursionOrNumber: StringRecordWithRecursionOrNumber = {
	outer: { inner: 5 },
};
type ReadonlyStringRecordWithRecursionOrNumber = {
	readonly [x: string]: ReadonlyStringRecordWithRecursionOrNumber | number;
};
export const readonlyStringRecordWithRecursionOrNumber: ReadonlyStringRecordWithRecursionOrNumber =
	stringRecordWithRecursionOrNumber;

export type SelfRecursiveFunctionWithProperties = (() => number) & {
	recurse?: SelfRecursiveFunctionWithProperties;
};
export const selfRecursiveFunctionWithProperties: SelfRecursiveFunctionWithProperties =
	Object.assign(() => 0, { recurse: Object.assign(() => 1, { recurse: () => 2 }) });
export type SelfRecursiveObjectAndFunction = {
	recurse?: SelfRecursiveObjectAndFunction;
} & (() => number);
export const selfRecursiveObjectAndFunction: SelfRecursiveObjectAndFunction =
	// eslint-disable-next-line prefer-object-spread
	Object.assign({ recurse: Object.assign({ recurse: () => 2 }, () => 1) }, () => 0);
// Visualization of the two types appear different in ordering of intersection.
// There is no known way to distinguish the two at compile time nor does tsc prevent
// assignment of one to the other.
assertIdenticalTypes(selfRecursiveObjectAndFunction, selfRecursiveFunctionWithProperties);

export type ReadonlySelfRecursiveFunctionWithProperties = (() => number) & {
	readonly recurse?: ReadonlySelfRecursiveFunctionWithProperties;
};
export const readonlySelfRecursiveFunctionWithProperties: ReadonlySelfRecursiveFunctionWithProperties =
	selfRecursiveFunctionWithProperties;
export type ReadonlySelfRecursiveObjectAndFunction = {
	readonly recurse?: ReadonlySelfRecursiveObjectAndFunction;
} & (() => number);
export const readonlySelfRecursiveObjectAndFunction: ReadonlySelfRecursiveObjectAndFunction =
	selfRecursiveObjectAndFunction;

interface ObjectInheritingOptionalRecursionAndWithNestedSymbol
	extends ObjectWithOptionalRecursion {
	complex: {
		number: number;
		symbol: symbol;
	};
}
export const objectInheritingOptionalRecursionAndWithNestedSymbol: ObjectInheritingOptionalRecursionAndWithNestedSymbol =
	{
		recursive: {
			recursive: {
				recursive: {},
			},
		},
		complex: {
			number: 0,
			symbol: Symbol("symbol"),
		},
	};

export const simpleJson: JsonTypeWith<never> = { a: [{ b: { b2: 8 }, c: true }] };
export const simpleImmutableJson: ReadonlyJsonTypeWith<never> = simpleJson;

export const jsonObject: NonNullJsonObjectWith<never> = [simpleJson];
export const immutableJsonObject: ReadonlyNonNullJsonObjectWith<never> = jsonObject;

// #endregion

// #region with literal types
export const objectWithLiterals = {
	true: true,
	false: false,
	zero: 0,
	string: "string",
	null: null,
} as const;
export const tupleWithLiterals = [true, false, 0, "string", null, 1e113] as const;
export const arrayOfLiterals: readonly (
	| true
	| 0
	| 1
	| "string"
	| "hello"
	// eslint-disable-next-line @rushstack/no-new-null
	| null
)[] = [true, 0, 1, "string", "hello", null];
// #endregion

// #region Class types
export class ClassWithPrivateData {
	public public = "public";
	// @ts-expect-error secret is never read
	private readonly secret = 0;
}
export const classInstanceWithPrivateData = new ClassWithPrivateData();
export class ClassWithPrivateMethod {
	public public = "public";
	// @ts-expect-error getSecret is never read
	private getSecret(): number {
		return 0;
	}
}
export const classInstanceWithPrivateMethod = new ClassWithPrivateMethod();
export class ClassWithPrivateGetter {
	public public = "public";
	// @ts-expect-error secret is never read
	private get secret(): number {
		return this.public.length;
	}
}
export const classInstanceWithPrivateGetter = new ClassWithPrivateGetter();
export class ClassWithPrivateSetter {
	public public = "public";
	// @ts-expect-error secret is never read
	private set secret(v: string) {
		this.public = v;
	}
}
export const classInstanceWithPrivateSetter = new ClassWithPrivateSetter();
export class ClassWithPublicData {
	public public = "public";
}
export const classInstanceWithPublicData = new ClassWithPublicData();
export class ClassWithPublicMethod {
	public public = "public";
	public getSecret(): number {
		return 0;
	}
}
export const classInstanceWithPublicMethod = new ClassWithPublicMethod();

export const functionObjectWithPrivateData = Object.assign(
	() => 23,
	new ClassWithPrivateData(),
);
export const functionObjectWithPublicData = Object.assign(() => 24, new ClassWithPublicData());
export const classInstanceWithPrivateDataAndIsFunction = Object.assign(
	new ClassWithPrivateData(),
	() => 25,
);
export const classInstanceWithPublicDataAndIsFunction = Object.assign(
	new ClassWithPublicData(),
	() => 26,
);

type ObjectWithClassWithPrivateDataInOptionalRecursion = {
	class: ClassWithPrivateData;
	recurse?: ObjectWithClassWithPrivateDataInOptionalRecursion;
};
export const objectWithClassWithPrivateDataInOptionalRecursion: ObjectWithClassWithPrivateDataInOptionalRecursion =
	{
		class: classInstanceWithPrivateData,
		recurse: { class: classInstanceWithPrivateData },
	};

// #region Built-in Class types

export type Point = { x: number; y: number };
export type StringRecordOfPoints = {
	[p: string]: Point;
};

export const mapOfStringsToNumbers = new Map<string, number>();
export const readonlyMapOfStringsToNumbers: ReadonlyMap<string, number> =
	mapOfStringsToNumbers;
export const mapOfPointToRecord = new Map<Point, StringRecordOfPoints>();
export const readonlyMapOfPointToRecord: ReadonlyMap<Point, StringRecordOfPoints> =
	mapOfPointToRecord;
export const setOfNumbers = new Set<number>();
export const readonlySetOfNumbers: ReadonlySet<number> = setOfNumbers;
export const setOfRecords = new Set<StringRecordOfPoints>();
export const readonlySetOfRecords: ReadonlySet<StringRecordOfPoints> = setOfRecords;

// #endregion

// #endregion

// #region Branded types

export const brandedNumber = 0 as number & BrandedType<"zero">;
export const brandedString = "encoding" as string & BrandedType<"encoded">;
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
export const brandedObject = {} as object & BrandedType<"its a secret">;
export const brandedObjectWithString = objectWithString as typeof objectWithString &
	BrandedType<"metadata">;

export const objectWithBrandedNumber = { brandedNumber };
export const objectWithBrandedString = { brandedString };

export const brandedStringIndexOfBooleans: { [x: string & BrandedType<"encoded">]: boolean } =
	{
		[brandedString]: false,
	};
// TypeScript has different treatment for index types such that duck-typing
// doesn't fully apply. These recreations are a bit different.
export const brandedStringAliasIndexOfBooleans: { [x: BrandedString]: boolean } =
	brandedStringIndexOfBooleans;
// @ts-expect-error - while the same, aliased index is not treated as same (just confirm)
assertIdenticalTypes(brandedStringAliasIndexOfBooleans, brandedStringIndexOfBooleans);
export const brandedStringRecordOfBooleans: Record<string & BrandedType<"encoded">, boolean> =
	brandedStringIndexOfBooleans;
export const brandedStringAliasRecordOfBooleans: Record<BrandedString, boolean> =
	brandedStringIndexOfBooleans;
// Records don't have the same aliased index issue
assertIdenticalTypes(brandedStringAliasRecordOfBooleans, brandedStringRecordOfBooleans);

// There is an unknown difference in handling of objects with number or string values compared
// to booleans and objects. (number or string valued cases did not have problems where boolean
// of object valued cases did. A scan of logic for values did not reveal special treatment of
// `string` or `number` compared to `boolean`. Since strings of numbers are possible key types
// there maybe some accidental key type check having an impact.)
export const brandedStringIndexOfNumbers: { [x: string & BrandedType<"encoded">]: number } = {
	[brandedString]: 5,
};
export type BrandedString = string & BrandedType<"encoded">;
export const brandedStringAliasIndexOfNumbers: { [x: BrandedString]: number } =
	brandedStringIndexOfNumbers;
// @ts-expect-error - while the same, aliased index is not treated as same (just confirm)
assertIdenticalTypes(brandedStringAliasIndexOfNumbers, brandedStringIndexOfNumbers);
export const brandedStringRecordOfNumbers: Record<string & BrandedType<"encoded">, number> =
	brandedStringIndexOfNumbers;
export const brandedStringAliasRecordOfNumbers: Record<BrandedString, number> =
	brandedStringIndexOfNumbers;
// Records don't have the same aliased index issue
assertIdenticalTypes(brandedStringAliasRecordOfNumbers, brandedStringRecordOfNumbers);

export const brandedStringAliasIndexOfTrueOrUndefined: {
	[x: BrandedString]: true | undefined;
} = {
	[brandedString]: undefined,
};

// #region Example Data Store
// This test mimics aspects of structures used in Presence protocol.
interface DecodedValueRequiredState<TValue> {
	value: TValue;
}
interface DecodedValueOptionalState<T> {
	value?: T;
}
interface DecodedValueDirectory<T> {
	items: {
		[name: string | number]: DecodedValueOptionalState<T> | DecodedValueDirectory<T>;
	};
}
export type DecodedValueDirectoryOrRequiredState<T> =
	| DecodedValueDirectory<T>
	| DecodedValueRequiredState<T>;
export type BrandedKey = string & BrandedType<"typed-key">;
type DataStore = {
	[k: string]: {
		[x: BrandedKey]: DecodedValueDirectoryOrRequiredState<OpaqueJsonDeserialized<unknown>>;
	};
};

export const datastore: DataStore = { outer: {} };
// #endregion
// #endregion

// #region Fluid types

function makeFauxFluidHandle<T>(): IFluidHandle<T> {
	return {
		isAttached: false,
		async get(): Promise<T> {
			throw new Error("Function not implemented.");
		},
		[fluidHandleSymbol]: undefined as unknown as IFluidHandleErased<T>,
	};
}

export const fluidHandleToNumber = makeFauxFluidHandle<number>();
export const fluidHandleToRecord = makeFauxFluidHandle<{
	[p: string]: { x: number; y: number };
}>();

export const objectWithFluidHandle = {
	handle: fluidHandleToNumber,
};

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface TestErasedType<T> extends ErasedType<readonly ["TestCustomType", T]> {}

export const erasedType = 0 as unknown as TestErasedType<number>;

export const opaqueSerializableObject = objectWithNumber as unknown as OpaqueJsonSerializable<
	typeof objectWithNumber
>;
export const opaqueDeserializedObject = objectWithNumber as unknown as OpaqueJsonDeserialized<
	typeof objectWithNumber
>;
export const opaqueSerializableAndDeserializedObject =
	objectWithNumber as unknown as OpaqueJsonSerializable<typeof objectWithNumber> &
		OpaqueJsonDeserialized<typeof objectWithNumber>;

export const opaqueSerializableUnknown =
	opaqueSerializableObject as OpaqueJsonSerializable<unknown>;
export const opaqueDeserializedUnknown =
	opaqueDeserializedObject as OpaqueJsonDeserialized<unknown>;
export const opaqueSerializableAndDeserializedUnknown =
	opaqueSerializableAndDeserializedObject as OpaqueJsonSerializable<unknown> &
		OpaqueJsonDeserialized<unknown>;

export const objectWithOpaqueSerializableUnknown = {
	opaque: opaqueSerializableUnknown,
};
export const objectWithOpaqueDeserializedUnknown = {
	opaque: opaqueDeserializedUnknown,
};
export const objectWithOpaqueSerializableAndDeserializedUnknown = {
	opaque: opaqueSerializableAndDeserializedUnknown,
};

interface OptionalValue<TValue> {
	value?: TValue;
}

export interface DirectoryOfValues<TValue> {
	items: {
		[name: string | number]: OptionalValue<TValue> | DirectoryOfValues<TValue>;
	};
}

export const opaqueSerializableInRecursiveStructure: DirectoryOfValues<
	OpaqueJsonSerializable<unknown>
> = {
	items: {
		item1: {},
		item2: { items: { subItem1: {} } },
	},
};

export const opaqueDeserializedInRecursiveStructure: DirectoryOfValues<
	OpaqueJsonDeserialized<unknown>
> = {
	items: {
		item1: {},
		item2: { items: { subItem1: {} } },
	},
};

export const opaqueSerializableAndDeserializedInRecursiveStructure: DirectoryOfValues<
	OpaqueJsonSerializable<unknown> & OpaqueJsonDeserialized<unknown>
> = {
	items: {
		item1: {},
		item2: { items: { subItem1: {} } },
	},
};

export const opaqueSerializableObjectRequiringBigintSupport =
	objectWithBigint as unknown as OpaqueJsonSerializable<typeof objectWithBigint, [bigint]>;
export const opaqueDeserializedObjectRequiringBigintSupport =
	objectWithBigint as unknown as OpaqueJsonDeserialized<typeof objectWithBigint, [bigint]>;
export const opaqueSerializableAndDeserializedObjectRequiringBigintSupport =
	objectWithBigint as unknown as OpaqueJsonSerializable<typeof objectWithBigint, [bigint]> &
		OpaqueJsonDeserialized<typeof objectWithBigint, [bigint]>;

// These values are branded as expecting `bigint` support, but they don't actually require it.
export const opaqueSerializableObjectExpectingBigintSupport =
	objectWithReadonlyArrayOfNumbers as unknown as OpaqueJsonSerializable<
		typeof objectWithReadonlyArrayOfNumbers,
		[bigint]
	>;
export const opaqueDeserializedObjectExpectingBigintSupport =
	objectWithReadonlyArrayOfNumbers as unknown as OpaqueJsonDeserialized<
		typeof objectWithReadonlyArrayOfNumbers,
		[bigint]
	>;
export const opaqueSerializableAndDeserializedObjectExpectingBigintSupport =
	objectWithReadonlyArrayOfNumbers as unknown as OpaqueJsonSerializable<
		typeof objectWithReadonlyArrayOfNumbers,
		[bigint]
	> &
		OpaqueJsonDeserialized<typeof objectWithReadonlyArrayOfNumbers, [bigint]>;

// #endregion

/* eslint-enable @typescript-eslint/consistent-type-definitions */
/* eslint-enable unicorn/no-null */
/* eslint-enable jsdoc/require-jsdoc */
