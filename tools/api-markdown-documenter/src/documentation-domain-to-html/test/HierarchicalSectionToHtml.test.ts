/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { h } from "hastscript";

import {
	HeadingNode,
	MarkdownBlockContentNode,
	SectionNode,
} from "../../documentation-domain/index.js";

import { assertTransformation } from "./Utilities.js";

describe("HierarchicalSection HTML rendering tests", () => {
	it("Simple section", () => {
		const input = new SectionNode(
			[
				new MarkdownBlockContentNode({
					type: "paragraph",
					children: [{ type: "text", value: "Foo" }],
				}),
				new MarkdownBlockContentNode({ type: "thematicBreak" }),
				new MarkdownBlockContentNode({
					type: "paragraph",
					children: [{ type: "text", value: "Bar" }],
				}),
			],
			/* heading: */ new HeadingNode("Hello World", /* id: */ "heading-id"),
		);

		const expected = h("section", [
			h("h1", { id: "heading-id" }, "Hello World"),
			h("p", "Foo"),
			h("hr"),
			h("p", "Bar"),
		]);

		assertTransformation(input, expected);
	});

	it("Nested section", () => {
		const input = new SectionNode(
			[
				new SectionNode(
					[
						new MarkdownBlockContentNode({
							type: "paragraph",
							children: [{ type: "text", value: "Foo" }],
						}),
					],
					/* heading: */ new HeadingNode("Sub-Heading 1", /* id: */ "sub-heading-1"),
				),

				new SectionNode(
					[
						new SectionNode(
							[
								new MarkdownBlockContentNode({
									type: "paragraph",
									children: [{ type: "text", value: "Bar" }],
								}),
							],
							/* heading: */ new HeadingNode("Sub-Heading 2b"),
						),
					],
					/* heading: */ undefined,
				),
			],
			/* heading: */ new HeadingNode("Root Heading", /* id: */ "root-heading"),
		);

		const expected = h("section", [
			h("h1", { id: "root-heading" }, "Root Heading"),
			h("section", [h("h2", { id: "sub-heading-1" }, "Sub-Heading 1"), h("p", "Foo")]),
			h("section", [h("section", [h("h3", "Sub-Heading 2b"), h("p", "Bar")])]),
		]);

		assertTransformation(input, expected);
	});
});
