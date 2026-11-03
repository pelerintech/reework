# Changelog

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
