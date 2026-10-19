import type { Engine } from "../engine.ts";

/** The thin common Component base shared by every core module. */
export interface Component {
  readonly id: string;
  /** Called once when the component is installed onto an engine. */
  init?(engine: Engine): Promise<void>;
  /** Called when the engine is torn down. */
  dispose?(): Promise<void>;
}

/**
 * A domain-specific contract extends the common base, sharing the lifecycle
 * (id / init / dispose) while adding its own surface. E.g. `ChannelComponent`
 * and `HITLGateComponent`.
 */
export type DomainComponent<TDomain> = Component & { readonly domain: TDomain };

export interface ComponentRegistry {
  register(component: Component): void;
  get<T extends Component>(id: string): T | undefined;
  list(): readonly Component[];
  has(id: string): boolean;
}

export function createComponentRegistry(): ComponentRegistry {
  const byId = new Map<string, Component>();
  return {
    register(component) {
      if (byId.has(component.id)) {
        throw new Error(`component already registered: ${component.id}`);
      }
      byId.set(component.id, component);
    },
    get<T extends Component>(id: string): T | undefined {
      return byId.get(id) as T | undefined;
    },
    list() {
      return [...byId.values()];
    },
    has(id: string) {
      return byId.has(id);
    },
  };
}

/**
 * Install a list of components into a registry, running each component's
 * `init` against the engine. Returns the registry.
 */
export async function installComponents(
  registry: ComponentRegistry,
  engine: Engine,
  components: readonly Component[],
): Promise<ComponentRegistry> {
  for (const component of components) {
    registry.register(component);
    await component.init?.(engine);
  }
  return registry;
}
