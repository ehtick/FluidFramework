/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "node:assert";
import {
	MockHandle,
	validateAssertionError,
} from "@fluidframework/test-runtime-utils/internal";
import { isStableId } from "@fluidframework/id-compressor/internal";

import { type NormalizedUpPath, rootFieldKey } from "../../../core/index.js";
import {
	jsonableTreeFromFieldCursor,
	MockNodeIdentifierManager,
	TreeStatus,
	type StableNodeIdentifier,
} from "../../../feature-libraries/index.js";
import {
	type InsertableField,
	type InsertableTreeNodeFromImplicitAllowedTypes,
	isTreeNode,
	type NodeFromSchema,
	SchemaFactory,
	SchemaFactoryAlpha,
	toStoredSchema,
	treeNodeApi as Tree,
	TreeBeta,
	type TreeChangeEvents,
	type TreeLeafValue,
	type TreeNode,
	TreeViewConfiguration,
	unhydratedFlexTreeFromInsertable,
	type UnsafeUnknownSchema,
	type VerboseTree,
} from "../../../simple-tree/index.js";
import {
	checkoutWithContent,
	chunkFromJsonableTrees,
	fieldCursorFromInsertable,
	getView,
	testIdCompressor,
	TestTreeProviderLite,
	validateUsageError,
} from "../../utils.js";
import { describeHydration, getViewForForkedBranch, hydrate } from "../utils.js";
import { brand, type areSafelyAssignable, type requireTrue } from "../../../util/index.js";

import {
	booleanSchema,
	handleSchema,
	nullSchema,
	numberSchema,
	stringSchema,
	// eslint-disable-next-line import/no-internal-modules
} from "../../../simple-tree/leafNodeSchema.js";
// eslint-disable-next-line import/no-internal-modules
import { tryGetSchema } from "../../../simple-tree/api/treeNodeApi.js";
import {
	testDocumentIndependentView,
	testDocuments,
	testSimpleTrees,
} from "../../testTrees.js";
import { FluidClientVersion } from "../../../codec/index.js";
import { ajvValidator } from "../../codec/index.js";
import {
	SchematizingSimpleTreeView,
	TreeAlpha,
	type TreeCheckout,
	type TreeStoredContent,
} from "../../../shared-tree/index.js";
import { FieldKinds } from "../../../feature-libraries/index.js";
import {
	createField,
	UnhydratedFlexTreeNode,
	type Context,
	// eslint-disable-next-line import/no-internal-modules
} from "../../../simple-tree/core/index.js";
// eslint-disable-next-line import/no-internal-modules
import { getUnhydratedContext } from "../../../simple-tree/createContext.js";
// eslint-disable-next-line import/no-internal-modules
import { createTreeNodeFromInner } from "../../../simple-tree/core/treeNodeKernel.js";
// eslint-disable-next-line import/no-internal-modules
import { fieldCursorFromVerbose } from "../../../simple-tree/api/verboseTree.js";

const schema = new SchemaFactoryAlpha("com.example");

class Point extends schema.object("Point", {}) {}

