# Changelog

## [1.4.0](https://github.com/pelerintech/reework/compare/core-v1.3.0...core-v1.4.0) (2026-11-12)


### Features

* **core:** close plugin sockets on stop ([27971c4](https://github.com/pelerintech/reework/commit/27971c4d3667da117187f4f8f1c570c9e79f18d9))
* **core:** count plugin sockets in shutdown ([8cdd27c](https://github.com/pelerintech/reework/commit/8cdd27c6fd5fd5a33dad4d0a20395bf05ba87c29))
* **core:** isolate plugin socket handler errors ([0c18100](https://github.com/pelerintech/reework/commit/0c181004fedeb0e8160cd364a9a415754dabf2ce))
* **core:** plugin route WebSocket upgrade ([295fe00](https://github.com/pelerintech/reework/commit/295fe000c8158719b4726d422a368805bd0ad440))
* **core:** plugin WebSocket limits ([5a04470](https://github.com/pelerintech/reework/commit/5a044706bdd22a5b17415b480ed0f9d547d84c41))
* **core:** plugin WebSocket routes (v18) ([7e620da](https://github.com/pelerintech/reework/commit/7e620daaebfdd2b84e4ef70f0cbc7632f2ef43cb))
* **testing:** open plugin WebSockets ([dd1643b](https://github.com/pelerintech/reework/commit/dd1643b2c863797dea7a32de6a687491e1199f57))


### Bug Fixes

* **core:** await thenable plugin handlers ([0a1b722](https://github.com/pelerintech/reework/commit/0a1b722bab4dbd47a7384899af8b67e96cd18c0d))
* **core:** enforce plugin message limits while receiving ([15e1504](https://github.com/pelerintech/reework/commit/15e150403f6245bc9977746dca884989b695add3))
* **core:** refuse upgrades in flight when stopping ([96e1bff](https://github.com/pelerintech/reework/commit/96e1bffe1fb2e16800c1c696dffbe32f5b1218cc))
* **core:** require Connection: Upgrade on plugin sockets ([fff337b](https://github.com/pelerintech/reework/commit/fff337b7f24f6974bcc180224a170d52d7765bb6))
* **core:** reserve plugin socket slots before awaiting factories ([5c8d598](https://github.com/pelerintech/reework/commit/5c8d5980a91cc8839d2e62484e370144b57178f6))
* **core:** settle stop within its deadline with upgraded sockets ([b1d6271](https://github.com/pelerintech/reework/commit/b1d6271cf660839e00847456eca1cf68d17373b3))
* **core:** validate plugin WebSocket limits ([2ba1904](https://github.com/pelerintech/reework/commit/2ba1904693b25db1b88659cf6321e0363a8ad466))
* **testing:** close the listener on a failed plugin socket handshake ([a87f9fd](https://github.com/pelerintech/reework/commit/a87f9fddf770cf0d25ba53140f5828ae41627803))
* **testing:** honour an authorization header on plugin sockets ([31c74b9](https://github.com/pelerintech/reework/commit/31c74b929ff0d0e702eae0065fb9b6ba65456200))

## [1.3.0](https://github.com/pelerintech/reework/compare/core-v1.2.3...core-v1.3.0) (2026-11-11)


### Features

* **core:** add conversation kinds, owners and case access ([ad491fa](https://github.com/pelerintech/reework/commit/ad491fa6cb0e8af58e2bb448a773675fe7d99d82))
* **core:** add plugin events to every plugin context ([c568d89](https://github.com/pelerintech/reework/commit/c568d89ccbfda3ac0d3decf73c3e821e05be5d9f))
* **core:** admit an agent decider on an agent-capable gate ([1f47b90](https://github.com/pelerintech/reework/commit/1f47b90108f70a2783c65e5df6c7b6d7c0a7ba3b))
* **core:** audit raw secret reads and fetches ([4117db1](https://github.com/pelerintech/reework/commit/4117db13c0832b4e65d0281abbefba8eeccaff56))
* **core:** budget seams (v12) ([5f75fd3](https://github.com/pelerintech/reework/commit/5f75fd3f8db80847dccb2d24862b23c8ece0e5d0))
* **core:** conversation kinds, owners and case access (v13) ([5c2865a](https://github.com/pelerintech/reework/commit/5c2865ae4f10ce7fec037f971dde76781022a4cd))
* **core:** deliver tool emits after the tool round commits ([3133b9f](https://github.com/pelerintech/reework/commit/3133b9fe650d8d39f0c88eef4c8c3e1bf43fd5dd))
* **core:** embed named models through their embeddings endpoint ([628c9d2](https://github.com/pelerintech/reework/commit/628c9d2c0e56a958611d6c716fd1f4fe78c3ceba))
* **core:** embeddings (v17) ([2f9388f](https://github.com/pelerintech/reework/commit/2f9388f3cf217c1aabad04c1593d6671dd1eff29))
* **core:** emit plugin events from setup and routes ([8e36579](https://github.com/pelerintech/reework/commit/8e365798bb4a9e584cfdd604c22a79b2db831193))
* **core:** external tools (v11) ([facbcf6](https://github.com/pelerintech/reework/commit/facbcf6186f72abf5248215529ae737b744839ea))
* **core:** fail startup when the gateway token env is unset ([3f37e02](https://github.com/pelerintech/reework/commit/3f37e025276036f6095c7436a3dd9d9ca4fc97e1))
* **core:** fetch with secrets in every plugin context ([54cfd51](https://github.com/pelerintech/reework/commit/54cfd51c91b564af571f316e04426c19bdfee771))
* **core:** gate audience (v15) ([e12ee35](https://github.com/pelerintech/reework/commit/e12ee35602c7ec428da9ea9a94bce9f978e8edc1))
* **core:** gateway secrets backend ([a0aac08](https://github.com/pelerintech/reework/commit/a0aac08c98d3f1757fbc98c467ed800cc7aa62fc))
* **core:** headless agents without a model ([c0db230](https://github.com/pelerintech/reework/commit/c0db230aa4616dd0367afc6a444cc0548bbf5282))
* **core:** keep input submitted during a run stop ([e573a65](https://github.com/pelerintech/reework/commit/e573a65537c05e7b2c23bc0d2528eac7933f22ba))
* **core:** keep the external flag sticky through the hook chain ([b2e6b70](https://github.com/pelerintech/reework/commit/b2e6b702c2051ee870cf7e17c921e613cdcdbfe5))
* **core:** let a built gate set the resolved audience ([0a027dd](https://github.com/pelerintech/reework/commit/0a027dd28fcdf64e58805273d5d67cc6b57a6e0b))
* **core:** let a hook mark a blocked result external ([ada2045](https://github.com/pelerintech/reework/commit/ada20455c2ac8f053219412b42e942874ebba560))
* **core:** let a plugin stop a run before the next model request ([8e76328](https://github.com/pelerintech/reework/commit/8e763289bf8b9417b1cf59364b5e167fd9288623))
* **core:** let a tool result mark itself external ([d6b5f36](https://github.com/pelerintech/reework/commit/d6b5f36d74eab9c94781e2e7f2184227b8c804f4))
* **core:** let humans and unnamed deciders settle either audience ([0eb8a4e](https://github.com/pelerintech/reework/commit/0eb8a4e4c8a2a69d7d0ceed7fe036418074f770c))
* **core:** mark a flagged tool's results external for hooks ([17ae971](https://github.com/pelerintech/reework/commit/17ae971da19e82f21f4c7b55ed1f9c61fb868253))
* **core:** model keys from secrets with exactly one source ([c4a1391](https://github.com/pelerintech/reework/commit/c4a1391df1531f6c95e194c937c065ca8d974330))
* **core:** plugin events (v16) ([cd007ba](https://github.com/pelerintech/reework/commit/cd007ba4612d86e7b3cb6dbbd52365681f100d82))
* **core:** refuse embeddings for models without an embeddings endpoint ([558ba2e](https://github.com/pelerintech/reework/commit/558ba2ed16c0f49f62f4e6752d391c14d03e06fe))
* **core:** refuse secrets a plugin did not declare ([1fc23f8](https://github.com/pelerintech/reework/commit/1fc23f8220a0eabac4365ce802d3e1dd6c4b79ee))
* **core:** reject an agent decider on a human gate ([f4d0f1c](https://github.com/pelerintech/reework/commit/f4d0f1c9968819ec3da1e4d6d523a4d9e703bb3d))
* **core:** reject malformed secret definitions ([d633694](https://github.com/pelerintech/reework/commit/d633694e80c6ea22f9a3dffb4e70d72d0e95024f))
* **core:** report embedding usage through onModelUsage ([a2299d7](https://github.com/pelerintech/reework/commit/a2299d7c4efe45c0d83c830f8449ee9a4ed20b32))
* **core:** require plugin event data to be JSON ([d31649d](https://github.com/pelerintech/reework/commit/d31649d3d20a60b5132ffd22ec6fcee5dd327bf1))
* **core:** resolve file-backed secrets ([28e870f](https://github.com/pelerintech/reework/commit/28e870f87e53f6597c12542b72df6673913d7d1c))
* **core:** run beforeModelCall refusals before embed calls ([9772c43](https://github.com/pelerintech/reework/commit/9772c4304121089ce4e23051b5dbe90b8c5bcd8b))
* **core:** secrets and headless agents (v14) ([c65bf35](https://github.com/pelerintech/reework/commit/c65bf35a9c5dbd953339a8104ac317c21b931aa9))
* **core:** serve settled proposals over HTTP and the client ([5792633](https://github.com/pelerintech/reework/commit/579263385ca26a2d3467a1b6503df0222f99bec6))
* **core:** skip the emitter when delivering plugin events ([28dab87](https://github.com/pelerintech/reework/commit/28dab87a6c0ae2bb15a623bdcf203394407d79af))
* **core:** validate secret definitions at startup ([b8cf6f3](https://github.com/pelerintech/reework/commit/b8cf6f3f7eb0e9bf09b3f8a4d3c0e82f084c06b5))
* **types:** carry a gate audience on proposals ([589dbcb](https://github.com/pelerintech/reework/commit/589dbcb861c6e98f3856c642e6586e1b956c290b))
* **types:** carry external on tool-result hook messages ([ea8e9a9](https://github.com/pelerintech/reework/commit/ea8e9a9c6fc755e1004a92623679759ca865ba0f))
* **types:** show external on transcript tool items ([124629d](https://github.com/pelerintech/reework/commit/124629db87b0141a8074cad6854bc11996e20570))


### Bug Fixes

* **core:** admit only the deciders a gate's audience names ([e80f3db](https://github.com/pelerintech/reework/commit/e80f3db2ab90a986e3a0fc237e08caeff8a093c3))
* **core:** answer a headless submit with 409 and the clear message ([1a95062](https://github.com/pelerintech/reework/commit/1a95062bfa8f435712d89a6c0887457d7bb161e2))
* **core:** answer an unknown conversation before a headless refusal ([311e2c3](https://github.com/pelerintech/reework/commit/311e2c3ab60bfa0aa1b2d726ef418980cd670c4b))
* **core:** apply header formats literally ([f03a985](https://github.com/pelerintech/reework/commit/f03a985626f746217b11e85733963526eeaec74d))
* **core:** attribute hook emits to their plugin and conversation ([cb8848d](https://github.com/pelerintech/reework/commit/cb8848d3e2194030d3099a7e6f5b96a41ca299a7))
* **core:** audit failed local secret uses ([28491ad](https://github.com/pelerintech/reework/commit/28491adb737545e84316d0b1dbcc97a8eb1aef22))
* **core:** audit refused secret uses and model keys ([b9e5927](https://github.com/pelerintech/reework/commit/b9e592722f4f0faf5ad456799dad55151effabe5))
* **core:** batch embed inputs and sum their usage ([812a53e](https://github.com/pelerintech/reework/commit/812a53ebe0a3d23ae87fa301e1fb79383063b5ea))
* **core:** buffer tool-hook emits with their tool round ([1e0a763](https://github.com/pelerintech/reework/commit/1e0a763c6df9b861cd192d7d81911d368cf5cada))
* **core:** cut plugin event reaction chains at depth 8 ([270aab4](https://github.com/pelerintech/reework/commit/270aab4c3f3ea61d43a3602e5bca5e9064e33265))
* **core:** discard tool emits from a round that did not commit ([75d7a50](https://github.com/pelerintech/reework/commit/75d7a50e68f90a22f3fed8f03c4c5b47407ede66))
* **core:** emit one run usage event per model response ([91c7cb5](https://github.com/pelerintech/reework/commit/91c7cb56c01797de5fcfaafee2cc113244015c5b))
* **core:** harden gateway request handling ([63e90c8](https://github.com/pelerintech/reework/commit/63e90c84017e6a0cbeaff93c76146e8af9895902))
* **core:** keep external on hook-rewritten tool-result messages ([1807621](https://github.com/pelerintech/reework/commit/18076219612ffcdc0c197dbd359154b4241e526d))
* **core:** match host entries by host, port and IPv6 form ([f263073](https://github.com/pelerintech/reework/commit/f2630731afceef381a08bc060dba90e1a01b526f))
* **core:** name malformed embedding responses ([86422ec](https://github.com/pelerintech/reework/commit/86422ecea4db2f470686fae44e8db4197b912508))
* **core:** order embedding vectors by their index ([b7d1a6f](https://github.com/pelerintech/reework/commit/b7d1a6f986e183c5fd2cbef30a3f8886648d0d86))
* **core:** pass abort signals to embed requests ([4aac211](https://github.com/pelerintech/reework/commit/4aac211729b514729a93aaafe2a5b7e5533f657b))
* **core:** re-check secret hosts on every redirect hop ([370bc31](https://github.com/pelerintech/reework/commit/370bc3184cd76cf9ab28725921e2a282e8a8986a))
* **core:** record embed usage on the tool result ledger ([3e122e4](https://github.com/pelerintech/reework/commit/3e122e4564f390ec79343306c9384d6519c4124e))
* **core:** redact query secrets from response URLs ([7a53c9a](https://github.com/pelerintech/reework/commit/7a53c9ae5d28e299de15b154f8c6e75393955e79))
* **core:** reject unknown proposal listing statuses ([4c83b3c](https://github.com/pelerintech/reework/commit/4c83b3c9e42bafe13260c87607ca609195af9659))
* **core:** report redirected after following a secret redirect ([091273f](https://github.com/pelerintech/reework/commit/091273f8e94bb6eff0eca306ddb878d378dc64c9))
* **core:** resolve and refuse empty embed input ([47d2ebb](https://github.com/pelerintech/reework/commit/47d2ebbe8dfe15f92a076ac03d517ffa02d76724))
* **core:** return a model error over HTTP as JSON ([c4ead1f](https://github.com/pelerintech/reework/commit/c4ead1f4743d8d25d2524752a7d51b387abe66d3))
* **core:** return no embeddings for empty input without a request ([de26826](https://github.com/pelerintech/reework/commit/de268263eeae8f251fefb707807b0eca1a77341f))
* **core:** settle a gate's decision and proposal in one commit ([789c09e](https://github.com/pelerintech/reework/commit/789c09ef1277b6472ff7ff37d6acb8643e618a15))
* **core:** share maxConcurrentRequests between completions and embeddings ([f323d94](https://github.com/pelerintech/reework/commit/f323d94b2b7116d0e32c2381a2210b5c926ba261))
* **core:** surface model errors as errors only for gateway agents ([e8456d7](https://github.com/pelerintech/reework/commit/e8456d7794fe3bbb1b0b0a84395a24d723d46730))
* **core:** time out embed requests ([3525b6c](https://github.com/pelerintech/reework/commit/3525b6c5df8e47816a4d53017a299c56150cb3f2))
* **core:** validate apply rules and empty secret values ([c3aaba3](https://github.com/pelerintech/reework/commit/c3aaba3923779f2d5436e5893ea35c0870ce5814))
* **core:** validate embedding dimensions across batches ([5adaa2b](https://github.com/pelerintech/reework/commit/5adaa2b0493f292b5c87269d71225db0206acf1e))
* **core:** validate embedding vectors against the inputs ([cd04c6b](https://github.com/pelerintech/reework/commit/cd04c6ba9fed47b1df6be92138b746c442cbfe0f))
* **core:** validate plugin event names and payload size ([33200c9](https://github.com/pelerintech/reework/commit/33200c9184e88f7d9007f7f1cf0f99998fe62b05))
* **core:** validate secret format and hosts types at startup ([aa66344](https://github.com/pelerintech/reework/commit/aa66344be64814f693d2f997b4307802eaa64e04))
* **core:** warn when only some embed batches report usage ([d1026c0](https://github.com/pelerintech/reework/commit/d1026c0662d09c906aa405b34fb78fe4abeeb0d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @reework/types bumped to 1.2.0

## [1.2.3](https://github.com/pelerintech/reework/compare/core-v1.2.2...core-v1.2.3) (2026-11-10)


### Bug Fixes

* **core:** give event hooks a working case store ([4b666a1](https://github.com/pelerintech/reework/commit/4b666a156792736d4b1c27f21c7e3d48564b3e9a))
* **core:** give event hooks a working case store ([db1f7f4](https://github.com/pelerintech/reework/commit/db1f7f49977eb3639fb4f1a8a769d7f00effa4e0))

## [1.2.2](https://github.com/pelerintech/reework/compare/core-v1.2.1...core-v1.2.2) (2026-11-09)


### Bug Fixes

* **core:** give run hooks the plugin's real store ([70fe10a](https://github.com/pelerintech/reework/commit/70fe10a2ac82e0bc2a4c21efd2f9f20ae1ab1c77))
* **core:** give run hooks the plugin's real store ([c054775](https://github.com/pelerintech/reework/commit/c05477537292abd7fba215c85acfb10b118ffbfc))

## [1.2.1](https://github.com/pelerintech/reework/compare/core-v1.2.0...core-v1.2.1) (2026-11-09)


### Bug Fixes

* **core:** return plain values from the plugin store ([c5fdc12](https://github.com/pelerintech/reework/commit/c5fdc12047f2839cefbfbf0fdc680893a70e7cd1))
* **core:** return plain values from the plugin store ([04965b2](https://github.com/pelerintech/reework/commit/04965b2b51fabac5b0e59d521fe52ccfb6e38d6e))

## [1.2.0](https://github.com/pelerintech/reework/compare/core-v1.1.1...core-v1.2.0) (2026-11-08)


### Features

* **core:** give setup and route contexts the plugin's named models ([f64f5b4](https://github.com/pelerintech/reework/commit/f64f5b4e22e0f9dc0480dcd8101a4f24b728a861))
* **core:** give setup and route contexts the plugin's named models ([ddc8c35](https://github.com/pelerintech/reework/commit/ddc8c35d1037b87d38dc076b87e2988e045bc40c))

## [1.1.1](https://github.com/pelerintech/reework/compare/core-v1.1.0...core-v1.1.1) (2026-11-04)


### Bug Fixes

* **core:** stop hooks from relabelling input authors ([97dabf3](https://github.com/pelerintech/reework/commit/97dabf33872f649bb3a2d7aa9dd5a87769faf229))
* **core:** stop hooks from relabelling input authors ([45fa408](https://github.com/pelerintech/reework/commit/45fa408eab65720b39dfe113fcadb58ae5c3c8ed))

## [1.1.0](https://github.com/pelerintech/reework/compare/core-v1.0.0...core-v1.1.0) (2026-11-04)


### Features

* **core:** attach input authors to hook messages ([8372213](https://github.com/pelerintech/reework/commit/837221365483d15b8408dcfb389b9acf4c964613))
* **core:** attach input authors to hook messages ([947e7ee](https://github.com/pelerintech/reework/commit/947e7ee756c2ffa40190e8abf1cdf54bc5da2caa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @reework/types bumped to 1.1.0

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
