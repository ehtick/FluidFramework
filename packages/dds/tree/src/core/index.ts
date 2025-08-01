/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

export {
	EmptyKey,
	type TreeType,
	type Value,
	type TreeValue,
	AnchorSet,
	type DetachedField,
	type UpPath,
	type NormalizedUpPath,
	type INormalizedUpPath,
	type NormalizedFieldUpPath,
	type Range,
	type RangeUpPath,
	type PlaceUpPath,
	type PlaceIndex,
	type NodeIndex,
	type FieldUpPath,
	type Anchor,
	type RootField,
	type ChildCollection,
	type ChildLocation,
	type FieldMapObject,
	type NodeData,
	type GenericTreeNode,
	type JsonableTree,
	EncodedJsonableTree,
	rootFieldKey,
	rootField,
	type ITreeCursor,
	CursorLocationType,
	type ITreeCursorSynchronous,
	castCursorToSynchronous,
	type GenericFieldsNode,
	type AnchorLocator,
	genericTreeKeys,
	getGenericTreeField,
	genericTreeDeleteIfEmpty,
	getDepth,
	mapCursorField,
	mapCursorFields,
	iterateCursorField,
	type MapTree,
	detachedFieldAsKey,
	keyAsDetachedField,
	visitDelta,
	createAnnouncedVisitor,
	combineVisitors,
	announceDelta,
	applyDelta,
	makeDetachedFieldIndex,
	setGenericTreeField,
	type DeltaVisitor,
	type AnnouncedVisitor,
	SparseNode,
	getDescendant,
	compareUpPaths,
	clonePath,
	topDownPath,
	compareFieldUpPaths,
	forEachNode,
	forEachNodeInSubtree,
	forEachField,
	type PathRootPrefix,
	deltaForRootInitialization,
	makeDetachedNodeId,
	offsetDetachId,
	emptyDelta,
	type AnchorSlot,
	type AnchorNode,
	anchorSlot,
	type UpPathDefault,
	isDetachedUpPath,
	inCursorField,
	inCursorNode,
	type AnchorEvents,
	type AnchorSetRootEvents,
	type ProtoNodes,
	CursorMarker,
	isCursor,
	DetachedFieldIndex,
	type ForestRootId,
	getDetachedFieldContainingPath,
	aboveRootPlaceholder,
	type DeltaRoot,
	type DeltaMark,
	type DeltaDetachedNodeId,
	type DeltaFieldMap,
	type DeltaDetachedNodeChanges,
	type DeltaDetachedNodeBuild,
	type DeltaDetachedNodeDestruction,
	type DeltaDetachedNodeRename,
	type DeltaFieldChanges,
	type ExclusiveMapTree,
	deepCopyMapTree,
	type TreeChunk,
	dummyRoot,
	cursorChunk,
	tryGetChunk,
	type ChunkedCursor,
} from "./tree/index.js";

export {
	TreeNavigationResult,
	type IEditableForest,
	type IForestSubscription,
	type TreeLocation,
	type FieldLocation,
	type ForestLocation,
	type ITreeSubscriptionCursor,
	ITreeSubscriptionCursorState,
	type FieldAnchor,
	moveToDetachedField,
	type ForestEvents,
} from "./forest/index.js";

export {
	type FieldKey,
	type TreeNodeSchemaIdentifier,
	type TreeFieldStoredSchema,
	ValueSchema,
	TreeNodeStoredSchema,
	type TreeStoredSchemaSubscription,
	type MutableTreeStoredSchema,
	type FieldKindIdentifier,
	type FieldKindData,
	type TreeTypeSet,
	type TreeStoredSchema,
	TreeStoredSchemaRepository,
	schemaDataIsEmpty,
	type SchemaEvents,
	forbiddenFieldKindIdentifier,
	identifierFieldKindIdentifier,
	storedEmptyFieldSchema,
	type StoredSchemaCollection,
	schemaFormatV1,
	schemaFormatV2,
	LeafNodeStoredSchema,
	ObjectNodeStoredSchema,
	MapNodeStoredSchema,
	decodeFieldSchema,
	encodeFieldSchemaV1,
	encodeFieldSchemaV2,
	storedSchemaDecodeDispatcher,
	type SchemaAndPolicy,
	Multiplicity,
	type SchemaPolicy,
	SchemaVersion,
} from "./schema-stored/index.js";

export {
	type ChangeFamily,
	type ChangeFamilyCodec,
	type ChangeEncodingContext,
	type ChangeFamilyEditor,
	EditBuilder,
} from "./change-family/index.js";

export {
	areEqualChangeAtomIds,
	areEqualChangeAtomIdOpts,
	makeChangeAtomId,
	asChangeAtomId,
	type ChangeRebaser,
	findAncestor,
	findCommonAncestor,
	type GraphCommit,
	CommitKind,
	type CommitMetadata,
	type RevisionTag,
	RevisionTagSchema,
	RevisionTagCodec,
	type ChangesetLocalId,
	type ChangeAtomId,
	type ChangeAtomIdMap,
	type TaggedChange,
	makeAnonChange,
	tagChange,
	mapTaggedChange,
	tagRollbackInverse,
	SessionIdSchema,
	mintCommit,
	rebaseBranch,
	type BranchRebaseResult,
	rebaseChange,
	rebaseChangeOverChanges,
	type RevisionMetadataSource,
	revisionMetadataSourceFromInfo,
	type RevisionInfo,
	type EncodedRevisionTag,
	type EncodedStableId,
	type EncodedChangeAtomId,
	taggedAtomId,
	taggedOptAtomId,
	offsetChangeAtomId,
	StableIdSchema,
	subtractChangeAtomIds,
	replaceAtomRevisions,
	replaceChange,
	type RebaseStats,
	type RebaseStatsWithDuration,
	isAncestor,
	type ChangeAtomIdRangeMap,
	newChangeAtomIdRangeMap,
	compareRevisions,
} from "./rebase/index.js";

export {
	type Adapters,
	AdaptedViewSchema,
	type TreeAdapter,
} from "./schema-view/index.js";

export {
	type Revertible,
	RevertibleStatus,
	type RevertibleFactory,
	type RevertibleAlphaFactory,
	type RevertibleAlpha,
} from "./revertible.js";
