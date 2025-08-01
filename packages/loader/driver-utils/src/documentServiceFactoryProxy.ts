/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { ILayerCompatDetails } from "@fluid-internal/client-utils";
import { ITelemetryBaseLogger, type FluidObject } from "@fluidframework/core-interfaces";
import { ISummaryTree } from "@fluidframework/driver-definitions";
import {
	IDocumentService,
	IDocumentServiceFactory,
	IResolvedUrl,
} from "@fluidframework/driver-definitions/internal";

/**
 * This abstract class implements IDocumentServiceFactory interface. It uses delegation pattern.
 * It delegates all calls to IDocumentServiceFactory implementation passed to constructor.
 */

export abstract class DocumentServiceFactoryProxy implements IDocumentServiceFactory {
	constructor(private readonly _serviceFactory: IDocumentServiceFactory) {}

	public get serviceFactory(): IDocumentServiceFactory {
		return this._serviceFactory;
	}

	/**
	 * The compatibility details of the base Driver layer that is exposed to the Loader layer
	 * for validating Loader-Driver compatibility.
	 */
	public get ILayerCompatDetails(): ILayerCompatDetails | undefined {
		return (this._serviceFactory as FluidObject<ILayerCompatDetails>).ILayerCompatDetails;
	}

	public async createContainer(
		createNewSummary: ISummaryTree | undefined,
		createNewResolvedUrl: IResolvedUrl,
		logger?: ITelemetryBaseLogger,
		clientIsSummarizer?: boolean,
	): Promise<IDocumentService> {
		return this.serviceFactory.createContainer(
			createNewSummary,
			createNewResolvedUrl,
			logger,
			clientIsSummarizer,
		);
	}

	public async createDocumentService(
		resolvedUrl: IResolvedUrl,
		logger?: ITelemetryBaseLogger,
		clientIsSummarizer?: boolean,
	): Promise<IDocumentService> {
		return this.serviceFactory.createDocumentService(resolvedUrl, logger, clientIsSummarizer);
	}
}
