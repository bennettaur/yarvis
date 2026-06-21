/**
 * Partial shapes of the Azure DevOps REST responses this client consumes. These
 * intentionally cover only the fields we read — Azure's real payloads are much
 * larger — so the mapping code is type-checked without pulling in the full SDK.
 * Fields are optional because the API omits them depending on state (e.g. a PR
 * has no `lastMergeSourceCommit` until merge has been evaluated).
 */

/** Generic `{ value: [...] }` envelope used by Azure list endpoints. */
export interface AzureList<T> {
  value?: T[];
}

/** An Azure DevOps identity as returned inside `connectionData`. `id` is the
 *  identity GUID that PR creator/reviewer search filters expect. */
export interface AzureIdentity {
  id: string;
  providerDisplayName?: string;
}

/**
 * `{org}/_apis/connectionData` — the org-scoped way to resolve the current user.
 * Unlike the cross-org vssps profile endpoint, this authenticates with an
 * org-scoped PAT (the only kind Azure DevOps supports after global PATs are
 * retired) and needs no User Profile scope.
 */
export interface AzureConnectionData {
  authenticatedUser?: AzureIdentity;
}

export interface AzureUser {
  displayName?: string;
}

export interface AzureProject {
  id?: string;
  name?: string;
}

export interface AzureRepository {
  name?: string;
  webUrl?: string;
  project?: AzureProject;
}

export interface AzureCommitRef {
  commitId?: string;
}

/** A pull request as returned by the list and get-by-id endpoints. */
export interface AzurePullRequest {
  pullRequestId: number;
  title?: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  creationDate?: string;
  createdBy?: AzureUser;
  repository?: AzureRepository;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: string;
  lastMergeSourceCommit?: AzureCommitRef;
  lastMergeTargetCommit?: AzureCommitRef;
}

/** A policy evaluation (our "checks"). */
export interface AzurePolicyEvaluation {
  status?: string;
  configuration?: {
    type?: { displayName?: string; id?: string };
  };
}

export interface AzureFilePosition {
  line?: number;
  offset?: number;
}

export interface AzureThreadContext {
  filePath?: string;
  rightFileStart?: AzureFilePosition;
  leftFileStart?: AzureFilePosition;
}

export interface AzureComment {
  commentType?: string;
  author?: AzureUser;
  content?: string;
  publishedDate?: string;
}

export interface AzureThread {
  status?: string;
  threadContext?: AzureThreadContext | null;
  comments?: AzureComment[];
}

export interface AzureIteration {
  id: number;
}

export interface AzureChangeEntry {
  changeType?: string;
  item?: { path?: string; isFolder?: boolean };
}

/** Iteration changes endpoint payload. */
export interface AzureChanges {
  changeEntries?: AzureChangeEntry[];
}

/** A git item fetched with `includeContent=true`. */
export interface AzureItemContent {
  content?: string;
}
