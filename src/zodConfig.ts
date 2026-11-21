import { config } from "zod";

// The CSP has no 'unsafe-eval'. Zod would probe for it with `new Function`
// on its first parse, which the browser refuses and reports as a violation.
// `main.tsx` imports this first, since some modules parse while they load.
config({ jitless: true });
