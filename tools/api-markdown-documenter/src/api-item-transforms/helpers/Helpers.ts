/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
	ApiClass,
	ApiDeclaredItem,
	ApiDocumentedItem,
	type ApiEntryPoint,
	ApiInterface,
	type ApiItem,
	ApiReturnTypeMixin,
	ApiTypeParameterListMixin,
	type Excerpt,
	ExcerptTokenKind,
	type HeritageType,
	type IResolveDeclarationReferenceResult,
	type TypeParameter,
	ApiPropertyItem,
	ApiVariable,
} from "@microsoft/api-extractor-model";
import {
	type DocNode,
	type DocNodeContainer,
	DocNodeKind,
	type DocPlainText,
	type DocSection,
} from "@microsoft/tsdoc";
import type { Link as MdastLink, Nodes, Parent, PhrasingContent, Strong, Text } from "mdast";

import type { Heading } from "../../Heading.js";
import type { Link } from "../../Link.js";
import type { Logger } from "../../Logging.js";
import {
	type BlockContent,
	HeadingNode,
	ListItemNode,
	ListNode,
	MarkdownBlockContentNode,
	type SectionContent,
	SectionNode,
} from "../../documentation-domain/index.js";
import {
	type ApiFunctionLike,
	injectSeparator,
	getFileSafeNameForApiItem,
	getSeeBlocks,
	getThrowsBlocks,
	getDeprecatedBlock,
	getExampleBlocks,
	getReturnsBlock,
	getApiItemKind,
	type ValidApiItemKind,
	getFilteredParent,
} from "../../utilities/index.js";
import {
	doesItemKindRequireOwnDocument,
	getLinkForApiItem,
} from "../ApiItemTransformUtilities.js";
import { transformAndWrapTsdoc, transformTsdoc } from "../TsdocNodeTransforms.js";
import {
	HierarchyKind,
	type ApiItemTransformationConfiguration,
} from "../configuration/index.js";

import {
	createParametersSummaryTable,
	createTypeParametersSummaryTable,
} from "./TableHelpers.js";

/**
 * Generates a section for an API signature.
 *
 * @remarks Displayed as a heading with a code-block under it.
 *
 * @param apiItem - The API item whose signature will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The doc section if there was any signature content to render, otherwise `undefined`.
 *
 * @public
 */
export function createSignatureSection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionNode | undefined {
	if (apiItem instanceof ApiDeclaredItem) {
		const signatureExcerpt = apiItem.getExcerptWithModifiers();
		if (signatureExcerpt !== "") {
			const contents: SectionContent[] = [];

			contents.push(
				new MarkdownBlockContentNode({
					type: "code",
					lang: "typescript",
					value: signatureExcerpt.trim(),
				}),
			);

			const renderedHeritageTypes = createHeritageTypesContent(apiItem, config);
			if (renderedHeritageTypes !== undefined) {
				contents.push(...renderedHeritageTypes);
			}

			return wrapInSection(contents, {
				title: "Signature",
				id: `${getFileSafeNameForApiItem(apiItem)}-signature`,
			});
		}
	}
	return undefined;
}

/**
 * Renders a section listing types extended / implemented by the API item, if any.
 *
 * @remarks Displayed as a heading with a comma-separated list of heritage types by category under it.
 *
 * @param apiItem - The API item whose heritage types will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns
 * The section content containing heritage type information, if any is present.
 * Otherwise `undefined`.
 */
