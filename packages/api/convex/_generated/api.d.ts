/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentSessions from "../agentSessions.js";
import type * as auth from "../auth.js";
import type * as cors from "../cors.js";
import type * as crons from "../crons.js";
import type * as documents from "../documents.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as ingestion from "../ingestion.js";
import type * as migrations from "../migrations.js";
import type * as projects from "../projects.js";
import type * as redirects from "../redirects.js";
import type * as stt from "../stt.js";
import type * as version from "../version.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentSessions: typeof agentSessions;
  auth: typeof auth;
  cors: typeof cors;
  crons: typeof crons;
  documents: typeof documents;
  files: typeof files;
  http: typeof http;
  ingestion: typeof ingestion;
  migrations: typeof migrations;
  projects: typeof projects;
  redirects: typeof redirects;
  stt: typeof stt;
  version: typeof version;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
