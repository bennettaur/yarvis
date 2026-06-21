/**
 * Provider dispatch for operations addressed by a {@link PrRef}. Each function
 * routes to the GitHub or Azure transport based on `ref.provider`, so the PR
 * components stay provider-agnostic.
 */

import {
  azAddStar,
  azPostComment,
  azPrDetail,
  azPrFileDiff,
  azPrFiles,
  azPrStatus,
  azRemoveStar,
} from "./azure";
import {
  ghAddStar,
  ghPostComment,
  ghPrDetail,
  ghPrFiles,
  ghPrStatus,
  ghRemoveStar,
} from "./github";
import type { NewComment, PrDetail, PrFile, PrRef, PrStatus } from "./types";

export const fetchPrStatus = (ref: PrRef): Promise<PrStatus> =>
  ref.provider === "github" ? ghPrStatus(ref) : azPrStatus(ref);

export const fetchPrDetail = (ref: PrRef): Promise<PrDetail> =>
  ref.provider === "github" ? ghPrDetail(ref) : azPrDetail(ref);

export const fetchPrFiles = (ref: PrRef): Promise<PrFile[]> =>
  ref.provider === "github" ? ghPrFiles(ref) : azPrFiles(ref);

/**
 * One file's diff. GitHub returns patches in the file list, so the file is
 * already complete and no request is made. Azure builds the patch on demand.
 */
export const fetchPrFileDiff = (ref: PrRef, file: PrFile): Promise<PrFile> =>
  ref.provider === "github" ? Promise.resolve(file) : azPrFileDiff(ref, file.filename);

export const postPrComment = (ref: PrRef, comment: NewComment): Promise<{ ok: boolean }> =>
  ref.provider === "github" ? ghPostComment(ref, comment) : azPostComment(ref, comment);

export const addStar = (ref: PrRef, title?: string | null, url?: string | null) =>
  ref.provider === "github" ? ghAddStar(ref, title, url) : azAddStar(ref, title, url);

export const removeStar = (ref: PrRef) =>
  ref.provider === "github" ? ghRemoveStar(ref) : azRemoveStar(ref);