function createHeritageTypesContent(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionContent[] | undefined {
	const { logger } = config;

	const contents: SectionContent[] = [];

	if (apiItem instanceof ApiClass) {
		// Render `extends` type if there is one.
		if (apiItem.extendsType) {
			const extendsTypesSpan = createHeritageTypeListSpan(
				[apiItem.extendsType],
				"Extends",
				config,
			);

			if (extendsTypesSpan.length === 0) {
				logger.error(
					'No content was rendered for non-empty "extends" type list. This is not expected.',
				);
			} else {
				contents.push(
					new MarkdownBlockContentNode({
						type: "paragraph",
						children: extendsTypesSpan,
					}),
				);
			}
		}

		// Render `implements` types if there are any.
		const renderedImplementsTypes = createHeritageTypeListSpan(
			apiItem.implementsTypes,
			"Implements",
			config,
		);
		if (renderedImplementsTypes.length > 0) {
			contents.push(
				new MarkdownBlockContentNode({
					type: "paragraph",
					children: renderedImplementsTypes,
				}),
			);
		}
	}

	if (apiItem instanceof ApiInterface) {
		// Render `extends` types if there are any.
		const renderedExtendsTypes = createHeritageTypeListSpan(
			apiItem.extendsTypes,
			"Extends",
			config,
		);

		if (renderedExtendsTypes.length > 0) {
			contents.push(
				new MarkdownBlockContentNode({
					type: "paragraph",
					children: renderedExtendsTypes,
				}),
			);
		}
	}

	// Render type information for properties and variables
	let renderedTypeSpan: PhrasingContent[] = [];
	if (apiItem instanceof ApiPropertyItem) {
		renderedTypeSpan = createTypeSpan(apiItem.propertyTypeExcerpt, config);
	} else if (apiItem instanceof ApiVariable) {
		renderedTypeSpan = createTypeSpan(apiItem.variableTypeExcerpt, config);
	}
	if (renderedTypeSpan.length > 0) {
		contents.push(
			new MarkdownBlockContentNode({
				type: "paragraph",
				children: renderedTypeSpan,
			}),
		);
	}

	// Render type parameters if there are any.
	if (ApiTypeParameterListMixin.isBaseClassOf(apiItem) && apiItem.typeParameters.length > 0) {
		const renderedTypeParameters = createTypeParametersSection(
			apiItem.typeParameters,
			apiItem,
			config,
		);
		contents.push(renderedTypeParameters);
	}

	if (contents.length === 0) {
		return undefined;
	}

	return contents;
}

/**
 * Renders a labeled type-information entry.
 *
 * @remarks Displayed as `Type: <type>`. Type excerpt will be rendered with the appropriate hyperlinks for other types in the API model.
 *
 * @param excerpt - The type excerpt to be displayed.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 */
function createTypeSpan(
	excerpt: Excerpt,
	config: ApiItemTransformationConfiguration,
): PhrasingContent[] {
	if (excerpt.isEmpty) {
		return [];
	}

	const renderedExcerpt = createExcerptSpanWithHyperlinks(excerpt, config);

	if (renderedExcerpt.length === 0) {
		// If the type excerpt is empty, we don't render anything.
		return [];
	}

	return [
		{
			type: "strong",
			children: [{ type: "text", value: "Type" }],
		},
		{
			type: "text",
			value: ": ",
		},
		...renderedExcerpt,
	];
}

/**
 * Renders a labeled, comma-separated list of heritage types.
 *
 * @remarks Displayed as `<label>: <heritage-type>[, <heritage-type>]*`
 *
 * @param heritageTypes - List of types to display.
 * @param label - Label text to display before the list of types.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 */
function createHeritageTypeListSpan(
	heritageTypes: readonly HeritageType[],
	label: string,
	config: ApiItemTransformationConfiguration,
): PhrasingContent[] {
	if (heritageTypes.length === 0) {
		return [];
	}

	// Build up array of excerpt entries
	const renderedHeritageTypes: PhrasingContent[][] = [];
	for (const heritageType of heritageTypes) {
		const renderedExcerpt = createExcerptSpanWithHyperlinks(heritageType.excerpt, config);
		renderedHeritageTypes.push(renderedExcerpt);
	}

	if (renderedHeritageTypes.length === 0) {
		// If the heritage types are empty, we don't render anything.
		return [];
	}

	const renderedList: PhrasingContent[] = [];
	let needsComma = false;
	for (const renderedExcerpt of renderedHeritageTypes) {
		if (needsComma) {
			renderedList.push({
				type: "text",
				value: ", ",
			});
		}
		renderedList.push(...renderedExcerpt);
		needsComma = true;
	}

	return [
		{
			type: "strong",
			children: [{ type: "text", value: label }],
		},
		{
			type: "text",
			value: ": ",
		},
		...renderedList,
	];
}

/**
 * Generates a section for an API item's {@link https://tsdoc.org/pages/tags/see/ | @see} comment blocks.
 *
 * @remarks Displayed as a "See also" heading, followed by the contents of the API item's `@see` comment blocks
 * merged into a single section.
 *
 * @param apiItem - The API item whose `@see` comment blocks will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The doc section if there was any signature content to render, otherwise `undefined`.
 *
 * @public
 */
export function createSeeAlsoSection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionNode | undefined {
	const seeBlocks = getSeeBlocks(apiItem);
	if (seeBlocks === undefined || seeBlocks.length === 0) {
		return undefined;
	}

	const contents: BlockContent[] = [];
	for (const seeBlock of seeBlocks) {
		contents.push(...transformAndWrapTsdoc(seeBlock, apiItem, config));
	}

	return wrapInSection(contents, {
		title: "See Also",
		id: `${getFileSafeNameForApiItem(apiItem)}-see-also`,
	});
}

/**
 * Renders a section describing the type parameters..
 * I.e. {@link https://tsdoc.org/pages/tags/typeparam/ | @typeParam} comment blocks.
 *
 * @remarks Displayed as a labeled, comma-separated list of types.
 * Links will be generated for types that are a part of the same API suite (model).
 *
 * @param typeParameters - List of type parameters associated with some API item.
 * @param contextApiItem - The API item with which the example is associated.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @public
 */
export function createTypeParametersSection(
	typeParameters: readonly TypeParameter[],
	contextApiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionNode {
	const typeParametersTable = createTypeParametersSummaryTable(
		typeParameters,
		contextApiItem,
		config,
	);

	return new SectionNode([typeParametersTable], new HeadingNode("Type Parameters"));
}

/**
 * Renders a doc paragraph for the provided TSDoc excerpt.
 *
 * @remarks This function is a helper to parse TSDoc excerpt token syntax into documentation with the appropriate links.
 * It will generate links to any API members that are a part of the same API suite (model). Other token contents
 * will be rendered as plain text.
 *
 * @param excerpt - The TSDoc excerpt to render.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The rendered contents, if any.
 */
export function createExcerptSpanWithHyperlinks(
	excerpt: Excerpt,
	config: ApiItemTransformationConfiguration,
): PhrasingContent[] {
	if (excerpt.isEmpty) {
		return [];
	}

	const content: PhrasingContent[] = [];
	for (const token of excerpt.spannedTokens) {
		// Markdown doesn't provide a standardized syntax for hyperlinks inside code spans, so we will render
		// the type expression as DocPlainText.  Instead of creating multiple DocParagraphs, we can simply
		// discard any newlines and let the renderer do normal word-wrapping.
		const unwrappedTokenText: string = token.text.replace(/[\n\r]+/g, " ");

		let wroteHyperlink = false;

		// If it's hyperlink-able, then append a DocLinkTag
		if (token.kind === ExcerptTokenKind.Reference && token.canonicalReference) {
			const apiItemResult: IResolveDeclarationReferenceResult =
				config.apiModel.resolveDeclarationReference(token.canonicalReference, undefined);

			if (apiItemResult.resolvedApiItem) {
				const link = getLinkForApiItem(
					apiItemResult.resolvedApiItem,
					config,
					unwrappedTokenText,
				);
				content.push({
					type: "link",
					url: link.target,
					children: [{ type: "text", value: link.text }],
				});
				wroteHyperlink = true;
			}
		}

		// If the token was not one from which we generated hyperlink text, write as plain text instead
		if (!wroteHyperlink) {
			content.push({
				type: "text",
				value: unwrappedTokenText,
			});
		}
	}

	return content;
}

/**
 * Renders a simple navigation breadcrumb.
 *
 * @remarks Displayed as a ` > `-separated list of hierarchical page links.
 * 1 for each element in the provided item's ancestry for which a separate document is generated
 * (see {@link HierarchyConfiguration}).
 *
 * @param apiItem - The API item whose ancestry will be used to generate the breadcrumb.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @public
 */
export function createBreadcrumbParagraph(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): MarkdownBlockContentNode {
	// #region Get hierarchy of document items

	const breadcrumbLinks: Link[] = [getLinkForApiItem(apiItem, config)];

	let currentItem: ApiItem | undefined = getFilteredParent(apiItem);
	while (currentItem !== undefined) {
		const currentItemKind = getApiItemKind(currentItem);
		const currentItemHierarchy = config.hierarchy[currentItemKind];
		// Push breadcrumb entries for all files in the hierarchy.
		if (currentItemHierarchy.kind !== HierarchyKind.Section) {
			breadcrumbLinks.push(getLinkForApiItem(currentItem, config));
		}

		currentItem = getFilteredParent(currentItem);
	}
	breadcrumbLinks.reverse(); // Items are populated in ascending order, but we want them in descending order.

	// #endregion

	const renderedLinks: MdastLink[] = breadcrumbLinks.map((link) => ({
		type: "link",
		url: link.target,
		children: [{ type: "text", value: link.text }],
	}));

	const breadcrumbSeparator: Text = {
		type: "text",
		value: " > ",
	};

	// Inject breadcrumb separator between each link
	const contents: PhrasingContent[] = injectSeparator<PhrasingContent>(
		renderedLinks,
		breadcrumbSeparator,
	);

	return new MarkdownBlockContentNode({
		type: "paragraph",
		children: contents,
	});
}

/**
 * Alert text used in {@link alphaWarningSpan}.
 */
export const alphaWarningText: string =
	"WARNING: This API is provided as an alpha preview and may change without notice. Use at your own risk.";

/**
 * A simple italic span containing a warning about using `@alpha` APIs.
 */
export const alphaWarningSpan: Strong = {
	type: "strong",
	children: [{ type: "text", value: alphaWarningText }],
};

/**
 * Alert text used in {@link betaWarningSpan}.
 */
export const betaWarningText: string =
	"WARNING: This API is provided as a beta preview and may change without notice. Use at your own risk.";

/**
 * A simple italic span containing a warning about using `@beta` APIs.
 */
export const betaWarningSpan: Strong = {
	type: "strong",
	children: [{ type: "text", value: betaWarningText }],
};

/**
 * Renders a section containing the API item's summary comment if it has one.
 *
 * @param apiItem - The API item whose summary documentation will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @public
 */
export function createSummarySection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionNode | undefined {
	if (apiItem instanceof ApiDocumentedItem && apiItem.tsdocComment !== undefined) {
		const sectionContents = transformAndWrapTsdoc(
			apiItem.tsdocComment.summarySection,
			apiItem,
			config,
		);
		return sectionContents.length === 0 ? undefined : new SectionNode(sectionContents);
	}
	return undefined;
}

/**
 * Renders a section containing the {@link https://tsdoc.org/pages/tags/remarks/ | @remarks} documentation of the
 * provided API item, if it has any.
 *
 * @remarks Displayed as a heading, with the documentation contents under it.
 *
 * @param apiItem - The API item whose `@remarks` documentation will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The doc section if the API item had a `@remarks` comment, otherwise `undefined`.
 *
 * @public
 */
export function createRemarksSection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionNode | undefined {
	if (
		!(apiItem instanceof ApiDocumentedItem) ||
		apiItem.tsdocComment?.remarksBlock === undefined
	) {
		return undefined;
	}

	return wrapInSection(
		transformAndWrapTsdoc(apiItem.tsdocComment.remarksBlock.content, apiItem, config),
		{ title: "Remarks", id: `${getFileSafeNameForApiItem(apiItem)}-remarks` },
	);
}

/**
 * Renders a section containing the {@link https://tsdoc.org/pages/tags/throws/ | @throws} documentation of the
 * provided API item, if it has any.
 *
 * @remarks Displayed as a heading, with the documentation contents under it.
 *
 * @param apiItem - The API item whose `@throws` documentation will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 * @param headingText - The text to use for the heading in the throws section. Defaults to "Throws".
 *
 * @returns The doc section if the API item had any `@throws` comments, otherwise `undefined`.
 *
 * @public
 */
export function createThrowsSection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
	headingText: string = "Throws",
): SectionNode | undefined {
	const throwsBlocks = getThrowsBlocks(apiItem);
	if (throwsBlocks === undefined || throwsBlocks.length === 0) {
		return undefined;
	}

	const contents: BlockContent[] = [];
	for (const throwsBlock of throwsBlocks) {
		contents.push(...transformAndWrapTsdoc(throwsBlock, apiItem, config));
	}

	return wrapInSection(contents, {
		title: headingText,
		id: `${getFileSafeNameForApiItem(apiItem)}-throws`,
	});
}

/**
 * Renders a section containing the {@link https://tsdoc.org/pages/tags/deprecated/ | @deprecated} notice documentation
 * of the provided API item if it is annotated as `@deprecated`.
 *
 * @remarks Displayed as a simple note box containing the deprecation notice comment.
 *
 * @param apiItem - The API item whose `@deprecated` documentation will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The doc section if the API item had a `@remarks` comment, otherwise `undefined`.
 *
 * @public
 */
export function createDeprecationNoticeSection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionNode | undefined {
	const deprecatedBlock = getDeprecatedBlock(apiItem);
	if (deprecatedBlock === undefined) {
		return undefined;
	}

	return wrapInSection([
		new MarkdownBlockContentNode({
			type: "paragraph",
			children: [
				{
					type: "strong",
					children: [
						{
							type: "text",
							value:
								"WARNING: This API is deprecated and will be removed in a future release.",
						},
					],
				},
			],
		}),
		...transformAndWrapTsdoc(deprecatedBlock, apiItem, config),
	]);
}

/**
 * Renders a section containing any {@link https://tsdoc.org/pages/tags/example/ | @example} documentation of the
 * provided API item if it has any.
 *
 * @remarks
 *
 * Each example will be displayed under its own heading.
 *
 * If there is only 1 example comment, all example headings will be parented under a top level "Examples" heading.
 *
 * @param apiItem - The API item whose `@example` documentation will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 * @param headingText - The text to use for the heading in the examples section. Defaults to "Examples".
 *
 * @returns The doc section if the API item had any `@example` comment blocks, otherwise `undefined`.
 *
 * @public
 */
export function createExamplesSection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
	headingText: string = "Examples",
): SectionNode | undefined {
	const exampleBlocks = getExampleBlocks(apiItem);

	if (exampleBlocks === undefined || exampleBlocks.length === 0) {
		return undefined;
	}

	// If there is only 1 example, render it with a single default (un-numbered) heading
	if (exampleBlocks.length === 1) {
		return createExampleSection({ apiItem, content: exampleBlocks[0] }, config);
	}

	const exampleSections: SectionNode[] = [];
	for (const [i, exampleBlock] of exampleBlocks.entries()) {
		const exampleNumber = i + 1; // i is 0-based, but we want our example numbers to be 1-based.
		exampleSections.push(
			createExampleSection({ apiItem, content: exampleBlock, exampleNumber }, config),
		);
	}

	return wrapInSection(exampleSections, {
		title: headingText,
		id: `${getFileSafeNameForApiItem(apiItem)}-examples`,
	});
}

