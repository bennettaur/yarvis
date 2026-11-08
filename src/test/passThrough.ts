/**
 * A stand-in for a module that answers each call with a test's override when
 * one is set and with the real implementation otherwise, for registering once
 * with `mock.module`.
 *
 * `mock.module` replaces a module for the whole run, so a suite that registers
 * its own stub leaves it in place for every file after it, and two suites that
 * each register one leave whichever loaded last. Which file that is depends on
 * the order `bun test` lists them, which differs between macOS and CI's Linux
 * runners. Registering one pass-through per module, from a helper in this
 * folder, and clearing its overrides in each suite's `afterAll` keeps every
 * file seeing the real module unless it asked otherwise.
 *
 * Pass a copy of the module (`{ ...(await import(path)) }`) taken before
 * registering: the namespace itself is live, so once the mock is in place it
 * would name the wrappers, and a wrapper passing through would call itself.
 *
 * An override changes what code outside the module sees. A real function there
 * calling another one in the same module still calls the real one.
 */
export function passThrough<M extends object>(
  actual: M,
): { module: M; stub: (next: Partial<M>) => void; reset: () => void } {
  let overrides: Partial<M> = {};
  const module = { ...actual };
  for (const name of Object.keys(actual) as (keyof M)[]) {
    const real = actual[name];
    // A class stays the real one, or `new` and `instanceof` stop working.
    if (typeof real !== "function" || /^class\b/.test(Function.prototype.toString.call(real))) {
      continue;
    }
    // biome-ignore lint/suspicious/noExplicitAny: forwards whatever the real function takes
    module[name] = ((...args: any[]) => ((overrides[name] ?? real) as any)(...args)) as M[keyof M];
  }
  return {
    module,
    stub(next) {
      overrides = { ...overrides, ...next };
    },
    reset() {
      overrides = {};
    },
  };
}
