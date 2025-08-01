/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert, fail } from "node:assert";

import { UsageError } from "@fluidframework/telemetry-utils/internal";

import { MockNodeIdentifierManager } from "../../feature-libraries/index.js";
import {
	SchematizingSimpleTreeView,
	// eslint-disable-next-line import/no-internal-modules
} from "../../shared-tree/schematizingTreeView.js";
import {
	SchemaFactory,
	SchemaFactoryAlpha,
	TreeViewConfiguration,
	type ImplicitFieldSchema,
	type InsertableField,
	type InsertableTypedNode,
	type UnsafeUnknownSchema,
	type TransactionResult,
	type TransactionResultExt,
	toStoredSchema,
	getKernel,
} from "../../simple-tree/index.js";
import {
	checkoutWithContent,
	createTestUndoRedoStacks,
	fieldCursorFromInsertable,
	getView,
	TestTreeProviderLite,
	validateUsageError,
} from "../utils.js";
import { insert, makeTreeFromJsonSequence } from "../sequenceRootUtils.js";
import {
	ForestTypeExpensiveDebug,
	ForestTypeReference,
	type TreeCheckout,
	type TreeStoredContent,
} from "../../shared-tree/index.js";
import type { Mutable } from "../../util/index.js";
import { brand } from "../../util/index.js";
// eslint-disable-next-line import/no-internal-modules
import { UnhydratedFlexTreeNode } from "../../simple-tree/core/unhydratedFlexTree.js";