/**
 * Represents a single {@link https://tsdoc.org/pages/tags/example/ | @example} comment block for a given API item.
 */
interface ExampleProperties {
	/**
	 * The API item the example doc content belongs to.
	 */
	apiItem: ApiItem;

	/**
	 * `@example` comment body.
	 */
	content: DocSection;

	/**
	 * Example number. Used to disambiguate multiple `@example` comment headings numerically when there is more than 1.
	 * If not specified, example heading will not be labeled with a number.
	 *
	 * @remarks The example number will not be displayed if the example has a title.
	 */
	exampleNumber?: number;
}

/**
 * Renders a section containing a single {@link https://tsdoc.org/pages/tags/example/ | @example} documentation comment.
 *
 * @remarks
 *
 * Displayed as a heading with the example body under it.
 *
 * Per the `TSDoc` spec linked above, the example heading is generated as follows:
 *
 * If the `@example` content has text on the first line (the same line as the `@example` tag), that text content is
 * treated as the example's "title", used in the heading text (and is not included in the content body).
 *
 * Otherwise, the heading is generated as "Example[ \<{@link ExampleProperties.exampleNumber}\>]".
 *
 * @example Example comment with title "Foo"
 *
 * An example comment with title "Foo" (regardless of `exampleNumber` value) will produce something like the following
 * (expressed in Markdown, heading levels will vary):
 *
 * ```markdown
 * # Example: Foo
 *
 * ...
 * ```
 *
 * @example Example comment without title, no `exampleNumber` provided
 *
 * An example comment without a title line, and with no `exampleNumber` value provided will generate content like
 * the following (expressed in Markdown, heading levels will vary):
 *
 * ```markdown
 * # Example
 *
 * ...
 * ```
 *
 * @example With no title and {@link ExampleProperties.exampleNumber} provided
 *
 * An example comment without a title line, and `exampleNumber` value of `2` will generate content like
 * the following (expressed in Markdown, heading levels will vary):
 *
 * ```markdown
 * # Example 2
 *
 * ...
 * ```
 *
 * @param example - The example comment to render.
 * @param contextApiItem - The API item with which the example is associated.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The rendered {@link SectionNode}.
 */
