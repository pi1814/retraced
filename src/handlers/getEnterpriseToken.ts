import "source-map-support/register";
import * as express from "express";
import getApiToken from "../models/api_token/get";
import modelsGetEnterpriseToken from "../models/eitapi_token/get";
import { apiTokenFromAuthHeader } from "../security/helpers";
import getPgPool from "../persistence/pg";
import { defaultEventCreater, CreateEventRequest } from "./createEvent";

const pgPool = getPgPool();

export async function getEnterpriseToken(
    authorization: string,
    projectId: string,
    groupId: string,
    eitapiTokenId: string,
    req: express.Request,
) {
    const apiTokenId = apiTokenFromAuthHeader(authorization);
    const apiToken: any = await getApiToken(apiTokenId, pgPool.query.bind(pgPool));
    const validAccess = apiToken && apiToken.project_id === projectId;

    if (!validAccess) {
        throw { status: 401, err: new Error("Unauthorized") };
    }

    const token = await modelsGetEnterpriseToken({
        eitapiTokenId,
    });

    if (!token) {
        throw { status: 404, err: new Error("Not Found") };
    }
    if (token.project_id !== apiToken.project_id) {
        throw { status: 401, err: new Error("Unauthorized") };
    }

    const thisEvent: CreateEventRequest = {
        action: "eitapi_token.get",
        crud: "r",
        actor: {
            id: "Publisher API",
            name: apiToken.name,
        },
        group: {
            id: groupId,
        },
        target: {
            id: eitapiTokenId,
        },
        description: `${req.method} ${req.originalUrl}`,
        source_ip: req.ip,
    };
    await defaultEventCreater.saveRawEvent(
        projectId,
        apiToken.environment_id,
        thisEvent,
    );

    return {
        status: 200,
        body: {
            token: token.id,
            display_name: token.display_name,
            view_log_action: token.view_log_action,
        },
    };
}
