# @fluid-tools/api-markdown-documenter

## 0.22.0

### Documentation Domain is being removed

This is a work in progress.

The goal is for transformations to target [mdast](https://github.com/syntax-tree/mdast) directly, rather than going through an intermediate domain.
Transformations to HTML will use `mdast-util-to-hast`.

#### Markdown Nodes

`MarkdownBlockContentNode` has been added to the Documentation Domain temporarily.
They allow `mdast` "block content" trees to be used directly within the `DocumentationNode` hierarchy.

This functionality will be used to iteratively replace and remove `DocumentationNode` implementations, until the entire domain can be removed.

Contexts that use conceptual "phrasing content" in the Documentation Domain now take `mdast` "phrasing content" directly as children.

#### Removed Node kinds

The following kinds of nodes have been removed from the library.
Usages should be converted to `MarkdownBlockContentNode` or `mdast` directly as appropriate.

- `CodeSpanNode`
- `FencedCodeBlockNode`
- `HorizontalRuleNode`
- `LineBreakNode`
- `LinkNode`
- `ParagraphNode`
- `PlainTextNode`
- `SpanNode`

## 0.21.0

### Add DocumentationNode -> mdast transformation layer

Adds transformation library for generating [mdast](https://github.com/syntax-tree/mdast) from `DocumentationNode`s.

#### Example

```typescript
const modelDirectoryPath = "<PATH-TO-YOUR-DIRECTORY-CONTAINING-API-REPORTS>";

// Create the API Model from our API reports
const apiModel = await loadModel({
	modelDirectoryPath,
});

// Transform the API Model to documents
const documents = transformApiModel({
	apiModel,
});

// Convert the documents to Markdown via mdast
const markdownDocuments = documents.map((document) => documentToMarkdown(document, {}));

// Use the resulting Markdown documents with your favorite mdast-compatible library!
```

### List parsing

Markdown-like list syntax is now supported in TSDoc comments.
This support is limited to lists of a single depth (i.e., nested lists are not yet supported).

#### Example

```typescript
/**
 * Foo
 * - bar
 * - baz
 */
export function foo(): string {
    ...
}
```

TSDoc parses the above as a paragraph of content that would otherwise be rendered as `Foo -bar -baz`, since soft line wraps are not treated as line breaks.
This is true for GitHub-flavored Markdown as well, but certain syntax like lists are special cased.

This library now accounts for list-like syntax, and similarly special-cases it to ensure the output matches the intent of the input.

### `DocumentationNode.singleLine` has been removed

This flag was never more than a hack to make our custom Markdown rendering work out correctly.
It doesn't make sense in the context of a general-purpose documentation domain, as it is specifically in terms of whether or not the associated content could be rendered on a single line in *Markdown*.

It has been removed and is no longer used by the system.

### `PlainTextNode.text` property removed

`text` was a redundant alias for `value`, which `PlainTextNode` inherits as a literal node.
This property has now been removed.
Use `PlainTextNode.value` instead.

### `PlainTextNode` no longer supports unsafe "escaped" text

This type previously supported an unsafe escape hatch for text escaping.
This support is no longer needed and has been removed.

### `SpanNode` now requires formatting options

This type's formatting options were previously optional, which encouraged using the type as general purpose grouping mechanism for children.
This resulted in unnecessary hierarchy in the generated trees.

Formatting options are now required when constructing `SpanNode`s.

### `LineBreakNode` removed from `BlockContent`

Block Content items are implicitly separated by a line break, so allowing `LineBreakNode`s in that context is redundant.
Support for `LineBreakNode`s in `BlockContent` contexts has been removed.

### Update `LinkNode`, `HeadingNode`, and `CodeSpanNode` to take `string`s rather than `PlainTextNode`s

Each of the above types accepted only a single `PlainTextNode` as a child value.
These have been updated to accept `string`s instead, which greatly simplifies their use.

Their `createFromPlainText` static factory functions have also been removed, as they are now redundant with their constructors.

### Replace `OrderedListNode` and `UnorderedListNode` with a single `ListNode` type

Additionally, the structure of `ListNode` has been updated to utilize `ListItemNode`s as children to make it easier to group child contents within a single list entry.

### `FencedCodeBlockNode` updated to be a literal node that accepts a string

This matches the requirements for fenced code in Markdown and is all that was required by the system.

### `BlockQuoteNode` was removed

This `DocumentationNode` implementation was not used by the library.
If this type is required, it can be re-introduced via the Documentation Domain's [extensibility model](#new-extensibility-model).

### `DocumentationNodeType` removed

The `DocumentationNodeType` enum has been removed.
Enumerations of supported node kinds in various contexts is now handled via type unions like `BlockContent` and `PhrasingContent`.
String literal types makes typing much simpler to reason about, and more inline with `unist` patterns.

### `TextFormatting` no longer permits *disabling* formatting

This type previously allowed formatting to be disabled at lower scopes in the tree.
E.g., some parent context could set `bold`, and a lower context could *unset* it.
This functionality was unused, does not align with Markdown nor HTML, and made transformation logic more complicated than it strictly needs to be.

This support has been removed.

Additionally, the `toHtml` transformations no longer accept "rootFormatting" as an argument.
Contents may be formatted using `SpanNode`s to introduce formatting to the tree instead.

## 0.20.0

### Add stronger type restrictions to Documentation Domain

The Documentation Domain has been updated to be more restrictive about what kinds of content can appear under specific kinds of nodes.
Most node kinds in the domain have been updated to better align with Markdown.

System node implementations have also been marked as `@sealed` - we do not support user derivations of these types.
If something similar to one of these types is required, a custom `DocumentationNode` implementation may be created instead.

#### New extensibility model

A new extensibility model has been added to the Documentation Domain to ensure users can continue to specify custom node kinds.
Depending on the context(s) in which a custom node is intended to be used, the corresponding type-map can be updated.

##### Example

```typescript
// Define custom node type
export class CustomDocumentationNode extends DocumentationParentNodeBase<PhrasingContent> {
	public readonly type = "custom-node";

	constructor(children) {
		super(children);
	}
}

// Extend the `BlockContentMap` interface to include our custom node kind, so it can be used in `SectionNode`s.
declare module "@fluid-tools/api-markdown-documenter" {
	interface BlockContentMap {
		"custom-node": CustomDocumentationNode;
	}
}

// Use the custom node!
const sectionNode: SectionNode = new SectionNode(
	[new CustomDocumentationNode([new PlainTextNode("Hello world!")])],
	HeadingNode.createFromPlainText("Section with custom children!"),
);
```

### Rename "Construct Signature" headings to "Constructor" for interface API items.

Updates default transformation logic for `ApiInterface` items to generate headings that read "Constructor" rather than "Construct Signature" for constructor-like members.
This better aligns with similar policies for members like interface methods which are labeled "Method" and not "Method Signature", despite the underlying TypeScript AST entry being a "method signature".

### `LayoutUtilities` function updates

- `createSummaryParagraph` has been renamed to `createSummarySection`.
  - It also now returns a `SectionNode`, rather than a `ParagraphNode` to be consistent with the other functions in `LayoutUtilities`.
  - It has also been optimized to not create empty sections for doc comments with no summary component.

- `createDeprecationNoticeSection` now returns a `SectionNode`, rather than a `ParagraphNode`.

### Simplify `DocumentationNode` types

Removes:

- `MultiLineDocumentationNode`
- `SingleLineDocumentationNode`
- `SingleLineSpanNode`

Updates `DocumentationNode` types that were constrained to single-line nodes to allow any `DocumentationNode` children.
Rendering to Markdown falls back to HTML syntax in cases where multi-line content appears in relevant contexts (lists).

Also updates `CodeSpanNode` to only allow plain text content, which is in line with how it is used, and how it is constrained in Markdown.

## 0.19.0

### Add the ability to filter out individual API items (and their descendants) from documentation generation

A new property `exclude` has been added to the options for documentation suite generation.
This can be used to omit API items (and their descendants) from documentation generation.

#### Example

My repo uses a custom `TSDoc` tag `@hideDocs` for API items we don't wish to include in public documentation.
To exclude such items, I could provide the following in my configuration:

```typescript
exclude: (apiItem) => {
	return ApiItemUtilities.hasModifierTag(apiItem, "@hideDocs");
};
```

### ⚠ BREAKING CHANGES

#### `skipPackage` option has been removed

With the addition of `exclude`, `skipPackage` has been removed.
This usage can be migrated as follows:

```typescript
skipPackage: (packageItem) => {
    ...
}
```

becomes

```typescript
exclude: (apiItem) => {
    if (apiItem.kind === ApiItemKind.Package) {
        ...
    } else {
        return false;
    }
}
```

#### `ApiItemUtilities.getReleaseTag` has been removed

This function would get the exact release tag with which the corresponding API item was annotated.
This is not generally useful information, however, as it does not account for inheritance.

E.g., if an item was untagged, but its parent was tagged with `@beta`, this API would have returned `None`.

Additionally, consider the following malformed case: an interface is tagged as `@public`, but its parent namespace is tagged as `@beta`.
The effective release level of the interface should be `Beta`, not `Public`.

A new API, `ApiItemUtilities.getEffectiveReleaseLevel` can now be used to get the appropriate release level of an item, accounting for inheritance.

## 0.18.0

-   The default suite structure has been updated as follows:
    -   `Package` and `Namespace` items now generate documents _inside_ of their own folder hierarchy, yielding documents named "index".
    -   `Enum` and `TypeAlias` items now generate their own documents (rather than being rendered as sections under their parent document).
-   `uriRoot` parameter is now optional.
    The default value is "".

### ⚠ BREAKING CHANGES

The default output format has been updated, as noted above.
Additionally...

#### Simplify the parameters given to `MarkdownRenderer` and `HtmlRenderer` methods.

Combines the separate "config" property bag parameters into a single "options" property bag for simplicity.

##### Example

Before:

```typescript
import { loadModel, MarkdownRenderer } from "@fluid-tools/api-markdown-documenter";

const modelDirectoryPath = "<PATH-TO-YOUR-DIRECTORY-CONTAINING-API-REPORTS>";
const outputDirectoryPath = "<YOUR-OUTPUT-DIRECTORY-PATH>";

// Create the API Model from our API reports
const apiModel = await loadModel({
	modelDirectoryPath,
});

const transformConfig = {
	apiModel,
	uriRoot: "",
};

await MarkdownRenderer.renderApiModel(transformConfig, {}, { outputDirectoryPath });
```

After:

```typescript
import { loadModel, MarkdownRenderer } from "@fluid-tools/api-markdown-documenter";

const modelDirectoryPath = "<PATH-TO-YOUR-DIRECTORY-CONTAINING-API-REPORTS>";
const outputDirectoryPath = "<YOUR-OUTPUT-DIRECTORY-PATH>";

// Create the API Model from our API reports
const apiModel = await loadModel({
	modelDirectoryPath,
});

await MarkdownRenderer.renderApiModel({
	apiModel,
	uriRoot: "", // Note: this parameter is also now optional. Default: "".
	outputDirectoryPath,
});
```

#### Update pattern for controlling file-wise hierarchy

Previously, users could control certain aspects of the output documentation suite's file-system hierarchy via the `documentBoundaries` and `hierarchyBoundaries` properties of the transformation configuration.
One particular limitation of this setup was that items yielding folder-wise hierarchy (`hierarchyBoundaries`) could never place their own document _inside_ of their own hierarchy.
This naturally lent itself to a pattern where output would commonly be formatted as:

```
- foo.md
- foo
    - bar.md
    - baz.md
```

This pattern works fine for many site generation systems - a link to `/foo` will end up pointing `foo.md` and a link to `/foo/bar` will end up pointing to `foo/bar.md`.
But some systems (e.g. `Docusaurus`) don't handle this well, and instead prefer setups like the following:

```
- foo
    - index.md
    - bar.md
    - baz.md
```

With the previous configuration options, this pattern was not possible, but now is.
Additionally, this pattern is _more_ commonly accepted, so lack of support for this was a real detriment.

Such patterns can now be produced via the consolidated `hierarchy` property, while still allowing full file-naming flexibility.

##### Related changes

For consistency / discoverability, the `DocumentationSuiteConfiguration.getFileNameForItem` property has also been moved under the new `hierarchy` property (`HierarchyConfiguration`) and renamed to `getDocumentName`.

Additionally, where previously that property controlled both the document _and_ folder naming corresponding to a given API item, folder naming can now be controlled independently via the `getFolderName` property.

##### Example migration

Consider the following configuration:

```typescript
const config = {
    ...
    documentBoundaries: [
        ApiItemKind.Class,
        ApiItemKind.Interface,
        ApiItemKind.Namespace,
    ],
    hierarchyBoundaries: [
        ApiItemKind.Namespace,
    ]
    ...
}
```

With this configuration, `Class`, `Interface`, and `Namespace` API items would yield their own documents (rather than being rendered to a parent item's document), and `Namespace` items would additionally generate folder hierarchy (child items rendered to their own documents would be placed under a sub-directory).

Output for this case might look something like the following:

```
- package.md
- class.md
- interface.md
- namespace.md
- namespace
    - namespace-member-a.md
    - namespace-member-b.md
```

This same behavior can now be configured via the following:

```typescript
const config = {
    ...
    hierarchy: {
        [ApiItemKind.Class]: HierarchyKind.Document,
        [ApiItemKind.Interface]: HierarchyKind.Document,
        [ApiItemKind.Namespace]: {
            kind: HierarchyKind.Folder,
            documentPlacement: FolderDocumentPlacement.Outside,
        },
    }
    ...
}
```

Further, if you would prefer to place the resulting `Namespace` documents _under_ their resulting folder, you could use a configuration like the following:

```typescript
const config = {
    ...
    hierarchy: {
        [ApiItemKind.Class]: HierarchyKind.Document,
        [ApiItemKind.Interface]: HierarchyKind.Document,
        [ApiItemKind.Namespace]: {
            kind: HierarchyKind.Folder,
            documentPlacement: FolderDocumentPlacement.Inside, // <=
        },
        getDocumentName: (apiItem) => {
            switch(apiItem.kind) {
                case ApiItemKind.Namespace:
                    return "index";
                default:
                    ...
            }
        }
    }
    ...
}
```

Output for this updated case might look something like the following:

```
- package.md
- class.md
- interface.md
- namespace
    - index.md
    - namespace-member-a.md
    - namespace-member-b.md
```

#### Type-renames

-   `ApiItemTransformationOptions` -> `ApiItemTransformations`
-   `ConfigurationBase` -> `LoggingConfiguration`
-   `RenderDocumentAsHtmlConfig` -> `RenderDocumentAsHtmlConfiguration`
-   `RenderHtmlConfig` -> `RenderHtmlConfiguration`
-   `ToHtmlConfig` -> `ToHtmlConfiguration`

#### Utility function renames

-   `ApiItemUtilities.getQualifiedApiItemName` -> `ApiItemUtilities.getFileSafeNameForApiItem`

#### Configuration properties made `readonly`

-   `ApiItemTransformations`
-   `ApiItemTransformationConfiguration`
-   `DocumentationSuiteOptions`
-   `FileSystemConfiguration`
-   `HtmlRenderer.RenderHtmlConfig`
-   `LintApiModelConfiguration`
-   `MarkdownRenderer.Renderers`
-   `MarkdownRenderer.RenderContext`
-   `ToHtmlTransformations`

#### Separate input "options" types and system "configuration" types

This library has an inconsistent mix of `Partial` and `Required` types to represent partial user input parameters and "complete" configurations needed by the system to function.

This version of the library attempts to align its APIs with the following conventions:

-   Naming:
    -   "Options": refers to user-provided API parameters, which may be incomplete.
    -   "Configuration": refers to the "complete" sets of parameters needed by system functionality.
-   Typing:
    -   When possible, "configuration" types will be declared with all properties required.
    -   When possible, "options" types will be declared as `Partial<FooConfiguration>`. When not possible, they will be declared as separate types.

##### Affected types

-   `ApiTransformationConfiguration` -> `ApiTransformationOptions` (user input) and `ApiTransformationConfiguration` (derived system configuration).
-   `DocumentationSuiteOptions` -> `DocumentationSuiteConfiguration` (user input is taken as `Partial<DocumentationSuiteConfiguration>`).

#### Updated structure of `ApiTransformationConfiguration` and `ApiItemTransformations`

Updated the structure of `ApiTransformationConfiguration` to contain a `transformations` property of type `ApiItemTransformations`, rather than implementing that interface directly.

Also updates `ApiItemTransformations` methods to be keyed off of `ApiItemKind`, rather than being individually named.

E.g. A call like `config.transformApiMethod(...)` would become `config.transformations["Method"](...)`.

This better aligns with similar transformational API surfaces in this library, like the renderers.

The `createDefaultLayout` property of `ApiItemTransformations` now lives directly in `ApiTransformationConfiguration`, but has been renamed to `defaultSectionLayout`.

## 0.17.3

-   Fixes an issue where directories generated for API items configured to yield directory-wise hierarchy (via the `hierarchyBoundaries` option) would be generated with names that differed from their corresponding document names.
    -   Longer term, it would be nice to make the relationship between directory names and document names less intertwined, but for now there are aspects of the system that rely on the two being the same, and this invariant was being violated.
        So, for now, this is considered a bug fix.

## 0.17.2

-   Fixes an issue with generated Markdown heading ID overrides where ID contents were not being properly escaped.
    E.g., an anchor ID of `_foo_` would generate `{#_foo_}` (which Markdown renderers could interpret as italicized contents) rather than `{#\_foo\_}`.
    This had the effect of some Markdown renderers (in this case, Docusaurus) treating the reference ID as `foo` instead of `_foo_`.

## 0.17.1

-   Updates `TSDoc` node handling to emit a _warning_ in place of an _error_ when an embedded `HTML` tag is encountered.
    Also updates the logged notice to include the tag that was encountered.
-   Fixes a bug where the default transformation for the `API Model` page did not correctly account for the `skipPackage` configuration, and would list packages that were not intended for inclusion in the generated docs suite.

## 0.17.0

-   Updates HTML rendering APIs to operate on `HAST` domain trees from `documentToHtml`, and leverage existing rendering libraries ([hast-util-to-html](https://www.npmjs.com/package/hast-util-to-html) and [hast-util-format](https://www.npmjs.com/package/hast-util-format)) rather than maintaining bespoke rendering code.
    -   Updates existing `HtmlRenderer.renderApiModel` and `HtmlRenderer.renderDocument` APIs to leverage the new flow.
    -   Also adds `HtmlRenderer.renderHtml` function for direct rendering of `HAST` format generated by `documentToHtml`.
-   Fixed a bug where text formatting was not applied correctly in some cases in the `toHtml` transformation.

### ⚠ BREAKING CHANGES

-   Formatting of generated HTML strings changes with this update.
-   Support for embedded HTML contents in TSDoc comments has been removed.
    The TSDoc parser has some half-baked support for preserving HTML tags in its output, despite the TSDoc spec making no claims about supporting embedded HTML.
    But it does so in a structure that is difficult to handle correctly, assuming that the output language can support arbitrary HTML contents, and that it is safe to output the contents raw and unsanitized.
    As a result, this library's support for such contents was similarly half-baked, and difficult to maintain.
    VSCode Intellisense, as a comparison, chooses to completely ignore HTML tags, and simply render the inner contents ignoring any HTML decorators.
    This library has adopted the same policy.
    If you depended on HTML content preservation, this change will break you.

## 0.16.1

-   Promote `toHtml` transformation functions to `@public`.
    Updates the API surface to be more flexible, allowing users to specify only a partial config, or the full transformation context if they have it.

## 0.16.0

-   Added the following new utility function to `ApiItemUtilities`:
    1. `ancestryHasModifierTag`: Checks if the provided API item or ancestor items are tagged with the specified [modifier tag](https://tsdoc.org/pages/spec/tag_kinds/#modifier-tags).

### Beta

-   Adds prototype functionality for "linting" an API Model (i.e., the set of packages whose docs are published as a single "suite").
    Can be invoked by importing `lintApiModel` from `@fluid-tools/api-markdown-documenter/beta`.
    Returns a set of TSDoc-related "errors" discovered while walking the API Model.
    -   The primary goal of this tool is to detect issues that `API-Extractor` cannot validate on a per-package basis when generating API reports.
        For now, this is limited to validating `@link` and `@inheritDoc` tags to ensure that symbolic references are valid within the API Model.

### ⚠ BREAKING CHANGES

-   Updated `loadModel` to take a configuration object, rather than individual parameters.
    -   Also allows default use of the console logger when no logger is explicitly given.

## 0.15.0

-   Added the following new utility functions to `ApiItemUtilities`:
    1. `getCustomBlockComments`: Gets all _custom_ [block comments](https://tsdoc.org/pages/spec/tag_kinds/#block-tags) associated with the provided API item.
        - **Will not** include built-in block comment kinds like `@see`, `@param`, etc.
    2. `getModifierTags`: Gets all [modifier tags](https://tsdoc.org/pages/spec/tag_kinds/#modifier-tags) associated with the provided API item.
        - **Will** include built-in modifier tags like `@sealed`, release tags, etc.
    3. `hasModifierTag`: Checks if the provided API item is tagged with the specified [modifier tag](https://tsdoc.org/pages/spec/tag_kinds/#modifier-tags).

### ⚠ BREAKING CHANGES

-   The following existing APIs were updated to return `readonly` arrays, where they were not previously `readonly`:
    -   `getExampleBlocks`
    -   `getSeeBlocks`
    -   `getThrowsBlocks`

## 0.14.0

-   Allow configuration of "alerts" in child item tables.
    -   Default behavior can be overridden via the the `getAlertsForItem` option.

### ⚠ BREAKING CHANGES

-   Update default policy for `getHeadingTextForItem` to not insert `(BETA)` and `(ALPHA)` postfixes based on release tags.
    If this is the desired behavior, it can be replicated by overriding `getHeadingTextForItem` to do so.

## 0.13.0

### ⚠ BREAKING CHANGES

-   Removed support for generating front-matter.
    Front-matter generation was never properly designed, and did not fit well into the transformation flow as it was implemented.
    If you require front-matter in the documents you generate, you can inject it by rendering the `DocumentNode`s generated by `transformApiModel`.

## 0.12.2

-   Fixed an issue where variable item tables did not include type information in default ApiItem transformations.
-   Add variable and property type information to associated details sections in default ApiItem transformations.
-   Further improved error messages when an unexpected child kind is encountered when iterating over children in default ApiItem transformations.

## 0.12.1

-   Improved error messages when an unexpected child kind is encountered when iterating over children in default ApiItem transformations.

## 0.12.0

-   Added functionality for transforming Documentation Domain trees to [hast](https://github.com/syntax-tree/hast).
    The main entrypoint for this is: `documentToHtml`.
-   Updated the package to emit ESM only.
-   Fixed a bug where [inline tags](https://tsdoc.org/pages/spec/tag_kinds/#inline-tags) (other than `{@link}` and `{@inheritDoc}`, which are handled specially by API-Extractor) were not handled and resulted in errors being logged to the console.
    Such tags are now handled in the following way:
    -   [{@label}](https://tsdoc.org/pages/tags/label/) tags are simply omitted from the output (they are intended as metadata, not documentation content).
    -   Other custom inline tags are emitted as italicized text.
-   Fixed a bug where pre-escaped text contents (including embedded HTML content) would be incorrectly re-escaped.
-   Fixed a bug where type parameter information was only being generated for `interface` and `class` items.
-   Adds "Constraint" and "Default" columns to type parameter tables when any are present among the type parameters.
-   Fixed a bug where getter/setter properties under interface items did not get documentation generated for them.

### ⚠ BREAKING CHANGES

-   The package now outputs ESM only.
    Consumers will have to migrate accordingly.
-   `DocumentationNode` now has a required `isEmpty` property.
    Implementations will need to provide this.
-   Update the signature of `createTypeParametersSection` to always generate a `SectionNode` when called, such that consumers don't have to handle a potentially undefined return value.
    If the consumer wants to omit the section (for example when the list of type parameters is empty), they can make the call conditional on their end.
-   Removed `createDocumentWriter`, and exported `DocumentWriter` is now an interface rather than a class.
    A `DocumentWriter` may be instantiated via `DocumentWriter.create` (or you can use your own implementation, which was not previously supported).
-   Update `typescript` dependency from `4.x` to `5.x`.