function createExampleSection(
	example: ExampleProperties,
	config: ApiItemTransformationConfiguration,
): SectionNode {
	const { logger } = config;

	let transformedExampleContent = transformTsdoc(example.content, example.apiItem, config);

	// Per TSDoc spec, if the `@example` comment has content on the same line as the tag,
	// that line is expected to be treated as the title.
	// This information is not provided to us directly, so instead we will walk the content tree
	// and see if the first leaf node is plain text. If it is, we will use that as the title (header).
	// If not (undefined), we will use the default heading scheme.
	// Reference: <https://tsdoc.org/pages/tags/example/>
	const exampleTitle = extractTitleFromExampleSection(example.content);

	const headingTitle =
		exampleTitle === undefined
			? example.exampleNumber === undefined
				? "Example"
				: `Example ${example.exampleNumber}`
			: `Example: ${exampleTitle}`;

	// If our example contained a title line, we need to strip that content out of the body.
	// Unfortunately, the input `DocNode` types are all class based, and do not expose their constructors, so it is
	// difficult to mutate or make surgical copies of their trees.
	// Instead, we will adjust the output we generated via the above transformation logic.
	if (exampleTitle !== undefined) {
		logger?.verbose(
			`Found example comment with title "${exampleTitle}". Adjusting output to adhere to TSDoc spec...`,
		);
		transformedExampleContent = stripTitleFromExampleComment(
			transformedExampleContent,
			exampleTitle,
			logger,
		);
	}

	const headingId = `${getFileSafeNameForApiItem(example.apiItem)}-example${
		example.exampleNumber ?? ""
	}`;

	const sectionChildren = transformedExampleContent.map(
		(node) => new MarkdownBlockContentNode(node),
	);

	// Always emit the section, even if the body is empty after stripping out the title.
	return wrapInSection(sectionChildren, {
		title: headingTitle,
		id: headingId,
	});
}