describe("treeNodeApi", () => {
	describe("is", () => {
		it("is", () => {
			const config = new TreeViewConfiguration({ schema: [Point, schema.number] });
			const view = getView(config);
			view.initialize({});
			const { root } = view;
			assert(Tree.is(root, Point));
			assert(root instanceof Point);
			assert(!Tree.is(root, schema.number));
			assert(Tree.is(5, schema.number));
			assert(!Tree.is(root, schema.number));
			assert(!Tree.is(5, Point));

			const NotInDocument = schema.object("never", {});
			// Using a schema that is not in the document works:
			assert(!Tree.is(root, NotInDocument));
		});

		it("`is` can narrow polymorphic leaf field content", () => {
			const config = new TreeViewConfiguration({ schema: [schema.number, schema.string] });
			const view = getView(config);
			view.initialize("x");
			const { root } = view;
			if (Tree.is(root, schema.number)) {
				const _check: number = root;
				assert.fail();
			} else {
				const value: string = root;
				assert.equal(value, "x");
			}
		});

		it("`is` can narrow polymorphic combinations of value and objects", () => {
			const config = new TreeViewConfiguration({ schema: [Point, schema.string] });
			const view = getView(config);
			view.initialize("x");
			const { root } = view;
			if (Tree.is(root, Point)) {
				const _check: Point = root;
				assert.fail();
			} else {
				const value: string = root;
				assert.equal(value, "x");
			}
		});

		it("`is` can handle leaves", () => {
			// true case for primitive
			assert(Tree.is(5, schema.number));
			// non-leaf primitives
			assert(!Tree.is(BigInt(5), schema.number));
			assert(!Tree.is(Symbol(), schema.number));
			// non-node objects
			assert(!Tree.is({}, schema.number));
			assert(!Tree.is(Tree, schema.null));
			// node to leaf
			assert(!Tree.is(hydrate(Point, {}), schema.number));
			// null: its a special case since its sorta an object
			assert(!Tree.is(null, schema.number));
			assert(Tree.is(null, schema.null));
			// handle: its a special case since it is an object but not a node
			assert(!Tree.is(null, schema.handle));
			assert(Tree.is(new MockHandle(1), schema.handle));
		});

		it("supports allowed types", () => {
			assert(!Tree.is(5, []));
			assert(!Tree.is(5, [schema.string]));
			assert(Tree.is(5, [schema.string, schema.number]));
		});

		it("errors on base type", () => {
			const Base = schema.object("Test", {});
			class Derived extends Base {}
			const node = new Derived({});
			// Check instanceof alternative works:
			assert(node instanceof Base);
			assert.throws(
				() => Tree.is(node, Base),
				validateUsageError(
					/Two schema classes were used \(CustomObjectNode and Derived\) which derived from the same SchemaFactory generated class \("com.example.Test"\)/,
				),
			);
		});
	});

	describe("schema", () => {
		it("primitives", () => {
			assert.equal(Tree.schema(5), numberSchema);
			assert.equal(Tree.schema(""), stringSchema);
			assert.equal(Tree.schema(true), booleanSchema);
			assert.equal(Tree.schema(new MockHandle(5)), handleSchema);
			assert.equal(Tree.schema(null), nullSchema);
			assert.equal(tryGetSchema({}), undefined);
		});

		it("unhydrated node", () => {
			assert.equal(Tree.schema(new Point({})), Point);
			const nodePojo = schema.object("Node", {});
			assert.equal(Tree.schema(new nodePojo({})), nodePojo);
		});

		it("hydrated node", () => {
			assert.equal(Tree.schema(hydrate(Point, {})), Point);
		});
	});

	describeHydration("upward path", (init) => {
		for (const [name, keyApi] of [
			["key", (n: TreeNode): string | undefined | number => Tree.key(n)],
			["key2", (n: TreeNode): string | undefined | number => TreeAlpha.key2(n)],
		] as const) {
			it(name, () => {
				class Child extends schema.object("Child", {
					x: Point,
					y: schema.optional(Point, { key: "stable-y" }),
				}) {}
				class Root extends schema.array("Root", Child) {}
				const root = init(Root, [
					{ x: {}, y: undefined },
					{ x: {}, y: {} },
				]);

				// This is this how we handle root keys.
				// Seems odd for detached fields other than root to have `rootFieldKey` key though.
				// Exactly which key is given in this case is undocumented, it could change in the future.
				// TreeAlpha.key2 just gives undefined, which is documented.
				const rootKey = name === "key" ? rootFieldKey : undefined;

				assert.equal(keyApi(root), rootKey);
				assert.equal(keyApi(root[0]), 0);
				assert.equal(keyApi(root[0].x), "x");
				assert.equal(keyApi(root[1]), 1);
				assert.equal(keyApi(root[1].x), "x");
				assert(root[1].y !== undefined);
				assert.equal(keyApi(root[1].y), "y");

				const added = new Child({ x: {}, y: {} });

				assert.equal(keyApi(added), rootKey);

				// Check index is updated after insert.
				root.insertAtStart(added);
				assert.equal(keyApi(root[2]), 2);
				assert.equal(keyApi(added), 0);

				// Check index is updated after removal.
				root.removeRange(0, 1);
				assert.equal(keyApi(root[1]), 1);
				assert.equal(keyApi(added), rootKey);
			});
		}

		it("parent", () => {
			class Child extends schema.object("Child", { x: Point }) {}
			class Root extends schema.array("Root", Child) {}
			const config = new TreeViewConfiguration({ schema: Root });
			const view = getView(config);
			const root = new Root([{ x: {} }, { x: {} }]);
			view.initialize(root);

			assert.equal(Tree.parent(root), undefined);
			assert.equal(Tree.parent(root[0]), root);
			assert.equal(Tree.parent(root[1]), root);
			assert.equal(Tree.parent(root[1].x), root[1]);

			const added = new Child({ x: {} });

			assert.equal(Tree.parent(added), undefined);
			root.insertAtStart(added);
			assert.equal(Tree.parent(added), root);
			root.removeRange(0, 1);
			assert.equal(Tree.parent(added), undefined);

			view.dispose();
			assert.throws(
				() => Tree.parent(root),
				validateUsageError(/Cannot access a deleted node/),
			);
		});

		it("key", () => {
			class Child extends schema.object("Child", { x: Point }) {}
			class Root extends schema.array("Root", Child) {}
			const config = new TreeViewConfiguration({ schema: Root });
			const view = getView(config);
			const root = new Root([{ x: {} }, { x: {} }]);
			view.initialize(root);

			assert.equal(Tree.key(root), rootFieldKey);
			assert.equal(Tree.key(root[0]), 0);
			assert.equal(Tree.key(root[1]), 1);
			assert.equal(Tree.key(root[1].x), "x");

			const added = new Child({ x: {} });

			assert.equal(Tree.key(added), rootFieldKey);
			root.insertAtStart(added);
			assert.equal(Tree.key(added), 0);
			root.removeRange(0, 1);
			assert.equal(Tree.key(added), rootFieldKey);

			view.dispose();
			assert.throws(() => Tree.key(root), validateUsageError(/Cannot access a deleted node/));
		});
	});

	it("treeStatus", () => {
		class Root extends schema.object("Root", { x: Point }) {}
		const config = new TreeViewConfiguration({ schema: Root });
		const view = getView(config);
		view.initialize({ x: {} });
		const { root } = view;
		const child = root.x;
		const newChild = new Point({});
		assert.equal(Tree.status(root), TreeStatus.InDocument);
		assert.equal(Tree.status(child), TreeStatus.InDocument);
		assert.equal(Tree.status(newChild), TreeStatus.New);
		root.x = newChild;
		assert.equal(Tree.status(root), TreeStatus.InDocument);
		assert.equal(Tree.status(child), TreeStatus.Removed);
		assert.equal(Tree.status(newChild), TreeStatus.InDocument);

		view.dispose();
		assert.equal(Tree.status(root), TreeStatus.Deleted);
		assert.equal(Tree.status(child), TreeStatus.Deleted);
		assert.equal(Tree.status(newChild), TreeStatus.Deleted);

		// TODO: test Deleted status when caused by removal from the tree + expiring from removed status.
	});

	describe("child", () => {
		describe("object", () => {
			it("Simple", () => {
				class TestObject extends schema.object("TestObject", {
					foo: schema.string,
					bar: schema.optional(schema.string),
					"0": schema.number,
					"1": SchemaFactory.optional(schema.number),
				}) {}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize({
					foo: "test",
					0: 42,
				});
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "foo"), "test");
				assert.equal(TreeAlpha.child(tree, 0), 42);
				assert.equal(TreeAlpha.child(tree, "0"), 42);

				assert.equal(TreeAlpha.child(tree, "bar"), undefined);
				assert.equal(TreeAlpha.child(tree, 1), undefined);
				assert.equal(TreeAlpha.child(tree, "1"), undefined);

				assert.equal(TreeAlpha.child(tree, "baz"), undefined);
				assert.equal(TreeAlpha.child(tree, 2), undefined);
				assert.equal(TreeAlpha.child(tree, "2"), undefined);
			});

			it("IDs of unhydrated nodes are considered", () => {
				class TestObject extends schema.object("TestObject", {
					id: schema.identifier,
				}) {}
				const tree: TestObject = new TestObject({});

				assert(TreeAlpha.child(tree, "id") !== undefined);
			});

			it("Fields are accessed by property key and not stored key", () => {
				class TestObject extends schema.object("TestObject", {
					foo: SchemaFactory.optional(schema.string, { key: "bar" }),
				}) {}
				const tree: TestObject = new TestObject({
					foo: "Hello world!",
				});

				assert(TreeAlpha.child(tree, "foo") === "Hello world!");
				assert(TreeAlpha.child(tree, "bar") === undefined);
			});

			it("Unknown optional fields not considered", () => {
				class TestObjectOld extends schema.objectAlpha(
					"TestObject",
					{
						foo: schema.string,
					},
					{
						allowUnknownOptionalFields: true,
					},
				) {}

				class TestObjectNew extends schema.objectAlpha("TestObject", {
					foo: schema.string,
					bar: schema.optional(schema.string),
				}) {}

				const oldViewConfig = new TreeViewConfiguration({
					schema: TestObjectOld,
				});
				const newViewConfig = new TreeViewConfiguration({
					schema: TestObjectNew,
				});

				const checkoutWithNewSchema = checkoutWithInitialTree(
					newViewConfig,
					new TestObjectNew({ foo: "Hello", bar: "World" }),
				);

				const viewWithOldSchema = new SchematizingSimpleTreeView(
					checkoutWithNewSchema,
					oldViewConfig,
					new MockNodeIdentifierManager(),
				);

				assert(viewWithOldSchema.compatibility.canView);

				const tree = viewWithOldSchema.root;

				assert.equal(TreeAlpha.child(tree, "foo"), "Hello");
				assert.equal(TreeAlpha.child(tree, "bar"), undefined);
			});

			it("Subclass properties are not considered", () => {
				class TestObject extends schema.object("TestObject", {
					foo: schema.string,
				}) {
					public readonly bar: string = "Bar";
				}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize({
					foo: "test",
				});
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "bar"), undefined);
			});

			it("Shadowed properties", () => {
				class TestObject extends schema.object("TestObject", {
					toString: schema.string,
				}) {}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize({
					toString: "test",
				});
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "toString"), "test");
			});

			it("Recursive", () => {
				class TestObject extends schema.objectRecursive("TestObject", {
					label: schema.string,
					data: schema.optionalRecursive([() => TestObject]),
				}) {}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize(
					new TestObject({
						label: "A",
						data: new TestObject({
							label: "B",
							data: new TestObject({
								label: "C",
								data: undefined,
							}),
						}),
					}),
				);
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "label"), "A");
				assert.equal(TreeAlpha.child(tree, "foo"), undefined);
				assert.equal(TreeAlpha.child(tree, 0), undefined);

				const b = TreeAlpha.child(tree, "data");
				assert(b !== undefined && isTreeNode(b));

				assert.equal(TreeAlpha.child(b, "label"), "B");
				assert.equal(TreeAlpha.child(b, "foo"), undefined);
				assert.equal(TreeAlpha.child(b, 0), undefined);

				const c = TreeAlpha.child(b, "data");
				assert(c !== undefined && isTreeNode(c));

				assert.equal(TreeAlpha.child(c, "label"), "C");
				assert.equal(TreeAlpha.child(c, "data"), undefined);
				assert.equal(TreeAlpha.child(c, "foo"), undefined);
				assert.equal(TreeAlpha.child(c, 0), undefined);
			});
		});

		describe("map", () => {
			it("Simple", () => {
				class TestMap extends schema.map("TestObject", schema.string) {}
				const config = new TreeViewConfiguration({ schema: TestMap });
				const view = getView(config);
				view.initialize({
					foo: "Hello",
					0: "World",
				});
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "foo"), "Hello");
				assert.equal(TreeAlpha.child(tree, "0"), "World");
				assert.equal(TreeAlpha.child(tree, 0), undefined); // Numeric keys are not supported by Map nodes

				assert.equal(TreeAlpha.child(tree, "bar"), undefined);
				assert.equal(TreeAlpha.child(tree, "1"), undefined);
				assert.equal(TreeAlpha.child(tree, 1), undefined);
			});

			it("Subclass properties are not considered", () => {
				class TestMap extends schema.map("TestObject", schema.string) {
					public readonly bar: string = "Bar";
				}
				const config = new TreeViewConfiguration({ schema: TestMap });
				const view = getView(config);
				view.initialize({
					foo: "Hello",
					0: "World",
				});
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "bar"), undefined);
			});

			it("Recursive", () => {
				class TestMap extends schema.mapRecursive("TestObject", [
					schema.string,
					() => TestMap,
				]) {}
				const config = new TreeViewConfiguration({ schema: TestMap });
				const view = getView(config);
				view.initialize(
					new TestMap({
						label: "A",
						data: new TestMap({
							label: "B",
							data: new TestMap({
								label: "C",
							}),
						}),
					}),
				);
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "label"), "A");
				assert.equal(TreeAlpha.child(tree, "foo"), undefined);
				assert.equal(TreeAlpha.child(tree, 0), undefined);

				const b = TreeAlpha.child(tree, "data");
				assert(b !== undefined && isTreeNode(b));

				assert.equal(TreeAlpha.child(b, "label"), "B");
				assert.equal(TreeAlpha.child(b, "foo"), undefined);
				assert.equal(TreeAlpha.child(b, 0), undefined);

				const c = TreeAlpha.child(b, "data");
				assert(c !== undefined && isTreeNode(c));

				assert.equal(TreeAlpha.child(c, "label"), "C");
				assert.equal(TreeAlpha.child(c, "data"), undefined);
				assert.equal(TreeAlpha.child(c, "foo"), undefined);
				assert.equal(TreeAlpha.child(c, 0), undefined);
			});
		});

		describe("record", () => {
			it("Simple", () => {
				class TestRecord extends schema.record("TestRecord", schema.string) {}
				const config = new TreeViewConfiguration({ schema: TestRecord });
				const view = getView(config);
				view.initialize({
					foo: "Hello",
					0: "World",
				});
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "foo"), "Hello");
				assert.equal(TreeAlpha.child(tree, "0"), "World");
				assert.equal(TreeAlpha.child(tree, 0), "World");

				assert.equal(TreeAlpha.child(tree, "bar"), undefined);
				assert.equal(TreeAlpha.child(tree, "1"), undefined);
				assert.equal(TreeAlpha.child(tree, 1), undefined);
			});

			it("Recursive", () => {
				class TestRecord extends schema.recordRecursive("TestRecord", [
					schema.string,
					() => TestRecord,
				]) {}
				const config = new TreeViewConfiguration({ schema: TestRecord });
				const view = getView(config);
				view.initialize(
					new TestRecord({
						label: "A",
						data: new TestRecord({
							label: "B",
							data: new TestRecord({
								label: "C",
							}),
						}),
					}),
				);
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "label"), "A");
				assert.equal(TreeAlpha.child(tree, "foo"), undefined);
				assert.equal(TreeAlpha.child(tree, 0), undefined);

				const b = TreeAlpha.child(tree, "data");
				assert(b !== undefined && isTreeNode(b));

				assert.equal(TreeAlpha.child(b, "label"), "B");
				assert.equal(TreeAlpha.child(b, "foo"), undefined);
				assert.equal(TreeAlpha.child(b, 0), undefined);

				const c = TreeAlpha.child(b, "data");
				assert(c !== undefined && isTreeNode(c));

				assert.equal(TreeAlpha.child(c, "label"), "C");
				assert.equal(TreeAlpha.child(c, "data"), undefined);
				assert.equal(TreeAlpha.child(c, "foo"), undefined);
				assert.equal(TreeAlpha.child(c, 0), undefined);
			});
		});

		describe("array", () => {
			it("Simple", () => {
				class TestArray extends schema.array("TestObject", schema.string) {}
				const config = new TreeViewConfiguration({ schema: TestArray });
				const view = getView(config);
				view.initialize(["Hello", "World"]);
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, 0), "Hello");
				assert.equal(TreeAlpha.child(tree, "0"), "Hello");
				assert.equal(TreeAlpha.child(tree, 1), "World");
				assert.equal(TreeAlpha.child(tree, "1"), "World");
				assert.equal(TreeAlpha.child(tree, 2), undefined);
				assert.equal(TreeAlpha.child(tree, "2"), undefined);
				assert.equal(TreeAlpha.child(tree, "foo"), undefined);
				assert.equal(TreeAlpha.child(tree, ""), undefined);
			});

			it("Subclass properties are not considered", () => {
				class TestArray extends schema.array("TestObject", schema.string) {
					public readonly bar: string = "Bar";
				}
				const config = new TreeViewConfiguration({ schema: TestArray });
				const view = getView(config);
				view.initialize(["Hello", "World"]);
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, "bar"), undefined);
			});

			it("Recursive", () => {
				class TestArray extends schema.arrayRecursive("TestObject", [
					schema.string,
					() => TestArray,
				]) {}
				const config = new TreeViewConfiguration({ schema: TestArray });
				const view = getView(config);
				view.initialize(
					new TestArray(["Hello", new TestArray(["World", new TestArray(["!"])])]),
				);
				const tree = view.root;

				assert.equal(TreeAlpha.child(tree, 0), "Hello");
				assert.equal(TreeAlpha.child(tree, "foo"), undefined);
				assert.equal(TreeAlpha.child(tree, 2), undefined);

				const root1 = TreeAlpha.child(tree, 1);
				assert(root1 !== undefined && isTreeNode(root1));

				assert.equal(TreeAlpha.child(root1, 0), "World");
				assert.equal(TreeAlpha.child(root1, "foo"), undefined);
				assert.equal(TreeAlpha.child(root1, 2), undefined);

				const child1 = TreeAlpha.child(root1, 1);
				assert(child1 !== undefined && isTreeNode(child1));

				assert.equal(TreeAlpha.child(child1, 0), "!");
				assert.equal(TreeAlpha.child(child1, "foo"), undefined);
				assert.equal(TreeAlpha.child(child1, 1), undefined);
			});
		});

		it("Throws if provided a disposed node", () => {
			class TestObject extends schema.object("TestObject", {
				foo: schema.string,
			}) {}
			const config = new TreeViewConfiguration({ schema: TestObject });
			const view = getView(config);
			view.initialize({
				foo: "test",
			});
			const tree = view.root;

			// Dispose the tree view
			view.dispose();

			assert.throws(
				() => TreeAlpha.child(tree, "foo"),
				validateUsageError(/Cannot access a deleted node/),
			);
		});

		it("parent of child is original node", () => {
			class TestChildObject extends schema.object("TestChildObject", {}) {}
			class TestObject extends schema.object("TestObject", {
				data: TestChildObject,
			}) {}

			const config = new TreeViewConfiguration({ schema: TestObject });
			const view = getView(config);
			view.initialize({
				data: {},
			});
			const tree = view.root;

			const child = TreeAlpha.child(tree, "data");
			assert(child !== undefined && isTreeNode(child));
			assert.equal(Tree.parent(child), tree);
		});
	});

	describe("children", () => {
		describe("object", () => {
			function getObjectSchema() {
				return schema.object("TestObject", {
					foo: schema.optional(schema.string),
					bar: schema.optional(schema.string),
					"0": SchemaFactory.optional(schema.number),
				});
			}

			function initializeObjectTree(
				input: InsertableTreeNodeFromImplicitAllowedTypes<ReturnType<typeof getObjectSchema>>,
			) {
				class TestObject extends getObjectSchema() {}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize(input);

				return { TestObject, tree: view.root };
			}

			it("Empty", () => {
				const { tree } = initializeObjectTree({});

				const children = [...TreeAlpha.children(tree)];
				assert.equal(children.length, 0);
			});

			it("Non-empty", () => {
				const { tree } = initializeObjectTree({
					foo: "test",
					0: 42,
				});

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 2);
				assert.equal(children.get("foo"), "test");
				assert.equal(children.get("0"), 42);
			});

			it("Unknown optional fields not included", () => {
				class TestObjectOld extends schema.objectAlpha(
					"TestObject",
					{
						foo: schema.string,
					},
					{
						allowUnknownOptionalFields: true,
					},
				) {}

				class TestObjectNew extends schema.objectAlpha("TestObject", {
					foo: schema.string,
					bar: schema.optional(schema.string),
				}) {}

				const checkoutWithNewSchema = checkoutWithInitialTree(
					new TreeViewConfiguration({
						schema: TestObjectNew,
					}),
					new TestObjectNew({ foo: "Hello", bar: "World" }),
				);

				const viewWithOldSchema = new SchematizingSimpleTreeView(
					checkoutWithNewSchema,
					new TreeViewConfiguration({
						schema: TestObjectOld,
					}),
					new MockNodeIdentifierManager(),
				);

				assert(viewWithOldSchema.compatibility.canView);

				const tree = viewWithOldSchema.root;

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 1);
				assert.equal(children.get("foo"), "Hello");
				assert.equal(children.get("bar"), undefined); // The extra property should not be included
			});

			it("ID fields of unhydrated nodes are included", () => {
				class TestObject extends schema.object("TestObject", {
					id: schema.identifier,
				}) {}
				const tree: TestObject = new TestObject({});

				const children = [...TreeAlpha.children(tree)];
				assert(children.length === 1);
				assert(children[0][0] === "id");
				assert(children[0][1] !== undefined);
			});

			it("Fields with stored keys are returned with their property keys", () => {
				class TestObject extends schema.object("TestObject", {
					foo: SchemaFactory.optional(schema.string, { key: "bar" }),
				}) {}
				const tree: TestObject = new TestObject({
					foo: "Hello world!",
				});

				const children = [...TreeAlpha.children(tree)];
				assert(children.length === 1);
				assert(children[0][0] === "foo");
				assert(children[0][1] === "Hello world!");
			});

			it("Subclass properties are not included", () => {
				class TestObject extends schema.object("TestObject", {
					foo: schema.optional(schema.string),
				}) {
					public readonly bar: string = "Bar"; // Subclass property
				}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize({
					foo: "test",
				});
				const tree = view.root;

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 1);
				assert.equal(children.get("bar"), undefined);
			});

			it("Shadowed properties are included", () => {
				class TestObject extends schema.object("TestObject", {
					toString: schema.string,
				}) {}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize({
					toString: "test",
				});
				const tree = view.root;

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 1);
				assert.equal(children.get("toString"), "test");
			});

			it("Recursive", () => {
				class TestObject extends schema.objectRecursive("TestObject", {
					label: schema.string,
					data: schema.optionalRecursive([() => TestObject]),
				}) {}
				const config = new TreeViewConfiguration({ schema: TestObject });
				const view = getView(config);
				view.initialize(
					new TestObject({
						label: "A",
						data: new TestObject({
							label: "B",
							data: new TestObject({
								label: "C",
							}),
						}),
					}),
				);
				const tree = view.root;

				const rootChildren = [...TreeAlpha.children(tree)];
				assert.equal(rootChildren.length, 2);
				assert.deepEqual(rootChildren[0], ["label", "A"]);
				assert.equal(rootChildren[1][0], "data");
				const sub1Node = rootChildren[1][1];
				assert(sub1Node !== undefined && isTreeNode(sub1Node));

				const sub1Children = [...TreeAlpha.children(sub1Node)];
				assert.equal(sub1Children.length, 2);
				assert.deepEqual(sub1Children[0], ["label", "B"]);
				assert.equal(sub1Children[1][0], "data");
				const sub2Node = sub1Children[1][1];
				assert(sub2Node !== undefined && isTreeNode(sub2Node));

				const sub2Children = [...TreeAlpha.children(sub2Node)];
				assert.equal(sub2Children.length, 1);
				assert.deepEqual(sub2Children[0], ["label", "C"]);
			});
		});

		describe("map", () => {
			function getMapSchema() {
				return schema.map("TestMap", schema.string);
			}

			function initializeMapTree(
				input: InsertableTreeNodeFromImplicitAllowedTypes<ReturnType<typeof getMapSchema>>,
			) {
				class TestMap extends getMapSchema() {}
				const config = new TreeViewConfiguration({ schema: TestMap });
				const view = getView(config);
				view.initialize(input);

				return { TestMap, tree: view.root };
			}

			it("empty", () => {
				const { tree } = initializeMapTree({});

				const children = [...TreeAlpha.children(tree)];
				assert.equal(children.length, 0);
			});

			it("non-empty", () => {
				const { tree } = initializeMapTree({
					foo: "Hello",
					bar: "World",
				});

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 2);
				assert.equal(children.get("foo"), "Hello");
				assert.equal(children.get("bar"), "World");
			});

			it("Subclass properties are not included", () => {
				class TestMap extends schema.map("TestMap", schema.string) {
					public readonly bar: string = "Bar"; // Subclass property
				}
				const config = new TreeViewConfiguration({ schema: TestMap });
				const view = getView(config);
				view.initialize({
					foo: "test",
				});
				const tree = view.root;

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 1);
				assert.equal(children.get("bar"), undefined);
			});

			it("Recursive", () => {
				class TestMap extends schema.mapRecursive("TestMap", [schema.string, () => TestMap]) {}
				const config = new TreeViewConfiguration({ schema: TestMap });
				const view = getView(config);
				view.initialize(
					new TestMap({
						label: "A",
						data: new TestMap({
							label: "B",
							data: new TestMap({
								label: "C",
							}),
						}),
					}),
				);
				const tree = view.root;

				const rootChildren = [...TreeAlpha.children(tree)];
				assert.equal(rootChildren.length, 2);
				assert.deepEqual(rootChildren[0], ["label", "A"]);
				assert.equal(rootChildren[1][0], "data");
				const sub1Node = rootChildren[1][1];
				assert(sub1Node !== undefined && isTreeNode(sub1Node));

				const sub1Children = [...TreeAlpha.children(sub1Node)];
				assert.equal(sub1Children.length, 2);
				assert.deepEqual(sub1Children[0], ["label", "B"]);
				assert.equal(sub1Children[1][0], "data");
				const sub2Node = sub1Children[1][1];
				assert(sub2Node !== undefined && isTreeNode(sub2Node));

				const sub2Children = [...TreeAlpha.children(sub2Node)];
				assert.equal(sub2Children.length, 1);
				assert.deepEqual(sub2Children[0], ["label", "C"]);
			});
		});

		describe("array", () => {
			function getArraySchema() {
				return schema.array("TestArray", schema.string);
			}

			function initializeArrayTree(
				input: InsertableTreeNodeFromImplicitAllowedTypes<ReturnType<typeof getArraySchema>>,
			) {
				class TestArray extends getArraySchema() {}
				const config = new TreeViewConfiguration({ schema: TestArray });
				const view = getView(config);
				view.initialize(input);

				return { TestArray, tree: view.root };
			}

			it("empty", () => {
				const { tree } = initializeArrayTree([]);

				const children = [...TreeAlpha.children(tree)];
				assert.equal(children.length, 0);
			});

			it("non-empty", () => {
				const { tree } = initializeArrayTree(["Hello", "World"]);

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 2);
				assert.equal(children.get(0), "Hello");
				assert.equal(children.get(1), "World");
			});

			it("Subclass properties are not included", () => {
				class TestArray extends schema.array("TestArray", schema.string) {
					public readonly bar: string = "Bar"; // Subclass property
				}
				const config = new TreeViewConfiguration({ schema: TestArray });
				const view = getView(config);
				view.initialize(["Hello", "World"]);
				const tree = view.root;

				const children = new Map<string | number, TreeNode | TreeLeafValue>(
					TreeAlpha.children(tree),
				);
				assert.equal(children.size, 2);
				assert.equal(children.get("bar"), undefined);
			});

			it("Recursive", () => {
				class TestArray extends schema.arrayRecursive("TestArray", [
					schema.string,
					() => TestArray,
				]) {}
				const config = new TreeViewConfiguration({ schema: TestArray });
				const view = getView(config);
				view.initialize(
					new TestArray(["Hello", new TestArray(["World", new TestArray(["!"])])]),
				);
				const tree = view.root;

				const rootChildren = [...TreeAlpha.children(tree)];
				assert.equal(rootChildren.length, 2);
				assert.deepEqual(rootChildren[0], [0, "Hello"]);

				const sub1Node = rootChildren[1][1];
				assert(sub1Node !== undefined && isTreeNode(sub1Node));

				const sub1Children = [...TreeAlpha.children(sub1Node)];
				assert.equal(sub1Children.length, 2);
				assert.deepEqual(sub1Children[0], [0, "World"]);

				const sub2Node = sub1Children[1][1];
				assert(sub2Node !== undefined && isTreeNode(sub2Node));

				const sub2Children = [...TreeAlpha.children(sub2Node)];
				assert.equal(sub2Children.length, 1);
				assert.deepEqual(sub2Children[0], [0, "!"]);
			});
		});

		it("Throws if provided a disposed node", () => {
			class TestObject extends schema.object("TestObject", {
				foo: schema.string,
			}) {}
			const config = new TreeViewConfiguration({ schema: TestObject });
			const view = getView(config);
			view.initialize({
				foo: "test",
			});
			const tree = view.root;

			// Dispose the tree view
			view.dispose();

			assert.throws(
				() => {
					const children = TreeAlpha.children(tree);
					for (const [key, child] of children) {
						// Accessing the first child should result in an error
					}
				},
				validateUsageError(/Cannot access a deleted node/),
			);
		});

		it("parent of each child is original node", () => {
			class TestChildObject extends schema.object("TestChildObject", {}) {}
			class TestArray extends schema.array("TestObject", TestChildObject) {}

			const config = new TreeViewConfiguration({ schema: TestArray });
			const view = getView(config);
			view.initialize([
				new TestChildObject({}),
				new TestChildObject({}),
				new TestChildObject({}),
			]);
			const tree = view.root;

			const children = [...TreeAlpha.children(tree)];
			assert(children.length === 3);
			for (const [, child] of children) {
				assert(isTreeNode(child));
				assert.equal(Tree.parent(child), tree);
			}
		});
	});

	describe("shortID", () => {
		it("returns local id when an identifier fieldkind exists.", () => {
			const schemaWithIdentifier = schema.object("parent", {
				identifier: schema.identifier,
			});
			const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
			const view = getView(config);
			const nodeKeyManager = view.nodeKeyManager;
			const id = nodeKeyManager.stabilizeNodeIdentifier(
				nodeKeyManager.generateLocalNodeIdentifier(),
			);
			view.initialize({ identifier: id });

			assert.equal(Tree.shortId(view.root), nodeKeyManager.localizeNodeIdentifier(id));
		});
		it("returns undefined when an identifier fieldkind does not exist.", () => {
			const schemaWithIdentifier = schema.object("parent", {
				identifier: schema.string,
			});
			const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
			const view = getView(config);
			view.initialize({ identifier: "testID" });

			assert.equal(Tree.shortId(view.root), undefined);
		});
		it("returns the uncompressed identifier value when the provided identifier is an invalid stable id.", () => {
			const schemaWithIdentifier = schema.object("parent", {
				identifier: schema.identifier,
			});
			const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
			const view = getView(config);
			view.initialize({ identifier: "invalidUUID" });

			assert.equal(Tree.shortId(view.root), "invalidUUID");
		});
		it("returns the uncompressed identifier value when the provided identifier is a valid stable id, but unknown by the idCompressor.", () => {
			const schemaWithIdentifier = schema.object("parent", {
				identifier: schema.identifier,
			});
			// Create a valid stableNodeKey which is not known by the tree's idCompressor.
			const nodeKeyManager = new MockNodeIdentifierManager();
			const stableNodeKey = nodeKeyManager.stabilizeNodeIdentifier(
				nodeKeyManager.generateLocalNodeIdentifier(),
			);

			const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
			const view = getView(config);
			view.initialize({ identifier: stableNodeKey });

			assert.equal(Tree.shortId(view.root), stableNodeKey);
		});
		it("errors if multiple identifiers exist on the same node", () => {
			const config = new TreeViewConfiguration({
				schema: schema.object("parent", {
					identifier: schema.identifier,
					identifier2: schema.identifier,
				}),
			});

			const view = getView(config);
			view.initialize({
				identifier: "a",
				identifier2: "b",
			});
			assert.throws(
				() => Tree.shortId(view.root),
				(error: Error) =>
					validateAssertionError(
						error,
						/may not be called on a node with more than one identifier/,
					),
			);
		});

		it("Returns undefined for non-object nodes", () => {
			const config = new TreeViewConfiguration({
				schema: schema.array("parent", schema.number),
			});
			const view = getView(config);
			view.initialize([1, 2, 3]);
			assert.equal(Tree.shortId(view.root), undefined);
		});

		describe("unhydrated", () => {
			class HasIdentifier extends schema.object("HasIdentifier", {
				identifier: schema.identifier,
			}) {}
			it("returns uncompressed string for unhydrated nodes", () => {
				const node = new HasIdentifier({ identifier: "x" });
				assert.equal(Tree.shortId(node), "x");
			});
			it("accessing defaulted", () => {
				const node = new HasIdentifier({});
				assert(typeof Tree.shortId(node) === "string");
			});

			// TODO: this policy seems questionable, but its whats implemented, and is documented in TreeStatus.new
			it("returns string when unhydrated then local id when hydrated", () => {
				const config = new TreeViewConfiguration({ schema: HasIdentifier });
				const view = getView(config);
				const nodeKeyManager = view.nodeKeyManager;
				view.initialize({});
				const identifier = view.root.identifier;
				const shortId = Tree.shortId(view.root);
				assert.equal(
					shortId,
					nodeKeyManager.localizeNodeIdentifier(identifier as StableNodeIdentifier),
				);

				const node = new HasIdentifier({ identifier });
				assert.equal(Tree.shortId(node), identifier);
				view.root = node;
				assert.equal(Tree.shortId(node), shortId);
			});
		});
	});

	describe("identifier", () => {
		it("returns stable id when an identifier fieldkind exists.", () => {
			const schemaWithIdentifier = schema.object("parent", {
				identifier: schema.identifier,
			});

			const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
			const view = getView(config);
			const nodeKeyManager = view.nodeKeyManager;
			const id = nodeKeyManager.stabilizeNodeIdentifier(
				nodeKeyManager.generateLocalNodeIdentifier(),
			);
			view.initialize({ identifier: id });

			assert.equal(TreeAlpha.identifier(view.root), id);
		});

		it("returns undefined when an identifier fieldkind does not exist.", () => {
			const schemaWithIdentifier = schema.object("parent", {
				identifier: schema.string,
			});
			const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
			const view = getView(config);
			view.initialize({ identifier: "testID" });

			assert.equal(TreeAlpha.identifier(view.root), undefined);
		});

		it("returns the original identifier value when the provided identifier is a valid stable id, but unknown by the idCompressor.", () => {
			const schemaWithIdentifier = schema.object("parent", {
				identifier: schema.identifier,
			});
			// Create a valid stableNodeKey which is not known by the tree's idCompressor.
			const nodeKeyManager = new MockNodeIdentifierManager();
			const stableNodeKey = nodeKeyManager.stabilizeNodeIdentifier(
				nodeKeyManager.generateLocalNodeIdentifier(),
			);

			const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
			const view = getView(config);
			view.initialize({ identifier: stableNodeKey });

			assert.equal(TreeAlpha.identifier(view.root), stableNodeKey);
		});

		it("errors if multiple identifiers exist on the same node", () => {
			const config = new TreeViewConfiguration({
				schema: schema.object("parent", {
					identifier: schema.identifier,
					identifier2: schema.identifier,
				}),
			});

			const view = getView(config);
			view.initialize({
				identifier: "a",
				identifier2: "b",
			});
			assert.throws(
				() => TreeAlpha.identifier(view.root),
				(error: Error) =>
					validateAssertionError(
						error,
						/may not be called on a node with more than one identifier/,
					),
			);
		});

		it("Returns undefined for non-object nodes", () => {
			const config = new TreeViewConfiguration({
				schema: schema.array("parent", schema.number),
			});
			const view = getView(config);
			view.initialize([1, 2, 3]);
			assert.equal(TreeAlpha.identifier(view.root), undefined);
		});

		describe("unhydrated", () => {
			it("accessing defaulted", () => {
				class HasIdentifier extends schema.object("HasIdentifier", {
					identifier: schema.identifier,
				}) {}
				const node = new HasIdentifier({});
				assert(typeof TreeAlpha.identifier(node) === "string");
			});
		});

		describe("getShort", () => {
			it("returns local id when an identifier fieldkind exists.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});

				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				const nodeKeyManager = view.nodeKeyManager;
				const id = nodeKeyManager.stabilizeNodeIdentifier(
					nodeKeyManager.generateLocalNodeIdentifier(),
				);
				view.initialize({ identifier: id });

				assert.equal(
					TreeAlpha.identifier.getShort(view.root),
					nodeKeyManager.localizeNodeIdentifier(id),
				);
			});

			it("returns undefined when an identifier fieldkind does not exist.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.string,
				});
				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				view.initialize({ identifier: "testID" });

				assert.equal(TreeAlpha.identifier.getShort(view.root), undefined);
			});

			it("returns the undefined when the provided identifier is an invalid stable id.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});
				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				view.initialize({ identifier: "invalidUUID" });

				assert.equal(TreeAlpha.identifier.getShort(view.root), undefined);
			});

			it("returns the undefined when the provided identifier is a valid stable id, but unknown by the idCompressor.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});
				// Create a valid stableNodeKey which is not known by the tree's idCompressor.
				const nodeKeyManager = new MockNodeIdentifierManager();
				const stableNodeKey = nodeKeyManager.stabilizeNodeIdentifier(
					nodeKeyManager.generateLocalNodeIdentifier(),
				);

				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				view.initialize({ identifier: stableNodeKey });

				assert.equal(TreeAlpha.identifier.getShort(view.root), undefined);
			});

			it("errors if multiple identifiers exist on the same node", () => {
				const config = new TreeViewConfiguration({
					schema: schema.object("parent", {
						identifier: schema.identifier,
						identifier2: schema.identifier,
					}),
				});

				const view = getView(config);
				view.initialize({
					identifier: "a",
					identifier2: "b",
				});
				assert.throws(
					() => TreeAlpha.identifier.getShort(view.root),
					(error: Error) =>
						validateAssertionError(
							error,
							/may not be called on a node with more than one identifier/,
						),
				);
			});

			it("Returns undefined for non-object nodes", () => {
				const config = new TreeViewConfiguration({
					schema: schema.array("parent", schema.number),
				});
				const view = getView(config);
				view.initialize([1, 2, 3]);
				assert.equal(TreeAlpha.identifier.getShort(view.root), undefined);
			});

			describe("unhydrated", () => {
				class HasIdentifier extends schema.object("HasIdentifier", {
					identifier: schema.identifier,
				}) {}
				it("returns undefined for unhydrated nodes", () => {
					const node = new HasIdentifier({ identifier: "x" });
					assert.equal(TreeAlpha.identifier.getShort(node), undefined);
				});
				it("returns undefined accessing defaulted for unhydrated nodes", () => {
					const node = new HasIdentifier({});
					assert.equal(TreeAlpha.identifier.getShort(node), undefined);
				});

				// TODO: this policy seems questionable, but its whats implemented, and is documented in TreeStatus.new
				it("returns undefined when unhydrated then local id when hydrated", () => {
					const config = new TreeViewConfiguration({ schema: HasIdentifier });
					const view = getView(config);
					view.initialize({});
					const identifier = view.root.identifier;
					const nodeKeyManager = view.nodeKeyManager;
					const shortId = TreeAlpha.identifier.getShort(view.root);
					assert.equal(
						shortId,
						nodeKeyManager.localizeNodeIdentifier(identifier as StableNodeIdentifier),
					);

					const node = new HasIdentifier({ identifier });
					assert.equal(TreeAlpha.identifier.getShort(node), undefined);
					view.root = node;
					assert.equal(TreeAlpha.identifier.getShort(node), shortId);
				});
			});
		});

		describe("shorten", () => {
			it("returns the local identifier for a known, stable identifier.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});

				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				const nodeKeyManager = view.nodeKeyManager;
				const id = nodeKeyManager.stabilizeNodeIdentifier(
					nodeKeyManager.generateLocalNodeIdentifier(),
				);
				view.initialize({ identifier: id });

				assert.equal(
					TreeAlpha.identifier.shorten(view, id),
					nodeKeyManager.localizeNodeIdentifier(id),
				);
			});

			it("returns undefined for a valid, but unknown stable identifier", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.string,
				});
				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				view.initialize({ identifier: "testID" });

				// create an nodeKeyManager unknown by the view.
				const nodeKeyManager = new MockNodeIdentifierManager();
				const id = nodeKeyManager.stabilizeNodeIdentifier(
					nodeKeyManager.generateLocalNodeIdentifier(),
				);
				const test = TreeAlpha.identifier.shorten(view, id);
				assert.equal(TreeAlpha.identifier.shorten(view, id), undefined);
			});

			it("returns undefined when the provided identifier is an invalid stable id.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});

				const invalidId = "invalidUUID";
				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				view.initialize({ identifier: invalidId });

				assert.equal(TreeAlpha.identifier.shorten(view, invalidId), undefined);
			});

			it("returns the original stable id when shortened and then lengthened.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});

				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				const nodeKeyManager = view.nodeKeyManager;
				const id = nodeKeyManager.stabilizeNodeIdentifier(
					nodeKeyManager.generateLocalNodeIdentifier(),
				);
				view.initialize({ identifier: id });

				const localId = TreeAlpha.identifier.shorten(view, id);
				assert(typeof localId === "number");
				assert.equal(TreeAlpha.identifier.lengthen(view, localId), id);
			});
		});

		describe("lengthen", () => {
			it("returns the stable identifier for a known, local identifier.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});

				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);

				const nodeKeyManager = view.nodeKeyManager;
				const localId = nodeKeyManager.generateLocalNodeIdentifier();
				const id = nodeKeyManager.stabilizeNodeIdentifier(localId);
				view.initialize({ identifier: id });

				assert.equal(TreeAlpha.identifier.lengthen(view, localId as unknown as number), id);
			});

			it("unknown local identifier, throws usage error", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.string,
				});
				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				view.initialize({ identifier: "testID" });
				assert.throws(() => TreeAlpha.identifier.lengthen(view, 98));
			});

			it("returns the original local id when lengthened and then shortened.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});

				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);
				const nodeKeyManager = view.nodeKeyManager;
				const id = nodeKeyManager.generateLocalNodeIdentifier();
				assert(typeof id === "number");
				const stableId = TreeAlpha.identifier.lengthen(view, id);

				view.initialize({ identifier: stableId });

				assert.equal(TreeAlpha.identifier.shorten(view, stableId), id);
			});
		});

		describe("create", () => {
			it("generates and returns a stable identifier.", () => {
				const schemaWithIdentifier = schema.object("parent", {
					identifier: schema.identifier,
				});

				const config = new TreeViewConfiguration({ schema: schemaWithIdentifier });
				const view = getView(config);

				const generatedIdentifier = TreeAlpha.identifier.create(view);
				const shortIdentifier = TreeAlpha.identifier.shorten(view, generatedIdentifier);
				assert(typeof shortIdentifier === "number");
			});
		});
	});

	describe("on", () => {
		it("Editing a node without an anchor still triggers 'treeChanged' event above it", () => {
			// Notes:
			// * For this bug to occur, the edit must change a node that does not have an anchor (and thus hasn't been viewed yet).
			// * Using the public API this can only be done via collaborative editing or branch merging.
			const sf = new SchemaFactory(undefined);
			class Child extends sf.object("Child", {
				value: sf.number,
			}) {}
			class Parent extends sf.object("Parent", {
				node: Child,
			}) {}

			const config = new TreeViewConfiguration({ schema: Parent });
			const provider = new TestTreeProviderLite(2);
			const [tree1, tree2] = provider.trees;
			// Initialize the first tree with a value of "0"
			const view1 = tree1.viewWith(config);
			view1.initialize(
				new Parent({
					node: new Child({
						value: 0,
					}),
				}),
			);
			provider.synchronizeMessages();
			const view2 = tree2.viewWith(config);
			// Count the number of times treeChanged fires
			let invalidations = 0;
			Tree.on(view2.root, "treeChanged", () => {
				invalidations += 1;
			});
			// Change the first tree to a value of "3"
			view1.root.node.value = 3;
			// Remove the no longer needed view1 to simplify debugging.
			view1.dispose();
			provider.synchronizeMessages();
			// Ensure that the second tree received the change...
			assert.equal(view2.root.node.value, 3);
			// ...and also that the event fired
			assert.equal(invalidations, 1);
		});

		describe("object node", () => {
			const sb = new SchemaFactory("object-node-in-root");
			class myObject extends sb.object("object", {
				myNumber: sb.number,
			}) {}
			const treeSchema = sb.object("root", {
				rootObject: myObject,
			});

			function check(
				eventName: keyof TreeChangeEvents,
				mutate: (root: NodeFromSchema<typeof treeSchema>) => void,
				expectedFirings: number = 1,
			) {
				it(`.on('${eventName}') subscribes and unsubscribes correctly`, () => {
					const root = hydrate(treeSchema, {
						rootObject: {
							myNumber: 1,
						},
					});
					const log: unknown[][] = [];

					const unsubscribe = Tree.on(root, eventName, (...args: unknown[]) => {
						log.push(args);
					});

					mutate(root);

					assert.equal(log.length, expectedFirings, `'${eventName}' should fire.`);

					unsubscribe();
					mutate(root);

					assert.equal(log.length, expectedFirings, `'${eventName}' should NOT fire.`);
				});
			}

			check(
				"nodeChanged",
				(root) =>
					(root.rootObject = new myObject({
						myNumber: 2,
					})),
			);
			check("treeChanged", (root) => root.rootObject.myNumber++, 1);

			it(`change to direct fields triggers both 'nodeChanged' and 'treeChanged'`, () => {
				const root = hydrate(treeSchema, {
					rootObject: {
						myNumber: 1,
					},
				});

				let shallowChanges = 0;
				let deepChanges = 0;
				Tree.on(root, "nodeChanged", () => shallowChanges++);
				Tree.on(root, "treeChanged", () => deepChanges++);

				root.rootObject = new myObject({
					myNumber: 2,
				});

				assert.equal(shallowChanges, 1, `nodeChanged should fire.`);
				assert.equal(deepChanges, 1, `treeChanged should fire.`);
			});

			it(`change to descendant fields only triggers 'treeChanged'`, () => {
				const root = hydrate(treeSchema, {
					rootObject: {
						myNumber: 1,
					},
				});

				let shallowChanges = 0;
				let deepChanges = 0;
				Tree.on(root, "nodeChanged", () => shallowChanges++);
				Tree.on(root, "treeChanged", () => deepChanges++);

				root.rootObject.myNumber++;

				assert.equal(shallowChanges, 0, `nodeChanged should NOT fire.`);
				assert.equal(deepChanges, 1, `treeChanged should fire.`);
			});
		});

		describe("array node", () => {
			const sb = new SchemaFactory("array-node-tests");
			class myObject extends sb.object("object", {
				myNumber: sb.number,
			}) {}
			const treeSchema = sb.array("root", myObject);

			function check(
				eventName: keyof TreeChangeEvents,
				mutate: (root: NodeFromSchema<typeof treeSchema>) => void,
				expectedFirings: number = 1,
			) {
				it(`.on('${eventName}') subscribes and unsubscribes correctly`, () => {
					const root = hydrate(treeSchema, [
						{
							myNumber: 1,
						},
					]);
					const log: unknown[][] = [];

					const unsubscribe = Tree.on(root, eventName, (...args: unknown[]) => {
						log.push(args);
					});

					mutate(root);

					assert.equal(log.length, expectedFirings, `'${eventName}' should fire.`);

					unsubscribe();
					mutate(root);

					assert.equal(log.length, expectedFirings, `'${eventName}' should NOT fire.`);
				});
			}

			check("nodeChanged", (root) => root.insertAtEnd({ myNumber: 2 }));
			check("treeChanged", (root) => root[0].myNumber++, 1);

			it(`change to descendant fields only triggers 'treeChanged'`, () => {
				const root = hydrate(treeSchema, [
					{
						myNumber: 1,
					},
				]);

				let shallowChanges = 0;
				let deepChanges = 0;
				Tree.on(root, "nodeChanged", () => shallowChanges++);
				Tree.on(root, "treeChanged", () => deepChanges++);

				root[0].myNumber++;

				assert.equal(shallowChanges, 0, `nodeChanged should NOT fire.`);
				assert.equal(deepChanges, 1, `treeChanged should fire.`);
			});

			it(`move between array nodes triggers both 'nodeChanged' and 'treeChanged' the correct number of times on source and target nodes`, () => {
				const testSchema = sb.object("root", {
					array1: sb.array(sb.number),
					array2: sb.array(sb.number),
				});
				const root = hydrate(testSchema, {
					array1: [1],
					array2: [2],
				});

				let a1ShallowChanges = 0;
				let a1DeepChanges = 0;
				let a2ShallowChanges = 0;
				let a2DeepChanges = 0;
				Tree.on(root.array1, "nodeChanged", () => a1ShallowChanges++);
				Tree.on(root.array1, "treeChanged", () => a1DeepChanges++);
				Tree.on(root.array2, "nodeChanged", () => a2ShallowChanges++);
				Tree.on(root.array2, "treeChanged", () => a2DeepChanges++);

				root.array2.moveToEnd(0, root.array1);

				assert.deepEqual(root.array1, []);
				assert.deepEqual(root.array2, [2, 1]);
				assert.equal(a1ShallowChanges, 1, `nodeChanged should fire once.`);
				assert.equal(a1DeepChanges, 1, `treeChanged should fire once.`);
				assert.equal(a2ShallowChanges, 1, `nodeChanged should fire once.`);
				assert.equal(a2DeepChanges, 1, `treeChanged should fire once.`);
			});

			it(`all operations on the node trigger 'nodeChanged' and 'treeChanged' the correct number of times`, () => {
				const testSchema = sb.array("listRoot", sb.number);
				const root = hydrate(testSchema, []);

				let shallowChanges = 0;
				let deepChanges = 0;
				Tree.on(root, "treeChanged", () => {
					deepChanges++;
				});
				Tree.on(root, "nodeChanged", () => {
					shallowChanges++;
				});

				// Insert single item
				root.insertAtStart(1);
				assert.equal(shallowChanges, 1);
				assert.equal(deepChanges, 1);

				// Insert multiple items
				root.insertAtEnd(2, 3);
				assert.equal(shallowChanges, 2);
				assert.equal(deepChanges, 2);

				// Move one item within the same node
				root.moveToEnd(0);
				assert.equal(shallowChanges, 3);
				assert.equal(deepChanges, 3);

				// Move multiple items within the same node
				root.moveRangeToEnd(0, 2);
				assert.equal(shallowChanges, 4);
				assert.equal(deepChanges, 4);

				// Remove single item
				root.removeAt(0);
				assert.equal(shallowChanges, 5);
				assert.equal(deepChanges, 5);

				// Remove multiple items
				root.removeRange(0, 2);
				assert.equal(shallowChanges, 6);
				assert.equal(deepChanges, 6);
			});
		});

		describe("map node", () => {
			const sb = new SchemaFactory("map-node-in-root");
			class myObject extends sb.object("object", {
				myNumber: sb.number,
			}) {}
			const treeSchema = sb.map("root", myObject);

			function check(
				eventName: keyof TreeChangeEvents,
				mutate: (root: NodeFromSchema<typeof treeSchema>) => void,
				expectedFirings: number = 1,
			) {
				it(`.on('${eventName}') subscribes and unsubscribes correctly`, () => {
					const root = hydrate(
						treeSchema,
						new Map([
							[
								"a",
								{
									myNumber: 1,
								},
							],
						]),
					);
					const log: unknown[][] = [];

					const unsubscribe = Tree.on(root, eventName, (...args: unknown[]) => {
						log.push(args);
					});

					mutate(root);

					assert.equal(log.length, expectedFirings, `'${eventName}' should fire.`);

					unsubscribe();
					mutate(root);

					assert.equal(log.length, expectedFirings, `'${eventName}' should NOT fire.`);
				});
			}

			check("nodeChanged", (root) => root.set("a", { myNumber: 2 }));
			check(
				"treeChanged",
				(root) => {
					const mapEntry = root.get("a");
					if (mapEntry === undefined) {
						throw new Error("Map entry for key 'a' not found");
					}
					mapEntry.myNumber++;
				},
				1,
			);

			it(`change to direct fields triggers both 'nodeChanged' and 'treeChanged'`, () => {
				const root = hydrate(
					treeSchema,
					new Map([
						[
							"a",
							{
								myNumber: 1,
							},
						],
					]),
				);

				let shallowChanges = 0;
				let deepChanges = 0;
				Tree.on(root, "nodeChanged", () => shallowChanges++);
				Tree.on(root, "treeChanged", () => deepChanges++);

				root.set("a", { myNumber: 2 });

				assert.equal(shallowChanges, 1, `nodeChanged should fire.`);
				assert.equal(deepChanges, 1, `treeChanged should fire.`);
			});

			it(`change to descendant fields only triggers 'treeChanged'`, () => {
				const root = hydrate(
					treeSchema,
					new Map([
						[
							"a",
							{
								myNumber: 1,
							},
						],
					]),
				);

				let shallowChanges = 0;
				let deepChanges = 0;
				Tree.on(root, "nodeChanged", () => shallowChanges++);
				Tree.on(root, "treeChanged", () => deepChanges++);

				const mapEntry = root.get("a");
				if (mapEntry === undefined) {
					throw new Error("Map entry for key 'a' not found");
				}
				mapEntry.myNumber++;

				assert.equal(shallowChanges, 0, `nodeChanged should NOT fire.`);
				assert.equal(deepChanges, 1, `treeChanged should fire.`);
			});
		});

		// Change events don't apply to leaf nodes since they don't have fields that change, they are themselves replaced
		// by other leaf nodes.

		it(`all kinds of changes trigger 'nodeChanged' and 'treeChanged' the correct number of times`, () => {
			const sb = new SchemaFactory("object-node-in-root");
			const innerObject = sb.object("inner-object", { innerProp: sb.number });
			class map extends sb.map("map", sb.number) {}
			class list extends sb.array("list", sb.number) {}
			const outerObject = sb.object("outer-object", {
				objectProp: sb.optional(innerObject),
				mapProp: sb.optional(map),
				arrayProp: sb.optional(list),
				valueProp: sb.optional(sb.number),
			});
			const treeSchema = sb.object("root", {
				rootObject: outerObject,
			});

			const root = hydrate(treeSchema, {
				rootObject: {
					objectProp: undefined,
					mapProp: undefined,
					arrayProp: undefined,
					valueProp: undefined,
				},
			});

			let shallowChanges = 0;
			let deepChanges = 0;
			// Deep changes subscription on the root
			Tree.on(root, "treeChanged", () => {
				deepChanges++;
			});
			// Shallow changes subscription on the object property of the root
			Tree.on(root.rootObject, "nodeChanged", () => {
				shallowChanges++;
			});

			let deepActionsSoFar = 0;
			let shallowActionsSoFar = 0;

			function actAndVerify(
				action: () => void,
				deepActionsIncrement: number,
				shallowActionsIncrement: number,
			) {
				action();
				deepActionsSoFar += deepActionsIncrement;
				shallowActionsSoFar += shallowActionsIncrement;
				assert.equal(shallowChanges, shallowActionsSoFar);
				assert.equal(deepChanges, deepActionsSoFar);
			}

			// Attach value node
			actAndVerify(() => (root.rootObject.valueProp = 1), 1, 1);
			// Replace value node
			actAndVerify(() => (root.rootObject.valueProp = 2), 1, 1);
			// Detach value node
			actAndVerify(() => (root.rootObject.valueProp = undefined), 1, 1);

			// Attach object node
			actAndVerify(
				() => (root.rootObject.objectProp = new innerObject({ innerProp: 1 })),
				1,
				1,
			);
			// Replace object node
			actAndVerify(
				() => (root.rootObject.objectProp = new innerObject({ innerProp: 2 })),
				1,
				1,
			);
			// Detach object node
			actAndVerify(() => (root.rootObject.objectProp = undefined), 1, 1);

			// Attach map node
			actAndVerify(() => (root.rootObject.mapProp = new map(new Map([["a", 1]]))), 1, 1);
			// Replace map node
			actAndVerify(() => (root.rootObject.mapProp = new map(new Map([["b", 2]]))), 1, 1);
			// Set key on map node (we set it above, we know it's good even if it's optional)
			actAndVerify(() => root.rootObject.mapProp?.set("c", 3), 1, 0); // The node at mapProp isn't changing so no shallow change on rootObject
			// Delete key on map node (we set it above, we know it's good even if it's optional)
			actAndVerify(() => root.rootObject.mapProp?.delete("c"), 1, 0); // The node at mapProp isn't changing so no shallow change on rootObject
			// Detach map node
			actAndVerify(() => (root.rootObject.mapProp = undefined), 1, 1);

			// Attach array node
			actAndVerify(() => (root.rootObject.arrayProp = new list([1])), 1, 1);
			// Replace array node
			actAndVerify(() => (root.rootObject.arrayProp = new list([2])), 1, 1);
			// Insert into array node (we set it above, we know it's good even if it's optional)
			actAndVerify(() => root.rootObject.arrayProp?.insertAtEnd(3), 1, 0); // The node at arrayProp isn't changing so no shallow change on rootObject
			// Move within array node (we set it above, we know it's good even if it's optional)
			actAndVerify(() => root.rootObject.arrayProp?.moveToEnd(0), 1, 0); // The node at arrayProp isn't changing so no shallow change on rootObject
			// Remove from array node (we set it above, we know it's good even if it's optional)
			actAndVerify(() => root.rootObject.arrayProp?.removeAt(0), 1, 0); // The node at arrayProp isn't changing so no shallow change on rootObject
			// Detach array node
			actAndVerify(() => (root.rootObject.arrayProp = undefined), 1, 1);
		});

		it(`batched changes to several direct fields trigger 'nodeChanged' and 'treeChanged' the correct number of times`, () => {
			const rootNode: NormalizedUpPath = {
				detachedNodeId: undefined,
				parent: undefined,
				parentField: rootFieldKey,
				parentIndex: 0,
			};

			const sb = new SchemaFactory("object-node-in-root");
			const treeSchema = sb.object("root", {
				prop1: sb.number,
				prop2: sb.number,
			});

			const view = getView(new TreeViewConfiguration({ schema: treeSchema }));
			view.initialize({ prop1: 1, prop2: 1 });
			const { root, checkout } = view;

			let shallowChanges = 0;
			let deepChanges = 0;
			Tree.on(root, "nodeChanged", () => shallowChanges++);
			Tree.on(root, "treeChanged", () => deepChanges++);

			const branch = checkout.branch();
			branch.editor
				.valueField({ parent: rootNode, field: brand("prop1") })
				.set(chunkFromJsonableTrees([{ type: brand(numberSchema.identifier), value: 2 }]));
			branch.editor
				.valueField({ parent: rootNode, field: brand("prop2") })
				.set(chunkFromJsonableTrees([{ type: brand(numberSchema.identifier), value: 2 }]));

			checkout.merge(branch);

			assert.equal(root.prop1, 2, "'prop2' value did not change as expected");
			assert.equal(root.prop2, 2, "'prop2' value did not change as expected");
			// Changes should be batched so we should only get one firing of each event type.
			assert.equal(deepChanges, 1, "'treeChanged' should only fire once");
			assert.equal(shallowChanges, 1, "'nodeChanged' should only fire once");
		});

		it(`'nodeChanged' and 'treeChanged' fire in the correct order`, () => {
			// The main reason this test exists is to ensure that the fact that a node (and its ancestors) might be visited
			// during the detach pass of the delta visit even if they're not being mutated during that pass, doesn't cause
			// the 'treeChanged' event to fire before the 'nodeChanged' event, which could be an easily introduced bug when
			// updating the delta visit code for the anchorset.
			const sb = new SchemaFactory("test");
			class innerObject extends sb.object("inner", { value: sb.number }) {}
			class treeSchema extends sb.object("root", {
				prop1: innerObject,
			}) {}

			const view = getView(new TreeViewConfiguration({ schema: treeSchema }));
			view.initialize({ prop1: { value: 1 } });

			let nodeChanged = false;
			let treeChanged = false;
			// Asserts in the event handlers validate the order of the events we expect
			Tree.on(view.root.prop1, "nodeChanged", () => {
				assert(nodeChanged === false, "nodeChanged should not have fired yet");
				assert(treeChanged === false, "treeChanged should not have fired yet");
				nodeChanged = true;
			});
			Tree.on(view.root.prop1, "treeChanged", () => {
				assert(nodeChanged === true, "nodeChanged should have fired before treeChanged");
				assert(treeChanged === false, "treeChanged should not have fired yet");
				treeChanged = true;
			});

			view.root.prop1.value = 2;

			// Validate changes actually took place and all listeners fired
			assert.equal(view.root.prop1.value, 2, "'prop1' value did not change as expected");
			assert.equal(nodeChanged, true, "'nodeChanged' should have fired");
			assert.equal(treeChanged, true, "'treeChanged' should have fired");
		});

		it(`'nodeChanged' includes the names of changed properties (objectNode)`, () => {
			const sb = new SchemaFactory("test");
			class TestNode extends sb.object("root", {
				prop1: sb.optional(sb.number),
				prop2: sb.optional(sb.number),
				prop3: sb.optional(sb.number),
			}) {}

			const view = getView(new TreeViewConfiguration({ schema: TestNode }));
			view.initialize({ prop1: 1, prop2: 2 });
			const root = view.root;

			// Using property names here instead of string checks that strong typing works.
			const eventLog: ReadonlySet<"prop1" | "prop2" | "prop3">[] = [];
			TreeBeta.on(root, "nodeChanged", ({ changedProperties }) => {
				eventLog.push(changedProperties);
			});

			const { forkView, forkCheckout } = getViewForForkedBranch(view);

			// The implementation details of the kinds of changes that can happen inside the tree are not exposed at this layer.
			// But since we know them, try to cover all of them.
			forkView.root.prop1 = 2; // Replace
			forkView.root.prop2 = undefined; // Detach
			forkView.root.prop3 = 3; // Attach

			view.checkout.merge(forkCheckout);

			assert.deepEqual(eventLog, [new Set(["prop1", "prop2", "prop3"])]);
		});

		it(`'nodeChanged' strong typing`, () => {
			// Check compile time type checking of property names

			const sb = new SchemaFactory("test");
			class ObjectAB extends sb.object("AB", {
				A: sb.optional(sb.number),
				B: sb.optional(sb.number),
			}) {}

			class ObjectBC extends sb.object("BC", {
				B: sb.optional(sb.number),
				C: sb.optional(sb.number),
			}) {}

			class Map1 extends sb.map("Map1", sb.number) {}

			class Array1 extends sb.array("Array1", sb.number) {}

			const ab = new ObjectAB({});
			const bc = new ObjectBC({});
			const map1 = new Map1({});
			const array = new Array1([]);

			TreeBeta.on(ab, "nodeChanged", (data) => {
				const x = data.changedProperties;
				type _check = requireTrue<areSafelyAssignable<typeof x, ReadonlySet<"A" | "B">>>;
			});

			// @ts-expect-error Incorrect variance (using method syntax for "nodeChanged" makes this build when it shouldn't: this is a regression test for that issue)
			TreeBeta.on(ab, "nodeChanged", (data: { changedProperties: ReadonlySet<"A"> }) => {
				const x = data.changedProperties;
			});

			function oneOf<T extends readonly unknown[]>(...items: T): T[number] {
				return items[0];
			}

			function out<T>(data: { changedProperties: ReadonlySet<T> }) {
				return data.changedProperties;
			}

			function outOpt<T>(data: { changedProperties?: ReadonlySet<T> }) {
				return data.changedProperties;
			}

			// Strong types work
			TreeBeta.on(ab, "nodeChanged", out<"A" | "B">);
			TreeBeta.on(ab, "nodeChanged", out<string>);
			// Weakly typed (general) callback works
			TreeBeta.on(ab, "nodeChanged", outOpt<string>);
			TreeBeta.on(ab as TreeNode, "nodeChanged", outOpt<string>);

			// @ts-expect-error Check these test utils work
			TreeBeta.on(ab, "nodeChanged", out<"A">);
			// @ts-expect-error Check these test utils work
			TreeBeta.on(ab, "nodeChanged", out<"A", "B", "C">);
			// @ts-expect-error Check these test utils work
			TreeBeta.on(ab as TreeNode, "nodeChanged", out<"A">);

			// Union cases

			TreeBeta.on(oneOf(ab, bc), "nodeChanged", out<"A" | "B" | "C">);
			TreeBeta.on(oneOf(ab, map1), "nodeChanged", out<string>);
			// @ts-expect-error Check map is included
			TreeBeta.on(oneOf(ab, map1), "nodeChanged", out<"A" | "B">);

			// @ts-expect-error Array makes changedProperties optional
			TreeBeta.on(array, "nodeChanged", out<string>);
			TreeBeta.on(array, "nodeChanged", outOpt<string>);
		});

		it(`'nodeChanged' strong typing example`, () => {
			const factory = new SchemaFactory("example");
			class Point2d extends factory.object("Point2d", {
				x: factory.number,
				y: factory.number,
			}) {}

			const point = new Point2d({ x: 0, y: 0 });

			TreeBeta.on(point, "nodeChanged", (data) => {
				const changed: ReadonlySet<"x" | "y"> = data.changedProperties;
				if (changed.has("x")) {
					// ...
				}
			});

			TreeBeta.on(point, "nodeChanged", (data) => {
				// @ts-expect-error Strong typing for changed properties of object nodes detects incorrect keys:
				if (data.changedProperties.has("z")) {
					// ...
				}
			});
		});

		it(`'nodeChanged' includes the names of changed properties (mapNode)`, () => {
			const sb = new SchemaFactory("test");
			class TestNode extends sb.map("root", [sb.number]) {}

			const view = getView(new TreeViewConfiguration({ schema: TestNode }));
			view.initialize(
				new Map([
					["key1", 1],
					["key2", 2],
				]),
			);
			const root = view.root;

			const eventLog: ReadonlySet<string>[] = [];
			TreeBeta.on(root, "nodeChanged", ({ changedProperties }) =>
				eventLog.push(changedProperties),
			);

			const { forkView, forkCheckout } = getViewForForkedBranch(view);

			// The implementation details of the kinds of changes that can happen inside the tree are not exposed at this layer.
			// But since we know them, try to cover all of them.
			forkView.root.set("key1", 0); // Replace existing key
			forkView.root.delete("key2"); // Remove a key
			forkView.root.set("key3", 3); // Add new key

			view.checkout.merge(forkCheckout);

			assert.deepEqual(eventLog, [new Set(["key1", "key2", "key3"])]);
		});

		it(`'nodeChanged' does not include the names of changed properties (arrayNode)`, () => {
			const sb = new SchemaFactory("test");
			class TestNode extends sb.array("root", [sb.number]) {}

			const view = getView(new TreeViewConfiguration({ schema: TestNode }));
			view.initialize([1, 2]);
			const root = view.root;

			const eventLog: (ReadonlySet<string> | undefined)[] = [];
			TreeBeta.on(root, "nodeChanged", (data) => eventLog.push(data.changedProperties));

			const { forkView, forkCheckout } = getViewForForkedBranch(view);

			// The implementation details of the kinds of changes that can happen inside the tree are not exposed at this layer.
			// But since we know them, try to cover all of them.
			forkView.root.insertAtEnd(3); // Append to array
			forkView.root.removeAt(0); // Remove from array
			forkView.root.moveRangeToEnd(0, 1); // Move within array

			view.checkout.merge(forkCheckout);

			assert.deepEqual(eventLog, [undefined]);
		});

		it(`'nodeChanged' uses property keys, not stored keys, for the list of changed properties`, () => {
			const sb = new SchemaFactory("test");
			class TestNode extends sb.object("root", {
				prop1: sb.optional(sb.number, { key: "stored-prop1" }),
			}) {}

			const view = getView(new TreeViewConfiguration({ schema: TestNode }));
			view.initialize({ prop1: 1 });
			const root = view.root;

			const eventLog: ReadonlySet<string>[] = [];
			TreeBeta.on(root, "nodeChanged", ({ changedProperties }) =>
				eventLog.push(changedProperties),
			);

			const { forkView, forkCheckout } = getViewForForkedBranch(view);

			forkView.root.prop1 = 2;

			view.checkout.merge(forkCheckout);

			assert.deepEqual(eventLog, [new Set(["prop1"])]);
		});
	});

	describe("tree.clone", () => {
		class TestPoint extends schema.object("TestPoint", {
			x: schema.number,
			y: schema.number,
			metadata: schema.optional(schema.string),
		}) {}

		class TestRectangle extends schema.object("TestRectangle", {
			topLeft: TestPoint,
			bottomRight: TestPoint,
			innerPoints: schema.array(TestPoint),
		}) {}

		it("clones unhydrated nodes", () => {
			const topLeft = new TestPoint({ x: 1, y: 1 });
			const bottomRight = new TestPoint({ x: 10, y: 10 });
			const rectangle = new TestRectangle({ topLeft, bottomRight, innerPoints: [] });

			// Clone the root rectangle node.
			const clonedRectangle = TreeBeta.clone<typeof TestRectangle>(rectangle);
			assert.deepEqual(rectangle, clonedRectangle, "Root node not cloned properly");
			assert.notEqual(
				rectangle,
				clonedRectangle,
				"Cloned root node object should be different from the original",
			);

			// Clone a node inside the rectangle.
			const clonedTopLeft = TreeBeta.clone<typeof TestPoint>(topLeft);
			assert.deepEqual(topLeft, clonedTopLeft, "Inner node not cloned properly");
			assert.notEqual(topLeft, clonedTopLeft, "Cloned inner node object should be different");

			// Modify the original rectangle and validate that the clone is not modified.
			rectangle.topLeft = new TestPoint({ x: 2, y: 2 });
			assert.deepEqual(
				clonedRectangle.topLeft,
				topLeft,
				"The cloned node should not be modified when the original changes",
			);
		});

		it("clones hydrated nodes", () => {
			const view = getView(new TreeViewConfiguration({ schema: TestRectangle }));

			const topLeft = new TestPoint({ x: 1, y: 1 });
			const bottomRight = new TestPoint({ x: 10, y: 10 });
			view.initialize({ topLeft, bottomRight, innerPoints: [] });
			const rectangle = view.root;

			// Clone the hydrated root rectangle node.
			const clonedRectangle = TreeBeta.clone<typeof TestRectangle>(rectangle);
			assert.deepEqual(rectangle, clonedRectangle, "Root node not cloned properly");
			assert.notEqual(
				rectangle,
				clonedRectangle,
				"Cloned root node object should be different from the original",
			);

			// Create a new node and insert it.
			const innerPoint1 = new TestPoint({ x: 2, y: 2 });
			{
				const clonedPoint1 = TreeBeta.clone<typeof TestPoint>(innerPoint1);
				assert.deepEqual(innerPoint1, clonedPoint1, "Inner node not cloned properly");
				assert.notEqual(
					innerPoint1,
					clonedPoint1,
					"Cloned inner node object should be different",
				);
			}

			rectangle.innerPoints.insertAtEnd(innerPoint1);

			// Clone the new node inside the rectangle.
			const point1 = rectangle.innerPoints.at(0);
			assert(point1 === innerPoint1, "Point not inserted correctly");
			{
				const clonedPoint1 = TreeBeta.clone<typeof TestPoint>(point1);
				assert.deepEqual(point1, clonedPoint1, "Inner node not cloned properly");
				assert.notEqual(point1, clonedPoint1, "Cloned inner node object should be different");
			}

			// Modify the original rectangle and validate that the clone is not modified.
			rectangle.topLeft = new TestPoint({ x: 2, y: 2 });
			assert.deepEqual(
				clonedRectangle.topLeft,
				topLeft,
				"The cloned node should not be modified when the original changes",
			);
		});

		it("clones unhydrated primitive types", () => {
			const point = new TestPoint({ x: 1, y: 1, metadata: "unhydratedPoint" });
			const clonedX = TreeBeta.clone<typeof schema.number>(point.x);
			assert.equal(clonedX, point.x, "Number not cloned properly");

			assert(point.metadata !== undefined, "Metadata not set correctly");
			const clonedMetadata = TreeBeta.clone<typeof schema.string>(point.metadata);
			assert.equal(clonedMetadata, point.metadata, "String not cloned properly");
		});

		it("clones hydrated primitive types", () => {
			const view = getView(new TreeViewConfiguration({ schema: TestRectangle }));

			const topLeft = new TestPoint({ x: 1, y: 1 });
			const bottomRight = new TestPoint({ x: 10, y: 10 });
			view.initialize({ topLeft, bottomRight, innerPoints: [] });

			const topLeftPoint = view.root.topLeft;
			const clonedX = TreeBeta.clone<typeof schema.number>(topLeftPoint.x);
			assert.equal(clonedX, topLeftPoint.x, "Number not cloned properly");

			topLeftPoint.metadata = "hydratedPoint";
			assert(topLeftPoint.metadata !== undefined, "Metadata not set correctly");
			const clonedMetadata = TreeBeta.clone<typeof schema.string>(topLeftPoint.metadata);
			assert.equal(clonedMetadata, topLeftPoint.metadata, "String not cloned properly");
		});

		describe("test-trees", () => {
			for (const testCase of testSimpleTrees) {
				it(testCase.name, () => {
					const tree = TreeAlpha.create<UnsafeUnknownSchema>(testCase.schema, testCase.root());
					const exported = TreeBeta.clone(tree);
					if (isTreeNode(tree)) {
						// New instance
						assert.notEqual(tree, exported);
					}
					expectTreesEqual(tree, exported);
				});
			}
		});

		describe("test-documents", () => {
			for (const testCase of testDocuments) {
				it(testCase.name, () => {
					const view = testDocumentIndependentView(testCase);
					// Clone hydrated into unhydrated.
					const exported = TreeBeta.clone(view.root);
					expectTreesEqual(exported, view.root);
					// Clone unhydrated into another unhydrated.
					const exported2 = TreeBeta.clone(view.root);
					expectTreesEqual(exported2, view.root);
				});
			}
		});
	});

	// create is mostly the same as node constructors which have their own tests, so just cover the new cases (optional and top level unions) here.
	describe("create", () => {
		it("undefined", () => {
			// Valid
			assert.equal(TreeAlpha.create(schema.optional([]), undefined), undefined);
			// Undefined where not allowed
			assert.throws(
				() => TreeAlpha.create(schema.required([]), undefined as never),
				validateUsageError(/undefined for non-optional field/),
			);
			// Undefined required, not provided
			assert.throws(
				() => TreeAlpha.create(schema.optional([]), 1 as unknown as undefined),
				validateUsageError(/incompatible/),
			);
		});

		it("union", () => {
			// Valid
			assert.equal(TreeAlpha.create([schema.null, schema.number], null), null);
			// invalid
			assert.throws(
				() => TreeAlpha.create([schema.null, schema.number], "x" as unknown as number),
				validateUsageError(/incompatible/),
			);
		});

		// Integration test object complex objects work (mainly covered by tests elsewhere)
		it("object", () => {
			const A = schema.object("A", { x: schema.number });
			const a = TreeAlpha.create(A, { x: 1 });
			assert.deepEqual(a, { x: 1 });
		});

		it("unhydrated object with defaulted read identifier field", () => {
			const A = schema.object("A", { x: schema.identifier });
			const node = TreeAlpha.create(A, { x: undefined });

			// TODO: make this work instead of error:
			const id = node.x;
			// Check allocated id is saved on node, and thus not regenerated on second access.
			assert.equal(id, node.x);
			// Id should be a valid UUID.
			assert(isStableId(id));
			// Since no id compressor is associated with the node, Tree.shortId should give back a UUID string.
			assert.equal(Tree.shortId(node), node.x);

			hydrate(A, node);

			assert.equal(Tree.shortId(node), node.x);
		});

		it("hydrated object with defaulted unread identifier field", () => {
			const A = schema.object("A", { x: schema.identifier });
			const node = TreeAlpha.create(A, { x: undefined });

			hydrate(A, node);
			assert(isStableId(node.x));
			const short = Tree.shortId(node);
			assert.equal(typeof short, "number");
		});

		it("object with explicit identifier field", () => {
			const A = schema.object("A", { x: schema.identifier });
			const node = TreeAlpha.create(A, { x: "id" });
			assert.deepEqual(node, { x: "id" });
		});

		// TODO: implement this case
		it.skip("identifier field", () => {
			const a = TreeAlpha.create(SchemaFactoryAlpha.identifier(), undefined);
			assert(isStableId(a));
		});

		it("reuses existing nodes", () => {
			const A = schema.object("A", {});
			const a = new A({});
			const node = TreeAlpha.create(A, a);
			assert.equal(node, a);

			const Parent = schema.object("P", { child: A });
			const parent = TreeAlpha.create(Parent, { child: a });
			assert.equal(parent.child, a);
		});

		describe("test trees", () => {
			for (const testCase of testSimpleTrees) {
				it(testCase.name, () => {
					// Check create does not error.
					const tree1 = TreeAlpha.create<UnsafeUnknownSchema>(
						testCase.schema,
						testCase.root(),
					);
					// We don't have a lot of ways to check the created tree is correct, so just do some sanity checks. Other more specific tests can cover the details.
					const tree2 = TreeAlpha.create<UnsafeUnknownSchema>(testCase.schema, tree1);
					assert.equal(
						tree1,
						tree2,
						"create should return the same node when given an existing node",
					);
					const tree3 = TreeAlpha.create<UnsafeUnknownSchema>(
						testCase.schema,
						testCase.root(),
					);
					expectTreesEqual(tree1, tree3);
				});
			}
		});
	});

	describe("concise", () => {
		describe("importConcise", () => {
			it("undefined", () => {
				// Valid
				assert.equal(TreeAlpha.importConcise(schema.optional([]), undefined), undefined);
				// Undefined where not allowed
				assert.throws(
					() => TreeAlpha.importConcise(schema.required([]), undefined),
					validateUsageError(/Got undefined for non-optional field/),
				);
				// Undefined required, not provided
				assert.throws(
					() => TreeAlpha.importConcise(schema.optional([]), 1),
					validateUsageError(/incompatible with all of the types allowed/),
				);
			});

			it("union", () => {
				// Valid
				assert.equal(TreeAlpha.importConcise([schema.null, schema.number], null), null);
				// invalid
				assert.throws(
					() => TreeAlpha.importConcise([schema.null, schema.number], "x"),
					validateUsageError(/The provided data is incompatible/),
				);
			});

			it("object", () => {
				const A = schema.object("A", { x: schema.number });
				const a = TreeAlpha.importConcise(A, { x: 1 });
				assert.deepEqual(a, { x: 1 });
			});
		});

		describe("roundtrip", () => {
			for (const testCase of testDocuments) {
				it(testCase.name, () => {
					const view = testDocumentIndependentView(testCase);
					const exported = TreeAlpha.exportConcise(view.root);
					if (testCase.ambiguous) {
						assert.throws(
							() => TreeAlpha.importConcise<UnsafeUnknownSchema>(testCase.schema, exported),
							validateUsageError(/compatible with more than one type/),
						);
					} else {
						const imported = TreeAlpha.importConcise<UnsafeUnknownSchema>(
							testCase.schema,
							exported,
						);
						if (!testCase.hasUnknownOptionalFields) {
							expectTreesEqual(view.root, imported);
						}
						const exported2 = TreeAlpha.exportConcise(imported);
						assert.deepEqual(exported, exported2);
					}
				});
			}
		});

		describe("export-stored", () => {
			for (const testCase of testDocuments) {
				it(testCase.name, () => {
					const view = testDocumentIndependentView(testCase);
					const exported = TreeAlpha.exportConcise(view.root, { useStoredKeys: true });
					// We have nothing that imports concise trees with stored keys, so no validation here.

					// Test exporting unhydrated nodes.
					// For nodes with unknown optional fields and thus are picky about the context, this can catch issues with the context.
					const clone = TreeBeta.clone(view.root);
					const exported2 = TreeAlpha.exportConcise(clone, { useStoredKeys: true });

					assert.deepEqual(exported, exported2);
				});
			}
		});

		it("export-undefined", () => {
			assert.equal(TreeAlpha.exportConcise(undefined), undefined);
		});
	});

	describe("verbose", () => {
		describe("importVerbose", () => {
			it("unknown schema: leaf", () => {
				// Input using schema not included in the context
				assert.throws(
					() => TreeAlpha.importVerbose(SchemaFactory.number, "x"),
					validateUsageError(
						/type "com.fluidframework.leaf.string" which is not defined in this context/,
					),
				);
			});

			it("unknown schema: non-leaf", () => {
				const factory = new SchemaFactory("Test");
				class A extends factory.object("A", {}) {}
				class B extends factory.object("B", {}) {}
				// Input using schema not included in the context
				assert.throws(
					() => TreeAlpha.importVerbose(A, { type: B.identifier, fields: {} }),
					validateUsageError(/type "Test.B" which is not defined/),
				);
			});

			it("invalid with known schema", () => {
				const factory = new SchemaFactory("Test");
				class A extends factory.object("A", { a: SchemaFactory.string }) {}
				assert.throws(
					() => TreeAlpha.importVerbose(A, { type: A.identifier, fields: { wrong: "x" } }),
					validateUsageError(
						`Failed to parse VerboseTree due to unexpected key "wrong" on type "Test.A".`,
					),
				);
			});

			it("missing field with default", () => {
				const factory = new SchemaFactory("Test");
				class A extends factory.object("A", { a: factory.identifier }) {}
				assert.throws(
					() => TreeAlpha.importVerbose(A, { type: A.identifier, fields: {} }),
					validateUsageError(/Field_MissingRequiredChild/),
				);
			});

			it("undefined", () => {
				// Valid
				assert.equal(TreeAlpha.importVerbose(schema.optional([]), undefined), undefined);
				// Undefined where not allowed
				assert.throws(
					() => TreeAlpha.importVerbose(schema.required([]), undefined),
					validateUsageError(/non-optional/),
				);
				// Undefined required, not provided
				assert.throws(
					() => TreeAlpha.importVerbose(schema.optional([]), 1),
					validateUsageError(/Failed to parse tree/),
				);
			});

			it("union", () => {
				// Valid
				assert.equal(TreeAlpha.importVerbose([schema.null, schema.number], null), null);
				// invalid
				assert.throws(
					() => TreeAlpha.importVerbose([schema.null, schema.number], "x"),
					validateUsageError(/Failed to parse tree/),
				);
			});

			it("object", () => {
				const A = schema.object("A", { x: schema.number });
				const a = TreeAlpha.importVerbose(A, { type: A.identifier, fields: { x: 1 } });
				assert.deepEqual(a, { x: 1 });
			});

			it("errors on unknown disallowed fields", () => {
				const exported: VerboseTree = {
					type: Point.identifier,
					fields: { x: 1 },
				};

				assert.throws(
					() => TreeAlpha.importVerbose(Point, exported, { useStoredKeys: true }),
					validateUsageError('Field "x" is not defined in the schema "com.example.Point".'),
				);
				assert.throws(
					() => TreeAlpha.importVerbose(Point, exported),
					validateUsageError(
						// TODO: Better error message: error should mention that unknown optional fields are not allowed in this context.
						'Failed to parse VerboseTree due to unexpected key "x" on type "com.example.Point".',
					),
				);
			});
		});

		describe("exportVerbose", () => {
			it("unknown optional fields", () => {
				const sf1 = new SchemaFactoryAlpha("com.example");
				class PointUnknown extends sf1.objectAlpha(
					"Point",
					{},
					{ allowUnknownOptionalFields: true },
				) {}

				// TODO AB#43548: Provide a utility (test or production) for easily building TreeNodes from content which has unknown optional fields or other schema evolution features.
				// Due to current limitation on unknown types, the utility might need to explicitly take in all referenced types and use a custom context if the node built is unhydrated.
				// Use such a utility here to build such a node instead of this:
				// Construct an A node from a flex node which has an extra unknown optional field.
				const field = createField(
					getUnhydratedContext(PointUnknown).flexContext,
					FieldKinds.optional.identifier,
					brand("x"),
					[unhydratedFlexTreeFromInsertable(1, SchemaFactory.number)],
				);

				const context: Context = getUnhydratedContext([PointUnknown, SchemaFactory.number]);
				const flex = new UnhydratedFlexTreeNode(
					{ type: brand(PointUnknown.identifier) },
					new Map([[brand("x"), field]]),
					context,
				);
				const node = createTreeNodeFromInner(flex);

				assert.deepEqual(TreeAlpha.exportVerbose(node, { useStoredKeys: true }), {
					type: PointUnknown.identifier,
					fields: { x: 1 },
				});

				// TODO AB#43548: provide and test a way to export with stored keys without unknown optional fields.

				assert.deepEqual(TreeAlpha.exportVerbose(node, { useStoredKeys: false }), {
					type: PointUnknown.identifier,
					fields: {},
				});
			});

			describe("test-documents", () => {
				for (const testCase of testDocuments) {
					it(testCase.name, () => {
						const view = testDocumentIndependentView(testCase);
						const exported =
							view.root === undefined
								? undefined
								: TreeAlpha.exportVerbose(view.root, { useStoredKeys: true });
						const fromView = view.checkout.exportVerbose();

						assert.deepEqual(exported, fromView);

						const jsonable = jsonableTreeFromFieldCursor(
							fieldCursorFromVerbose(exported === undefined ? [] : [exported], {}),
						);
						assert.deepEqual(testCase.treeFactory(testIdCompressor), jsonable);
					});
				}
			});
		});

		describe("roundtrip", () => {
			// These tests don't include any unknown optional fields: see the "test-documents" for those.
			// These tests are mostly redundant with the large set of tests in the "test-documents",
			// but these are simpler and have less dependencies.
			describe("unhydrated test-trees", () => {
				for (const testCase of testSimpleTrees) {
					if (testCase.root() !== undefined) {
						it(testCase.name, () => {
							const tree = TreeAlpha.create<UnsafeUnknownSchema>(
								testCase.schema,
								testCase.root(),
							);
							assert(tree !== undefined);

							const exported = TreeAlpha.exportVerbose(tree);
							const imported = TreeAlpha.importVerbose(testCase.schema, exported);
							expectTreesEqual(tree, imported);

							const exportedStored = TreeAlpha.exportVerbose(tree, { useStoredKeys: true });
							const importedStored = TreeAlpha.importVerbose(testCase.schema, exportedStored, {
								useStoredKeys: true,
							});
							expectTreesEqual(tree, importedStored);
							expectTreesEqual(imported, importedStored);
						});
					}
				}
			});

			describe("test-documents", () => {
				for (const testKind of ["hydrated", "unhydrated"] as const) {
					describe(testKind, () => {
						for (const testCase of testDocuments) {
							it(testCase.name, () => {
								const view = testDocumentIndependentView(testCase);
								const root = testKind === "hydrated" ? view.root : TreeBeta.clone(view.root);
								expectTreesEqual(view.root, root);
								if (root !== undefined) {
									// Stored keys
									{
										const exported = TreeAlpha.exportVerbose(root, {
											useStoredKeys: true,
										});
										if (testCase.hasUnknownOptionalFields) {
											// is not defined in the schema
											assert.throws(
												() =>
													TreeAlpha.importVerbose(view.schema, exported, {
														useStoredKeys: true,
													}),
												validateUsageError(/is not defined in the schema/),
											);
										} else {
											const imported = TreeAlpha.importVerbose(view.schema, exported, {
												useStoredKeys: true,
											});
											expectTreesEqual(root, imported);
										}
									}

									// property keys
									{
										const exported = TreeAlpha.exportVerbose(root);
										const imported = TreeAlpha.importVerbose(view.schema, exported);
										if (!testCase.hasUnknownOptionalFields) {
											expectTreesEqual(root, imported);
										}
										assert(imported !== undefined);
										const reexported = TreeAlpha.exportVerbose(imported);
										assert.deepEqual(exported, reexported);
									}
								}
							});
						}
					});
				}
			});

			describe("with misaligned view and stored schema", () => {
				it("does not preserve additional optional fields", () => {
					// (because stored keys are not being used, see analogous test in roundtrip-stored)
					const sf1 = new SchemaFactoryAlpha("com.example");
					class Point2D extends sf1.objectAlpha(
						"Point",
						{
							x: sf1.number,
							y: sf1.number,
						},
						{ allowUnknownOptionalFields: true },
					) {}
					class Point3D extends sf1.objectAlpha("Point", {
						x: sf1.number,
						y: sf1.number,
						z: sf1.optional(sf1.number),
					}) {}

					const testTree = new Point3D({ x: 1, y: 2, z: 3 });
					const exported = TreeAlpha.exportVerbose(testTree);

					// TODO:AB#26720 The error here should be more clear:
					// perhaps reference allowUnknownOptionalFields and stored keys specifically.
					assert.throws(
						() => TreeAlpha.importVerbose(Point2D, exported),

						validateUsageError(
							`Failed to parse VerboseTree due to unexpected key "z" on type "com.example.Point".`,
						),
					);
				});
			});
		});
	});

	describe("compressed", () => {
		describe("roundtrip", () => {
			for (const testCase of testSimpleTrees) {
				if (testCase.root() !== undefined) {
					it(testCase.name, () => {
						const tree = TreeAlpha.create<UnsafeUnknownSchema>(
							testCase.schema,
							testCase.root(),
						);
						assert(tree !== undefined);
						const exported = TreeAlpha.exportCompressed(tree, {
							oldestCompatibleClient: FluidClientVersion.v2_0,
						});
						const imported = TreeAlpha.importCompressed(testCase.schema, exported, {
							jsonValidator: ajvValidator,
						});
						expectTreesEqual(tree, imported);
					});
				}
			}
		});
	});
});

