/**
 * The GitHub the demo sees: one repo, a handful of pull requests and issues.
 * Every name is made up. Pull request #477 is the one the flows open, so it
 * carries the full review detail: description, checks, reviewers, a thread
 * and a diff.
 */

export const VIEWER = "alex-rivera";
export const OWNER = "acme";
export const REPO = "checkout-web";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

export interface FakeFile {
  filename: string;
  status: "added" | "modified" | "removed";
  additions: number;
  deletions: number;
  patch: string;
}

export interface FakePull {
  number: number;
  title: string;
  author: string;
  body: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  /** Logins asked to review who haven't yet. */
  requestedReviewers: string[];
  /** Each reviewer's latest review, by login. */
  reviews: Record<string, "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED">;
  /** A null conclusion means the check is still running. */
  checks: { name: string; conclusion: "SUCCESS" | "FAILURE" | null }[];
  reviewThreads: { path: string; line: number; author: string; body: string }[];
  /** The diff. A PR without files shows none, and its +/- counts are zero. */
  files: FakeFile[];
}

/**
 * Where a PR shows up is decided by its fields:
 * - `author: VIEWER`: My PRs.
 * - `requestedReviewers` includes `VIEWER`: Needs review.
 * - any other author: Reviewing, which lists PRs the viewer has commented on
 *   or reviewed.
 */
export const PULLS: FakePull[] = [
  {
    number: 477,
    title: "Payment step: show saved cards first",
    author: "priya-shah",
    body: [
      "Saved cards now load before the new-card form, so returning customers can pay in one tap.",
      "",
      "## What changed",
      "- `PaymentStep` renders saved cards first and lazy-loads the card form",
      "- `usePaymentIntent` reuses the intent across a retry",
      "",
      "## Testing",
      "- New tests in `payment-step.test.ts`",
      "- Load time on a mid-range phone: 1.4s → 0.8s",
    ].join("\n"),
    draft: false,
    headRef: "priya/saved-cards-first",
    baseRef: "main",
    createdAt: hoursAgo(26),
    updatedAt: hoursAgo(2),
    requestedReviewers: [VIEWER],
    reviews: { "sam-okafor": "APPROVED" },
    checks: [
      { name: "build", conclusion: "SUCCESS" },
      { name: "unit tests", conclusion: "SUCCESS" },
      { name: "lighthouse", conclusion: "SUCCESS" },
    ],
    reviewThreads: [
      {
        path: "src/checkout/PaymentStep.tsx",
        line: 42,
        author: "sam-okafor",
        body: "Nice. Should the empty state still show the card form straight away?",
      },
    ],
    files: [
      {
        filename: "src/checkout/PaymentStep.tsx",
        status: "modified",
        additions: 14,
        deletions: 6,
        patch: [
          "@@ -1,12 +1,14 @@",
          ' import { useSavedCards } from "./useSavedCards";',
          '-import { CardForm } from "./CardForm";',
          '+import { lazy, Suspense } from "react";',
          "+",
          '+const CardForm = lazy(() => import("./CardForm"));',
          " ",
          " export function PaymentStep({ cart }: { cart: Cart }) {",
          "   const cards = useSavedCards();",
          "-  return (",
          "-    <section>",
          "-      <CardForm cart={cart} />",
          "-      <SavedCards cards={cards} />",
          "-    </section>",
          "-  );",
          "+  return (",
          "+    <section>",
          "+      <SavedCards cards={cards} />",
          "+      <Suspense fallback={<CardFormSkeleton />}>",
          "+        <CardForm cart={cart} />",
          "+      </Suspense>",
          "+    </section>",
          "+  );",
          " }",
        ].join("\n"),
      },
      {
        filename: "src/checkout/usePaymentIntent.ts",
        status: "modified",
        additions: 6,
        deletions: 1,
        patch: [
          "@@ -8,7 +8,12 @@ export function usePaymentIntent(cart: Cart) {",
          "   return useQuery({",
          '     queryKey: ["intent", cart.id],',
          "-    queryFn: () => createPaymentIntent(cart),",
          "+    queryFn: () => cachedPaymentIntent(cart, { retries: 1 }),",
          "+    // A declined card retries against the same intent, so the",
          "+    // customer isn't charged twice if the first attempt went through.",
          "+    staleTime: Number.POSITIVE_INFINITY,",
          "+    retry: 1,",
          "+    retryDelay: 300,",
          "   });",
          " }",
        ].join("\n"),
      },
      {
        filename: "tests/checkout/payment-step.test.ts",
        status: "added",
        additions: 18,
        deletions: 0,
        patch: [
          "@@ -0,0 +1,18 @@",
          '+import { render, screen } from "@testing-library/react";',
          '+import { PaymentStep } from "../../src/checkout/PaymentStep";',
          "+",
          '+describe("PaymentStep", () => {',
          '+  it("renders saved cards first", async () => {',
          "+    render(<PaymentStep cart={cartWithSavedCards} />);",
          '+    const [first] = await screen.findAllByRole("radio");',
          '+    expect(first).toHaveAccessibleName("Visa ending 4242");',
          "+  });",
          "+",
          '+  it("retries a declined card once", async () => {',
          "+    declineNextCharge();",
          "+    render(<PaymentStep cart={cartWithSavedCards} />);",
          '+    await pay("Visa ending 4242");',
          "+    expect(chargeAttempts()).toBe(2);",
          "+  });",
          "+});",
        ].join("\n"),
      },
    ],
  },
  {
    number: 471,
    title: "Cart totals: round to the cent before tax",
    author: "sam-okafor",
    body: "Totals were rounded after tax, which left some carts a cent off the receipt.",
    draft: false,
    headRef: "sam/round-before-tax",
    baseRef: "main",
    createdAt: hoursAgo(50),
    updatedAt: hoursAgo(20),
    requestedReviewers: [VIEWER],
    reviews: {},
    checks: [
      { name: "build", conclusion: "SUCCESS" },
      { name: "unit tests", conclusion: "FAILURE" },
    ],
    reviewThreads: [],
    files: [],
  },
  {
    number: 482,
    title: "Load the payment step lazily behind the checkout flag",
    author: VIEWER,
    body: "Puts the new payment step behind `checkout-v2` and loads it lazily.",
    draft: false,
    headRef: "feat/payment-step",
    baseRef: "main",
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(1),
    requestedReviewers: [],
    reviews: { "priya-shah": "APPROVED" },
    checks: [
      { name: "build", conclusion: "SUCCESS" },
      { name: "unit tests", conclusion: "SUCCESS" },
    ],
    reviewThreads: [],
    files: [],
  },
  {
    number: 479,
    title: "Measure checkout load time in the perf dashboard",
    author: VIEWER,
    body: "Adds a `checkout.load` timing so the dashboard can chart it.",
    draft: true,
    headRef: "alex/checkout-timing",
    baseRef: "main",
    createdAt: hoursAgo(30),
    updatedAt: hoursAgo(28),
    requestedReviewers: [],
    reviews: {},
    checks: [{ name: "build", conclusion: null }],
    reviewThreads: [],
    files: [],
  },
];