/**
 * Scans the input tree to see if the first leaf node is plain text. If it is, returns it. Otherwise, returns undefined.
 *
 * @remarks
 *
 * Per TSDoc spec, if the `@example` comment has content on the same line as the tag,
 * that line is expected to be treated as the title.
 *
 * Ideally, the TSDoc parser would handle all of this for us, but it does not currently do so.
 * See the following github issue for more details: {@link https://github.com/microsoft/rushstack/issues/4860}
 *
 * Since the information is not provided to us directly, we instead walk the content tree
 * and see if the first leaf node is plain text. If it is, we will use that as the title (header).
 * If not (undefined), we will use the default heading scheme.
 *
 * Reference: {@link https://tsdoc.org/pages/tags/example/}
 */
function extractTitleFromExampleSection(sectionNode: DocSection): string | undefined {
	// Drill down to find first leaf node. If it is plain text (and not a line break),
	// use it as title.
	let currentNode: DocNode = sectionNode;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const children = (currentNode as Partial<DocNodeContainer>).nodes;

		if (children === undefined || children.length === 0) {
			if (currentNode.kind === DocNodeKind.PlainText) {
				return (currentNode as DocPlainText).text.trim();
			}

			return undefined;
		}
		currentNode = children[0];
	}
}

/**
 * Scans the input tree for the first leaf. We expect it to be a plain text node, whose text is the specified `title`.
 * If it is, we will make a copy of the input tree which omits that node and any subsequent line break nodes, and
 * return that copy.
 *
 * @remarks
 *
 * See {@link createExampleSection} for a more complete description of why this is needed.
 *
 * In short, we need to strip out the "title" line of the example in some cases.
 * But making edits to the input "DocNode" trees is difficult.
 * Instead, we will validate our assumptions about the generated output tree, and strip off the title if everything
 * is as we expect.
 *
 * In the case where the output is not in a form we expect, we will log an error and return the node we were given,
 * rather than making a copy.
 *
 * @returns The updated node, if any content remains. Otherwise, `undefined`.
 */
