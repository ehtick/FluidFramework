/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { type ApiItem, ReleaseTag } from "@microsoft/api-extractor-model";

import {
	MarkdownBlockContentNode,
	type SectionNode,
} from "../../documentation-domain/index.js";
import { getEffectiveReleaseLevel } from "../../utilities/index.js";
import {
	doesItemRequireOwnDocument,
	getHeadingForApiItem,
} from "../ApiItemTransformUtilities.js";
import type { ApiItemTransformationConfiguration } from "../configuration/index.js";
import {
	alphaWarningSpan,
	betaWarningSpan,
	createDeprecationNoticeSection,
	createExamplesSection,
	createRemarksSection,
	createSeeAlsoSection,
	createSignatureSection,
	createSummarySection,
	createThrowsSection,
	wrapInSection,
} from "../helpers/index.js";

/**
 * Default {@link ApiItemTransformationConfiguration.defaultSectionLayout} implementation.
 *
 * @remarks Lays out the content in the following manner:
 *
 * 1. Heading (if not the document-root item, in which case headings are handled specially by document-level rendering)
 *
 * 1. Beta warning (if item annotated with `@beta`)
 *
 * 1. Deprecation notice (if any)
 *
 * 1. Summary (if any)
 *
 * 1. Item Signature
 *
 * 1. Remarks (if any)
 *
 * 1. Examples (if any)
 *
 * 1. `itemSpecificContent`
 *
 * 1. Throws (if any)
 *
 * 1. See (if any)
 *
 * @param apiItem - The API item being rendered.
 * @param itemSpecificContent - API item-specific details to be included in the default layout.
 * @param config - See {@link MarkdownDocumenterConfiguration}.
 */
export function createSectionForApiItem(
	apiItem: ApiItem,
	itemSpecificContent: SectionNode[] | undefined,
	config: ApiItemTransformationConfiguration,
): SectionNode[] {
	const sections: SectionNode[] = [];

	// Render summary comment (if any)
	const summary = createSummarySection(apiItem, config);
	if (summary !== undefined) {
		sections.push(summary);
	}

	// Render deprecation notice (if any)
	const deprecationNotice = createDeprecationNoticeSection(apiItem, config);
	if (deprecationNotice !== undefined) {
		sections.push(deprecationNotice);
	}

	// Render alpha/beta notice if applicable
	const releaseLevel = getEffectiveReleaseLevel(apiItem);
	if (releaseLevel === ReleaseTag.Alpha) {
		sections.push(
			wrapInSection([
				new MarkdownBlockContentNode({
					type: "paragraph",
					children: [alphaWarningSpan],
				}),
			]),
		);
	} else if (releaseLevel === ReleaseTag.Beta) {
		sections.push(
			wrapInSection([
				new MarkdownBlockContentNode({
					type: "paragraph",
					children: [betaWarningSpan],
				}),
			]),
		);
	}

	// Render signature (if any)
	const signature = createSignatureSection(apiItem, config);
	if (signature !== undefined) {
		sections.push(signature);
	}

	// Render @remarks content (if any)
	const renderedRemarks = createRemarksSection(apiItem, config);
	if (renderedRemarks !== undefined) {
		sections.push(renderedRemarks);
	}

	// Render examples (if any)
	const renderedExamples = createExamplesSection(apiItem, config);
	if (renderedExamples !== undefined) {
		sections.push(renderedExamples);
	}

	// Render provided contents
	if (itemSpecificContent !== undefined) {
		// Flatten contents into this section
		sections.push(...itemSpecificContent);
	}

	// Render @throws content (if any)
	const renderedThrows = createThrowsSection(apiItem, config);
	if (renderedThrows !== undefined) {
		sections.push(renderedThrows);
	}

	// Render @see content (if any)
	const renderedSeeAlso = createSeeAlsoSection(apiItem, config);
	if (renderedSeeAlso !== undefined) {
		sections.push(renderedSeeAlso);
	}

	// Add heading to top of section only if this is being rendered to a parent item.
	// Document items have their headings handled specially.
	return doesItemRequireOwnDocument(apiItem, config.hierarchy)
		? sections
		: [wrapInSection(sections, getHeadingForApiItem(apiItem, config))];
}
