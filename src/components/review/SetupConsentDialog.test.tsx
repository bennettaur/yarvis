import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { SidecarError } from "../../lib/api";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import type { ReviewSetupInfo, ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../test/render";
import { resetReviewApi, stubReviewApi } from "../../test/reviewWorkspacesApi";
import SetupConsentDialog, {
  consentAnswer,
  MOVED_NOTICE,
  SetupConsentView,
} from "./SetupConsentDialog";

const info = (over: Partial<ReviewSetupInfo> = {}): ReviewSetupInfo => ({
  script: "bun install\nbun run db:migrate",
  author: "octo",
  branch: "feature/tabs",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  withheldEnv: ["SSH_AUTH_SOCK"],
  consent: null,
  status: null,
  log: null,
  ...over,
});

const pr = { ref: { provider: "github" as const, owner: "acme", repo: "widgets", number: 7 } };

const view = (props: Partial<Parameters<typeof SetupConsentView>[0]> = {}) =>
  createElement(SetupConsentView, {
    pr,
    info: info(),
    error: null,
    busy: false,
    onClose: () => {},
    onAnswer: () => {},
    ...props,
  });

describe("SetupConsentView", () => {
  let unmount = () => {};
  afterEach(() => unmount());

  it("shows whose code, which commit, the exact script and what is withheld", async () => {
    const html = await renderToHtml(view());
    expect(html).toContain("acme/widgets#7");
    expect(html).toContain("octo");
    expect(html).toContain("feature/tabs");
    expect(html).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(html).toContain("bun install\nbun run db:migrate");
    expect(html).toContain("SSH_AUTH_SOCK");
    expect(textOf(html)).toContain("Setup is not sandboxed");
    expect(textOf(html)).toContain("One narrow exception");
    expect(html).toContain(">Run setup</button>");
    expect(html).toContain("Don't run");
  });

  it("offers nothing to run when the repo has no script", async () => {
    const html = await renderToHtml(view({ info: info({ script: null }) }));
    expect(html).toContain("no setup script");
    expect(html).not.toContain(">Run setup</button>");
  });

  it("won't run a script whose commit isn't known", async () => {
    const mounted = await mountForInteraction(view({ info: info({ headSha: null }) }));
    unmount = mounted.unmount;
    const run = [...mounted.host.querySelectorAll("button")].find(
      (b) => b.textContent === "Run setup",
    );
    expect(run?.disabled).toBe(true);
  });

  it("names a fork's branch with its owner and shows the sidecar's sandbox notes", async () => {
    const text = textOf(
      await renderToHtml(
        view({
          fromFork: true,
          info: info({ sandboxNotes: "The setup script runs without a sandbox.\n\nSecond note." }),
        }),
      ),
    );
    expect(text).toContain("octo:feature/tabs");
    expect(text).toContain("from a fork");
    expect(text).toContain("The setup script runs without a sandbox.");
    expect(text).toContain("Second note.");
  });

  it("takes focus when it opens", async () => {
    const mounted = await mountForInteraction(view());
    unmount = mounted.unmount;
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
  });

  it("waits for the script before offering to run it", async () => {
    const html = await renderToHtml(view({ info: null }));
    expect(html).toContain("Loading the setup script");
    expect(html).not.toContain(">Run setup</button>");
  });

  it("answers with the button pressed", async () => {
    const answers: boolean[] = [];
    const mounted = await mountForInteraction(view({ onAnswer: (g) => answers.push(g) }));
    unmount = mounted.unmount;
    const button = (label: string) =>
      [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    button("Run setup").click();
    button("Don't run").click();
    expect(answers).toEqual([true, false]);
  });
});

describe("consentAnswer", () => {
  it("sends back exactly the script and commit the prompt showed", () => {
    expect(consentAnswer(info(), true)).toEqual({
      grant: true,
      script: "bun install\nbun run db:migrate",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(consentAnswer(info({ headSha: null }), false)).toEqual({
      grant: false,
      script: "bun install\nbun run db:migrate",
      headSha: null,
    });
  });
});

describe("SetupConsentDialog", () => {
  const pr = {
    id: "pr1",
    ref: { provider: "github", owner: "acme", repo: "widgets", number: 7 },
  } as ReviewWorkspacePr;
  let setupReads = 0;
  let answers: unknown[] = [];
  const stub = () =>
    stubReviewApi({
      reviewSetupInfo: async () => {
        setupReads++;
        return info(setupReads === 1 ? {} : { script: "make bootstrap" });
      },
      answerReviewSetup: async (_ws, _pr, answer) => {
        answers.push(answer);
        throw new SidecarError("answer setup failed (409): the setup script changed", 409);
      },
    });

  let unmount = () => {};
  afterEach(() => {
    unmount();
    resetReviewApi();
    setupReads = 0;
    answers = [];
  });

  it("says so and shows what would run now when the script or head moved", async () => {
    stub();
    primeCache(prDetailKey(pr.ref), { fromFork: false } as PrDetail);
    const mounted = await mountForInteraction(
      createElement(SetupConsentDialog, {
        workspaceId: "ws",
        pr,
        onClose: () => {},
        onAnswered: () => {
          throw new Error("a refused answer must not count as answered");
        },
      }),
    );
    unmount = mounted.unmount;
    const button = (label: string) =>
      [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === label);
    await waitFor(() => button("Run setup") !== undefined, "the script to load");
    button("Run setup")?.click();
    await waitFor(
      () => (mounted.host.textContent ?? "").includes("make bootstrap"),
      "the script to reload",
    );
    expect(answers).toEqual([
      {
        grant: true,
        script: "bun install\nbun run db:migrate",
        headSha: "0123456789abcdef0123456789abcdef01234567",
      },
    ]);
    expect(mounted.host.textContent).toContain(MOVED_NOTICE);
    expect(button("Run setup")?.disabled).toBe(false);
  });
});