function stripTitleFromExampleComment<TNode extends Nodes>(
	nodes: readonly TNode[],
	title: string,
	logger: Logger | undefined,
): TNode[] {
	// Verify title matches text of first plain text in output.
	// This is an expected invariant. If this is not the case, then something has gone wrong.
	// Note: if we ever allow consumers to provide custom DocNode transformations, this invariant will likely
	// disappear, and this code will need to be updated to function differently.
	// Reference: <https://tsdoc.org/pages/tags/example/>
	if (nodes.length === 0) {
		logger?.error(
			"Transformed example paragraph begins with empty parent node. This is unexpected and indicates a bug.",
		);
		return [];
	}

	const firstChild = nodes[0];
	if ((firstChild as Partial<Parent>).children !== undefined) {
		const newFirst = {
			...firstChild,
			children: stripTitleFromExampleComment((firstChild as Parent).children, title, logger),
		};

		const remaining = nodes.slice(1);

		// If there are no remaining children under the first item after stripping out the title, omit that item altogether.
		return newFirst.children.length === 0 ? remaining : [newFirst, ...remaining];
	}

	if (firstChild.type === "text") {
		const text = firstChild.value;
		if (text === title) {
			// Remove the title element from the input list, and remove any intervening line breaks
			const remaining = nodes.slice(1);
			while (remaining.length > 0 && remaining[0].type === "break") {
				remaining.shift();
			}
			// If there are no remaining children under this parent after stripping out the title, omit this parent node.
			return remaining;
		} else {
			logger?.error(
				"Transformed example paragraph does not begin with expected title. This is unexpected and indicates a bug.",
				`Expected: "${title}".`,
				`Found: "${text}".`,
			);
			return [...nodes];
		}
	} else {
		logger?.error(
			"Transformed example paragraph does not begin with plain text. This is unexpected and indicates a bug.",
		);
		return [...nodes];
	}
}

