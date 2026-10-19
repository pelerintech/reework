import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

/**
 * Build a fresh mock (faux) Models catalog for a test. Each call returns an
 * isolated provider so `setResponses` can be driven per-engine.
 */
export function ENGINE_TEST_MODELS() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    setResponses: (responses: unknown[]) => {
      (faux as unknown as { setResponses: (r: unknown[]) => void }).setResponses(responses);
    },
  };
}