/** Everyone who appears in the data; the Issues tab offers them as assignees. */
export const PEOPLE = [VIEWER, "priya-shah", "sam-okafor", "jordan-lee"];

export interface FakeIssue {
  number: number;
  title: string;
  author: string;
  assignees: string[];
  labels: { name: string; color: string }[];
  body: string;
  createdAt: string;
  comments: { author: string; body: string; createdAt: string }[];
}

const BUG = { name: "bug", color: "d73a4a" };
const CHECKOUT = { name: "checkout", color: "5319e7" };
const PERF = { name: "performance", color: "fbca04" };

export const ISSUES: FakeIssue[] = [
  {
    number: 488,
    title: "Apple Pay sheet opens twice on iOS 18",
    author: "sam-okafor",
    assignees: [VIEWER],
    labels: [BUG, CHECKOUT],
    body: "Tapping Apple Pay on the new payment step opens the sheet, closes it, and opens it again.",
    createdAt: hoursAgo(8),
    comments: [
      {
        author: "priya-shah",
        body: "Reproduced on an iPhone 15. Looks like a double mount under Suspense.",
        createdAt: hoursAgo(6),
      },
    ],
  },
  {
    number: 485,
    title: "Checkout loads in 1.4s on mid-range Android",
    author: "priya-shah",
    assignees: [VIEWER],
    labels: [PERF, CHECKOUT],
    body: "The target is under a second. Most of the time goes to the card form bundle.",
    createdAt: hoursAgo(40),
    comments: [],
  },
  {
    number: 476,
    title: "Saved cards list doesn't announce the selected card",
    author: "jordan-lee",
    assignees: [],
    labels: [CHECKOUT],
    body: "VoiceOver reads the card number but not that it's selected.",
    createdAt: hoursAgo(70),
    comments: [],
  },
];