/**
 * Renders a section describing the list of parameters (if any) of a function-like API item.
 *
 * @remarks Displayed as a heading with a table representing the different parameters under it.
 *
 * @param apiFunctionLike - The function-like API item whose parameters will be described.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The doc section if the item had any parameters, otherwise `undefined`.
 *
 * @public
 */
export function createParametersSection(
	apiFunctionLike: ApiFunctionLike,
	config: ApiItemTransformationConfiguration,
): SectionNode | undefined {
	if (apiFunctionLike.parameters.length === 0) {
		return undefined;
	}

	return wrapInSection(
		[createParametersSummaryTable(apiFunctionLike.parameters, apiFunctionLike, config)],
		{
			title: "Parameters",
			id: `${getFileSafeNameForApiItem(apiFunctionLike)}-parameters`,
		},
	);
}

/**
 * Renders a section containing the {@link https://tsdoc.org/pages/tags/returns/ | @returns} documentation of the
 * provided API item, if it has one.
 *
 * @remarks Displayed as a heading, with the documentation contents and the return type under it.
 *
 * @param apiItem - The API item whose `@returns` documentation will be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 *
 * @returns The doc section if the API item had a `@returns` comment, otherwise `undefined`.
 *
 * @public
 */
export function createReturnsSection(
	apiItem: ApiItem,
	config: ApiItemTransformationConfiguration,
): SectionNode | undefined {
	const children: SectionContent[] = [];

	// Generate span from `@returns` comment
	if (apiItem instanceof ApiDocumentedItem && apiItem.tsdocComment !== undefined) {
		const returnsBlock = getReturnsBlock(apiItem);
		if (returnsBlock !== undefined) {
			children.push(...transformAndWrapTsdoc(returnsBlock, apiItem, config));
		}
	}

	// Generate paragraph with notes about the return type
	if (
		ApiReturnTypeMixin.isBaseClassOf(apiItem) &&
		apiItem.returnTypeExcerpt.text.trim() !== ""
	) {
		// Special case to detect when the return type is `void`.
		// We will skip declaring the return type in this case.
		// eslint-disable-next-line unicorn/no-lonely-if
		if (apiItem.returnTypeExcerpt.text.trim() !== "void") {
			const typeExcerptSpan = createExcerptSpanWithHyperlinks(
				apiItem.returnTypeExcerpt,
				config,
			);
			if (typeExcerptSpan.length > 0) {
				children.push(
					new MarkdownBlockContentNode({
						type: "paragraph",
						children: [
							{
								type: "strong",
								children: [{ type: "text", value: "Return type" }],
							},
							{
								type: "text",
								value: ": ",
							},
							...typeExcerptSpan,
						],
					}),
				);
			}
		}
	}

	return children.length === 0
		? undefined
		: wrapInSection(children, {
				title: "Returns",
				id: `${getFileSafeNameForApiItem(apiItem)}-returns`,
			});
}

