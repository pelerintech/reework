# Changelog

## [1.0.0](https://github.com/pelerintech/reework/compare/tui-v0.1.0...tui-v1.0.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **core:** tools now get execute(args, ctx: ToolContext) and return a string or { output, isError, details } instead of pi-durable's execute(args, api, context) with output arrays. Plugin tasks and the raw StorageSeam are no longer part of the public contract, and Engine, CONTEXT, StorageSeam and toExtension moved to @reework/core/internal.

### Features

* **core:** make the framework runnable, publishable and ready for real agents ([bcefafc](https://github.com/pelerintech/reework/commit/bcefafc78d34d9036fadb34f2d8a43ded6e635d4))
* **core:** own the plugin contract and add cases, files, hooks and named models ([496cb7b](https://github.com/pelerintech/reework/commit/496cb7b5a590f149e1aef058c36e44732993a948))
* **core:** ship runnable framework core ([7e8223f](https://github.com/pelerintech/reework/commit/7e8223ffc899af6278f1b4ad44857fb6c76f0b90))
* harden the framework and rebuild the TUI on a conversation view ([a6c5035](https://github.com/pelerintech/reework/commit/a6c5035ee2f3a848becd3381e64c999e286031fd))
* **tui:** send input and decisions as a human ([02fabd7](https://github.com/pelerintech/reework/commit/02fabd7ae324b273d803508e0fa218942d7b78e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @reework/client bumped to 1.0.0
    * @reework/types bumped to 1.0.0
