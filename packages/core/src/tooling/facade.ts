import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Extension, Registry } from "@earendil-works/pi-durable";

/**
 * The Layer-2 plugin facade. This is the single point that touches pi-durable's
 * extension API. External Layer-2 plugins (separate repo) import only this
 * facade, so a pi-durable API change is contained here and the N plugins keep
 * working without modification.
 */

/** Re-export the extension-building surface so plugins need not import pi-durable. */
export { defineTool, section };

export type PluginDefinition = Parameters<typeof defineExtension>[0];

export function definePlugin(definition: PluginDefinition): Extension {
  return defineExtension(definition);
}

/** Install a plugin into a pi-durable registry. */
export function installPlugin(plugin: Extension, registry: Registry): void {
  registry.install(plugin);
}