/**
 * Represents a series API child items for which documentation sections will be generated.
 */
export interface ChildSectionProperties {
	/**
	 * Heading for the section being rendered.
	 */
	heading: Heading;

	/**
	 * The API item kind of all child items.
	 */
	itemKind: ValidApiItemKind;

	/**
	 * The child items to be rendered.
	 *
	 * @remarks Every item's `kind` must be `itemKind`.
	 */
	items: readonly ApiItem[];
}

/**
 * Renders a section describing child items of some API item, grouped by `kind`.
 *
 * @remarks Displayed as a series of subsequent sub-sections.
 *
 * Note: Rendering here will skip any items intended to be rendered to their own documents
 * (see {@link DocumentBoundaries}).
 * The assumption is that this is used to render child contents to the same document as the parent.
 *
 * @param childItems - The child sections to be rendered.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 * @param createChildContent - Callback to render a given child item.
 *
 * @returns The doc section if there were any child contents to render, otherwise `undefined`.
 */
export function createChildDetailsSection(
	childItems: readonly ChildSectionProperties[],
	config: ApiItemTransformationConfiguration,
	createChildContent: (apiItem) => SectionContent[],
): SectionNode[] | undefined {
	const sections: SectionNode[] = [];

	for (const childItem of childItems) {
		// Only render contents for a section if the item kind is one that gets rendered to its parent's document
		// (i.e. it does not get rendered to its own document).
		// Also only render the section if it actually has contents to render (to avoid empty headings).
		if (
			!doesItemKindRequireOwnDocument(childItem.itemKind, config.hierarchy) &&
			childItem.items.length > 0
		) {
			const childContents: SectionContent[] = [];
			for (const item of childItem.items) {
				childContents.push(...createChildContent(item));
			}

			sections.push(wrapInSection(childContents, childItem.heading));
		}
	}

	return sections.length === 0 ? undefined : sections;
}

/**
 * Wraps the provided contents in a {@link SectionNode}.
 * @param nodes - The section's child contents.
 * @param heading - Optional heading to associate with the section.
 */
export function wrapInSection(nodes: SectionContent[], heading?: Heading): SectionNode {
	return new SectionNode(
		nodes,
		heading ? HeadingNode.createFromPlainTextHeading(heading) : undefined,
	);
}

/**
 * Creates an {@link UnorderedListNode} containing links to each of the specified entry-points.
 *
 * @param apiEntryPoints - The list of entry-points to display / link to.
 * @param config - See {@link ApiItemTransformationConfiguration}.
 */
export function createEntryPointList(
	apiEntryPoints: readonly ApiEntryPoint[],
	config: ApiItemTransformationConfiguration,
): ListNode | undefined {
	if (apiEntryPoints.length === 0) {
		return undefined;
	}

	return new ListNode(
		apiEntryPoints.map((entryPoint) => {
			const link = getLinkForApiItem(entryPoint, config);
			return new ListItemNode([
				{
					type: "link",
					url: link.target,
					children: [{ type: "text", value: link.text }],
				},
			]);
		}),
		/* ordered */ false,
	);
}
