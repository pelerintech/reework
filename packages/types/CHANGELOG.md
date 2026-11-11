# Changelog

## [1.2.0](https://github.com/pelerintech/reework/compare/types-v1.1.0...types-v1.2.0) (2026-11-11)


### Features

* **core:** add conversation kinds, owners and case access ([ad491fa](https://github.com/pelerintech/reework/commit/ad491fa6cb0e8af58e2bb448a773675fe7d99d82))
* **core:** budget seams (v12) ([5f75fd3](https://github.com/pelerintech/reework/commit/5f75fd3f8db80847dccb2d24862b23c8ece0e5d0))
* **core:** conversation kinds, owners and case access (v13) ([5c2865a](https://github.com/pelerintech/reework/commit/5c2865ae4f10ce7fec037f971dde76781022a4cd))
* **core:** external tools (v11) ([facbcf6](https://github.com/pelerintech/reework/commit/facbcf6186f72abf5248215529ae737b744839ea))
* **core:** gate audience (v15) ([e12ee35](https://github.com/pelerintech/reework/commit/e12ee35602c7ec428da9ea9a94bce9f978e8edc1))
* **core:** let a plugin stop a run before the next model request ([8e76328](https://github.com/pelerintech/reework/commit/8e763289bf8b9417b1cf59364b5e167fd9288623))
* **core:** plugin events (v16) ([cd007ba](https://github.com/pelerintech/reework/commit/cd007ba4612d86e7b3cb6dbbd52365681f100d82))
* **core:** secrets and headless agents (v14) ([c65bf35](https://github.com/pelerintech/reework/commit/c65bf35a9c5dbd953339a8104ac317c21b931aa9))
* **core:** serve settled proposals over HTTP and the client ([5792633](https://github.com/pelerintech/reework/commit/579263385ca26a2d3467a1b6503df0222f99bec6))
* **types:** carry a gate audience on proposals ([589dbcb](https://github.com/pelerintech/reework/commit/589dbcb861c6e98f3856c642e6586e1b956c290b))
* **types:** carry external on tool-result hook messages ([ea8e9a9](https://github.com/pelerintech/reework/commit/ea8e9a9c6fc755e1004a92623679759ca865ba0f))
* **types:** show external on transcript tool items ([124629d](https://github.com/pelerintech/reework/commit/124629db87b0141a8074cad6854bc11996e20570))

## [1.1.0](https://github.com/pelerintech/reework/compare/types-v1.0.0...types-v1.1.0) (2026-11-04)


### Features

* **core:** attach input authors to hook messages ([8372213](https://github.com/pelerintech/reework/commit/837221365483d15b8408dcfb389b9acf4c964613))
* **types:** carry an input author on hook model messages ([1e3c099](https://github.com/pelerintech/reework/commit/1e3c099d541fae5703a80f069c15c35d2e5e5455))

## [1.0.0](https://github.com/pelerintech/reework/compare/types-v0.1.0...types-v1.0.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **core:** tools now get execute(args, ctx: ToolContext) and return a string or { output, isError, details } instead of pi-durable's execute(args, api, context) with output arrays. Plugin tasks and the raw StorageSeam are no longer part of the public contract, and Engine, CONTEXT, StorageSeam and toExtension moved to @reework/core/internal.

### Features

* **core:** carry an input author through host, client and snapshots ([9de0777](https://github.com/pelerintech/reework/commit/9de07773db7fe837cb06b63bd1b4f260add5de92))
* **core:** make the framework runnable, publishable and ready for real agents ([bcefafc](https://github.com/pelerintech/reework/commit/bcefafc78d34d9036fadb34f2d8a43ded6e635d4))
* **core:** mount plugin routes under /plugins behind the token ([4c267e9](https://github.com/pelerintech/reework/commit/4c267e9b2b6daf99cc3e9c68bac4923fda107270))
* **core:** own the plugin contract and add cases, files, hooks and named models ([496cb7b](https://github.com/pelerintech/reework/commit/496cb7b5a590f149e1aef058c36e44732993a948))
* **core:** record who decided a gate and name them in the resumed message ([c29b83c](https://github.com/pelerintech/reework/commit/c29b83cedff2c490802fdd72dfbf8686e390b5ca))
* **core:** ship runnable framework core ([7e8223f](https://github.com/pelerintech/reework/commit/7e8223ffc899af6278f1b4ad44857fb6c76f0b90))
* **core:** type model usage as tokens on afterModelResponse ([65dd289](https://github.com/pelerintech/reework/commit/65dd289cee386c697accc2816ec13f279b82abc3))
* harden the framework and rebuild the TUI on a conversation view ([a6c5035](https://github.com/pelerintech/reework/commit/a6c5035ee2f3a848becd3381e64c999e286031fd))
* scaffold rework core engine on pi-durable (v01) ([2cae252](https://github.com/pelerintech/reework/commit/2cae25214b5be2954f34affead61cb2ab53de8e0))
