import { seed } from "./seed";
import { startStack } from "./stack";

/**
 * Brings the stack up once for the whole run. Demo flows read its details from
 * the env vars set here, which Playwright passes on to its workers.
 */
export default async function globalSetup() {
  const stack = await startStack();
  try {
    await seed(stack);
  } catch (e) {
    await stack.stop();
    throw e;
  }
  process.env.DEMO_APP_URL = stack.appUrl;
  process.env.DEMO_SIDECAR_PORT = String(stack.sidecarPort);
  process.env.DEMO_SIDECAR_TOKEN = stack.sidecarToken;
  return stack.stop;
}