function checkoutWithInitialTree(
	viewConfig: TreeViewConfiguration,
	unhydratedInitialTree: InsertableField<UnsafeUnknownSchema>,
): TreeCheckout {
	const initialTree = fieldCursorFromInsertable<UnsafeUnknownSchema>(
		viewConfig.schema,
		unhydratedInitialTree,
	);
	const treeContent: TreeStoredContent = {
		schema: toStoredSchema(viewConfig.schema),
		initialTree,
	};
	return checkoutWithContent(treeContent);
}

function expectTreesEqual(
	a: TreeNode | TreeLeafValue | undefined,
	b: TreeNode | TreeLeafValue | undefined,
): void {
	if (a === undefined || b === undefined) {
		assert.equal(a === undefined, b === undefined);
		return;
	}

	// Validate the same schema objects are used.
	assert.equal(Tree.schema(a), Tree.schema(b));

	// This should catch all cases, assuming exportVerbose works correctly.
	// Use stored keys so unknown optional fields can be included.
	assert.deepEqual(
		TreeAlpha.exportVerbose(a, { useStoredKeys: true }),
		TreeAlpha.exportVerbose(b, { useStoredKeys: true }),
	);

	// Since this uses some of the tools to compare trees that this is testing for, perform the comparison in a few ways to reduce risk of a bug making this pass when it shouldn't:
	// This case could have false negatives (two trees with ambiguous schema could export the same concise tree),
	// but should have no false positives since equal trees always have the same concise tree.
	assert.deepEqual(TreeAlpha.exportConcise(a), TreeAlpha.exportConcise(b));
	assert.deepEqual(TreeAlpha.exportVerbose(a), TreeAlpha.exportVerbose(b));
}
