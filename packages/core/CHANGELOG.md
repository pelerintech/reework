# Changelog

## [1.0.0](https://github.com/pelerintech/reework/compare/core-v0.1.0...core-v1.0.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **core:** tools now get execute(args, ctx: ToolContext) and return a string or { output, isError, details } instead of pi-durable's execute(args, api, context) with output arrays. Plugin tasks and the raw StorageSeam are no longer part of the public contract, and Engine, CONTEXT, StorageSeam and toExtension moved to @reework/core/internal.

### Features

* **core:** add onProposalOpened to the plugin event hooks ([0b3ac44](https://github.com/pelerintech/reework/commit/0b3ac443e9b5a91d991d54c6047cfe0cc254a2a4))
* **core:** bound plugin stops and engine close with one stop deadline ([13a5d7b](https://github.com/pelerintech/reework/commit/13a5d7bfb7f480f6a90d71d06112cfda8fd9aba8))
* **core:** carry an input author through host, client and snapshots ([9de0777](https://github.com/pelerintech/reework/commit/9de07773db7fe837cb06b63bd1b4f260add5de92))
* **core:** contain plugin route errors and map protocol errors ([fee9bbc](https://github.com/pelerintech/reework/commit/fee9bbc735197f0247d86bc0ad36a74d224d5bbc))
* **core:** dispatch case closed and reopened events once per transition ([6687b04](https://github.com/pelerintech/reework/commit/6687b04f645422b683d2c7f9917a92fc47f416b0))
* **core:** dispatch onDecision events with the settled proposal ([a6ed1f8](https://github.com/pelerintech/reework/commit/a6ed1f879cd3b10542d668cdfd35c58da8c98904))
* **core:** dispatch onInput events through a per-agent queue ([73090b2](https://github.com/pelerintech/reework/commit/73090b235c24f3bc6b8714746d7a5bc0e09ff52a))
* **core:** drain queued event hooks before plugins stop ([0bb1b95](https://github.com/pelerintech/reework/commit/0bb1b95ca9c11e062be2523cba59b0b4b0397a6a))
* **core:** give plugin setup an abort signal that fires on stop ([ccde452](https://github.com/pelerintech/reework/commit/ccde45244015bf9f428fdef09732ea12c7eb5fc1))
* **core:** give plugins a persistent data directory beside storage ([c4c3487](https://github.com/pelerintech/reework/commit/c4c34876d5880235c06bd3e525d3849c2a9171d3))
* **core:** let plugin factories be async, built in declaration order ([6c9983c](https://github.com/pelerintech/reework/commit/6c9983cb3ca0c97e189fdd0aa00bc5bbf02bb81b))
* **core:** make the framework runnable, publishable and ready for real agents ([bcefafc](https://github.com/pelerintech/reework/commit/bcefafc78d34d9036fadb34f2d8a43ded6e635d4))
* **core:** mount plugin routes under /plugins behind the token ([4c267e9](https://github.com/pelerintech/reework/commit/4c267e9b2b6daf99cc3e9c68bac4923fda107270))
* **core:** own the plugin contract and add cases, files, hooks and named models ([496cb7b](https://github.com/pelerintech/reework/commit/496cb7b5a590f149e1aef058c36e44732993a948))
* **core:** record who decided a gate and name them in the resumed message ([c29b83c](https://github.com/pelerintech/reework/commit/c29b83cedff2c490802fdd72dfbf8686e390b5ca))
* **core:** refuse unsafe plugin route names and agent routes under /plugins ([dae90a5](https://github.com/pelerintech/reework/commit/dae90a55d80b7fe03140fb9febc66c4bb4a1f536))
* **core:** serve plugin /open/ routes unauthenticated with a startup warning ([a813ebe](https://github.com/pelerintech/reework/commit/a813ebe03e40e1bd3178af6b1b02f9916394db78))
* **core:** ship runnable framework core ([7e8223f](https://github.com/pelerintech/reework/commit/7e8223ffc899af6278f1b4ad44857fb6c76f0b90))
* **core:** stop built plugins on any startup failure ([44e9a0f](https://github.com/pelerintech/reework/commit/44e9a0fbd1d37ba220448112ffc688f1922e74a4))
* **core:** stop plugins in reverse order before the engine closes ([d154bf0](https://github.com/pelerintech/reework/commit/d154bf08a3c34a98cb43f9f25561fe8a73f48109))
* **core:** type model usage as tokens on afterModelResponse ([65dd289](https://github.com/pelerintech/reework/commit/65dd289cee386c697accc2816ec13f279b82abc3))
* **core:** validate input authors and keep only their known fields ([d34ae1b](https://github.com/pelerintech/reework/commit/d34ae1b5cfe8ffc1fc7f3e94fd8aaf340ce46854))
* harden the framework and rebuild the TUI on a conversation view ([a6c5035](https://github.com/pelerintech/reework/commit/a6c5035ee2f3a848becd3381e64c999e286031fd))
* scaffold rework core engine on pi-durable (v01) ([2cae252](https://github.com/pelerintech/reework/commit/2cae25214b5be2954f34affead61cb2ab53de8e0))


### Bug Fixes

* **core:** count attributed input as user input in the run budget ([5c3276b](https://github.com/pelerintech/reework/commit/5c3276b31f63944e2c0287b4d7a34a14f099227d))
* **core:** restrict open plugin routes and precreate data dirs ([f062169](https://github.com/pelerintech/reework/commit/f06216981ee3268eed240b40ce6ed6e4a08eb9af))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @reework/types bumped to 1.0.0