const schema = new SchemaFactory("com.example");
const config = new TreeViewConfiguration({ schema: schema.number });
const configGeneralized = new TreeViewConfiguration({
	schema: [schema.number, schema.string],
});
const configGeneralized2 = new TreeViewConfiguration({
	schema: [schema.number, schema.boolean],
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

// Schema for tree that must always be empty.
const emptySchema = toStoredSchema(schema.optional([]));

describe("SchematizingSimpleTreeView", () => {
	describe("initialize", () => {
		it("Initialize document", () => {
			const emptyContent = {
				schema: emptySchema,
				initialTree: undefined,
			};
			const checkout = checkoutWithContent(emptyContent);
			const view = new SchematizingSimpleTreeView(
				checkout,
				config,
				new MockNodeIdentifierManager(),
			);

			const { compatibility } = view;
			assert.equal(compatibility.canView, false);
			assert.equal(compatibility.canUpgrade, false);
			assert.equal(compatibility.canInitialize, true);

			view.initialize(5);
			assert.equal(view.root, 5);

			assert.throws(
				() => view.initialize(5),
				validateUsageError(/initialized more than once/),
			);
		});

		for (const additionalAsserts of [true, false]) {
			for (const enableSchemaValidation of [true, false]) {
				it(`Initialize invalid content: enableSchemaValidation: ${enableSchemaValidation}, additionalAsserts: ${additionalAsserts}`, () => {
					class Root extends schema.object("Root", {
						content: schema.number,
					}) {}

					const config2 = new TreeViewConfiguration({
						schema: Root,
						enableSchemaValidation,
					});

					const view = getView(config2, {
						forest: additionalAsserts ? ForestTypeExpensiveDebug : ForestTypeReference,
					});

					const root = new Root({ content: 5 });

					const inner = getKernel(root).getOrCreateInnerNode();
					const field = inner.getBoxed(brand("content"));
					const child = field.boxedAt(0) ?? assert.fail("Expected child");
					assert(child instanceof UnhydratedFlexTreeNode);

					// Modify the tree so that it is out of schema.
					// The public API is supposed to prevent out of schema trees,
					// so this hack using internal APIs is needed a workaround to test the additional schema validation layer.
					// In production cases this extra validation exists to help prevent corruption when bugs
					// allow invalid data through the public API.
					(child.data as Mutable<typeof child.data>).value = "invalid value";

					// Attempt to initialize with invalid content.
					// Currently src/simple-tree/prepareForInsertion.ts has `validateSchema` unconditionally enabled, so this is detected regardless of the value of `enableSchemaValidation`.
					assert.throws(
						() => view.initialize(root),
						validateUsageError(/Tree does not conform to schema./),
					);

					assert.throws(() => view.root, validateUsageError(/invalid state by another error/));
				});
			}
		}
	});

	it("Broken state", () => {
		const emptyContent = {
			schema: emptySchema,
			initialTree: undefined,
		};
		const checkout = checkoutWithContent(emptyContent);
		const view = new SchematizingSimpleTreeView(
			checkout,
			config,
			new MockNodeIdentifierManager(),
		);

		// Put into broken state by trying incompatible upgrade
		assert.throws(() => view.upgradeSchema(), validateUsageError(/compatibility/));

		assert.throws(
			() => view.initialize(5),
			validateUsageError(/invalid state by another error/),
		);
		assert.throws(
			() => view.upgradeSchema(),
			validateUsageError(/invalid state by another error/),
		);
		assert.throws(() => view.root, validateUsageError(/invalid state by another error/));
	});

	const getChangeData = <T extends ImplicitFieldSchema>(
		view: SchematizingSimpleTreeView<T>,
	) => {
		return view.compatibility.canView
			? view.root
			: `SchemaCompatibilityStatus canView: ${view.compatibility.canView} canUpgrade: ${view.compatibility.canUpgrade}`;
	};

	it("Open and close existing document", () => {
		const checkout = checkoutWithInitialTree(config, 5);
		const view = new SchematizingSimpleTreeView(
			checkout,
			config,
			new MockNodeIdentifierManager(),
		);
		assert.equal(view.compatibility.isEquivalent, true);
		const root = view.root;
		assert.equal(root, 5);
		const log: [string, unknown][] = [];
		const unsubscribe = view.events.on("schemaChanged", () =>
			log.push(["schemaChanged", getChangeData(view)]),
		);
		const unsubscribe2 = view.events.on("rootChanged", () =>
			log.push(["rootChanged", view.root]),
		);

		// Should be a no op since not in an error state;
		view.upgradeSchema();

		view.dispose();
		assert.throws(
			() => view.root,
			(e) => e instanceof UsageError,
		);

		unsubscribe();
		unsubscribe2();

		assert.deepEqual(log, []);
	});

	it("Modify root", () => {
		const checkout = checkoutWithInitialTree(config, 5);
		const view = new SchematizingSimpleTreeView(
			checkout,
			config,
			new MockNodeIdentifierManager(),
		);
		view.events.on("schemaChanged", () => log.push(["schemaChanged", getChangeData(view)]));
		view.events.on("rootChanged", () => log.push(["rootChanged", getChangeData(view)]));
		assert.equal(view.root, 5);
		const log: [string, unknown][] = [];

		view.root = 6;

		assert.deepEqual(log, [["rootChanged", 6]]);
	});

	it("Modify root to undefined", () => {
		const config2 = new TreeViewConfiguration({
			schema: SchemaFactory.optional(schema.number),
		});
		const checkout = checkoutWithInitialTree(config2, 5);
		const view = new SchematizingSimpleTreeView(
			checkout,
			config2,
			new MockNodeIdentifierManager(),
		);
		view.events.on("schemaChanged", () => log.push(["schemaChanged", getChangeData(view)]));
		view.events.on("rootChanged", () => log.push(["rootChanged", getChangeData(view)]));
		assert.equal(view.root, 5);
		const log: [string, unknown][] = [];

		view.root = undefined;

		assert.deepEqual(log, [["rootChanged", undefined]]);
	});

	it("Schema becomes un-upgradeable then exact match again", () => {
		const checkout = checkoutWithInitialTree(config, 5);
		const view = new SchematizingSimpleTreeView(
			checkout,
			config,
			new MockNodeIdentifierManager(),
		);
		assert.equal(view.root, 5);
		const log: [string, unknown][] = [];
		view.events.on("schemaChanged", () => log.push(["schemaChanged", getChangeData(view)]));

		// Modify schema to invalidate view
		checkout.updateSchema(toStoredSchema([schema.number, schema.string]));

		assert.deepEqual(log, [
			["schemaChanged", "SchemaCompatibilityStatus canView: false canUpgrade: false"],
		]);
		log.length = 0;
		assert.equal(view.compatibility.isEquivalent, false);
		assert.equal(view.compatibility.canUpgrade, false);
		assert.equal(view.compatibility.canView, false);

		assert.throws(
			() => view.upgradeSchema(),
			(e) => e instanceof UsageError,
		);
		view.breaker.clearError();
		// Modify schema to be compatible again
		checkout.updateSchema(toStoredSchema([schema.number]), true);
		assert.equal(view.compatibility.isEquivalent, true);
		assert.equal(view.compatibility.canUpgrade, true);
		assert.equal(view.compatibility.canView, true);

		assert.deepEqual(log, [["schemaChanged", 5]]);
		assert.equal(view.root, 5);
		view.dispose();
	});

	it("Open document whose stored schema has additional optional fields", () => {
		// This sort of scenario might be reasonably encountered when an "older" version of an application opens
		// up a document that has been created and/or edited by a "newer" version of an application (which has
		// expanded the schema to include more information).
		const factory = new SchemaFactoryAlpha(undefined);
		class PersonGeneralized extends factory.objectAlpha("Person", {
			name: factory.string,
			age: factory.number,
			address: factory.optional(factory.string),
		}) {}
		class PersonSpecific extends factory.objectAlpha(
			"Person",
			{
				name: factory.string,
				age: factory.number,
			},
			{ allowUnknownOptionalFields: true },
		) {}

		const personConfig = new TreeViewConfiguration({
			schema: PersonSpecific,
		});
		const personConfigGeneralied = new TreeViewConfiguration({
			schema: PersonGeneralized,
		});
		const checkout = checkoutWithInitialTree(
			personConfigGeneralied,
			new PersonGeneralized({ name: "Alice", age: 42, address: "123 Main St" }),
		);
		const viewSpecific = new SchematizingSimpleTreeView(
			checkout,
			personConfig,
			new MockNodeIdentifierManager(),
		);

		assert.deepEqual(viewSpecific.compatibility, {
			canView: true,
			canUpgrade: false,
			isEquivalent: false,
			canInitialize: false,
		});

		assert.equal(Object.keys(viewSpecific.root).length, 2);
		assert.equal(Object.entries(viewSpecific.root).length, 2);
		assert.equal(viewSpecific.root.name, "Alice");
		assert.equal(viewSpecific.root.age, 42);

		viewSpecific.dispose();
		const viewGeneralized = new SchematizingSimpleTreeView(
			checkout,
			personConfigGeneralied,
			new MockNodeIdentifierManager(),
		);
		assert.deepEqual(viewGeneralized.compatibility, {
			canView: true,
			canUpgrade: true,
			isEquivalent: true,
			canInitialize: false,
		});
		assert.equal(Object.keys(viewGeneralized.root).length, 3);
		assert.equal(Object.entries(viewGeneralized.root).length, 3);
		assert.equal(viewGeneralized.root.name, "Alice");
		assert.equal(viewGeneralized.root.age, 42);
		assert.equal(viewGeneralized.root.address, "123 Main St");
	});

	it("Calling moveToEnd on a more specific schema preserves a node's optional fields that were unknown to that schema", () => {
		const factorySpecific = new SchemaFactoryAlpha(undefined);
		const factoryGeneral = new SchemaFactoryAlpha(undefined);
		class PersonGeneralized extends factorySpecific.objectAlpha("Person", {
			name: factoryGeneral.string,
			age: factoryGeneral.number,
			address: factoryGeneral.optional(factoryGeneral.string),
		}) {}
		class PersonSpecific extends factorySpecific.objectAlpha(
			"Person",
			{
				name: factorySpecific.string,
				age: factorySpecific.number,
			},
			{ allowUnknownOptionalFields: true },
		) {}

		const peopleConfig = new TreeViewConfiguration({
			schema: factorySpecific.array(PersonSpecific),
		});
		const peopleGeneralizedConfig = new TreeViewConfiguration({
			schema: factoryGeneral.array(PersonGeneralized),
		});
		const checkout = checkoutWithInitialTree(peopleGeneralizedConfig, [
			new PersonGeneralized({ name: "Alice", age: 42, address: "123 Main St" }),
			new PersonGeneralized({ name: "Bob", age: 24 }),
		]);
		const viewSpecific = new SchematizingSimpleTreeView(
			checkout,
			peopleConfig,
			new MockNodeIdentifierManager(),
		);

		assert.deepEqual(viewSpecific.compatibility, {
			canView: true,
			canUpgrade: false,
			isEquivalent: false,
			canInitialize: false,
		});

		viewSpecific.root.moveRangeToEnd(0, 1);

		// To the view that doesn't have "address" in its schema, the node appears as if it doesn't
		// have an address...
		assert.equal(Object.keys(viewSpecific.root[1]).length, 2);
		assert.equal(viewSpecific.root[1].name, "Alice");
		assert.equal(viewSpecific.root[1].age, 42);
		viewSpecific.dispose();

		const viewGeneralized = new SchematizingSimpleTreeView(
			checkout,
			peopleGeneralizedConfig,
			new MockNodeIdentifierManager(),
		);
		assert.deepEqual(viewGeneralized.compatibility, {
			canView: true,
			canUpgrade: true,
			isEquivalent: true,
			canInitialize: false,
		});

		// ...however, despite that client making an edit to Alice, the field is preserved via the move APIs.
		assert.equal(Object.keys(viewGeneralized.root[1]).length, 3);
		assert.equal(viewGeneralized.root[1].name, "Alice");
		assert.equal(viewGeneralized.root[1].age, 42);
		assert.equal(viewGeneralized.root[1].address, "123 Main St");
	});

	it("Open upgradable document, then upgrade schema", () => {
		const checkout = checkoutWithInitialTree(config, 5);
		const view = new SchematizingSimpleTreeView(
			checkout,
			configGeneralized,
			new MockNodeIdentifierManager(),
		);
		const log: [string, unknown][] = [];
		view.events.on("rootChanged", () => log.push(["rootChanged", getChangeData(view)]));

		assert.equal(view.compatibility.canView, false);
		assert.equal(view.compatibility.canUpgrade, true);
		assert.equal(view.compatibility.isEquivalent, false);
		assert.throws(
			() => view.root,
			(e) => e instanceof UsageError,
		);

		view.upgradeSchema();

		assert.deepEqual(log, [["rootChanged", 5]]);

		assert.equal(view.compatibility.isEquivalent, true);
		assert.equal(view.root, 5);
	});

	it("Attempt to open document using view schema that is incompatible due to being too strict compared to the stored schema", () => {
		const checkout = checkoutWithInitialTree(configGeneralized, 6);
		const view = new SchematizingSimpleTreeView(
			checkout,
			config,
			new MockNodeIdentifierManager(),
		);

		assert.equal(view.compatibility.canView, false);
		assert.equal(view.compatibility.canUpgrade, false);
		assert.equal(view.compatibility.isEquivalent, false);
		assert.throws(
			() => view.root,
			(e) => e instanceof UsageError,
		);

		assert.throws(
			() => view.upgradeSchema(),
			(e) => e instanceof UsageError,
		);
	});

	it("Open incompatible document", () => {
		const checkout = checkoutWithInitialTree(configGeneralized, 6);
		const view = new SchematizingSimpleTreeView(
			checkout,
			configGeneralized2,
			new MockNodeIdentifierManager(),
		);

		assert.equal(view.compatibility.canView, false);
		assert.equal(view.compatibility.canUpgrade, false);
		assert.equal(view.compatibility.isEquivalent, false);
		assert.throws(
			() => view.root,
			(e) => e instanceof UsageError,
		);

		assert.throws(
			() => view.upgradeSchema(),
			(e) => e instanceof UsageError,
		);
	});

	it("supports revertibles", () => {
		const checkout = makeTreeFromJsonSequence([]);
		const view = new SchematizingSimpleTreeView(
			checkout,
			config,
			new MockNodeIdentifierManager(),
		);

		const { undoStack, redoStack } = createTestUndoRedoStacks(view.events);

		insert(checkout, 0, "a");
		assert.equal(undoStack.length, 1);
		assert.equal(redoStack.length, 0);

		undoStack.pop()?.revert();
		assert.equal(undoStack.length, 0);
		assert.equal(redoStack.length, 1);
	});

	const schemaFactory = new SchemaFactory(undefined);
	class ChildObject extends schemaFactory.object("ChildObject", {
		content: schemaFactory.number,
	}) {}
	class TestObject extends schemaFactory.object("TestObject", {
		content: schemaFactory.number,
		child: schemaFactory.optional(ChildObject),
	}) {}

	function getTestObjectView(child?: InsertableTypedNode<typeof ChildObject>) {
		const view = getView(new TreeViewConfiguration({ schema: TestObject }));
		view.initialize({
			content: 42,
			child,
		});
		return view;
	}

	it("breaks on error", () => {
		const view = getTestObjectView();
		const node = view.root;
		assert.throws(() => view.breaker.break(new Error("Oh no")));

		assert.throws(() => view.root, validateUsageError(/Oh no/));

		// Ideally this would error, but thats not too important: reads are less dangerous.
		// assert.throws(() => node.content, validateUsageError(/Oh no/));

		// Its important that editing errors when we might be in an invalid state.
		assert.throws(() => {
			node.content = 5;
		}, validateUsageError(/Oh no/));
	});

	describe("events", () => {
		it("schemaChanged", () => {
			const content = {
				schema: toStoredSchema(SchemaFactory.optional([])),
				initialTree: undefined,
			};
			const checkout = checkoutWithContent(content);
			const view = new SchematizingSimpleTreeView(
				checkout,
				new TreeViewConfiguration({ schema: SchemaFactory.optional(SchemaFactory.number) }),
				new MockNodeIdentifierManager(),
			);
			const log: string[] = [];
			view.events.on("schemaChanged", () => log.push("changed"));
			assert.deepEqual(log, []);
			view.upgradeSchema();
			assert.deepEqual(log, ["changed"]);
		});

		it("emits changed events for local edits", () => {
			const view = getView(config);
			view.initialize(1);

			let localChanges = 0;

			const unsubscribe = view.events.on("changed", (data) => {
				if (data.isLocal) {
					localChanges++;
				}
			});

			view.root = 2;
			assert.equal(localChanges, 1);
			unsubscribe();
		});

		it("does not emit changed events for rebases", () => {
			const stringArraySchema = schema.array([schema.string]);
			const stringArrayStoredSchema = toStoredSchema(stringArraySchema);
			const stringArrayContent = {
				schema: stringArrayStoredSchema,
				initialTree: fieldCursorFromInsertable(stringArraySchema, ["a", "b", "c"]),
			};
			const checkout = checkoutWithContent(stringArrayContent);
			const main = new SchematizingSimpleTreeView(
				checkout,
				new TreeViewConfiguration({ schema: stringArraySchema }),
				new MockNodeIdentifierManager(),
			);
			const branch = main.fork();
			const mainRoot = main.root;
			const branchRoot = branch.root;

			mainRoot.insertAt(0, "a");
			assert.deepEqual([...mainRoot], ["a", "a", "b", "c"]);

			let changes = 0;
			branch.events.on("changed", (data) => {
				changes++;
			});

			branch.rebaseOnto(main);
			assert.deepEqual([...branchRoot], ["a", "a", "b", "c"]);
			assert.equal(changes, 0);
		});
	});

	describe("runTransaction", () => {
		describe("transaction callback return values", () => {
			it("implicit success", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
				});
				assert.equal(view.root.content, 43, "The transaction did not commit");
				const expectedResult: TransactionResult = { success: true };
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("explicit success", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return { rollback: false };
				});
				assert.equal(view.root.content, 43, "The transaction did not commit");
				const expectedResult: TransactionResult = { success: true };
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("rollback", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return { rollback: true };
				});
				assert.equal(view.root.content, 42, "The transaction did not rollback");
				const expectedResult: TransactionResult = { success: false };
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("success + user defined value", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return { value: view.root.content };
				});
				assert.equal(view.root.content, 43, "The transaction did not commit");
				const expectedResult: TransactionResultExt<number, undefined> = {
					success: true,
					value: 43,
				};
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("rollback + user defined value", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return { rollback: true, value: view.root.content };
				});
				// The transaction is rolled back. So, the content is reverted to the original value.
				assert.equal(view.root.content, 42, "The transaction did not rollback");
				const expectedResult: TransactionResultExt<undefined, number> = {
					success: false,
					// Note that this is the value that was returned before the transaction was rolled back.
					value: 43,
				};
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("success + preconditions on revert", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return {
						preconditionsOnRevert: [{ type: "nodeInDocument", node: view.root }],
					};
				});
				assert.equal(view.root.content, 43, "The transaction did not commit");
				const expectedResult: TransactionResult = {
					success: true,
				};
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("rollback + preconditions on revert", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return {
						rollback: true,
						preconditionsOnRevert: [{ type: "nodeInDocument", node: view.root }],
					};
				});
				assert.equal(view.root.content, 42, "The transaction did not rollback");
				const expectedResult: TransactionResult = {
					success: false,
				};
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});
		});

		describe("transactions", () => {
			it("runs transactions", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
				});
				assert.equal(view.root.content, 43);
				const expectedResult: TransactionResult = { success: true };
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("can be rolled back", () => {
				const view = getTestObjectView();
				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return { rollback: true };
				});
				assert.equal(view.root.content, 42);
				const expectedResult: TransactionResult = { success: false };
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);
			});

			it("breaks the view on error", () => {
				const view = getTestObjectView();
				const node = view.root;
				assert.throws(
					() =>
						view.runTransaction(() => {
							view.root.content = 43;
							throw new Error("Oh no");
						}),
					(e) => {
						return e instanceof Error && e.message === "Oh no";
					},
				);
				assert.throws(() => view.root, validateUsageError(/Oh no/));
			});

			it("undoes and redoes entire transaction", () => {
				const view = getTestObjectView();
				const { undoStack, redoStack } = createTestUndoRedoStacks(view.checkout.events);

				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					view.root.content = 44;
				});
				const expectedResult: TransactionResult = { success: true };
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);

				assert.equal(view.root.content, 44);
				assert.equal(undoStack.length, 1);
				undoStack[0].revert();
				assert.equal(view.root.content, 42);
				assert.equal(redoStack.length, 1);
				redoStack[0].revert();
				assert.equal(view.root.content, 44);
			});

			it("fails if node existence constraint is already violated", () => {
				const view = getTestObjectView({ content: 42 });
				const childB = view.root.child;
				assert(childB !== undefined);
				// The node given to the constraint is deleted from the document, so the transaction can't possibly succeed even locally/optimistically
				view.root.child = undefined;
				assert.throws(
					() =>
						view.runTransaction(
							() => {
								view.root.content = 43;
							},
							{
								preconditions: [{ type: "nodeInDocument", node: childB }],
							},
						),
					(e) => {
						return (
							e instanceof UsageError &&
							e.message.startsWith(
								`Attempted to add a "nodeInDocument" constraint, but the node is not currently in the document`,
							)
						);
					},
				);
				assert.throws(() => view.root.content, "View should be broken");
			});

			it("respects a violated node existence constraint after sequencing", () => {
				// Create two connected trees with child nodes
				const viewConfig = new TreeViewConfiguration({ schema: TestObject });
				const provider = new TestTreeProviderLite(2);
				const [treeA, treeB] = provider.trees;
				const viewA = treeA.viewWith(viewConfig);
				const viewB = treeB.kernel.viewWith(viewConfig);
				viewA.initialize({
					content: 42,
					child: { content: 42 },
				});
				provider.synchronizeMessages();

				// Tree A removes the child node (this will be sequenced before anything else because the provider sequences ops in the order of submission).
				viewA.root.child = undefined;
				// Tree B runs a transaction to change the root content to 43, but it should only succeed if the child node exists.
				const childB = viewB.root.child;
				assert(childB !== undefined);
				const runTransactionResult = viewB.runTransaction(
					() => {
						viewB.root.content = 43;
					},
					{
						preconditions: [{ type: "nodeInDocument", node: childB }],
					},
				);
				const expectedResult: TransactionResult = { success: true };
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);

				// The transaction does apply optimistically...
				assert.equal(viewA.root.content, 42);
				assert.equal(viewB.root.content, 43);
				// ...but then is rolled back after sequencing because the child node was removed by Tree A.
				provider.synchronizeMessages();
				assert.equal(viewB.root.content, 42);
				assert.equal(viewB.root.content, 42);
			});

			/**
			 * This test exercises the precondition on revert constraints API with a representative scenario.
			 * For more in-depth testing of undo precondition constraints, see editing.spec.ts.
			 */
			it("constraint on revert violated by transaction body", () => {
				const view = getTestObjectView({ content: 42 });
				const child = view.root.child;
				assert(child !== undefined);

				// Called by the transaction body. This violates the constraint on revert but the transaction
				// body doesn't know about it.
				const doSomething = () => {
					view.root.child = undefined;
				};
				assert.throws(
					() =>
						view.runTransaction(() => {
							child.content = 43;
							// Simulates a side effect where a code that the transaction calls ends up violating the
							// constraint on revert.
							doSomething();
							return {
								preconditionsOnRevert: [{ type: "nodeInDocument", node: child }],
							};
						}),
					(e) => {
						return (
							e instanceof UsageError &&
							e.message.startsWith(
								`Attempted to add a "nodeInDocument" constraint on revert, but the node is not currently in the document`,
							)
						);
					},
				);
				assert.throws(() => view.root.content, "View should be broken");
			});

			/**
			 * This test exercises the precondition on revert constraints API with a representative scenario.
			 * For more in-depth testing of undo precondition constraints, see editing.spec.ts.
			 */
			it("constraint on revert violated by interim change", () => {
				const view = getTestObjectView({ content: 42 });
				const child = view.root.child;
				assert(child !== undefined);

				const stack = createTestUndoRedoStacks(view.events);

				const runTransactionResult = view.runTransaction(() => {
					view.root.content = 43;
					return {
						preconditionsOnRevert: [{ type: "nodeInDocument", node: child }],
					};
				});
				assert.equal(view.root.content, 43, "The transaction did not succeed");
				const expectedResult: TransactionResult = {
					success: true,
				};
				assert.deepStrictEqual(
					runTransactionResult,
					expectedResult,
					"The runTransaction result is incorrect",
				);

				const changed42To43 = stack.undoStack[0] ?? fail("Missing undo");

				// This change should violate the constraint in the revert
				view.root.child = undefined;

				// This revert should do nothing since its constraint has been violated
				changed42To43.revert();
				assert.equal(view.root.content, 43, "The revert should have been ignored");

				stack.unsubscribe();
			});
		});
	});
});
