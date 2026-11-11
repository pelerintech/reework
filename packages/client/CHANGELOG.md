# Changelog

## [1.1.0](https://github.com/pelerintech/reework/compare/client-v1.0.1...client-v1.1.0) (2026-11-11)


### Features

* **core:** add conversation kinds, owners and case access ([ad491fa](https://github.com/pelerintech/reework/commit/ad491fa6cb0e8af58e2bb448a773675fe7d99d82))
* **core:** conversation kinds, owners and case access (v13) ([5c2865a](https://github.com/pelerintech/reework/commit/5c2865ae4f10ce7fec037f971dde76781022a4cd))
* **core:** gate audience (v15) ([e12ee35](https://github.com/pelerintech/reework/commit/e12ee35602c7ec428da9ea9a94bce9f978e8edc1))
* **core:** plugin events (v16) ([cd007ba](https://github.com/pelerintech/reework/commit/cd007ba4612d86e7b3cb6dbbd52365681f100d82))
* **core:** secrets and headless agents (v14) ([c65bf35](https://github.com/pelerintech/reework/commit/c65bf35a9c5dbd953339a8104ac317c21b931aa9))
* **core:** serve settled proposals over HTTP and the client ([5792633](https://github.com/pelerintech/reework/commit/579263385ca26a2d3467a1b6503df0222f99bec6))


### Bug Fixes

* **core:** reject unknown proposal listing statuses ([4c83b3c](https://github.com/pelerintech/reework/commit/4c83b3c9e42bafe13260c87607ca609195af9659))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @reework/types bumped to 1.2.0

## [1.0.1](https://github.com/pelerintech/reework/compare/client-v1.0.0...client-v1.0.1) (2026-11-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @reework/types bumped to 1.1.0

## [1.0.0](https://github.com/pelerintech/reework/compare/client-v0.1.0...client-v1.0.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **core:** tools now get execute(args, ctx: ToolContext) and return a string or { output, isError, details } instead of pi-durable's execute(args, api, context) with output arrays. Plugin tasks and the raw StorageSeam are no longer part of the public contract, and Engine, CONTEXT, StorageSeam and toExtension moved to @reework/core/internal.

### Features

* **client:** call plugin routes with client.plugin(name).request ([55ffd12](https://github.com/pelerintech/reework/commit/55ffd120ce7a5e3c68fc358d6e65978197ad3d96))
* **core:** carry an input author through host, client and snapshots ([9de0777](https://github.com/pelerintech/reework/commit/9de07773db7fe837cb06b63bd1b4f260add5de92))
* **core:** make the framework runnable, publishable and ready for real agents ([bcefafc](https://github.com/pelerintech/reework/commit/bcefafc78d34d9036fadb34f2d8a43ded6e635d4))
* **core:** own the plugin contract and add cases, files, hooks and named models ([496cb7b](https://github.com/pelerintech/reework/commit/496cb7b5a590f149e1aef058c36e44732993a948))
* harden the framework and rebuild the TUI on a conversation view ([a6c5035](https://github.com/pelerintech/reework/commit/a6c5035ee2f3a848becd3381e64c999e286031fd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @reework/types bumped to 1.0.0
